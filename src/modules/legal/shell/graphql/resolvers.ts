/**
 * Legal module — GraphQL resolvers (plan §6). Thin: parse args → call the SAME
 * usecase MCP calls. `ApiError` → `GraphQLError` with `extensions.code`. Cursor
 * pages → Relay connections (per-edge cursor re-encoded, bound to the active
 * fhash). Lazy `LegalAct` fields (canonical/summary/links/timeline) resolve
 * via the repos; `targetAct`/`sourceAct` on edges resolve via a batched act loader.
 *
 * ENUM MAPPING (Codex finding #6): DB values are lowercase/hyphenated
 * (`abrogat-partial`), GraphQL enum values are UPPER_SNAKE (`ABROGAT_PARTIAL`).
 * The enum resolver maps below translate both directions so default serialization
 * does not drop a value.
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  fhashFor,
  filterHash,
  makeBatchLoader,
  type ApiError,
  type CursorPage,
  type FilterInput,
} from '@/modules/shared/index.js';

import { versionProvenanceNote } from '../../core/provenance.js';
import {
  getAct,
  getActLinksIn,
  getActLinksOut,
  getActTimeline,
  getActVersions,
  getDocumentOutline,
  getExternalAct,
  listActs,
  resolveLegalFilters,
  searchLegal,
  type LegalSearchDeps,
  type ResolveLegalFiltersDeps,
} from '../../core/usecases.js';
import { legalActsSpec } from '../filters/legal-acts.spec.js';

import type {
  LegalActsRepo,
  LegalGraphRepo,
  LegalOutlineRepo,
  LegalRenderRepo,
} from '../../core/ports.js';
import type {
  LegalAct,
  LegalActCard,
  LegalActStatus,
  LegalDocument,
  LegalRelation,
  LegalRenderInfo,
  LegalResolveDim,
  LegalSortKey,
  LegalVersionProvenance,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface LegalResolverDeps {
  readonly acts: LegalActsRepo;
  readonly graph: LegalGraphRepo;
  readonly outline: LegalOutlineRepo;
  readonly render: LegalRenderRepo;
  readonly searchDeps: LegalSearchDeps;
  readonly resolveDeps: ResolveLegalFiltersDeps;
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type },
  });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

// ── enum value maps (DB ↔ GraphQL) ───────────────────────────────────────────

const STATUS_TO_GQL: Record<LegalActStatus, string> = {
  'in-vigoare': 'IN_VIGOARE',
  modificat: 'MODIFICAT',
  abrogat: 'ABROGAT',
  'abrogat-partial': 'ABROGAT_PARTIAL',
  suspendat: 'SUSPENDAT',
  'iesit-din-vigoare': 'IESIT_DIN_VIGOARE',
  necunoscut: 'NECUNOSCUT',
};
const STATUS_FROM_GQL: Record<string, LegalActStatus> = Object.fromEntries(
  Object.entries(STATUS_TO_GQL).map(([k, v]) => [v, k as LegalActStatus])
);

const RELATION_TO_GQL: Record<LegalRelation, string> = {
  modifica: 'MODIFICA',
  abroga: 'ABROGA',
  completeaza: 'COMPLETEAZA',
  suspenda: 'SUSPENDA',
  aproba: 'APROBA',
  rectifica: 'RECTIFICA',
  'face-referire': 'FACE_REFERIRE',
  respinge: 'RESPINGE',
};
const RELATION_FROM_GQL: Record<string, LegalRelation> = Object.fromEntries(
  Object.entries(RELATION_TO_GQL).map(([k, v]) => [v, k as LegalRelation])
);

const SORT_FROM_GQL: Record<string, LegalSortKey> = {
  IN_DEGREE: 'in_degree',
  ACT_YEAR: 'act_year',
  ENTRY_INTO_FORCE: 'entry_into_force',
  DISPLAY_CITATION: 'display_citation',
};

const sortKeysOf = (act: LegalAct, sort: LegalSortKey): readonly (string | number | null)[] => {
  switch (sort) {
    case 'in_degree':
      return [act.inDegree, act.actId];
    case 'act_year':
      return [act.actYear ?? '', act.actId];
    case 'entry_into_force':
      return [act.entryIntoForce ?? '', act.actId];
    case 'display_citation':
      return [act.displayCitation, act.actId];
  }
};

export const makeLegalResolvers = (deps: LegalResolverDeps): Record<string, unknown> => {
  const { acts, graph, outline, render, searchDeps, resolveDeps } = deps;

  // Batched act loader for edge `targetAct`/`sourceAct` (tolerates dangling → null).
  // The batch fn returns a Map<id, V>; the loader fills missing keys with `null`.
  const actLoader = makeBatchLoader<LegalAct | null>(async (ids) => {
    const res = await acts.findActsByIds(ids);
    if (res.isErr()) throw toGraphqlError(res.error);
    return new Map(res.value.map((a) => [a.actId, a]));
  }, null);

  const canonicalLoader = makeBatchLoader<LegalDocument | null>(async (actIds) => {
    const res = await acts.canonicalDocumentsForActs(actIds);
    if (res.isErr()) throw toGraphqlError(res.error);
    return res.value;
  }, null);

  // §5.2-C provenance. Batched because every search hit exposes `act`, so an
  // unbatched resolver would be one statement per hit.
  const provenanceLoader = makeBatchLoader<LegalVersionProvenance | null>(async (actIds) => {
    const res = await acts.versionProvenanceForActs(actIds);
    if (res.isErr()) throw toGraphqlError(res.error);
    return res.value;
  }, null);

  // Render availability, batched: an act page lists its whole version cluster,
  // so an unbatched resolver would be one generation lookup per document.
  const renderInfoLoader = makeBatchLoader<LegalRenderInfo | null>(async (documentIds) => {
    const res = await render.renderInfoForDocuments(documentIds);
    if (res.isErr()) throw toGraphqlError(res.error);
    return res.value;
  }, null);

  /** An act with no provenance row (dangling id) still answers honestly. */
  const provenanceOrUnknown = (prov: LegalVersionProvenance | null): LegalVersionProvenance =>
    prov ?? {
      versionKind: '',
      versionDate: null,
      sourceUrl: null,
      amendedAfterPublication: 0,
      latestConsolidationDate: null,
      latestConsolidationLoaded: false,
    };

  return {
    // Enum resolvers map GQL value name → internal value (graphql-tools convention),
    // so an internal `'abrogat-partial'` serializes to `ABROGAT_PARTIAL` automatically.
    LegalActStatus: STATUS_FROM_GQL,
    LegalRelation: RELATION_FROM_GQL,

    Query: {
      legalAct: async (_r: unknown, args: { actId?: string; citation?: string }) => {
        const ref =
          args.actId !== undefined ? { actId: args.actId } : { citation: args.citation ?? '' };
        return unwrap(await getAct(acts, ref));
      },
      legalActs: async (
        _r: unknown,
        args: { filter?: FilterInput; sort?: string; dir?: string; first?: number; after?: string }
      ) => {
        const filter = args.filter ?? {};
        const sort = SORT_FROM_GQL[args.sort ?? 'IN_DEGREE'] ?? 'in_degree';
        const dir = args.dir === 'ASC' ? 'asc' : 'desc';
        const page = unwrap(
          await listActs(acts, {
            filter,
            sort,
            dir,
            page: { first: args.first ?? 20, ...(args.after != null && { after: args.after }) },
          })
        );
        return toActConnection(page, filter, sort, dir, async () => {
          // Lazy: runs only when the query actually selects totalCount. A
          // count failure degrades to null (unknown) — it never fails the
          // list it annotates.
          const counted = await acts.countActs(filter);
          return counted.isOk() ? counted.value : null;
        });
      },
      legalSearch: async (
        _r: unknown,
        args: {
          q: string;
          filter?: FilterInput;
          channel?: string;
          includeHistorical?: boolean;
          limit?: number;
        }
      ) =>
        unwrap(
          await searchLegal(searchDeps, {
            q: args.q,
            filter: args.filter ?? {},
            channel: (args.channel ?? 'auto') as 'auto' | 'sections' | 'docs',
            includeHistorical: args.includeHistorical ?? false,
            limit: args.limit ?? 20,
          })
        ),
      legalDocumentOutline: async (
        _r: unknown,
        args: { documentId: string; maxDepth?: number; first?: number; after?: string }
      ) => {
        const page = unwrap(
          await getDocumentOutline(outline, {
            documentId: args.documentId,
            maxDepth: args.maxDepth ?? 3,
            page: {
              first: args.first ?? 200,
              // `!= null`: an explicit `after: null` variable is a normal
              // GraphQL first-page request, not a malformed cursor.
              ...(args.after != null && { after: args.after }),
            },
          })
        );
        // SDL keeps `depth: Int!`. That guarantee is real on THIS path and only
        // this one: the outline query filters to ranked heading types, so every
        // row it returns has a grammar rank. `entryByPath` (MCP only) resolves
        // any structural node and legitimately yields a null depth, which is
        // why the core type is nullable — weakening the published GraphQL field
        // to match it would break generated clients to describe a case that
        // cannot reach them. A null here means the repo filter and the rank
        // table disagree; that is a contract violation, not a nullable value.
        const entries = page.items.map((entry) => {
          if (entry.depth === null) {
            throw new Error(
              `legalDocumentOutline: ${entry.documentId}${entry.path} passed the heading-type ` +
                'filter but has no grammar rank — outline filter and OUTLINE_DEPTH_RANK disagree'
            );
          }
          return { ...entry, depth: entry.depth };
        });
        return { entries, next: page.next };
      },
      legalExternalAct: async (_r: unknown, args: { externalActId: string }) =>
        unwrap(await getExternalAct(graph, args.externalActId)),
      legalResolve: async (_r: unknown, args: { dim: string; q: string; limit?: number }) =>
        unwrap(
          await resolveLegalFilters(
            resolveDeps,
            args.dim as LegalResolveDim,
            args.q,
            args.limit ?? 10
          )
        ),
    },

    LegalAct: {
      canonical: async (parent: LegalAct) => canonicalLoader.load(parent.actId),
      summary: async (parent: LegalAct) => {
        const canon = await canonicalLoader.load(parent.actId);
        if (canon === null) return null;
        return unwrap(await acts.getSummary(canon.documentId));
      },
      aliases: async (parent: LegalAct) => {
        const card = unwrap(await acts.getActCard({ actId: parent.actId }));
        return card?.aliases ?? [];
      },
      citationKeys: async (parent: LegalAct) => {
        const card = unwrap(await acts.getActCard({ actId: parent.actId }));
        return card?.citationKeys ?? [];
      },
      versionCount: async (parent: LegalAct) => {
        const docs = unwrap(await getActVersions(acts, parent.actId));
        return docs.length;
      },
      // The act-card path already carries the count; every other path reads it
      // off the batched provenance loader rather than one count per act.
      amendedAfterPublication: async (parent: LegalAct) => {
        const onCard = (parent as Partial<LegalActCard>).amendedAfterPublication;
        if (typeof onCard === 'number') return onCard;
        return provenanceOrUnknown(await provenanceLoader.load(parent.actId))
          .amendedAfterPublication;
      },
      versionProvenance: async (parent: LegalAct) =>
        provenanceOrUnknown(await provenanceLoader.load(parent.actId)),
      textProvenance: async (parent: LegalAct) =>
        versionProvenanceNote(provenanceOrUnknown(await provenanceLoader.load(parent.actId))),
      documents: async (parent: LegalAct) => unwrap(await getActVersions(acts, parent.actId)),
      links: async (
        parent: LegalAct,
        args: { direction: string; relation?: string[]; first?: number }
      ) => {
        const relations = (args.relation ?? []).map(
          (r) => RELATION_FROM_GQL[r] ?? (r as LegalRelation)
        );
        const rels = relations.length > 0 ? relations : undefined;
        // 199 cap: the repo clamps reads at 200, so the +1 probe must stay
        // inside it — at exactly 200 the probe would be silently truncated
        // and hasNextPage would read false with more edges present.
        const limit = Math.min(args.first ?? 50, 199);
        // limit+1 probe: hasNextPage is a fact, not a hardcoded false, and
        // totalCount is NULL (unknown) rather than the page size — a bounded
        // read cannot know the hub's true fan-out and must not claim to.
        if (args.direction === 'OUT' || args.direction === 'out') {
          const edges = unwrap(await getActLinksOut(graph, parent.actId, rels, limit + 1));
          const hasNextPage = edges.length > limit;
          return {
            edges: (hasNextPage ? edges.slice(0, limit) : edges).map((edge) => ({
              ...edge,
              sourceAct: null,
            })),
            pageInfo: { hasNextPage, endCursor: null },
            totalCount: null,
          };
        }
        const inEdges = unwrap(await getActLinksIn(graph, parent.actId, rels, limit + 1));
        const hasNextPage = inEdges.length > limit;
        return {
          edges: (hasNextPage ? inEdges.slice(0, limit) : inEdges).map(({ edge, sourceAct }) => ({
            ...edge,
            sourceAct,
          })),
          pageInfo: { hasNextPage, endCursor: null },
          totalCount: null,
        };
      },
      incomingAnchors: async (parent: LegalAct, args: { first?: number; after?: string }) => {
        const page = unwrap(
          await graph.incomingAnchors(parent.actId, {
            first: args.first ?? 50,
            // `!= null`: an explicit `after: null` variable is a normal
            // GraphQL first-page request, not a malformed cursor.
            ...(args.after != null && { after: args.after }),
          })
        );
        // Per-edge cursors re-encode the repo's keyset (edge_id asc, fhash
        // bound to the act) — sort/dir/scope must match graph-repo's
        // ANCHOR_SORT or a resumed cursor would be rejected.
        const fhash = filterHash(`anchors:${parent.actId}`);
        const edges = page.items.map((node) => ({
          node,
          cursor: buildNextCursor({
            sort: 'edge_id',
            dir: 'asc',
            fhash,
            lastKeys: [node.edgeId],
          }),
        }));
        return {
          edges,
          pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
          totalCount: page.totalCount,
        };
      },
      timeline: async (parent: LegalAct) => unwrap(await getActTimeline(acts, graph, parent.actId)),
    },

    LegalActConnection: {
      // The connection carries totalCount as a thunk (or null); resolving it
      // here rather than via the default field resolver keeps the laziness
      // explicit and engine-independent (graphql-jit vs graphql-js).
      totalCount: async (parent: { totalCount: null | (() => Promise<number | null>) }) =>
        typeof parent.totalCount === 'function' ? parent.totalCount() : parent.totalCount,
    },

    LegalIncomingAnchor: {
      sourceAct: async (parent: { sourceActId: string | null }) =>
        parent.sourceActId === null ? null : actLoader.load(parent.sourceActId),
    },

    LegalDocument: {
      // null = never compiled. The artifact body is NOT served here — only the
      // availability card; the body travels over the cacheable REST route.
      render: async (parent: LegalDocument) => renderInfoLoader.load(parent.documentId),
    },

    LegalReferenceEdge: {
      targetAct: async (parent: { targetActId: string | null }) =>
        parent.targetActId === null ? null : actLoader.load(parent.targetActId),
      targetExternalAct: async (parent: { targetExternalActId: string | null }) =>
        parent.targetExternalActId === null
          ? null
          : unwrap(await getExternalAct(graph, parent.targetExternalActId)),
      // sourceAct is provided eagerly by the incoming-edge resolver above.
    },

    LegalSectionHit: {
      act: async (parent: { actId: string }) => actLoader.load(parent.actId),
    },
  };
};

// ── connection projection ──────────────────────────────────────────────────────

const toActConnection = (
  page: CursorPage<LegalAct>,
  filter: FilterInput,
  sort: LegalSortKey,
  dir: 'asc' | 'desc',
  countTotal?: () => Promise<number | null>
): {
  edges: { node: LegalAct; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: null | (() => Promise<number | null>);
} => {
  const fhash = fhashFor(legalActsSpec, filter);
  const edges = page.items.map((node) => ({
    node,
    cursor: buildNextCursor({ sort, dir, fhash, lastKeys: sortKeysOf(node, sort) }),
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: page.next !== null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
    },
    // A thunk, resolved by the explicit LegalActConnection.totalCount
    // resolver only when the field is selected — the count query never runs
    // for a list that did not ask for it.
    totalCount: countTotal ?? null,
  };
};

export { STATUS_FROM_GQL, RELATION_FROM_GQL };
