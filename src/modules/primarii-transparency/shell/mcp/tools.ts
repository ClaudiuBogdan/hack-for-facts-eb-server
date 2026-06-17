/**
 * Primarii-transparency module — MCP tools (plan §8). Each tool → the SAME usecase
 * the GraphQL resolver calls (tri-surface equivalence, §14.7); output is the kernel
 * `{ ok, kind, query?, link?, item|items?, summary? }` object. Raw/excerpt columns
 * are NEVER returned. Naming `<verb>_primarii_<noun>`.
 *
 * GRAIN GATE (§4): no tool sums `amount_ron` into a spend total; the salary amounts
 * are surfaced only as per-claim disclosure facts (not exposed by these 4 tools at
 * all — they operate on the entity/coverage grain).
 */

import {
  PRIMARII_MCP_KINDS,
  aggregatePrimariiTransparencyInput,
  getPrimariiEntityTransparencyInput,
  listPrimariiEntitiesInput,
  resolvePrimariiFiltersInput,
} from './io.js';
import {
  getCategoryCoverage,
  getEntityTransparencyProfile,
  getTransparencyStats,
  listTransparencyEntities,
  resolveFilters,
  type PrimariiDeps,
} from '../../core/usecases.js';

import type { PrimariiResolveDim, PrimariiStatGroupBy } from '../../core/types.js';
import type { FilterInput, KernelMcpTool, McpToolOutput } from '@/modules/shared/index.js';

export interface PrimariiMcpDeps extends PrimariiDeps {
  readonly clientBaseUrl: string;
}

const strArg = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  return typeof v === 'string' ? v : '';
};
const intArg = (args: Record<string, unknown>, key: string, dflt: number): number => {
  const v = args[key];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.floor(n) : dflt;
};
const filterArg = (args: Record<string, unknown>): FilterInput => {
  const v = args['filter'];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as FilterInput) : {};
};
const errorOut = (kind: string, message: string): McpToolOutput => ({ ok: false, kind, error: message });
const n = (x: number): string => String(x);

const RESOLVE_DIMS = new Set(['entity', 'county', 'status', 'siruta']);
const STAT_GROUP_BYS = new Set(['county', 'region', 'data_quality_status', 'result_status', 'entity_type']);

export const makePrimariiMcpTools = (deps: PrimariiMcpDeps): readonly KernelMcpTool[] => {
  const { clientBaseUrl } = deps;
  const entityLink = (cui: string): string => `${clientBaseUrl}/transparency/uat/${cui}`;
  const listLink = (filter: FilterInput): string => {
    const params = new URLSearchParams();
    const dq = (filter['dataQualityStatus'] as { in?: string[] } | undefined)?.in;
    const county = (filter['county'] as { in?: string[] } | undefined)?.in;
    if (dq?.[0] !== undefined) params.set('quality', dq[0]);
    if (county?.[0] !== undefined) params.set('county', county[0]);
    const qs = params.toString();
    return `${clientBaseUrl}/transparency${qs !== '' ? `?${qs}` : ''}`;
  };

  // (1) Discovery
  const resolveFiltersTool: KernelMcpTool = {
    name: 'resolve_primarii_filters',
    description:
      'Resolve a free-text query to a filter value before querying other primarii tools: entity (institution name → CUI), county (county name normalize), status (Romanian label → enum), siruta (locality → CUI via the kernel territory hub). Use first.',
    inputShape: resolvePrimariiFiltersInput,
    async handler(args): Promise<McpToolOutput> {
      const dim = strArg(args, 'dim');
      if (!RESOLVE_DIMS.has(dim)) return errorOut(PRIMARII_MCP_KINDS.resolve, `unknown dim '${dim}'`);
      const q = strArg(args, 'q');
      const res = await resolveFilters(deps, dim as PrimariiResolveDim, q, intArg(args, 'limit', 10));
      if (res.isErr()) return errorOut(PRIMARII_MCP_KINDS.resolve, res.error.message);
      const top = res.value[0];
      return {
        ok: true,
        kind: PRIMARII_MCP_KINDS.resolve,
        query: { dim, q },
        items: res.value,
        summary:
          `Resolved «${q}» → ${n(res.value.length)} ${dim} match(es)` +
          (top !== undefined ? `; top: ${top.label} (${top.value}).` : '.'),
      };
    },
  };

  // (2) Query — entity transparency snapshot
  const getEntityTool: KernelMcpTool = {
    name: 'get_primarii_entity_transparency',
    description:
      "Get a UAT's transparency profile by CUI: data-quality + result status, which of the 3 required categories (organigrama/headcount/salaries) are published, staffing headcount, organigrama status, and evidence-document counts. Institutional QA only — no person PII, no spend.",
    inputShape: getPrimariiEntityTransparencyInput,
    async handler(args): Promise<McpToolOutput> {
      const cui = strArg(args, 'cui');
      if (cui === '') return errorOut(PRIMARII_MCP_KINDS.entity, 'cui is required');
      const res = await getEntityTransparencyProfile(deps, cui);
      if (res.isErr()) return errorOut(PRIMARII_MCP_KINDS.entity, res.error.message);
      const profile = res.value;
      if (profile === null)
        return { ok: true, kind: PRIMARII_MCP_KINDS.entity, query: { cui }, summary: 'No transparency profile for this CUI.' };
      const s = profile.status;
      const found = profile.categories.filter((c) => c.status === 'found').length;
      const docCount = profile.documentCounts.reduce((a, c) => a + c.count, 0);
      return {
        ok: true,
        kind: PRIMARII_MCP_KINDS.entity,
        query: { cui },
        link: entityLink(s.cui),
        item: profile,
        summary:
          `${s.entityName}${s.county !== null ? ` (${s.county})` : ''} — transparency ${s.dataQualityStatus}, ` +
          `result ${s.resultStatus}; publishes ${n(found)}/3 required categories ` +
          `(organigrama/headcount/salaries), ${n(docCount)} evidence documents.`,
      };
    },
  };

  // (3) Query — filtered list / coverage ranking
  const listEntitiesTool: KernelMcpTool = {
    name: 'list_primarii_entities',
    description:
      'List UATs in the transparency registry with filters (dataQualityStatus/resultStatus/entityType/county, missingCategory, publishesCategory+categoryState, hasIssues, minConfidence/minEvidenceCoverage). Returns the filtered count vs the registry denominator. Territory filters (region/siruta/isUat/population) are capability-gated.',
    inputShape: listPrimariiEntitiesInput,
    async handler(args): Promise<McpToolOutput> {
      const filter = filterArg(args);
      const sort = strArg(args, 'sort');
      const after = strArg(args, 'after');
      const res = await listTransparencyEntities(deps, filter, {
        first: intArg(args, 'limit', 20),
        ...(after !== '' && { after }),
        ...(sort !== '' && { sort }),
      });
      if (res.isErr()) return errorOut(PRIMARII_MCP_KINDS.list, res.error.message);
      const page = res.value;
      return {
        ok: true,
        kind: PRIMARII_MCP_KINDS.list,
        query: { filter, sort: sort !== '' ? sort : 'data_quality' },
        link: listLink(filter),
        items: page.items,
        summary:
          `${n(page.items.length)} UAT(s) on this page; ${n(page.totalCount)} match the filter ` +
          `(of 3,187 registered UATs).` +
          (page.next !== null ? ' More pages available.' : ''),
      };
    },
  };

  // (4) Query — aggregate / coverage dashboards
  const aggregateTool: KernelMcpTool = {
    name: 'aggregate_primarii_transparency',
    description:
      "Roll up the transparency registry. groupBy=category_coverage answers 'which UATs publish organigrame/headcount/salaries?' (per-category found/not_found/unknown/blocked + coverage ratio); the others count UATs by county/data_quality_status/result_status/entity_type. groupBy=region requires the kernel cui→territory builder (capability-gated).",
    inputShape: aggregatePrimariiTransparencyInput,
    async handler(args): Promise<McpToolOutput> {
      const groupBy = strArg(args, 'groupBy');
      const filter = filterArg(args);

      if (groupBy === 'category_coverage') {
        const res = await getCategoryCoverage(deps, filter);
        if (res.isErr()) return errorOut(PRIMARII_MCP_KINDS.aggregate, res.error.message);
        const parts = res.value.map((c) => `${c.category} ${(c.coverage * 100).toFixed(0)}%`);
        return {
          ok: true,
          kind: PRIMARII_MCP_KINDS.aggregate,
          query: { groupBy, filter },
          link: listLink(filter),
          items: res.value,
          summary: `Category coverage — ${parts.join(', ')} (share of UATs with the category 'found').`,
        };
      }

      if (!STAT_GROUP_BYS.has(groupBy)) return errorOut(PRIMARII_MCP_KINDS.aggregate, `unknown groupBy '${groupBy}'`);
      const res = await getTransparencyStats(deps, groupBy as PrimariiStatGroupBy, filter);
      if (res.isErr()) return errorOut(PRIMARII_MCP_KINDS.aggregate, res.error.message);
      const top = res.value[0];
      const caveat =
        groupBy === 'county'
          ? ' (county is denormalized text — best-effort; SIRUTA/region grouping requires the territory builder.)'
          : '';
      return {
        ok: true,
        kind: PRIMARII_MCP_KINDS.aggregate,
        query: { groupBy, filter },
        link: listLink(filter),
        items: res.value,
        summary:
          `${n(res.value.length)} ${groupBy} bucket(s)` +
          (top !== undefined ? `; largest: ${top.key} (${n(top.total)} UATs)` : '') +
          `.${caveat}`,
      };
    },
  };

  return [resolveFiltersTool, getEntityTool, listEntitiesTool, aggregateTool];
};
