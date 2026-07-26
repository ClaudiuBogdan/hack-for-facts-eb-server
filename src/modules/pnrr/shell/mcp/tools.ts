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
  type PnrrAnalysisScope,
} from '../../core/types.js';
import {
  aggregatePnrrPayments,
  getPnrrEntity,
  getPnrrEntityProfile,
  getPnrrCapabilities,
  getPnrrCurrentRelease,
  getPnrrOverview,
  getPnrrPlaceProfile,
  getPnrrProject,
  getPnrrProjectFacets,
  getPnrrProjectHistory,
  getPnrrVerification,
  listPnrrPlaces,
  listPnrrProjects,
  listPnrrFundingApplicationListings,
  listPnrrFundingCalls,
  listPnrrCatalogResources,
  listPnrrDocumentReferences,
  listPnrrProgramRevisions,
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
  const entityLink = (cui: string): string =>
    `${clientBaseUrl}/pnrr/organizatii/${encodeURIComponent(cui)}`;
  const scope = (
    grain: PnrrAnalysisScope['grain'],
    measure: PnrrAnalysisScope['measure']
  ): PnrrAnalysisScope => ({
    grain,
    measure,
    componentCode: null,
    beneficiaryCui: null,
    countySiruta: null,
    from: null,
    to: null,
    timeRole: 'snapshot_date',
    geographyRole: 'implementation_county',
    currency: null,
    resolutionPolicyVersion: 'pnrr-resolution-v1',
  });
  const currentRelease = async (
    expected?: string
  ): Promise<{ releaseId: string } | McpToolOutput> => {
    const release = await getPnrrCurrentRelease(repo);
    if (release.isErr()) return errorOut('pnrr_release', release.error.message);
    if (release.value.state === 'abstained') {
      return errorOut('pnrr_release', 'PNRR_UNAVAILABLE: no validated serving release');
    }
    if (expected !== undefined && expected !== '' && release.value.releaseId !== expected) {
      return errorOut(
        'pnrr_release',
        `RELEASE_MISMATCH: expected ${expected}, current ${release.value.releaseId}`
      );
    }
    return { releaseId: release.value.releaseId };
  };
  const legacyRelease = async (
    expected?: string
  ): Promise<{ releaseId: string | null } | McpToolOutput> => {
    if (expected === undefined || expected === '') return { releaseId: null };
    return currentRelease(expected);
  };
  const legacyReleaseAfter = async (releaseId: string | null): Promise<McpToolOutput | null> => {
    if (releaseId === null) return null;
    const result = await currentRelease(releaseId);
    return 'ok' in result ? result : null;
  };

  const getStatus: KernelMcpTool = {
    name: 'get_pnrr_status',
    description:
      'Get the current PNRR operational release and source-lane capabilities, including degraded and abstained states.',
    inputShape: {},
    async handler(): Promise<McpToolOutput> {
      const release = await getPnrrCurrentRelease(repo);
      if (release.isErr()) return errorOut('pnrr_status', release.error.message);
      const capabilities = await getPnrrCapabilities(repo);
      if (capabilities.isErr()) return errorOut('pnrr_status', capabilities.error.message);
      const releaseAfter = await getPnrrCurrentRelease(repo);
      if (releaseAfter.isErr()) return errorOut('pnrr_status', releaseAfter.error.message);
      if (
        releaseAfter.value.releaseId !== release.value.releaseId ||
        capabilities.value.some((capability) => capability.releaseId !== release.value.releaseId)
      ) {
        return errorOut(
          'pnrr_status',
          'RELEASE_MISMATCH: the PNRR release changed while reading capabilities'
        );
      }
      return {
        ok: true,
        kind: 'pnrr_status',
        item: { release: release.value, capabilities: capabilities.value },
        summary: `PNRR release ${release.value.releaseId} is ${release.value.state}; capability limitations are explicit per lane.`,
      };
    },
  };

  const getOverview: KernelMcpTool = {
    name: 'get_pnrr_overview',
    description:
      'Get source-separated PNRR program indicators, beneficiary payments, commitments, delivery coverage and caveats. Different grains and currencies are never combined.',
    inputShape: {
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await currentRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const result = await getPnrrOverview(repo, scope('program', 'amount'));
      if (result.isErr()) return errorOut('pnrr_overview', result.error.message);
      const releaseAfter = await currentRelease(release.releaseId);
      if ('ok' in releaseAfter) return releaseAfter;
      return {
        ok: true,
        kind: 'pnrr_overview',
        item: result.value,
        link: `${clientBaseUrl}/pnrr`,
        summary:
          'PNRR overview returned as separate program, payment, commitment and delivery sections; no cross-grain total was computed.',
      };
    },
  };

  const getProject: KernelMcpTool = {
    name: 'get_pnrr_project',
    description:
      'Get one current public MIPE project-progress observation. The key is release-scoped until project_key_v1 membership is persisted.',
    inputShape: {
      key: z.string().min(1).max(512).describe('Current MIPE observation key.'),
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const expected = strArg(args, 'assertReleaseId');
      const release = await currentRelease(expected);
      if ('ok' in release) return release;
      const key = strArg(args, 'key');
      const result = await getPnrrProject(repo, key);
      if (result.isErr()) return errorOut('project', result.error.message);
      const after = await currentRelease(release.releaseId);
      if ('ok' in after) return after;
      return {
        ok: true,
        kind: 'project',
        query: { key },
        link: `${clientBaseUrl}/pnrr/proiecte/${encodeURIComponent(key)}`,
        ...(result.value === null ? {} : { item: result.value }),
        summary:
          result.value === null
            ? `No current PNRR project record for ${key}.`
            : `Current MIPE project observation ${key}; project identity remains release-scoped until project_key_v1 is persisted.`,
      };
    },
  };

  const listProjects: KernelMcpTool = {
    name: 'list_pnrr_projects',
    description:
      'List current public MIPE project-progress observations with stable release-bound cursor pagination.',
    inputShape: {
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A PnrrProjects filter object.'),
      first: z.number().int().min(1).max(100).optional().describe('Page size (default 20).'),
      after: z.string().optional().describe('Opaque release-bound cursor.'),
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await currentRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const after = strArg(args, 'after');
      const result = await listPnrrProjects(
        repo,
        filterArg(args),
        {
          first: intArg(args, 'first', 20),
          ...(after !== '' && { after }),
        },
        release.releaseId
      );
      if (result.isErr()) return errorOut('projects', result.error.message);
      const releaseAfter = await currentRelease(release.releaseId);
      if ('ok' in releaseAfter) return releaseAfter;
      return {
        ok: true,
        kind: 'projects',
        query: { filter: filterArg(args), releaseId: release.releaseId },
        items: result.value.items,
        item: { next: result.value.next, releaseId: release.releaseId },
        link: `${clientBaseUrl}/pnrr/proiecte`,
        summary: `${n(result.value.items.length)} MIPE project observation(s); keys and cursor are bound to release ${release.releaseId}.`,
      };
    },
  };

  const getProjectFacets: KernelMcpTool = {
    name: 'get_pnrr_project_facets',
    description:
      'Get exact component, measure, status and county counts for the same filtered PNRR project slice used by the project list.',
    inputShape: {
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('The same PnrrProjects filter object used by list_pnrr_projects.'),
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await currentRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const result = await getPnrrProjectFacets(repo, filterArg(args));
      if (result.isErr()) return errorOut('project_facets', result.error.message);
      const releaseAfter = await currentRelease(release.releaseId);
      if ('ok' in releaseAfter) return releaseAfter;
      return {
        ok: true,
        kind: 'project_facets',
        query: { filter: filterArg(args), releaseId: release.releaseId },
        item: result.value,
        link: `${clientBaseUrl}/pnrr/proiecte`,
        summary: `${n(result.value.totalCount)} project observation(s) in the filtered slice; facet counts use the identical server-owned filter kernel.`,
      };
    },
  };

  const getProjectHistory: KernelMcpTool = {
    name: 'get_pnrr_project_history',
    description:
      'Get collision-safe source observations for one current MIPE project key. Membership requires endpoint, item, beneficiary and commitment identity agreement.',
    inputShape: {
      key: z.string().min(1).max(512),
      assertReleaseId: z.string().optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await currentRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const key = strArg(args, 'key');
      const result = await getPnrrProjectHistory(repo, key);
      if (result.isErr()) return errorOut('project_history', result.error.message);
      const releaseAfter = await currentRelease(release.releaseId);
      if ('ok' in releaseAfter) return releaseAfter;
      return {
        ok: true,
        kind: 'project_history',
        query: { key, releaseId: release.releaseId },
        items: result.value,
        link: `${clientBaseUrl}/pnrr/proiecte/${encodeURIComponent(key)}`,
        summary: `${n(result.value.length)} collision-safe source observation(s) for ${key}.`,
      };
    },
  };

  const listSourceRecords: KernelMcpTool = {
    name: 'list_pnrr_source_records',
    description:
      'List one release-bound PNRR source collection: calls, applications, program revisions, catalog resources, or document metadata. Document content and OCR claims are not exposed.',
    inputShape: {
      source: z.enum([
        'calls',
        'applications',
        'program_revisions',
        'catalog_resources',
        'documents',
      ]),
      first: z.number().int().min(1).max(100).optional(),
      after: z.string().optional().describe('Opaque release-bound cursor.'),
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await currentRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const source = strArg(args, 'source');
      const after = strArg(args, 'after');
      const page = {
        first: intArg(args, 'first', 20),
        ...(after !== '' && { after }),
      };
      const result =
        source === 'calls'
          ? await listPnrrFundingCalls(repo, page, release.releaseId)
          : source === 'applications'
            ? await listPnrrFundingApplicationListings(repo, page, release.releaseId)
            : source === 'program_revisions'
              ? await listPnrrProgramRevisions(repo, page, release.releaseId)
              : source === 'catalog_resources'
                ? await listPnrrCatalogResources(repo, page, release.releaseId)
                : await listPnrrDocumentReferences(repo, page, release.releaseId);
      if (result.isErr()) return errorOut('pnrr_source_records', result.error.message);
      const releaseAfter = await currentRelease(release.releaseId);
      if ('ok' in releaseAfter) return releaseAfter;
      return {
        ok: true,
        kind: 'pnrr_source_records',
        query: { source, releaseId: release.releaseId },
        items: result.value.items,
        item: { next: result.value.next, releaseId: release.releaseId },
        link: `${clientBaseUrl}/pnrr/surse`,
        summary: `${n(result.value.items.length)} ${source} record(s); collection and cursor are bound to release ${release.releaseId}.`,
      };
    },
  };

  const listCounties: KernelMcpTool = {
    name: 'list_pnrr_counties',
    description:
      'List canonical Romanian counties with source-role-separated PNRR payment, commitment and MIPE observation counts.',
    inputShape: {
      assertReleaseId: z.string().optional(),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await currentRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const result = await listPnrrPlaces(repo, scope('place', 'amount'));
      if (result.isErr()) return errorOut('counties', result.error.message);
      const releaseAfter = await currentRelease(release.releaseId);
      if ('ok' in releaseAfter) return releaseAfter;
      return {
        ok: true,
        kind: 'counties',
        items: result.value,
        link: `${clientBaseUrl}/pnrr/judete`,
        summary: `${n(result.value.length)} canonical counties with source-role-separated PNRR facts.`,
      };
    },
  };

  const getCounty: KernelMcpTool = {
    name: 'get_pnrr_county',
    description:
      'Get source-role-qualified PNRR payment and commitment facts for one county SIRUTA. Source locality labels are count-only and are not resolved UATs.',
    inputShape: {
      countySiruta: z
        .string()
        .regex(/^[0-9]+$/)
        .describe('County SIRUTA code.'),
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await currentRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const countySiruta = strArg(args, 'countySiruta');
      const result = await getPnrrPlaceProfile(repo, countySiruta, {
        ...scope('place', 'amount'),
        countySiruta,
      });
      if (result.isErr()) return errorOut('county', result.error.message);
      const releaseAfter = await currentRelease(release.releaseId);
      if ('ok' in releaseAfter) return releaseAfter;
      return {
        ok: true,
        kind: 'county',
        query: { countySiruta },
        item: result.value,
        link: `${clientBaseUrl}/pnrr/judete/${countySiruta}`,
        summary: `PNRR county ${countySiruta}: source-role-qualified facts; source locality labels are count-only and not treated as resolved UATs.`,
      };
    },
  };

  const getVerification: KernelMcpTool = {
    name: 'list_pnrr_verification_signals',
    description:
      'Get deterministic PNRR quality and coverage signal counts. Signals are not adjudicated findings.',
    inputShape: {
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await currentRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const result = await getPnrrVerification(repo, scope('verification', 'count'));
      if (result.isErr()) return errorOut('verification', result.error.message);
      const releaseAfter = await currentRelease(release.releaseId);
      if ('ok' in releaseAfter) return releaseAfter;
      return {
        ok: true,
        kind: 'verification',
        item: result.value,
        link: `${clientBaseUrl}/pnrr/verificare`,
        summary: 'Deterministic PNRR quality signal counts; no review verdict is implied.',
      };
    },
  };

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
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await legacyRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const dim = strArg(args, 'dim') as PnrrResolveDim;
      if (!PNRR_RESOLVE_DIMS.includes(dim)) return errorOut('resolve', `unknown dim '${dim}'`);
      const q = strArg(args, 'q');
      const res = await resolvePnrrFilters(repo, dim, q, intArg(args, 'limit', 10));
      if (res.isErr()) return errorOut('resolve', res.error.message);
      const releaseAfter = await legacyReleaseAfter(release.releaseId);
      if (releaseAfter !== null) return releaseAfter;
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
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await legacyRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const cui = strArg(args, 'cui');
      const [entityRes, profileRes] = await Promise.all([
        getPnrrEntity(repo, cui),
        getPnrrEntityProfile(repo, cui),
      ]);
      if (entityRes.isErr()) return errorOut('entity', entityRes.error.message);
      if (profileRes.isErr()) return errorOut('entity', profileRes.error.message);
      const releaseAfter = await legacyReleaseAfter(release.releaseId);
      if (releaseAfter !== null) return releaseAfter;
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
        `; ${n(profile.procurement.participantRelationCount)} procurement participant relation(s) (winning-role policy unresolved). ${PNRR_GRAIN_NOTE}`;
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
      'Rank PNRR contractors by participant-row count. Procurement amounts remain unavailable until allocation is resolved. Self-award acquisitions are excluded.',
    inputShape: {
      filter: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A PnrrContractors filter object (e.g. { role: { eq: "winning_bidder" } }).'),
      by: z
        .enum(['value', 'awards', 'relationships'])
        .optional()
        .describe(
          'Ranking basis. Value is retained for compatibility but money remains unavailable.'
        ),
      limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 20).'),
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await legacyRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const byRaw = strArg(args, 'by');
      const by: PnrrContractorRankBy =
        byRaw === 'value' || byRaw === 'awards' ? byRaw : 'relationships';
      const res = await rankPnrrContractors(repo, filterArg(args), by, intArg(args, 'limit', 20));
      if (res.isErr()) return errorOut('ranking', res.error.message);
      const releaseAfter = await legacyReleaseAfter(release.releaseId);
      if (releaseAfter !== null) return releaseAfter;
      const top = res.value[0];
      return {
        ok: true,
        kind: 'ranking',
        query: { by, filter: filterArg(args) },
        link: `${clientBaseUrl}/pnrr/contractori`,
        items: res.value,
        summary:
          `Top ${n(res.value.length)} PNRR organizations by participant-relation count (self-relations excluded; winning-role policy and money unavailable)` +
          (top !== undefined
            ? `; #1 ${top.contractorName ?? top.contractorCui ?? 'n/a'} (${n(top.participantRelationCount)} relation(s)).`
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
      assertReleaseId: z.string().optional().describe('Optimistic consistency token.'),
    },
    async handler(args): Promise<McpToolOutput> {
      const release = await legacyRelease(strArg(args, 'assertReleaseId'));
      if ('ok' in release) return release;
      const groupBy = strArg(args, 'groupBy') as PnrrPaymentGroupBy;
      const res = await aggregatePnrrPayments(repo, filterArg(args), groupBy);
      if (res.isErr()) return errorOut('aggregate', res.error.message);
      const releaseAfter = await legacyReleaseAfter(release.releaseId);
      if (releaseAfter !== null) return releaseAfter;
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

  return [
    getStatus,
    getOverview,
    listProjects,
    getProjectFacets,
    getProject,
    getProjectHistory,
    listSourceRecords,
    listCounties,
    getCounty,
    getVerification,
    resolveFilters,
    getEntity,
    rankContractors,
    aggregatePayments,
  ];
};
