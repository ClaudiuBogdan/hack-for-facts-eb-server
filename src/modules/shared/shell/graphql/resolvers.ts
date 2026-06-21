/**
 * Shared Kernel — base GraphQL resolvers (foundation §6.2, §14.7).
 *
 * Thin resolvers: parse args → call the same core usecase the (future) REST
 * handlers call. `Entity` field resolvers read from the entity-360 payload
 * computed once per `entity(cui)` call. ApiError → GraphQLError with
 * `extensions.code`. The kernel scalars are merged in by the module index.
 */

import { GraphQLError } from 'graphql';

import { scalarResolvers } from './scalars.js';
import { GRAPHQL_ERROR_CODE, type ApiError } from '../../core/errors.js';
import {
  makeEntityCore,
  resolveEntityPresence,
  type EntityCore,
  type Entity360Deps,
} from '../../core/usecases/entity-360.js';
import {
  makeGlobalSearch,
  type GlobalSearchDeps,
} from '../../core/usecases/global-search.js';

import type { ContributorRegistry, FlowsRepo, IdentityRepo, SearchRepo } from '../../core/ports.js';
import type { FlowSummary, SourcePresence, Territory } from '../../core/types.js';
import type { KernelCache } from '../middleware/cache.js';
import type { RateLimiter } from '../middleware/rate-limiter.js';
import type { Result } from 'neverthrow';

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type },
  });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

/** Dependencies the kernel resolvers need (a slice of the kernel). */
export interface KernelResolverDeps {
  readonly entity360Deps: Entity360Deps;
  readonly globalSearchDeps: GlobalSearchDeps;
  readonly identityRepo: IdentityRepo;
  readonly flowsRepo: FlowsRepo;
  readonly searchRepo: SearchRepo;
  readonly registry: ContributorRegistry;
  readonly health: () => Promise<unknown>;
  /** Kernel response cache — the searchEntities resolver wraps hot queries (T3). */
  readonly cache: KernelCache;
  /** Kernel rate limiter — the searchEntities resolver guards the palette (T3). */
  readonly rateLimiter: RateLimiter;
}

interface EntityArgs {
  cui: string;
}
interface SearchArgs {
  q: string;
  docTypes?: string[];
  limit?: number;
}

export const makeKernelResolvers = (deps: KernelResolverDeps): Record<string, unknown> => ({
  ...scalarResolvers,

  Query: {
    health: async () => deps.health(),

    entity: async (_root: unknown, args: EntityArgs): Promise<EntityCore | null> => {
      // Lazy: resolve the non-flow core only. flowsIn/flowsOut are field
      // resolvers that scan flows.money_flows ONLY when selected.
      const result = await makeEntityCore(deps.entity360Deps, args.cui);
      if (result.isErr()) {
        // Invalid CUI input → null entity rather than a hard error.
        if (result.error.type === 'InvalidInput') return null;
        throw toGraphqlError(result.error);
      }
      return result.value;
    },

    searchEntities: async (_root: unknown, args: SearchArgs) =>
      unwrap(
        await makeGlobalSearch(deps.globalSearchDeps, {
          q: args.q,
          ...(args.docTypes !== undefined && { docTypes: args.docTypes }),
          ...(args.limit !== undefined && { limit: args.limit }),
        })
      ),
  },

  // Field-level resolvers — each computed lazily per-request, so a query pays
  // only for what it selects. flowsIn/flowsOut hit the 19GB flow graph;
  // documentCount is a ~7s any(cuis) scan over 6.1M docs; territory + presence
  // are their own joins/fan-out. `entity(cui){ pnrr }` touches NONE of these.
  Entity: {
    flowsIn: async (parent: { cui: string }): Promise<FlowSummary> =>
      unwrap(await deps.flowsRepo.getFlowSummary(parent.cui, 'in')),
    flowsOut: async (parent: { cui: string }): Promise<FlowSummary> =>
      unwrap(await deps.flowsRepo.getFlowSummary(parent.cui, 'out')),
    territory: async (parent: { cui: string }): Promise<Territory | null> =>
      unwrap(await deps.identityRepo.territoryForCui(parent.cui)),
    documentCount: async (parent: { cui: string }): Promise<number> =>
      unwrap(await deps.searchRepo.countByCui(parent.cui)),
    presence: async (parent: { cui: string }): Promise<readonly SourcePresence[]> =>
      resolveEntityPresence(deps.registry, parent.cui),
  },
});
