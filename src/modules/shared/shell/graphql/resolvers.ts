/**
 * Shared Kernel — base GraphQL resolvers (foundation §6.2, §14.7).
 *
 * Thin resolvers: parse args → call the same core usecase the (future) REST
 * handlers call. `Entity` field resolvers read from the entity-360 payload
 * computed once per `entity(cui)` call. ApiError → GraphQLError with
 * `extensions.code`. The kernel scalars are merged in by the module index.
 */

import { GraphQLError, type GraphQLResolveInfo } from 'graphql';

import { scalarResolvers } from './scalars.js';
import { GRAPHQL_ERROR_CODE, type ApiError } from '../../core/errors.js';
import {
  confirmServedFacts,
  makeEntityCore,
  resolveEntityPresence,
  type EntityCore,
  type Entity360Deps,
} from '../../core/usecases/entity-360.js';
import {
  confirmGlobalSearchServed,
  makeGlobalSearch,
  type GlobalSearchDeps,
  type GlobalSearchResult,
} from '../../core/usecases/global-search.js';
import { makeOrganizationLabels } from '../../core/usecases/organization-labels.js';

import type {
  ContributorRegistry,
  FlowsRepo,
  IdentityRepo,
  OwningResultGuard,
  ResponsePath,
  SearchRepo,
  ServedFactsCheck,
} from '../../core/ports.js';
import type {
  FlowSummary,
  OrgIdentifier,
  SearchHitCompany,
  SourcePresence,
  Territory,
} from '../../core/types.js';
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

/**
 * The GraphQL context key under which the transport provides the operation's
 * owning-result guard (one per request; see `OwningResultGuard`).
 */
export const OWNING_RESULT_GUARD: unique symbol = Symbol('owningResultGuard');

/** The operation's owning-result guard, when the transport provides one. */
export const owningResultGuardOf = (context: unknown): OwningResultGuard | null => {
  if (typeof context !== 'object' || context === null) return null;
  const guard = (context as { [OWNING_RESULT_GUARD]?: unknown })[OWNING_RESULT_GUARD];
  return typeof guard === 'object' && guard !== null && 'refuse' in guard && 'confirm' in guard
    ? (guard as OwningResultGuard)
    : null;
};

/** A resolver path as response keys (aliases as written, list indexes as numbers). */
export const responsePathOf = (path: GraphQLResolveInfo['path'] | undefined): ResponsePath => {
  const keys: (string | number)[] = [];
  for (let at = path; at !== undefined; at = at.prev) keys.unshift(at.key);
  return keys;
};

/**
 * Final decisions for facts a field served for the object that owns it (its
 * parent field, `info.path.prev`): registered with the operation's guard,
 * which runs them after every selected field settled. Without a transport
 * guard (a bare executor) they are taken here, before the field returns.
 */
export const guardServedFacts = async (
  context: unknown,
  info: GraphQLResolveInfo | undefined,
  checks: readonly ServedFactsCheck[]
): Promise<void> => {
  if (checks.length === 0) return;
  const guard = owningResultGuardOf(context);
  if (guard === null || info === undefined) {
    unwrap(await confirmServedFacts(checks));
    return;
  }
  const owner = responsePathOf(info.path.prev);
  for (const check of checks) guard.confirm(owner, check);
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
  /** Kernel cache — the searchEntities resolver caches CANDIDATE answers only (T3). */
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
  roles?: readonly string[];
  isActive?: boolean;
  isUat?: boolean | null;
  entityTags?: readonly string[] | null;
  excludeEntityTags?: readonly string[] | null;
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

    organizationLabels: async (_root: unknown, args: { cuis: readonly string[] }) =>
      unwrap(await makeOrganizationLabels({ identityRepo: deps.identityRepo }, args.cuis)),

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
      context: KernelGraphqlContext,
      info?: GraphQLResolveInfo
    ): Promise<GlobalSearchResult> => {
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
        ...(args.roles !== undefined && { roles: args.roles }),
        ...(args.isActive !== undefined && { isActive: args.isActive }),
        ...(args.isUat != null && { isUat: args.isUat }),
        ...(args.entityTags != null && { entityTags: args.entityTags }),
        ...(args.excludeEntityTags != null && { excludeEntityTags: args.excludeEntityTags }),
        ...(args.limit !== undefined && { limit: args.limit }),
        ...(args.offset !== undefined && { offset: args.offset }),
      };
      // Only the engine's CANDIDATE answer is cached (short TTL), keyed by the
      // witnessed index generation + registry scope and a structured JSON
      // signature of the normalized query (never delimiter-joined). The final
      // answer is never cached: the company scope, parent access and company
      // values are read fresh for every request, cache hits included.
      const result = unwrap(
        await makeGlobalSearch(
          { ...deps.globalSearchDeps, candidateCache: deps.cache },
          searchInput
        )
      );
      // The company scope and the served identities' access are decided again
      // once the whole operation settled (empty answers included).
      const check = () => confirmGlobalSearchServed(deps.globalSearchDeps, result);
      const guard = owningResultGuardOf(context);
      if (guard === null || info === undefined) unwrap(await check());
      else guard.confirm(responsePathOf(info.path), check);
      return result;
    },
  },

  // The core vocabulary is lowercase; the SDL enums are uppercase.
  GlobalSearchResult: {
    companyContribution: (result: GlobalSearchResult): string =>
      result.companyContribution.toUpperCase(),
  },
  SearchHitCompany: {
    registryState: (company: SearchHitCompany): string => company.registryState.toUpperCase(),
  },

  // Field-level resolvers — each computed lazily per-request, so a query pays
  // only for what it selects. flowsIn/flowsOut hit the 19GB flow graph;
  // documentCount is a ~7s any(cuis) scan over 6.1M docs; territory + presence
  // are their own joins/fan-out. `entity(cui){ pnrr }` touches NONE of these.
  Entity: {
    identifiers: async (parent: { cui: string }): Promise<readonly OrgIdentifier[]> => {
      // Cross-source joins can provide only { cui }. Resolve through the same
      // identity/privacy guards as the root, never trust a supplied org_id.
      const core = unwrap(await makeEntityCore(deps.entity360Deps, parent.cui));
      if (core.organization === null) return [];
      return unwrap(await deps.identityRepo.getIdentifiers(core.organization.orgId));
    },
    flowsIn: async (parent: { cui: string }): Promise<FlowSummary> =>
      unwrap(await deps.flowsRepo.getFlowSummary(parent.cui, 'in')),
    flowsOut: async (parent: { cui: string }): Promise<FlowSummary> =>
      unwrap(await deps.flowsRepo.getFlowSummary(parent.cui, 'out')),
    territory: async (parent: { cui: string }): Promise<Territory | null> =>
      unwrap(await deps.identityRepo.territoryForCui(parent.cui)),
    documentCount: async (parent: { cui: string }): Promise<number> =>
      unwrap(await deps.searchRepo.countByCui(parent.cui)),
    presence: async (
      parent: { cui: string },
      _args: unknown,
      context: unknown,
      info?: GraphQLResolveInfo
    ): Promise<readonly SourcePresence[]> => {
      // A source's guard refusal throws here; `presence` is non-null, so it
      // withholds the owning Entity rather than reading as a missing badge.
      const fanOut = unwrap(await resolveEntityPresence(deps.registry, parent.cui));
      await guardServedFacts(context, info, fanOut.checks);
      return fanOut.presences;
    },
  },
});
