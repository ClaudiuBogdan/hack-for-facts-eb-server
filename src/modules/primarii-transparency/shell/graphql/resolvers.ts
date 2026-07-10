/**
 * Primarii-transparency module — GraphQL resolvers (plan §6). Thin: parse args →
 * call the SAME usecase MCP calls. `ApiError` → `GraphQLError` with `extensions.code`.
 * Cursor pages → Relay connections (each edge re-encodes its node's cursor bound to
 * the active fhash). `PrimariiEntityStatus.territory` is a CUI-keyed DataLoader over
 * the kernel `IdentityRepo.territoryForCui` (no N+1 on lists; null where the
 * CUI→public_entities→territory path is incomplete). `Entity.primariiTransparency`
 * goes through the kernel `makeEntityProfileSlice` (contributor parity, §14.7).
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  fhashFor,
  makeBatchLoader,
  makeEntityProfileSlice,
  normalizeCui,
  type ApiError,
  type CollectionFilterSpec,
  type ContributorRegistry,
  type CursorPage,
  type FilterInput,
  type IdentityRepo,
  type Territory,
} from '@/modules/shared/index.js';

import { primariiDocumentFilterSpec, primariiEntityFilterSpec } from '../../core/filters.js';
import {
  getCategoryCoverage,
  getEntityTransparencyProfile,
  getTransparencyStats,
  listEntityDocuments,
  listLoadIssues,
  listSalaryClaims,
  listEntitySnapshots,
  listTransparencyEntities,
  resolveFilters,
  type PrimariiDeps,
} from '../../core/usecases.js';
import { primariiEntitySortDir } from '../repo/primarii-repo.js';

import type {
  PrimariiDocument,
  PrimariiEntityProfile,
  PrimariiEntityStatus,
  PrimariiResolveDim,
  PrimariiSalaryClaim,
  PrimariiSnapshot,
  PrimariiStatGroupBy,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface PrimariiResolverDeps extends PrimariiDeps {
  readonly registry: ContributorRegistry;
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type },
  });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

interface PageArgs {
  filter?: FilterInput | null;
  first?: number | null;
  after?: string | null;
  sort?: string | null;
}

/** Map the UPPERCASE GraphQL sort enum to the repo's lowercase sort key. */
const ENTITY_SORT_KEY: Record<string, string> = {
  DATA_QUALITY: 'data_quality',
  CONFIDENCE: 'confidence',
  EVIDENCE_COVERAGE: 'evidence_coverage',
  ISSUE_COUNT: 'issue_count',
  ENTITY_NAME: 'entity_name',
  UPDATED_AT: 'updated_at',
};

const pageReq = (
  args: { first?: number | null; after?: string | null },
  sortKey?: string
): { first: number; after?: string; sort?: string } => ({
  first: args.first ?? 20,
  ...(args.after != null && args.after !== '' && { after: args.after }),
  ...(sortKey !== undefined && sortKey !== '' && { sort: sortKey }),
});

/** Build a Relay connection from a CursorPage; each edge re-encodes its own cursor. */
const toConnection = <T>(
  page: CursorPage<T> & { totalCount?: number },
  fhash: string,
  sort: string,
  dir: 'asc' | 'desc',
  keysOf: (node: T) => readonly (string | number | null)[]
): {
  edges: { node: T; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number;
} => {
  const edges = page.items.map((node) => ({
    node,
    cursor: buildNextCursor({ sort, dir, fhash, lastKeys: keysOf(node) }),
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: page.next !== null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
    },
    totalCount: page.totalCount ?? edges.length,
  };
};

const fhashOf = (spec: CollectionFilterSpec, filter: FilterInput): string => fhashFor(spec, filter);

const entitySortKey = (sortField: string, n: PrimariiEntityStatus): string => {
  switch (sortField) {
    case 'confidence':
      return n.confidence === null ? '' : String(n.confidence);
    case 'evidence_coverage':
      return n.evidenceCoverage === null ? '' : String(n.evidenceCoverage);
    case 'issue_count':
      return String(n.issueCount);
    case 'entity_name':
      return n.entityName;
    case 'updated_at':
      return n.updatedAt;
    case 'data_quality':
    default:
      return n.dataQualityStatus;
  }
};

export const makePrimariiResolvers = (deps: PrimariiResolverDeps): Record<string, unknown> => {
  // CUI → kernel Territory DataLoader (batched point lookups for list rows).
  const territoryByCuiLoader = makeTerritoryLoader(deps.identityRepo);

  return {
    Query: {
      primariiEntity: async (_r: unknown, args: { cui: string }) =>
        unwrap(await getEntityTransparencyProfile(deps, args.cui)),

      primariiEntities: async (_r: unknown, args: PageArgs & { sort?: string | null }) => {
        const filter = args.filter ?? {};
        const sortKey =
          args.sort != null && args.sort in ENTITY_SORT_KEY
            ? ENTITY_SORT_KEY[args.sort]
            : undefined;
        const page = unwrap(await listTransparencyEntities(deps, filter, pageReq(args, sortKey)));
        const sortField = sortKey ?? primariiEntityFilterSpec.sort.default;
        const dir = primariiEntitySortDir(sortField);
        return toConnection(
          page,
          fhashOf(primariiEntityFilterSpec, filter),
          sortField,
          dir,
          (n) => [entitySortKey(sortField, n), n.cui]
        );
      },

      primariiEntitySnapshots: async (
        _r: unknown,
        args: { cui: string; first?: number | null; after?: string | null }
      ) => {
        const page = unwrap(await listEntitySnapshots(deps, args.cui, pageReq(args)));
        // The per-CUI cursor fhash MUST match the repo's (it normalizes the cui).
        const cui = normalizeCui(args.cui) ?? args.cui;
        return toConnection(
          page,
          `snapshots:${cui}`,
          'loaded_at',
          'desc',
          (n: PrimariiSnapshot) => [n.loadedAt, n.snapshotId]
        );
      },

      primariiEntitySalaryClaims: async (
        _r: unknown,
        args: { cui: string; first?: number | null; after?: string | null }
      ) => {
        const page = unwrap(await listSalaryClaims(deps, args.cui, pageReq(args)));
        const cui = normalizeCui(args.cui) ?? args.cui;
        return toConnection(
          page,
          `salary:${cui}`,
          'amount_ron',
          'desc',
          (n: PrimariiSalaryClaim) => [n.amountRon, n.salaryAmountClaimId]
        );
      },

      primariiDocuments: async (_r: unknown, args: PageArgs) => {
        const filter = args.filter ?? {};
        const page = unwrap(await listEntityDocuments(deps, filter, pageReq(args)));
        const sortField = primariiDocumentFilterSpec.sort.default;
        return toConnection(
          page,
          fhashOf(primariiDocumentFilterSpec, filter),
          sortField,
          'asc',
          (n: PrimariiDocument) => [
            sortField === 'category' ? (n.category ?? '') : n.cui,
            n.documentPk,
          ]
        );
      },

      primariiStats: async (
        _r: unknown,
        args: { groupBy: PrimariiStatGroupBy; filter?: FilterInput | null }
      ) => unwrap(await getTransparencyStats(deps, args.groupBy, args.filter ?? {})),

      primariiCategoryCoverage: async (_r: unknown, args: { filter?: FilterInput | null }) =>
        unwrap(await getCategoryCoverage(deps, args.filter ?? {})),

      primariiLoadIssues: async (
        _r: unknown,
        args: {
          cui?: string | null;
          severity?: string | null;
          issueCode?: string | null;
          limit?: number | null;
        }
      ) =>
        unwrap(
          await listLoadIssues(
            deps,
            {
              ...(args.cui != null && args.cui !== '' && { cui: args.cui }),
              ...(args.severity != null && args.severity !== '' && { severity: args.severity }),
              ...(args.issueCode != null && args.issueCode !== '' && { issueCode: args.issueCode }),
            },
            args.limit ?? 50
          )
        ),

      primariiResolve: async (
        _r: unknown,
        args: { dim: PrimariiResolveDim; q: string; limit?: number | null }
      ) => unwrap(await resolveFilters(deps, args.dim, args.q, args.limit ?? 10)),
    },

    PrimariiEntityProfile: {
      // territory hangs off the nested status node — resolved there.
    },

    PrimariiEntityStatus: {
      // Lazy territory via a CUI-keyed DataLoader (kernel territoryForCui).
      territory: async (parent: PrimariiEntityStatus): Promise<Territory | null> =>
        territoryByCuiLoader.load(parent.cui),
    },

    Entity: {
      // Contributor parity (§14.7): the registry slice and this field share ONE
      // source of truth — `getEntityTransparencyProfile` (the same usecase the
      // contributor's `profileSlice` calls). The presence gate (registry) returns
      // null for absent CUIs; we then return the full profile (richer than the
      // summary slice) so the client gets the same shape as `primariiEntity`.
      primariiTransparency: async (parent: {
        cui: string;
      }): Promise<PrimariiEntityProfile | null> => {
        const slice = unwrap(
          await makeEntityProfileSlice(deps.registry, 'primarii_transparency', parent.cui)
        );
        if (slice === null) return null;
        return unwrap(await getEntityTransparencyProfile(deps, parent.cui));
      },
    },
  };
};

/** A DataLoader keyed by CUI over the kernel IdentityRepo.territoryForCui. */
const makeTerritoryLoader = (identityRepo: IdentityRepo) =>
  makeBatchLoader<Territory | null>(async (cuis) => {
    const out = new Map<string, Territory | null>();
    await Promise.all(
      [...new Set(cuis)].map(async (cui) => {
        const res = await identityRepo.territoryForCui(cui);
        out.set(cui, res.isOk() ? res.value : null);
      })
    );
    return out;
  }, null);
