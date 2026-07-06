/**
 * Legal module — GraphQL resolvers (plan §6). Thin: parse args → call the SAME
 * usecase MCP calls. `ApiError` → `GraphQLError` with `extensions.code`. Cursor
 * pages → Relay connections (per-edge cursor re-encoded, bound to the active
 * fhash). Lazy `LegalAct` fields (canonical/summary/links/timeline/tree) resolve
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
  makeBatchLoader,
  type ApiError,
  type CursorPage,
  type FilterInput,
} from '@/modules/shared/index.js';

import {
  getAct,
  getActLinksIn,
  getActLinksOut,
  getActTimeline,
  getActTree,
  getActVersions,
  getExternalAct,
  listActs,
  resolveLegalFilters,
  searchLegal,
  type LegalSearchDeps,
  type ResolveLegalFiltersDeps,
} from '../../core/usecases.js';
import { legalActsSpec } from '../filters/legal-acts.spec.js';

import type { LegalActsRepo, LegalGraphRepo, LegalTreeRepo } from '../../core/ports.js';
import type {
  LegalAct,
  LegalActStatus,
  LegalDocument,
  LegalRelation,
  LegalResolveDim,
  LegalSortKey,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface LegalResolverDeps {
  readonly acts: LegalActsRepo;
  readonly graph: LegalGraphRepo;
  readonly tree: LegalTreeRepo;
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
  const { acts, graph, tree, searchDeps, resolveDeps } = deps;

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
        return toActConnection(page, filter, sort, dir);
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
      amendedAfterPublication: async (parent: LegalAct) =>
        unwrap(await acts.countAmendmentsAfter(parent.actId)),
      documents: async (parent: LegalAct) => unwrap(await getActVersions(acts, parent.actId)),
      links: async (
        parent: LegalAct,
        args: { direction: string; relation?: string[]; first?: number }
      ) => {
        const relations = (args.relation ?? []).map(
          (r) => RELATION_FROM_GQL[r] ?? (r as LegalRelation)
        );
        const rels = relations.length > 0 ? relations : undefined;
        const limit = args.first ?? 50;
        if (args.direction === 'OUT' || args.direction === 'out') {
          const edges = unwrap(await getActLinksOut(graph, parent.actId, rels, limit));
          return {
            edges: edges.map((edge) => ({ ...edge, sourceAct: null })),
            pageInfo: { hasNextPage: false, endCursor: null },
            totalCount: edges.length,
          };
        }
        const inEdges = unwrap(await getActLinksIn(graph, parent.actId, rels, limit));
        return {
          edges: inEdges.map(({ edge, sourceAct }) => ({ ...edge, sourceAct })),
          pageInfo: { hasNextPage: false, endCursor: null },
          totalCount: inEdges.length,
        };
      },
      timeline: async (parent: LegalAct) => unwrap(await getActTimeline(acts, graph, parent.actId)),
      tree: async (
        parent: LegalAct,
        args: { documentId?: string; path?: string; depth?: number }
      ) => {
        const documentId = args.documentId ?? parent.canonicalDocumentId;
        if (documentId === null) return [];
        return unwrap(
          await getActTree(tree, {
            documentId,
            ...(args.path !== undefined && { path: args.path }),
            depth: args.depth ?? 1,
          })
        );
      },
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
  dir: 'asc' | 'desc'
): {
  edges: { node: LegalAct; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number | null;
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
    totalCount: null,
  };
};

export { STATUS_FROM_GQL, RELATION_FROM_GQL };
