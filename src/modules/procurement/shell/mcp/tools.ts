/**
 * Procurement module — MCP tools (plan §8). Each tool → the SAME usecase the
 * GraphQL resolver calls; output is the kernel `{ ok, kind, query?, link?, item|
 * items, summary }` shape. Every aggregate carries the grain + the gate caveats.
 * PII-free (procurement has none). The DA search tool's filter is REQUIRED +
 * runtime-validated (the selective-filter rule, §3a(1)).
 */

import { z } from 'zod';

import {
  GRAPHQL_ERROR_CODE,
  invalidInput,
  type ApiError,
  type FilterInput,
  type KernelMcpTool,
  type McpToolOutput,
} from '@/modules/shared/index.js';

import { parseAnalysisScope, type AnalysisScope } from '../../core/analysis-scope.js';
import {
  analysisBreakdown,
  analysisConcentration,
  analysisSeries,
  analysisStats,
  type AnalysisBreakdownBlock,
  type AnalysisConcentrationBlock,
  type AnalysisSeriesBlock,
  type AnalysisStatsBlock,
} from '../../core/analysis-usecases.js';
import {
  ANALYSIS_GRAINS,
  BREAKDOWN_DIMENSIONS,
  MEASURE_IDS,
  PROCUREMENT_GRAIN_NOTE,
  FRAMEWORK_ROLE_FILTERS,
  RECORD_KINDS,
  SERIES_BUCKETS,
  type BreakdownDimension,
  type MeasureId,
  type SeriesBucket,
  VALUE_STATES,
} from '../../core/constants.js';
import { resolveCpv, searchContracts, searchDirectAcquisitions } from '../../core/usecases.js';

import type { AnalysisRepo, ProcurementRepo } from '../../core/ports.js';

export interface ProcurementMcpDeps {
  readonly repo: ProcurementRepo;
  readonly analysis: AnalysisRepo;
  readonly clientBaseUrl: string;
}

/**
 * The `aggregate_procurement` scope shape — field names MUST equal the SDL
 * `ProcurementAnalysisScopeInput` fields and the core `SCOPE_FIELDS` (the
 * surface-parity test asserts all three). Exported for that test.
 */
export const ANALYSIS_SCOPE_ZOD_SHAPE = {
  authorityCui: z.string().optional(),
  supplierCui: z.string().optional(),
  cpvDivision: z
    .string()
    .optional()
    .describe('2-digit CPV division (at most ONE CPV level per scope).'),
  cpvGroup: z
    .string()
    .optional()
    .describe('Canonical 8-digit CPV group code, XXY00000 with Y≠0 (one CPV level per scope).'),
  cpvClass: z
    .string()
    .optional()
    .describe('Canonical 8-digit CPV class code, XXXY0000 with Y≠0 (one CPV level per scope).'),
  cpvCategory: z
    .string()
    .optional()
    .describe('Canonical 8-digit CPV category code, XXXXY000 with Y≠0 (one CPV level per scope).'),
  cpvCode: z.string().optional().describe('8-digit CPV code (at most ONE CPV level per scope).'),
  buyerCounty: z.string().optional().describe('Buyer registered-office county code.'),
  buyerRegion: z.string().optional(),
  buyerSiruta: z
    .string()
    .optional()
    .describe('Buyer registered-office territorial SIRUTA (UAT natural key).'),
  supplierCounty: z.string().optional().describe('Supplier registered-office county code.'),
  supplierRegion: z.string().optional(),
  supplierSiruta: z
    .string()
    .optional()
    .describe('Supplier registered-office territorial SIRUTA (UAT natural key).'),
  status: z.string().optional(),
  procedureType: z.string().optional(),
  recordKind: z
    .enum(RECORD_KINDS)
    .optional()
    .describe('Contract grain only: award record vs framework umbrella.'),
  frameworkRole: z
    .enum(FRAMEWORK_ROLE_FILTERS)
    .optional()
    .describe(
      'Contract grain only. OMITTING THIS IS NOT "no filter": the contract grain defaults to purchases only (standalone + not-yet-stamped rows), because framework ceilings are an umbrella maximum rather than money spent and counting them overstated 2016-2025 by 20.8%. Pass "all" to include ceilings and call-offs.'
    ),
  grain: z.enum(ANALYSIS_GRAINS).optional().describe('Absent = all grains the matrix supports.'),
  from: z.string().optional().describe('YYYY-MM, inclusive (XOR year).'),
  to: z.string().optional().describe('YYYY-MM, inclusive (XOR year).'),
  year: z.number().int().optional(),
  q: z
    .string()
    .optional()
    .describe('Free-text title filter on aggregates (title coverage is partial per grain).'),
  valueMin: z
    .number()
    .optional()
    .describe('Awarded-value lower bound, RON (restricts to accepted-value rows in range).'),
  valueMax: z
    .number()
    .optional()
    .describe('Awarded-value upper bound, RON (restricts to accepted-value rows in range).'),
} as const;

const AWARDED_NOTE = 'Amounts are awarded value, not payments.';

const strArg = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v : '';
};
const intArg = (args: Record<string, unknown>, key: string, dflt: number): number => {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
};
const optStr = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
};
const errorOut = (kind: string, error: ApiError): McpToolOutput => ({
  ok: false,
  kind: error.type === 'Timeout' ? 'timeout' : kind,
  errorType: error.type,
  errorCode: GRAPHQL_ERROR_CODE[error.type],
  error: error.message,
});
const errorFrom = (kind: string, error: ApiError): McpToolOutput => errorOut(kind, error);
const invalidOut = (kind: string, message: string, field?: string): McpToolOutput =>
  errorOut(kind, invalidInput(message, field));
const n = (x: number): string => String(x);

export const makeProcurementMcpTools = (deps: ProcurementMcpDeps): readonly KernelMcpTool[] => {
  const { repo, analysis, clientBaseUrl } = deps;
  const analysisDeps = { analysisRepo: analysis };

  // ── (1) discovery ──────────────────────────────────────────────────────────
  const resolveFilter: KernelMcpTool = {
    name: 'resolve_procurement_filter',
    description:
      'Resolve a free-text procurement query to a filter value: CPV label → 2-digit CPV division (the reliable hierarchy). For authority/supplier names use the kernel entity resolver, for region/county the territory resolver — this tool owns CPV. MANDATORY first step before any CPV-based question.',
    strictInput: true,
    inputShape: {
      dim: z.enum(['cpvDivision', 'cpv']).describe('Which procurement-owned dimension to resolve.'),
      q: z.string().describe('The free-text query (label or code prefix).'),
      limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const q = strArg(args, 'q');
      const res = await resolveCpv(repo, q, intArg(args, 'limit', 10));
      if (res.isErr()) return errorFrom('resolution', res.error);
      const lowConf = res.value.some((m) => m.level === 'code');
      return {
        ok: true,
        kind: 'resolution',
        query: { dim: strArg(args, 'dim'), q },
        items: res.value,
        summary:
          `Found ${n(res.value.length)} CPV match(es) for «${q}».` +
          (lowConf
            ? ' (8-digit code matches are low-confidence; prefer the 2-digit division.)'
            : ''),
      };
    },
  };

  // ── (2) query / rank ────────────────────────────────────────────────────────
  const searchContractsTool: KernelMcpTool = {
    name: 'search_procurement_contracts',
    description:
      'Search supplier-level procurement contracts (SEAP). Filter by authority/supplier CUI, CPV code/division, value range (RESOLVED comparable value), date, status, valueState. Canonical-only by default. Cursor-paginated; no totals on the 1.9M-row table. Each item carries the value-model resolution (value.valueState / value.valueRonComparable).',
    strictInput: true,
    inputShape: {
      authorityCui: z.string().optional(),
      supplierCui: z.string().optional(),
      cpvDivision: z.string().optional().describe('2-digit CPV division.'),
      minValueRon: z.string().optional().describe('Decimal string (resolved comparable value).'),
      valueState: z
        .enum(VALUE_STATES)
        .optional()
        .describe('Value-model state filter; accepted states carry a comparable value.'),
      year: z.number().int().optional(),
      first: z.number().int().min(1).max(100).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const filter = buildContractFilter(args);
      const res = await searchContracts(repo, filter, { first: intArg(args, 'first', 20) });
      if (res.isErr()) return errorFrom('contract_list', res.error);
      return {
        ok: true,
        kind: 'contract_list',
        query: filter,
        link: `${clientBaseUrl}/procurement/contracts`,
        items: res.value.items,
        summary: `${n(res.value.items.length)} contract(s)${res.value.next !== null ? ' (more available)' : ''}.`,
      };
    },
  };

  const searchDaTool: KernelMcpTool = {
    name: 'search_procurement_direct_acquisitions',
    description:
      'Search direct acquisitions (catalog buys; the 20M-row grain). A SELECTIVE filter is REQUIRED — at least one of authorityCui, supplierCui, cpvCode/Division, uniqueCode, or a bounded year/date window. Cursor-paginated; no totals.',
    strictInput: true,
    inputShape: {
      authorityCui: z.string().optional(),
      supplierCui: z.string().optional(),
      cpvDivision: z.string().optional(),
      uniqueCode: z.string().optional(),
      valueState: z.enum(VALUE_STATES).optional().describe('Value-model state filter.'),
      year: z.number().int().optional(),
      first: z.number().int().min(1).max(100).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const filter = buildDaFilter(args);
      const res = await searchDirectAcquisitions(repo, filter, {
        first: intArg(args, 'first', 20),
      });
      if (res.isErr()) return errorFrom('da_list', res.error);
      return {
        ok: true,
        kind: 'da_list',
        query: filter,
        link: `${clientBaseUrl}/procurement/direct-acquisitions`,
        items: res.value.items,
        summary: `${n(res.value.items.length)} direct acquisition(s)${res.value.next !== null ? ' (more available)' : ''}.`,
      };
    },
  };

  // ── the analysis surface (design §5.5 — one tool, four shapes) ──────────────

  /** Deduped caveats across per-grain envelopes, for the human summary tail. */
  const caveatTail = (envelopes: readonly { caveats: readonly string[] }[]): string => {
    const caveats = [...new Set(envelopes.flatMap((e) => e.caveats))];
    return caveats.length > 0 ? ` (${caveats.join('; ')})` : '';
  };

  const analysisOutput = (
    shape: string,
    scope: AnalysisScope,
    items: readonly unknown[],
    envelopes: readonly { caveats: readonly string[] }[],
    moneyShown: boolean,
    headline: string
  ): McpToolOutput => ({
    ok: true,
    kind: `analysis_${shape}`,
    query: { scope, shape },
    items,
    meta: { envelopes },
    summary:
      headline +
      (moneyShown ? ` ${AWARDED_NOTE}` : '') +
      ` ${PROCUREMENT_GRAIN_NOTE}` +
      caveatTail(envelopes),
  });

  const aggregateProcurement: KernelMcpTool = {
    name: 'aggregate_procurement',
    description:
      'Aggregate procurement analytics over ONE scope: stats, series, breakdown, or supplier concentration. Money is AWARDED value, not payments; unsupported combinations are rejected by the pinned matrix. Every answer carries answerability, reason, buildId, and canonicalScope.',
    strictInput: true,
    inputShape: {
      scope: z.object(ANALYSIS_SCOPE_ZOD_SHAPE).strict().optional(),
      shape: z.enum(['stats', 'series', 'breakdown', 'concentration']),
      dimension: z.enum(BREAKDOWN_DIMENSIONS).optional().describe('Required for shape=breakdown.'),
      bucket: z.enum(SERIES_BUCKETS).optional().describe('For shape=series; default month.'),
      measure: z.enum(MEASURE_IDS).optional().describe('Required for shape=series.'),
      // Core owns the shared integer/range contract so GraphQL and MCP return
      // the same InvalidInput category/message for explicit numeric values.
      topN: z.number().optional(),
      basis: z.enum(['count', 'value']).optional().describe('For concentration; default count.'),
      rankBy: z
        .enum(['count', 'value'])
        .optional()
        .describe(
          'Breakdown bucket ranking. Default: value where the spend gate allows, else count.'
        ),
    },
    async handler(args): Promise<McpToolOutput> {
      const scopeR = parseAnalysisScope(args['scope'] as Record<string, unknown> | undefined);
      if (scopeR.isErr()) return errorFrom('analysis', scopeR.error);
      const scope = scopeR.value;
      const shape = strArg(args, 'shape');
      const topNValue = args['topN'];
      const topN = typeof topNValue === 'number' ? topNValue : undefined;
      const rankBy = optStr(args, 'rankBy') as 'count' | 'value' | undefined;

      if (shape === 'stats') {
        const res = await analysisStats(analysisDeps, { scope });
        if (res.isErr()) return errorFrom('analysis_stats', res.error);
        const blocks: readonly AnalysisStatsBlock[] = res.value.blocks;
        return analysisOutput(
          'stats',
          scope,
          blocks,
          blocks.map((b) => b.meta),
          blocks.some((b) => b.valueAwardedSum !== null || b.valueEstimatedSum !== null),
          `${n(blocks.length)} per-grain stats block(s).`
        );
      }

      if (shape === 'series') {
        const measure = optStr(args, 'measure') as MeasureId | undefined;
        if (measure === undefined)
          return invalidOut('analysis_series', "shape 'series' requires a measure", 'measure');
        const bucket = (optStr(args, 'bucket') ?? 'month') as SeriesBucket;
        const res = await analysisSeries(analysisDeps, { scope, bucket, measure });
        if (res.isErr()) return errorFrom('analysis_series', res.error);
        const blocks: readonly AnalysisSeriesBlock[] = res.value;
        return analysisOutput(
          'series',
          scope,
          blocks,
          blocks.map((b) => b.meta),
          blocks.some((b) => b.meta.valueBasis !== null && b.points.length > 0),
          `${n(blocks.length)} per-grain ${measure} series (${bucket} buckets).`
        );
      }

      if (shape === 'breakdown') {
        const dimension = optStr(args, 'dimension') as BreakdownDimension | undefined;
        if (dimension === undefined) {
          return invalidOut(
            'analysis_breakdown',
            "shape 'breakdown' requires a dimension",
            'dimension'
          );
        }
        const res = await analysisBreakdown(analysisDeps, {
          scope,
          dimension,
          ...(topN !== undefined && { topN }),
          ...(rankBy !== undefined && { rankBy }),
        });
        if (res.isErr()) return errorFrom('analysis_breakdown', res.error);
        const blocks: readonly AnalysisBreakdownBlock[] = res.value;
        return analysisOutput(
          'breakdown',
          scope,
          blocks,
          blocks.map((b) => b.meta),
          blocks.some((b) => b.buckets.some((bucket) => bucket.valueAwardedSum !== null)),
          `${n(blocks.length)} per-grain ${dimension} breakdown(s): top-N + other + unknown reconcile to the scope stats.`
        );
      }

      if (shape === 'concentration') {
        const basis = optStr(args, 'basis') as 'count' | 'value' | undefined;
        const res = await analysisConcentration(analysisDeps, {
          scope,
          ...(basis === undefined ? {} : { basis }),
        });
        if (res.isErr()) return errorFrom('analysis_concentration', res.error);
        const blocks: readonly AnalysisConcentrationBlock[] = res.value;
        return analysisOutput(
          'concentration',
          scope,
          blocks,
          blocks.map((b) => b.meta),
          blocks.some((b) => b.totalRon !== null),
          `${n(blocks.length)} per-grain concentration block(s). High concentration is a signal, not a finding.`
        );
      }

      return invalidOut('analysis', `unknown shape '${shape}'`, 'shape');
    },
  };

  return [resolveFilter, searchContractsTool, searchDaTool, aggregateProcurement];
};

// ── filter builders (scalar MCP args → kernel FilterInput) ──────────────────────

const buildContractFilter = (args: Record<string, unknown>): FilterInput => {
  const f: Record<string, FilterInput[string]> = {};
  const au = strArg(args, 'authorityCui');
  const su = strArg(args, 'supplierCui');
  const cd = strArg(args, 'cpvDivision');
  const mv = strArg(args, 'minValueRon');
  const yr = args['year'];
  if (au !== '') f['authorityCui'] = { in: [au] };
  if (su !== '') f['supplierCui'] = { in: [su] };
  if (cd !== '') f['cpvDivision'] = { in: [cd] };
  if (mv !== '') f['minValueRon'] = { gte: mv };
  const vsC = strArg(args, 'valueState');
  if (vsC !== '') f['valueState'] = { in: [vsC] };
  if (typeof yr === 'number') f['year'] = { eq: yr };
  return f;
};

const buildDaFilter = (args: Record<string, unknown>): FilterInput => {
  const f: Record<string, FilterInput[string]> = {};
  const au = strArg(args, 'authorityCui');
  const su = strArg(args, 'supplierCui');
  const cd = strArg(args, 'cpvDivision');
  const uc = strArg(args, 'uniqueCode');
  const yr = args['year'];
  if (au !== '') f['authorityCui'] = { in: [au] };
  if (su !== '') f['supplierCui'] = { in: [su] };
  if (cd !== '') f['cpvDivision'] = { in: [cd] };
  if (uc !== '') f['uniqueCode'] = { eq: uc };
  const vsD = strArg(args, 'valueState');
  if (vsD !== '') f['valueState'] = { in: [vsD] };
  if (typeof yr === 'number') f['year'] = { eq: yr };
  return f;
};
