/**
 * Reference module — GraphQL resolvers (plan §6). Thin: parse args → call the SAME
 * usecase MCP calls. `ApiError` → `GraphQLError` with `extensions.code`. Cursor
 * pages → Relay connections (each edge re-encodes its node's cursor bound to the
 * active fhash; the connection carries `totalCount`). `ReferencePublicEntity.territory`
 * is a CUI-keyed DataLoader over the kernel TerritoryRepo (no N+1 on lists).
 * `Entity.reference` goes through the kernel `makeEntityProfileSlice` (contributor
 * parity, §14.7) — never a divergent path.
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  fhashFor,
  makeBatchLoader,
  makeEntityProfileSlice,
  type ApiError,
  type CollectionFilterSpec,
  type ContributorRegistry,
  type CursorPage,
  type FilterInput,
  type TerritoryRepo,
  type Territory,
} from '@/modules/shared/index.js';

import {
  referenceClassificationFilterSpec,
  referencePublicEntityFilterSpec,
  referenceTerritoryFilterSpec,
} from '../../core/filters.js';
import {
  aggregatePublicEntities,
  getClassificationCode,
  getOrganizationRef,
  getPublicEntity,
  getPublicEntityChildren,
  getTerritory,
  listClassificationCodes,
  listClassificationSystems,
  listCounties,
  listPublicEntities,
  listRegions,
  listTerritories,
  resolveReference,
  type ReferenceDeps,
} from '../../core/usecases.js';
import { publicEntitySortDir } from '../repo/public-entity-repo.js';
import { territorySortDir } from '../repo/territory-query-repo.js';

import type {
  ReferenceAggregateDim,
  ReferencePublicEntity,
  ReferencePublicEntityCard,
  ReferenceResolveDim,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface ReferenceResolverDeps extends ReferenceDeps {
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

// GraphQL nullable args can arrive as explicit `null` (not just undefined); treat
// null/'' as absent so a `null` cursor/sort never reaches decodeCursor / the SORT
// lookup as a bogus string (review SHOULD-FIX).
const pageReq = (args: PageArgs): { first: number; after?: string; sort?: string } => ({
  first: args.first ?? 20,
  ...(args.after != null && args.after !== '' && { after: args.after }),
  ...(args.sort != null && args.sort !== '' && { sort: args.sort }),
});

/** Build a Relay connection from a CursorPage; each edge re-encodes its own cursor. */
const toConnection = <T>(
  page: CursorPage<T>,
  spec: CollectionFilterSpec,
  filter: FilterInput,
  sort: string,
  dir: 'asc' | 'desc',
  keysOf: (node: T) => readonly (string | number | null)[],
  totalCount?: number
): {
  edges: { node: T; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount?: number;
} => {
  const fhash = fhashFor(spec, filter);
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
    ...(totalCount !== undefined && { totalCount }),
  };
};

export const makeReferenceResolvers = (deps: ReferenceResolverDeps): Record<string, unknown> => {
  // CUI → kernel Territory DataLoader (batched point lookups for list rows).
  const territoryByCuiLoader = makeTerritoryLoader(deps.territoryRepo);

  return {
    Query: {
      referencePublicEntity: async (_r: unknown, args: { cui: string; includeTrace?: boolean }) =>
        unwrap(await getPublicEntity(deps, args.cui, args.includeTrace ?? false)),

      referencePublicEntities: async (_r: unknown, args: PageArgs) => {
        const filter = args.filter ?? {};
        const page = unwrap(await listPublicEntities(deps, filter, pageReq(args)));
        const sortField = args.sort ?? referencePublicEntityFilterSpec.sort.default;
        const dir = publicEntitySortDir(sortField);
        return toConnection(
          page,
          referencePublicEntityFilterSpec,
          filter,
          sortField,
          dir,
          (n) => [sortKeyOfPe(sortField, n), n.cui],
          page.totalCount
        );
      },

      referencePublicEntityChildren: async (_r: unknown, args: { cui: string }) =>
        unwrap(await getPublicEntityChildren(deps, args.cui)),

      referencePublicEntityAggregate: async (
        _r: unknown,
        args: { by: ReferenceAggregateDim; filter?: FilterInput }
      ) => unwrap(await aggregatePublicEntities(deps, args.by, args.filter ?? {})),

      referenceTerritory: async (
        _r: unknown,
        args: { id?: string | null; siruta?: string | null }
      ) => unwrap(await getTerritory(deps, args)),

      referenceTerritories: async (_r: unknown, args: PageArgs) => {
        const filter = args.filter ?? {};
        const page = unwrap(await listTerritories(deps, filter, pageReq(args)));
        const sortField = args.sort ?? referenceTerritoryFilterSpec.sort.default;
        const dir = territorySortDir(sortField);
        return toConnection(
          page,
          referenceTerritoryFilterSpec,
          filter,
          sortField,
          dir,
          (n) => [sortKeyOfTerritory(sortField, n), String(n.id)],
          page.totalCount
        );
      },

      referenceCounties: async () => unwrap(await listCounties(deps)),
      referenceRegions: async () => unwrap(await listRegions(deps)),

      referenceClassificationCode: async (_r: unknown, args: { system: string; code: string }) =>
        unwrap(await getClassificationCode(deps, args.system, args.code)),

      referenceClassificationCodes: async (_r: unknown, args: PageArgs) => {
        const filter = args.filter ?? {};
        const page = unwrap(await listClassificationCodes(deps, filter, pageReq(args)));
        const sortField = args.sort ?? referenceClassificationFilterSpec.sort.default;
        return toConnection(
          page,
          referenceClassificationFilterSpec,
          filter,
          sortField,
          'asc',
          (n) => [sortField === 'label' ? (n.label ?? '') : n.code, n.system, n.code]
        );
      },

      referenceClassificationSystems: async () => unwrap(await listClassificationSystems(deps)),

      referenceOrganization: async (_r: unknown, args: { cui: string }) =>
        unwrap(await getOrganizationRef(deps, args.cui)),

      referenceResolve: async (
        _r: unknown,
        args: { dim: ReferenceResolveDim; q: string; limit?: number }
      ) => unwrap(await resolveReference(deps, args.dim, args.q, args.limit ?? 10)),
    },

    ReferencePublicEntity: {
      // Lazy territory via a CUI-keyed DataLoader (list rows already carry territorialSirutaCode).
      territory: async (
        parent: ReferencePublicEntity | ReferencePublicEntityCard
      ): Promise<Territory | null> => {
        if ('territory' in parent && parent.territory !== null) return parent.territory;
        if (parent.territorialSirutaCode === null) return null;
        return territoryByCuiLoader.load(parent.territorialSirutaCode);
      },
    },

    Entity: {
      // Contributor parity (§14.7): resolve through the registry, not a 2nd path.
      reference: async (parent: { cui: string }): Promise<ReferencePublicEntityCard | null> => {
        const slice = unwrap(await makeEntityProfileSlice(deps.registry, 'reference', parent.cui));
        if (slice?.data === undefined) return null;
        return slice.data as unknown as ReferencePublicEntityCard;
      },
    },
  };
};

/** A DataLoader keyed by territorial_siruta_code over the kernel TerritoryRepo. */
const makeTerritoryLoader = (territoryRepo: TerritoryRepo) =>
  makeBatchLoader<Territory | null>(async (sirutaCodes) => {
    const out = new Map<string, Territory | null>();
    // The kernel repo has no batch-by-siruta method; the list rows are bounded
    // (page ≤ 100), so resolve each via the point lookup. Dedup keys upstream.
    await Promise.all(
      [...new Set(sirutaCodes)].map(async (code) => {
        const res = await territoryRepo.byTerritorialSiruta(code);
        out.set(code, res.isOk() ? res.value : null);
      })
    );
    return out;
  }, null);

const sortKeyOfPe = (sortField: string, n: ReferencePublicEntityCard): string => {
  if (sortField === 'cui') return n.cui;
  if (sortField === 'entity_type') return n.entityType ?? '';
  if (sortField === 'updated_at') return n.updatedAt;
  return n.name;
};

const sortKeyOfTerritory = (sortField: string, n: Territory): string => {
  if (sortField === 'population') return n.population === null ? '' : String(n.population);
  if (sortField === 'county_code') return n.countyCode ?? '';
  return n.name;
};
