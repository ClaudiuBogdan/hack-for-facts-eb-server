/**
 * Procurement module — MCP tools (plan §8). Each tool → the SAME usecase the
 * GraphQL resolver calls; output is the kernel `{ ok, kind, query?, link?, item|
 * items, summary }` shape. Every aggregate carries the grain + the gate caveats.
 * PII-free (procurement has none). The DA search tool's filter is REQUIRED +
 * runtime-validated (the selective-filter rule, §3a(1)).
 */

import { z } from 'zod';

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
  SERIES_BUCKETS,
  type BreakdownDimension,
  type MeasureId,
  type ProcurementGrain,
  type SeriesBucket,
} from '../../core/constants.js';
import {
  authorityCpvSpend,
  grainQuality,
  resolveCpv,
  sameDaySplittingCandidates,
  searchContracts,
  searchDirectAcquisitions,
  supplierConcentration,
  topAuthorities,
  topSuppliers,
} from '../../core/usecases.js';

import type { AnalysisRepo, ProcurementAggregateRepo, ProcurementRepo } from '../../core/ports.js';
import type { EdgeAggFilter } from '../../core/types.js';
import type { FilterInput, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface ProcurementMcpDeps {
  readonly repo: ProcurementRepo;
  readonly aggregate: ProcurementAggregateRepo;
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
  cpvDivision: z.string().optional().describe('2-digit CPV division (XOR cpvCode).'),
  cpvCode: z.string().optional().describe('8-digit CPV code (XOR cpvDivision).'),
  buyerCounty: z.string().optional().describe('Not served in wave 1 (named rejection).'),
  buyerRegion: z.string().optional(),
  supplierCounty: z.string().optional().describe('Milestone M3 (named rejection).'),
  supplierRegion: z.string().optional().describe('Milestone M3 (named rejection).'),
  status: z.string().optional(),
  procedureType: z.string().optional(),
  grain: z.enum(ANALYSIS_GRAINS).optional().describe('Absent = all grains the matrix supports.'),
  from: z.string().optional().describe('YYYY-MM, inclusive (XOR year).'),
  to: z.string().optional().describe('YYYY-MM, inclusive (XOR year).'),
  year: z.number().int().optional(),
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
const grainArg = (args: Record<string, unknown>): ProcurementGrain =>
  strArg(args, 'grain') === 'procurement_contract' ? 'procurement_contract' : 'direct_acquisition';

/** Build an EdgeAggFilter from scalar MCP args (month bounds only when present). */
const edgeFilterOf = (args: Record<string, unknown>, topN: number): EdgeAggFilter => {
  const monthFrom = optStr(args, 'monthFrom');
  const monthTo = optStr(args, 'monthTo');
  return {
    grain: grainArg(args),
    topN,
    ...(monthFrom !== undefined && { monthFrom }),
    ...(monthTo !== undefined && { monthTo }),
  };
};

const errorOut = (kind: string, message: string): McpToolOutput => ({
  ok: false,
  kind,
  error: message,
});
const n = (x: number): string => String(x);

export const makeProcurementMcpTools = (deps: ProcurementMcpDeps): readonly KernelMcpTool[] => {
  const { repo, aggregate, analysis, clientBaseUrl } = deps;
  const analysisDeps = { analysisRepo: analysis };
  const entityLink = (cui: string, role: 'authority' | 'supplier'): string =>
    `${clientBaseUrl}/procurement/entity/${cui}?role=${role}`;

  // ── (1) discovery ──────────────────────────────────────────────────────────
  const resolveFilter: KernelMcpTool = {
    name: 'resolve_procurement_filter',
    description:
      'Resolve a free-text procurement query to a filter value: CPV label → 2-digit CPV division (the reliable hierarchy). For authority/supplier names use the kernel entity resolver, for region/county the territory resolver — this tool owns CPV. MANDATORY first step before any CPV-based question.',
    inputShape: {
      dim: z.enum(['cpvDivision', 'cpv']).describe('Which procurement-owned dimension to resolve.'),
      q: z.string().describe('The free-text query (label or code prefix).'),
      limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const q = strArg(args, 'q');
      const res = await resolveCpv(repo, q, intArg(args, 'limit', 10));
      if (res.isErr()) return errorOut('resolution', res.error.message);
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
      'Search supplier-level procurement contracts (SEAP). Filter by authority/supplier CUI, CPV code/division, value range, date, status. Canonical-only by default. Cursor-paginated; no totals on the 1.9M-row table.',
    inputShape: {
      authorityCui: z.string().optional(),
      supplierCui: z.string().optional(),
      cpvDivision: z.string().optional().describe('2-digit CPV division.'),
      minValueRon: z.string().optional().describe('Decimal string.'),
      year: z.number().int().optional(),
      first: z.number().int().min(1).max(100).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const filter = buildContractFilter(args);
      const res = await searchContracts(repo, filter, { first: intArg(args, 'first', 20) });
      if (res.isErr()) return errorOut('contract_list', res.error.message);
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
    inputShape: {
      authorityCui: z.string().optional(),
      supplierCui: z.string().optional(),
      cpvDivision: z.string().optional(),
      uniqueCode: z.string().optional(),
      year: z.number().int().optional(),
      first: z.number().int().min(1).max(100).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const filter = buildDaFilter(args);
      const res = await searchDirectAcquisitions(repo, filter, {
        first: intArg(args, 'first', 20),
      });
      if (res.isErr()) return errorOut('da_list', res.error.message);
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

  const rankSuppliers: KernelMcpTool = {
    name: 'rank_procurement_suppliers',
    description:
      'PC-1: rank the top suppliers of an authority for a grain + period. Ranked by value when the grain allows it, else by flow count (the gate decides). Returns per-grain caveats.',
    inputShape: {
      authorityCui: z.string().describe('The buyer authority CUI.'),
      grain: z.enum(['direct_acquisition', 'procurement_contract']).optional(),
      monthFrom: z.string().optional().describe('YYYY-MM-DD lower bound.'),
      monthTo: z.string().optional(),
      topN: z.number().int().min(1).max(100).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'authorityCui');
      if (cui === '') return errorOut('ranking', 'authorityCui is required');
      const res = await topSuppliers(aggregate, cui, edgeFilterOf(args, intArg(args, 'topN', 20)));
      if (res.isErr()) return errorOut('ranking', res.error.message);
      const top = res.value.data[0];
      return {
        ok: true,
        kind: 'ranking',
        query: { authorityCui: cui, grain: res.value.grain },
        link: entityLink(cui, 'authority'),
        items: res.value.data,
        summary:
          `Top ${n(res.value.data.length)} suppliers of ${cui} (${res.value.grain})` +
          (top !== undefined
            ? `; #1 ${top.supplierName ?? top.supplierCui} = ${top.flowCount} flows, ${top.amountRonSum ?? 'n/a'} RON.`
            : '.') +
          (res.value.caveats.length > 0 ? ` (${res.value.caveats.join('; ')})` : ''),
      };
    },
  };

  const rankAuthorities: KernelMcpTool = {
    name: 'rank_procurement_authorities',
    description: 'PC-3: rank the top authorities buying from a supplier for a grain + period.',
    inputShape: {
      supplierCui: z.string().describe('The supplier CUI.'),
      grain: z.enum(['direct_acquisition', 'procurement_contract']).optional(),
      monthFrom: z.string().optional(),
      monthTo: z.string().optional(),
      topN: z.number().int().min(1).max(100).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'supplierCui');
      if (cui === '') return errorOut('ranking', 'supplierCui is required');
      const res = await topAuthorities(
        aggregate,
        cui,
        edgeFilterOf(args, intArg(args, 'topN', 20))
      );
      if (res.isErr()) return errorOut('ranking', res.error.message);
      const top = res.value.data[0];
      return {
        ok: true,
        kind: 'ranking',
        query: { supplierCui: cui, grain: res.value.grain },
        link: entityLink(cui, 'supplier'),
        items: res.value.data,
        summary:
          `Top ${n(res.value.data.length)} authorities buying from ${cui} (${res.value.grain})` +
          (top !== undefined ? `; #1 ${top.authorityName ?? top.authorityCui}.` : '.') +
          (res.value.caveats.length > 0 ? ` (${res.value.caveats.join('; ')})` : ''),
      };
    },
  };

  // NOTE: kept on the legacy MV path (usecase `supplierConcentration` over
  // org_edge_monthly_rollups) — byte-identical output to the pre-analysis tool.
  // Re-plumbing onto the analysis rollups is DEFERRED until the MV stack retires;
  // the rollup-backed concentration is served by `aggregate_procurement` and the
  // GraphQL `procurementConcentration(scope, basis)` query instead.
  const concentration: KernelMcpTool = {
    name: 'get_procurement_concentration',
    description:
      'PC-5: supplier concentration (top1/top5 share + HHI) for an authority. Value-based when the grain allows it, else count-based (the gate decides). High concentration is a signal, not a finding.',
    inputShape: {
      authorityCui: z.string(),
      grain: z.enum(['direct_acquisition', 'procurement_contract']).optional(),
      monthFrom: z.string().optional(),
      monthTo: z.string().optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'authorityCui');
      if (cui === '') return errorOut('concentration', 'authorityCui is required');
      const res = await supplierConcentration(aggregate, cui, edgeFilterOf(args, 0));
      if (res.isErr()) return errorOut('concentration', res.error.message);
      const c = res.value;
      return {
        ok: true,
        kind: 'concentration',
        query: { authorityCui: cui, grain: c.grain, basis: c.basis },
        link: entityLink(cui, 'authority'),
        item: c,
        summary:
          `${cui} (${c.grain}, ${c.basis}-based): ${n(c.supplierCount)} suppliers; ` +
          `top1 ${c.top1Share !== null ? `${(c.top1Share * 100).toFixed(1)}%` : 'n/a'}, ` +
          `HHI ${c.hhi !== null ? c.hhi.toFixed(3) : 'n/a'}.` +
          (c.caveats.length > 0 ? ` (${c.caveats.join('; ')})` : ''),
      };
    },
  };

  const authorityCpv: KernelMcpTool = {
    name: 'get_procurement_authority_cpv_spend',
    description:
      'PC-4: an authority’s spend broken down by CPV division × period (from the rollup).',
    inputShape: {
      authorityCui: z.string(),
      grain: z.enum(['direct_acquisition', 'procurement_contract']).optional(),
      cpvDivision: z.array(z.string()).optional(),
      monthFrom: z.string().optional(),
      monthTo: z.string().optional(),
      topN: z.number().int().min(1).max(100).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'authorityCui');
      if (cui === '') return errorOut('cpv_spend', 'authorityCui is required');
      const divisions = Array.isArray(args['cpvDivision'])
        ? (args['cpvDivision'] as unknown[]).map(String)
        : undefined;
      const monthFrom = optStr(args, 'monthFrom');
      const monthTo = optStr(args, 'monthTo');
      const res = await authorityCpvSpend(aggregate, cui, {
        grain: grainArg(args),
        topN: intArg(args, 'topN', 50),
        ...(divisions !== undefined && { cpvDivisions: divisions }),
        ...(monthFrom !== undefined && { monthFrom }),
        ...(monthTo !== undefined && { monthTo }),
      });
      if (res.isErr()) return errorOut('cpv_spend', res.error.message);
      return {
        ok: true,
        kind: 'cpv_spend',
        query: { authorityCui: cui, grain: res.value.grain },
        link: entityLink(cui, 'authority'),
        items: res.value.data,
        summary:
          `${n(res.value.data.length)} CPV division(s) for ${cui} (${res.value.grain}).` +
          (res.value.caveats.length > 0 ? ` (${res.value.caveats.join('; ')})` : ''),
      };
    },
  };

  const sameDay: KernelMcpTool = {
    name: 'find_same_day_da_candidates',
    description:
      'PC-7: same-day direct-acquisition splitting CANDIDATES for an authority (or a date window). A candidate is a REVIEW SIGNAL, not evidence of wrongdoing. Requires authorityCui or a date window.',
    inputShape: {
      authorityCui: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      minSameDayCount: z.number().int().min(2).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const authorityCui = optStr(args, 'authorityCui');
      const dateFrom = optStr(args, 'dateFrom');
      const dateTo = optStr(args, 'dateTo');
      const res = await sameDaySplittingCandidates(
        aggregate,
        {
          minSameDayCount: intArg(args, 'minSameDayCount', 2),
          ...(authorityCui !== undefined && { authorityCui }),
          ...(dateFrom !== undefined && { candidateDateFrom: dateFrom }),
          ...(dateTo !== undefined && { candidateDateTo: dateTo }),
        },
        { page: 1, pageSize: 50 }
      );
      if (res.isErr()) return errorOut('same_day_candidates', res.error.message);
      return {
        ok: true,
        kind: 'same_day_candidates',
        query: { authorityCui: authorityCui ?? null },
        items: res.value.items,
        summary: `${n(res.value.items.length)} same-day candidate group(s). NOTE: a candidate is a review signal, not proof of illegal splitting.`,
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
      'Aggregate procurement analytics over ONE scope: stats (labeled per-grain blocks), series (month/quarter/year buckets), breakdown (top-N + other + unknown, reconciling to stats), or concentration (HHI/top shares). Money is AWARDED value, not payments; unsupported scope/dimension combinations are rejected with the missing capability named. Every answer carries its envelope (policyKey, valueBasis, caveats, link) in meta.',
    inputShape: {
      scope: z.object(ANALYSIS_SCOPE_ZOD_SHAPE).optional(),
      shape: z.enum(['stats', 'series', 'breakdown', 'concentration']),
      dimension: z.enum(BREAKDOWN_DIMENSIONS).optional().describe('Required for shape=breakdown.'),
      bucket: z.enum(SERIES_BUCKETS).optional().describe('For shape=series; default month.'),
      measure: z.enum(MEASURE_IDS).optional().describe('Required for shape=series.'),
      topN: z.number().int().min(1).max(50).optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const scopeR = parseAnalysisScope(args['scope'] as Record<string, unknown> | undefined);
      if (scopeR.isErr()) return errorOut('analysis', scopeR.error.message);
      const scope = scopeR.value;
      const shape = strArg(args, 'shape');
      const topNValue = args['topN'];
      const topN = typeof topNValue === 'number' ? Math.floor(topNValue) : undefined;

      if (shape === 'stats') {
        const res = await analysisStats(analysisDeps, { scope });
        if (res.isErr()) return errorOut('analysis_stats', res.error.message);
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
          return errorOut('analysis_series', "shape 'series' requires a measure");
        const bucket = (optStr(args, 'bucket') ?? 'month') as SeriesBucket;
        const res = await analysisSeries(analysisDeps, { scope, bucket, measure });
        if (res.isErr()) return errorOut('analysis_series', res.error.message);
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
          return errorOut('analysis_breakdown', "shape 'breakdown' requires a dimension");
        }
        const res = await analysisBreakdown(analysisDeps, {
          scope,
          dimension,
          ...(topN !== undefined && { topN }),
        });
        if (res.isErr()) return errorOut('analysis_breakdown', res.error.message);
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
        const res = await analysisConcentration(analysisDeps, { scope });
        if (res.isErr()) return errorOut('analysis_concentration', res.error.message);
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

      return errorOut('analysis', `unknown shape '${shape}'`);
    },
  };

  const grainGate: KernelMcpTool = {
    name: 'get_procurement_grain_quality',
    description:
      'Return the procurement grain gate (which aggregate answers are allowed per grain: filters / spend rankings / supplier-region filters). Self-check what is answerable before asking.',
    inputShape: {},
    async handler(): Promise<McpToolOutput> {
      const res = await grainQuality(aggregate);
      if (res.isErr()) return errorOut('grain_quality', res.error.message);
      return {
        ok: true,
        kind: 'grain_quality',
        items: res.value,
        summary:
          res.value
            .map(
              (g) =>
                `${g.grain}: filters=${g.filterAnswersAllowed ? 'yes' : 'no'}, spend-rankings=${g.spendRankingsAllowed ? 'yes' : 'no'}.`
            )
            .join(' ') + ` ${PROCUREMENT_GRAIN_NOTE}`,
      };
    },
  };

  return [
    resolveFilter,
    searchContractsTool,
    searchDaTool,
    rankSuppliers,
    rankAuthorities,
    concentration,
    authorityCpv,
    sameDay,
    grainGate,
    aggregateProcurement,
  ];
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
  if (typeof yr === 'number') f['year'] = { eq: yr };
  return f;
};
