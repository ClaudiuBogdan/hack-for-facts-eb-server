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
  county?: string;
  year?: number;
  limit?: number;
  offset?: number;
}

/**
 * The slice of the Mercurius GraphQL context the kernel resolvers read. Mercurius
 * exposes `{ app, reply }`; `reply.request.ip` is the caller IP (Fastify honors
 * `X-Forwarded-For` because the app is built with `trustProxy: true`).
 */
interface KernelGraphqlContext {
  reply?: { request?: { ip?: string } };
}

/** Best-effort caller IP for the per-IP rate-limit bucket; falls back to a constant. */
const callerIp = (context: KernelGraphqlContext | undefined): string =>
  context?.reply?.request?.ip ?? 'anon';

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

    searchEntities: async (
      _root: unknown,
      args: SearchArgs,
      context: KernelGraphqlContext
    ) => {
      // Rate-limit the palette per caller IP (it has no other guard). On exhaustion,
      // surface a structured GraphQLError the client can detect (extensions.code).
      const ip = callerIp(context);
      const limit = deps.rateLimiter.consume(`searchEntities:${ip}`);
      if (!limit.allowed) {
        throw new GraphQLError('Rate limit exceeded for searchEntities.', {
          extensions: { code: 'RATE_LIMITED', retryAfterMs: limit.retryAfterMs },
        });
      }

      const searchInput = {
        q: args.q,
        ...(args.docTypes !== undefined && { docTypes: args.docTypes }),
        ...(args.county !== undefined && { county: args.county }),
        ...(args.year !== undefined && { year: args.year }),
        ...(args.limit !== undefined && { limit: args.limit }),
        ...(args.offset !== undefined && { offset: args.offset }),
      };
      // Short TTL cache (index changes ≤ once/cron). Key = a structured JSON
      // signature of the normalized args (NOT delimiter-joined — `q="a|b"` with no
      // types must not collide with `q="a", docTypes=["b"]`). Degrade-not-error
      // behavior lives inside the usecase.
      const cacheKey = `entities-search:${JSON.stringify({
        q: args.q,
        docTypes: (args.docTypes ?? []).slice().sort(),
        county: args.county ?? null,
        year: args.year ?? null,
        limit: args.limit ?? null,
        offset: args.offset ?? null,
      })}`;
      return unwrap(
        await deps.cache.wrap(cacheKey, () => makeGlobalSearch(deps.globalSearchDeps, searchInput))
      );
    },
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
