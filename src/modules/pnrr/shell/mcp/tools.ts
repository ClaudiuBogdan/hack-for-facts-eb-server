/**
 * PNRR module — MCP tools (plan §8). Each tool → the SAME usecase the GraphQL
 * resolver calls; output is the kernel `{ ok, kind, query?, link?, item|items,
 * summary?, ... }` object. PII never returned. The grain caveat (§14.6) rides in
 * the entity tool's `summary`. Filters arrive as a plain JSON object validated by
 * the kernel filter pipeline downstream (the repo rejects bad ops/values).
 */

import { Decimal } from 'decimal.js';
import { z } from 'zod';

import {
  PNRR_GRAIN_NOTE,
  PNRR_RESOLVE_DIMS,
  type PnrrContractorRankBy,
  type PnrrPaymentGroupBy,
  type PnrrResolveDim,
} from '../../core/types.js';
import {
  aggregatePnrrPayments,
  getPnrrEntity,
  getPnrrEntityProfile,
  rankPnrrContractors,
  resolvePnrrFilters,
} from '../../core/usecases.js';

import type { PnrrRepository } from '../../core/ports.js';
import type { FilterInput, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface PnrrMcpDeps {
  readonly repo: PnrrRepository;
  readonly clientBaseUrl: string;
}

const strArg = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v : '';
};

const filterArg = (args: Record<string, unknown>): FilterInput => {
  const v = args['filter'];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as FilterInput) : {};
};

const intArg = (args: Record<string, unknown>, key: string, dflt: number): number => {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
};

const errorOut = (kind: string, message: string): McpToolOutput => ({
  ok: false,
  kind,
  error: message,
});

/** Stringify a number for safe template interpolation (no implicit number→string). */
const n = (x: number): string => String(x);

export const makePnrrMcpTools = (deps: PnrrMcpDeps): readonly KernelMcpTool[] => {
  const { repo, clientBaseUrl } = deps;
  const entityLink = (cui: string): string => `${clientBaseUrl}/pnrr/${cui}`;

  const resolveFilters: KernelMcpTool = {
    name: 'resolve_pnrr_filters',
    description:
      'Resolve a free-text PNRR query to a filter value: entity/contractor name → CUI, label → component code, name → measure fenix reference, county name → SIRUTA. Use before querying other PNRR tools.',
    inputShape: {
      dim: z
        .enum(['entity', 'component', 'measure', 'county', 'contractor'])
        .describe('Which dimension to resolve.'),
      q: z.string().describe('The free-text query (name or label).'),
      limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 10).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const dim = strArg(args, 'dim') as PnrrResolveDim;
      if (!PNRR_RESOLVE_DIMS.includes(dim)) return errorOut('resolve', `unknown dim '${dim}'`);
      const q = strArg(args, 'q');
      const res = await resolvePnrrFilters(repo, dim, q, intArg(args, 'limit', 10));
      if (res.isErr()) return errorOut('resolve', res.error.message);
      return {
        ok: true,
        kind: 'resolve',
        query: { dim, q },
        items: res.value,
        summary: `Found ${n(res.value.length)} match(es) for «${q}» as ${dim}.`,
      };
    },
  };

  const getEntity: KernelMcpTool = {
    name: 'get_pnrr_entity',
    description:
      'PNRR profile for an entity by CUI: payment totals (cash), commitment totals (obligations), and procurement (acquisitions + contractor wins). Grains are reported separately and never summed.',
    inputShape: {
      cui: z.string().describe('The entity CUI/CIF (digits only).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'cui');
      const [entityRes, profileRes] = await Promise.all([
        getPnrrEntity(repo, cui),
        getPnrrEntityProfile(repo, cui),
      ]);
      if (entityRes.isErr()) return errorOut('entity', entityRes.error.message);
      if (profileRes.isErr()) return errorOut('entity', profileRes.error.message);
      const entity = entityRes.value;
      const profile = profileRes.value;
      if (entity === null || profile === null) {
        return {
          ok: true,
          kind: 'entity',
          query: { cui },
          summary: `No PNRR entity for CUI ${cui}.`,
        };
      }
      const name = entity.name ?? cui;
      const pay = profile.payments;
      const summary =
        `${name} (${cui}): ${n(pay.count)} payment(s)` +
        (pay.totalLei !== null ? ` = ${pay.totalLei} lei net` : '') +
        (pay.reversalLei !== null && !new Decimal(pay.reversalLei).isZero()
          ? ` (gross ${pay.grossLei ?? '0'} − reversals ${pay.reversalLei})`
          : '') +
        (pay.totalEur !== null ? ` / ${pay.totalEur} eur` : '') +
        `; ${n(profile.commitments.count)} commitment(s)` +
        (profile.commitments.unresolvedCount > 0
          ? ` (${n(profile.commitments.unresolvedCount)} without summable value)`
          : '') +
        `; won ${n(profile.procurement.wonAsContractor)} contract(s). ${PNRR_GRAIN_NOTE}`;
      return {
        ok: true,
        kind: 'entity',
        query: { cui },
        link: entityLink(cui),
        item: { entity, profile },
        summary,
      };
    },
  };

  const rankContractors: KernelMcpTool = {
    name: 'rank_pnrr_contractors',
    description:
      'Rank PNRR contractors by total awarded value or award count, from source procurement facts. Self-award acquisitions are excluded. Optionally filter by role/CUI/acquisition.',
    inputShape: {
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A PnrrContractors filter object (e.g. { role: { eq: "winning_bidder" } }).'),
      by: z.enum(['value', 'awards']).optional().describe('Ranking basis (default value).'),
      limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 20).'),
    },
    async handler(args): Promise<McpToolOutput> {
      const byRaw = strArg(args, 'by');
      const by: PnrrContractorRankBy = byRaw === 'awards' ? 'awards' : 'value';
      const res = await rankPnrrContractors(repo, filterArg(args), by, intArg(args, 'limit', 20));
      if (res.isErr()) return errorOut('ranking', res.error.message);
      const top = res.value[0];
      return {
        ok: true,
        kind: 'ranking',
        query: { by, filter: filterArg(args) },
        link: `${clientBaseUrl}/pnrr/contractori`,
        items: res.value,
        summary:
          `Top ${n(res.value.length)} PNRR contractors by ${by} (self-awards excluded)` +
          (top !== undefined
            ? `; #1 ${top.contractorName ?? top.contractorCui ?? 'n/a'} (${n(top.awardCount)} award(s)).`
            : '.'),
      };
    },
  };

  const aggregatePayments: KernelMcpTool = {
    name: 'aggregate_pnrr_payments',
    description:
      'Aggregate PNRR cash payments grouped by component, measure, county, or year. Needs a bounded window (paymentDate/year) or a driving predicate (beneficiaryCui/componentCode/measureFenix).',
    inputShape: {
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A PnrrPayments filter object.'),
      groupBy: z.enum(['component', 'measure', 'county', 'year']).describe('Grouping dimension.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const groupBy = strArg(args, 'groupBy') as PnrrPaymentGroupBy;
      const res = await aggregatePnrrPayments(repo, filterArg(args), groupBy);
      if (res.isErr()) return errorOut('aggregate', res.error.message);
      const top = res.value[0];
      return {
        ok: true,
        kind: 'aggregate',
        query: { groupBy, filter: filterArg(args) },
        link: `${clientBaseUrl}/pnrr/plati`,
        items: res.value,
        summary:
          `PNRR payments grouped by ${groupBy}: ${n(res.value.length)} group(s)` +
          (top !== undefined
            ? `; top ${top.label ?? top.key} = ${top.totalLei ?? '0'} lei (cash; not commitments).`
            : '.'),
      };
    },
  };

  return [resolveFilters, getEntity, rankContractors, aggregatePayments];
};
