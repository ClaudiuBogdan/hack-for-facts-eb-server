/**
 * PNRR module — GraphQL resolvers (plan §6). Thin: parse args → call the SAME
 * usecase REST/MCP would. `ApiError` → `GraphQLError` with `extensions.code`
 * (kernel convention). Cursor pages → Relay connections (edges carry the row's
 * own cursor via a per-edge re-encode bound to the active fhash). `Entity.pnrr`
 * goes through the kernel `makeEntityProfileSlice` (contributor parity, §14.7).
 *
 * `PnrrCommitment.progress` is NOT a list field (741k-row footgun); use
 * `progressCount`/`latestProgress` on the row + the dedicated
 * `pnrrCommitmentProgress` query. `PnrrAcquisition.contractors` is a bounded
 * child resolved via a DataLoader by acquisition_key (no N+1 on list pages).
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  fhashFor,
  makeBatchLoader,
  makeEntityProfileSlice,
  type ApiError,
  type ContributorRegistry,
  type CursorPage,
  type FilterInput,
  type CollectionFilterSpec,
} from '@/modules/shared/index.js';

import {
  pnrrAcquisitionsFilterSpec,
  pnrrCommitmentsFilterSpec,
  pnrrContractorsFilterSpec,
  pnrrEntitiesFilterSpec,
  pnrrPaymentsFilterSpec,
} from '../../core/filters.js';
import {
  aggregatePnrrPayments,
  getPnrrAcquisition,
  getPnrrCommitmentProgress,
  getPnrrEntity,
  getPnrrEntityProfile,
  listPnrrAcquisitions,
  listPnrrCommitments,
  listPnrrComponents,
  listPnrrContractors,
  listPnrrEntities,
  listPnrrMeasures,
  listPnrrPayments,
  listPnrrProgramIndicators,
  rankPnrrContractors,
  resolvePnrrFilters,
} from '../../core/usecases.js';

import type { PnrrRepository } from '../../core/ports.js';
import type {
  PnrrAcquisition,
  PnrrCommitmentSnapshot,
  PnrrContractor,
  PnrrContractorRankBy,
  PnrrEntity,
  PnrrEntityProfile,
  PnrrPaymentGroupBy,
  PnrrResolveDim,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface PnrrResolverDeps {
  readonly repo: PnrrRepository;
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
  filter?: FilterInput;
  first?: number;
  after?: string;
}

const pageReq = (args: PageArgs): { first: number; after?: string } => ({
  first: args.first ?? 20,
  ...(args.after != null && { after: args.after }),
});

/**
 * Build a Relay connection from a CursorPage. Each edge carries a cursor
 * re-encoded from that node's sort tuple, bound to the active filter fhash — so
 * `edges[i].cursor` is a valid resume point (not just the page-level `next`).
 */
const toConnection = <T>(
  page: CursorPage<T>,
  spec: CollectionFilterSpec,
  filter: FilterInput,
  sort: string,
  dir: 'asc' | 'desc',
  keysOf: (node: T) => readonly (string | number | null)[]
): {
  edges: { node: T; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
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
  };
};

export const makePnrrResolvers = (deps: PnrrResolverDeps): Record<string, unknown> => {
  const { repo, registry } = deps;

  // Per-process DataLoader for acquisition → contractors (bounded child fan-out).
  // (A per-request loader would be ideal; the batch is small and idempotent, so a
  // shared loader with no caching is acceptable for the read-only surface.)
  const contractorsLoader = makeBatchLoader<readonly PnrrContractor[]>(async (keys) => {
    const res = await repo.contractorsForAcquisitions(keys);
    if (res.isErr()) throw toGraphqlError(res.error);
    return res.value;
  }, []);

  return {
    Query: {
      pnrrEntities: async (_r: unknown, args: PageArgs) => {
        const filter = args.filter ?? {};
        const page = unwrap(await listPnrrEntities(repo, filter, pageReq(args)));
        return toConnection(page, pnrrEntitiesFilterSpec, filter, 'cui', 'asc', (n) => [n.cui]);
      },
      pnrrEntity: async (_r: unknown, args: { cui: string }) =>
        unwrap(await getPnrrEntity(repo, args.cui)),
      pnrrEntityProfile: async (_r: unknown, args: { cui: string }) =>
        unwrap(await getPnrrEntityProfile(repo, args.cui)),

      pnrrPayments: async (_r: unknown, args: PageArgs) => {
        const filter = args.filter ?? {};
        const page = unwrap(await listPnrrPayments(repo, filter, pageReq(args)));
        return toConnection(page, pnrrPaymentsFilterSpec, filter, 'payment_date', 'desc', (n) => [
          n.paymentDate ?? '1900-01-01',
          n.paymentKey,
        ]);
      },
      pnrrPaymentAggregate: async (
        _r: unknown,
        args: { filter?: FilterInput; groupBy: PnrrPaymentGroupBy }
      ) => unwrap(await aggregatePnrrPayments(repo, args.filter ?? {}, args.groupBy)),

      pnrrCommitments: async (_r: unknown, args: PageArgs) => {
        const filter = args.filter ?? {};
        const page = unwrap(await listPnrrCommitments(repo, filter, pageReq(args)));
        return toConnection(
          page,
          pnrrCommitmentsFilterSpec,
          filter,
          'commitment_date',
          'desc',
          (n) => [n.commitmentDate ?? '1900-01-01', n.commitmentKey]
        );
      },
      pnrrCommitmentProgress: async (_r: unknown, args: { commitmentKey: string }) =>
        unwrap(await getPnrrCommitmentProgress(repo, args.commitmentKey)),

      pnrrAcquisitions: async (_r: unknown, args: PageArgs) => {
        const filter = args.filter ?? {};
        const page = unwrap(await listPnrrAcquisitions(repo, filter, pageReq(args)));
        return toConnection(page, pnrrAcquisitionsFilterSpec, filter, 'signed_at', 'desc', (n) => [
          n.signedAt ?? '1900-01-01',
          n.acquisitionKey,
        ]);
      },
      pnrrAcquisition: async (_r: unknown, args: { key: string }) =>
        unwrap(await getPnrrAcquisition(repo, args.key)),

      pnrrContractors: async (_r: unknown, args: PageArgs) => {
        const filter = args.filter ?? {};
        const page = unwrap(await listPnrrContractors(repo, filter, pageReq(args)));
        return toConnection(
          page,
          pnrrContractorsFilterSpec,
          filter,
          'contract_value',
          'desc',
          (n) => [n.contractValue ?? '', n.contractorKey]
        );
      },
      pnrrContractorRank: async (
        _r: unknown,
        args: { filter?: FilterInput; by?: PnrrContractorRankBy; limit?: number }
      ) =>
        unwrap(
          await rankPnrrContractors(repo, args.filter ?? {}, args.by ?? 'value', args.limit ?? 20)
        ),

      pnrrComponents: async () => unwrap(await listPnrrComponents(repo)),
      pnrrMeasures: async (_r: unknown, args: { filter?: FilterInput }) =>
        unwrap(await listPnrrMeasures(repo, args.filter ?? {})),
      pnrrProgramIndicators: async () => unwrap(await listPnrrProgramIndicators(repo)),
      pnrrResolve: async (_r: unknown, args: { dim: PnrrResolveDim; q: string; limit?: number }) =>
        unwrap(await resolvePnrrFilters(repo, args.dim, args.q, args.limit ?? 10)),
    },

    PnrrEntity: {
      // Lazy profile via the SAME usecase the contributor + Entity.pnrr call.
      profile: async (parent: PnrrEntity): Promise<PnrrEntityProfile | null> =>
        unwrap(await getPnrrEntityProfile(repo, parent.cui)),
    },

    PnrrAcquisition: {
      contractors: async (parent: PnrrAcquisition): Promise<readonly PnrrContractor[]> =>
        contractorsLoader.load(parent.acquisitionKey),
    },

    Entity: {
      // Contributor parity (§14.7): resolve through the registry, not a 2nd path.
      pnrr: async (parent: { cui: string }): Promise<PnrrEntityProfile | null> => {
        const slice = unwrap(await makeEntityProfileSlice(registry, 'pnrr', parent.cui));
        if (slice?.data === undefined) return null;
        return slice.data as unknown as PnrrEntityProfile;
      },
    },
  };
};

// Re-export the snapshot type so the resolver module's consumers can see it.
export type { PnrrCommitmentSnapshot };
