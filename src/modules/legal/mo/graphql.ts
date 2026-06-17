/**
 * Monitorul-Oficial (`mo/` area, plan 06) — GraphQL SDL + resolvers (§6). MO
 * EXTENDS the portal-owned `legal` slice: it adds `Mo*` types, `extend type Query`,
 * `extend type LegalAct { gazette* }` (the reconciled 3-field gazette set), and
 * `extend type Entity { monitorul }`. It NEVER redeclares `LegalAct`/`Entity` — only
 * references + extends them. All these defs are STITCHED INSIDE `makeLegalModule`
 * before the single `legal` slice is contributed, so the kernel conflict gate sees
 * one slice (same-slice extends are not cross-slice field collisions).
 *
 * Enum value-translation (§6.1): OUTPUT object enum fields with hyphenated DB
 * values are aliased via graphql-tools enum resolver maps (internal DB value →
 * enum NAME). Filter inputs carry raw DB strings (kernel emits enum filters as
 * `String`), so no input-side translation (preserves fhash; Codex #6).
 *
 * DataLoaders (§6, prevent N+1 on the LegalAct/Entity fan-out): by act_id for
 * gazette publications/status-events/in-edges; an act loader (over the 05 base's
 * `findActsByIds`) for `act`/`targetAct`/`sourceAct`; an issue loader by
 * mo_issue_id for `MoActPublication.issue`.
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  fhashFor,
  makeBatchLoader,
  toGraphQLInput,
  type ApiError,
  type ContributorRegistry,
  type CursorPage,
  type EntityProfileSlice,
  type FilterInput,
} from '@/modules/shared/index.js';

import { moEdgesSpec, moIssuesSpec, moPublicationsSpec } from './filters.js';
import { MO_EDGE_RESOLUTION_GQL, MO_MATCHED_VIA_GQL, MO_STATUS_KIND_GQL } from './mappers.js';
import {
  browseIssues,
  getIssueContents,
  issuerYearBreakdown,
  listEdges,
  listPublications,
  type MoCoverageDeps,
} from './usecases.js';

import type { MonitorulRepo, MoAggGroupBy } from './ports.js';
import type {
  MoActPublication,
  MoIssue,
  MoIssuerSummary,
  MoLifecycleEdge,
  MoStatusEvent,
} from './types.js';
import type { LegalRepoBase } from '../core/repo-base.js';
import type { LegalAct } from '../core/types.js';
import type { Result } from 'neverthrow';

export interface MonitorulGraphqlDeps {
  readonly repo: MonitorulRepo;
  readonly base: LegalRepoBase;
  readonly coverage: MoCoverageDeps;
  readonly registry: ContributorRegistry;
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, { extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type } });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

// ── SDL ──────────────────────────────────────────────────────────────────────

const moObjectsAndQuery = /* GraphQL */ `
  enum MoPartCode { PI PII PIM PIII PIV PV PVI PVII }
  enum MoResolution { unique ambiguous unmatched }
  "Edge resolution. 'mo_only' ↔ DB 'mo-only' (value-translated)."
  enum MoEdgeResolution { unique mo_only ambiguous unresolved }
  enum MoRelation { promulga aproba respinge rectifica republica }
  "MO status kind. 'aprobare_oug'/'aprobare_og' ↔ DB hyphenated values."
  enum MoStatusKind { promulgare aprobare_oug aprobare_og rectificare republicare }
  "'act_year'/'issue_year' ↔ DB 'act-year'/'issue-year'."
  enum MoMatchedVia { act_year issue_year }
  enum MoIssueSort { ISSUE_DATE_DESC ISSUE_DATE_ASC ISSUE_YEAR_DESC }
  enum MoPublicationSort { ACT_YEAR_DESC ACT_YEAR_ASC }
  enum MoAggGroupBy { issuer act_type year }

  "A gazette issue (one Monitorul Oficial issue). Storage internals (s3/sha256) excluded."
  type MoIssue {
    moIssueId: BigInt!
    partCode: MoPartCode!
    moPart: Int
    issueLabel: String!
    issueNumber: Int
    issueSuffix: String!
    issueYear: Int!
    issueDate: Date
    pdfUrl: String
    hasArchiveIndex: Boolean!
    hasEmonitorLink: Boolean!
    pdfBytes: BigInt
    firstSeenAt: DateTime!
    lastSeenAt: DateTime!
    "The issue's table of contents (publications in this issue; scoped to this issue)."
    contents(first: Int = 20, after: String): MoActPublicationConnection!
  }

  "A publication event (one act published in one gazette issue). act_id null when unresolved."
  type MoActPublication {
    moActKey: ID!
    moIssueId: BigInt
    issue: MoIssue
    actType: String
    actNumberNorm: String
    actYear: Int
    issueYear: Int
    issuerSlug: String
    title: String
    actDate: Date
    actId: BigInt
    "The resolved legal act (DataLoader by act_id; null when link-not-merge unresolved)."
    act: LegalAct
    resolution: MoResolution!
    matchedVia: MoMatchedVia
    sourcePdfUrl: String
    firstSeenAt: DateTime!
    lastSeenAt: DateTime!
  }

  "A lifecycle relation grounded in MO (promulgare/aprobare/respinge/rectificare/republicare)."
  type MoLifecycleEdge {
    edgeId: BigInt!
    sourceMoActKey: ID!
    source: MoActPublication
    relation: MoRelation!
    targetRaw: String!
    targetIndex: Int!
    targetActType: String
    targetActNumber: String
    targetActYear: Int
    targetIssuerSlug: String!
    targetActId: BigInt
    targetAct: LegalAct
    targetMoActKey: ID
    resolution: MoEdgeResolution!
    matchedVia: MoMatchedVia
    method: String!
    confidence: Float
  }

  "An MO-grounded status event (the act_status_events MO slice). respinge is edge-only (never here)."
  type MoStatusEvent {
    eventId: BigInt!
    actId: BigInt!
    eventKind: MoStatusKind!
    effectiveDate: Date
    sourceActId: BigInt
    sourceAct: LegalAct
    eventSource: String!
  }

  type MoIssuerYearCount { issuerSlug: String  actType: String  year: Int  count: Int! }
  type MoPartCount { partCode: MoPartCode!  count: Int! }
  type MoResolutionRates { unique: Int!  ambiguous: Int!  unmatched: Int! }
  "Per-collection coverage honesty (catalog Core Rule). resolutionRates is publication-only."
  type MoCoverage { yearMin: Int  yearMax: Int  gaps: [String!]!  resolutionRates: MoResolutionRates }

  "Issuer-keyed entity summary (best-effort; MO has no CUI — matchConfidence labels it)."
  type MoEntitySummary {
    issuerSlug: String
    publicationCount: Int!
    byPartCode: [MoPartCount!]!
    lastIssueDate: Date
    topActTypes: [String!]!
    matchConfidence: Float!
  }

  "The where-published answer (MO-4): publications + coverage."
  type MoPublicationEvents { publications: [MoActPublication!]!  coverage: MoCoverage! }
  "The act-lifecycle answer (MO-3/LG-2 MO slice): status events + in-edges + coverage."
  type MoActLifecycle { statusEvents: [MoStatusEvent!]!  inEdges: [MoLifecycleEdge!]!  coverage: MoCoverage! }
  "MO-1 aggregate: grouped counts + denominator + coverage."
  type MoIssuerBreakdown { items: [MoIssuerYearCount!]!  denominator: Int!  coverage: MoCoverage! }

  type MoIssueConnection { edges: [MoIssueEdge!]!  pageInfo: PageInfo!  total: Int }
  type MoIssueEdge { node: MoIssue!  cursor: String! }
  type MoActPublicationConnection { edges: [MoActPublicationEdge!]!  pageInfo: PageInfo! }
  type MoActPublicationEdge { node: MoActPublication!  cursor: String! }
  type MoLifecycleEdgeConnection { edges: [MoLifecycleEdgeEdge!]!  pageInfo: PageInfo! }
  type MoLifecycleEdgeEdge { node: MoLifecycleEdge!  cursor: String! }

  "A name→value discovery hit (issuer/part/act-type)."
  type MoResolveHit { kind: String!  value: String!  label: String!  count: Int }

  input MoPublicationAggFilter {
    year: Int!
    issuerSlug: String
    actType: [String!]
    groupBy: MoAggGroupBy = issuer
  }

  extend type Query {
    "A gazette issue by id."
    moIssue(moIssueId: BigInt!): MoIssue
    "Browse gazette issues. Requires a year filter (bounds the scan); offset-paged."
    moIssues(filter: MoIssuesFilter, page: Int = 1, pageSize: Int = 20, sort: MoIssueSort = ISSUE_DATE_DESC): MoIssueConnection!
    "A publication event by its content key."
    moPublication(moActKey: ID!): MoActPublication
    "List publication events. Requires ≥1 bounding predicate (actYear/issuerSlug/actId/moIssueId)."
    moPublications(filter: MoPublicationsFilter!, first: Int = 20, after: String, sort: MoPublicationSort = ACT_YEAR_DESC): MoActPublicationConnection!
    "List lifecycle edges (bounded by relation and/or targetActId)."
    moEdges(filter: MoEdgesFilter!, first: Int = 20, after: String): MoLifecycleEdgeConnection!
    "MO-1: grouped publication counts for a year."
    moPublicationsByIssuerYear(filter: MoPublicationAggFilter!): MoIssuerBreakdown!
    "Resolve a free-text issuer/act-type label to a filter value."
    moResolve(dim: String!, q: String!, limit: Int = 10): [MoResolveHit!]!
  }

  # MO consumer side of the act↔gazette correlation (joined via mo_act_publications.act_id).
  extend type LegalAct {
    "Every place this act was published in the gazette (DataLoader by act_id)."
    gazettePublications: [MoActPublication!]!
    "MO-grounded status events for this act (event_source='monitorul-oficial')."
    gazetteStatusEvents: [MoStatusEvent!]!
    "MO lifecycle edges TARGETING this act (DataLoader by target_act_id)."
    gazetteInEdges: [MoLifecycleEdge!]!
  }

  extend type Entity {
    "Issuer-keyed Monitorul Oficial summary (best-effort; via the cross-source contributor)."
    monitorul: MoEntitySummary
  }
`;

const moFilterInputs = [
  toGraphQLInput(moIssuesSpec),
  toGraphQLInput(moPublicationsSpec),
  toGraphQLInput(moEdgesSpec),
].join('\n\n');

export const monitorulTypeDefs = `${moObjectsAndQuery}\n\n${moFilterInputs}`;

// ── resolvers ──────────────────────────────────────────────────────────────────

const ISSUE_SORT_FROM_GQL: Record<string, string> = {
  ISSUE_DATE_DESC: 'issue_date_desc',
  ISSUE_DATE_ASC: 'issue_date_asc',
  ISSUE_YEAR_DESC: 'issue_year_desc',
};
const PUB_SORT_FROM_GQL: Record<string, string> = {
  ACT_YEAR_DESC: 'act_year_desc',
  ACT_YEAR_ASC: 'act_year_asc',
};

/** Offset connection: `hasNextPage` derived from page/pageSize/total (Codex #4). */
const issueConnection = (
  page: { items: readonly MoIssue[]; total: number },
  pageNum: number,
  pageSize: number
): unknown => ({
  edges: page.items.map((node) => ({ node, cursor: node.moIssueId })),
  pageInfo: { hasNextPage: pageNum * pageSize < page.total, endCursor: null },
  total: page.total,
});

/**
 * Cursor connection: each edge's `cursor` is a PER-NODE keyset cursor (Codex #3 —
 * was the page-level next on every edge). `endCursor` is the page's `next`.
 */
const cursorConnection = <T>(
  page: CursorPage<T>,
  spec: Parameters<typeof fhashFor>[0],
  filter: FilterInput,
  sort: string,
  dir: 'asc' | 'desc',
  keysOf: (node: T) => readonly (string | number | null)[]
): unknown => {
  const fhash = fhashFor(spec, filter);
  return {
    edges: page.items.map((node) => ({
      node,
      cursor: buildNextCursor({ sort, dir, fhash, lastKeys: keysOf(node) }),
    })),
    pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
  };
};

export const makeMonitorulResolvers = (deps: MonitorulGraphqlDeps): Record<string, unknown> => {
  const { repo, base, coverage, registry } = deps;

  // act loader over the 05 base (tolerates dangling/null → null). MO's OWN instance.
  const actLoader = makeBatchLoader<LegalAct | null>(async (ids) => {
    const res = await base.findActsByIds(ids);
    if (res.isErr()) throw toGraphqlError(res.error);
    return new Map(res.value.map((a) => [a.actId, a]));
  }, null);

  const issueLoader = makeBatchLoader<MoIssue | null>(async (ids) => {
    const map = new Map<string, MoIssue>();
    // mo_issue_id point lookups; small fan-out — batch via individual gets is fine,
    // but prefer one query: reuse getIssueById per id is N — instead use a set fetch.
    await Promise.all(
      ids.map(async (id) => {
        const r = await repo.getIssueById(id);
        if (r.isOk() && r.value !== null) map.set(id, r.value);
      })
    );
    return map;
  }, null);

  // LegalAct.gazette* loaders (batch by act_id → Map<actId, T[]>).
  const pubsByActLoader = makeBatchLoader<readonly MoActPublication[]>(async (ids) => {
    const res = await repo.getPublicationsForActs(ids);
    if (res.isErr()) throw toGraphqlError(res.error);
    return res.value;
  }, []);
  const statusByActLoader = makeBatchLoader<readonly MoStatusEvent[]>(async (ids) => {
    const res = await repo.getStatusEventsForActs(ids);
    if (res.isErr()) throw toGraphqlError(res.error);
    return res.value;
  }, []);
  const inEdgesByActLoader = makeBatchLoader<readonly MoLifecycleEdge[]>(async (ids) => {
    const res = await repo.getEdgesForTargetActs(ids);
    if (res.isErr()) throw toGraphqlError(res.error);
    return res.value;
  }, []);

  return {
    // Output enum value-translation (graphql-tools: enum NAME → internal DB value).
    MoEdgeResolution: MO_EDGE_RESOLUTION_GQL,
    MoStatusKind: MO_STATUS_KIND_GQL,
    MoMatchedVia: MO_MATCHED_VIA_GQL,

    Query: {
      moIssue: async (_r: unknown, args: { moIssueId: string }) =>
        unwrap(await repo.getIssueById(args.moIssueId)),
      moIssues: async (
        _r: unknown,
        args: { filter?: FilterInput; page?: number; pageSize?: number; sort?: string }
      ) => {
        const filter = args.filter ?? {};
        const sort = ISSUE_SORT_FROM_GQL[args.sort ?? 'ISSUE_DATE_DESC'] ?? 'issue_date_desc';
        const pageNum = args.page ?? 1;
        const pageSize = args.pageSize ?? 20;
        const page = unwrap(await browseIssues(repo, coverage, filter, { page: pageNum, pageSize }, sort));
        return issueConnection(page, pageNum, pageSize);
      },
      moPublication: async (_r: unknown, args: { moActKey: string }) =>
        unwrap(await repo.getPublicationByKey(args.moActKey)),
      moPublications: async (
        _r: unknown,
        args: { filter?: FilterInput; first?: number; after?: string; sort?: string }
      ) => {
        const filter = args.filter ?? {};
        const sort = PUB_SORT_FROM_GQL[args.sort ?? 'ACT_YEAR_DESC'] ?? 'act_year_desc';
        const dir = sort === 'act_year_asc' ? 'asc' : 'desc';
        const page = unwrap(
          await listPublications(repo, filter, { first: args.first ?? 20, ...(args.after !== undefined && { after: args.after }) }, sort)
        );
        return cursorConnection(page, moPublicationsSpec, filter, sort, dir, (n) => [
          n.actYear === null ? '' : String(n.actYear),
          n.moActKey,
        ]);
      },
      moEdges: async (_r: unknown, args: { filter?: FilterInput; first?: number; after?: string }) => {
        const filter = args.filter ?? {};
        const page = unwrap(
          await listEdges(repo, filter, { first: args.first ?? 20, ...(args.after !== undefined && { after: args.after }) })
        );
        return cursorConnection(page, moEdgesSpec, filter, 'edge_id', 'asc', (n) => [n.edgeId]);
      },
      moPublicationsByIssuerYear: async (
        _r: unknown,
        args: { filter: { year: number; issuerSlug?: string; actType?: string[]; groupBy?: string } }
      ) => {
        const f = args.filter;
        return unwrap(
          await issuerYearBreakdown(repo, coverage, {
            year: f.year,
            ...(f.issuerSlug !== undefined && { issuerSlug: f.issuerSlug }),
            ...(f.actType !== undefined && { actType: f.actType }),
            groupBy: (f.groupBy ?? 'issuer') as MoAggGroupBy,
          })
        );
      },
      moResolve: async (_r: unknown, args: { dim: string; q: string; limit?: number }) => {
        const limit = args.limit ?? 10;
        if (args.dim === 'mo_act_type') return unwrap(await repo.resolveActType(args.q, limit));
        // default + 'mo_issuer' → issuer resolution
        return unwrap(await repo.resolveIssuer(args.q, limit));
      },
    },

    MoIssue: {
      contents: async (parent: MoIssue, args: { first?: number; after?: string }) => {
        // SCOPED to the parent issue (ignore any client-supplied issue id; GLM #3).
        const page = unwrap(
          await getIssueContents(repo, parent.moIssueId, {
            first: args.first ?? 20,
            ...(args.after !== undefined && { after: args.after }),
          })
        );
        // Same cursor contract as the repo: sort mo_act_key asc, fhash bound to the issue.
        return cursorConnection(
          page,
          moPublicationsSpec,
          { moIssueId: { eq: parent.moIssueId } },
          'mo_act_key',
          'asc',
          (n) => [n.moActKey]
        );
      },
    },

    MoActPublication: {
      // null FK → null without a DataLoader fetch (GLM #7).
      act: async (parent: MoActPublication) =>
        parent.actId === null ? null : actLoader.load(parent.actId),
      issue: async (parent: MoActPublication) =>
        parent.moIssueId === null ? null : issueLoader.load(parent.moIssueId),
    },

    MoLifecycleEdge: {
      source: async (parent: MoLifecycleEdge) => {
        const res = await repo.getPublicationByKey(parent.sourceMoActKey);
        return unwrap(res);
      },
      targetAct: async (parent: MoLifecycleEdge) =>
        parent.targetActId === null ? null : actLoader.load(parent.targetActId),
    },

    MoStatusEvent: {
      sourceAct: async (parent: MoStatusEvent) =>
        parent.sourceActId === null ? null : actLoader.load(parent.sourceActId),
    },

    // The act↔gazette consumer extension (DataLoaders by act_id; §6/§13).
    LegalAct: {
      gazettePublications: async (parent: LegalAct) => pubsByActLoader.load(parent.actId),
      gazetteStatusEvents: async (parent: LegalAct) => statusByActLoader.load(parent.actId),
      gazetteInEdges: async (parent: LegalAct) => inEdgesByActLoader.load(parent.actId),
    },

    Entity: {
      // Contributor parity (§14.7): resolve through the registry, not a divergent path.
      monitorul: async (parent: { cui: string }): Promise<MoIssuerSummary | null> => {
        const contributor = registry.get('monitorul-oficial');
        if (contributor?.profileSlice === undefined) return null;
        const res = await contributor.profileSlice(parent.cui);
        const slice: EntityProfileSlice | null = unwrap(res);
        if (slice?.data === undefined) return null;
        return slice.data as unknown as MoIssuerSummary;
      },
    },
  };
};

// re-export cursor helpers used by tests
export { buildNextCursor, fhashFor };
