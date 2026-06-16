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
import { makeEntity360, type Entity360, type Entity360Deps } from '../../core/usecases/entity-360.js';
import {
  makeGlobalSearch,
  type GlobalSearchDeps,
} from '../../core/usecases/global-search.js';


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
  readonly health: () => Promise<unknown>;
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

    entity: async (_root: unknown, args: EntityArgs): Promise<Entity360 | null> => {
      const result = await makeEntity360(deps.entity360Deps, args.cui);
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
});
