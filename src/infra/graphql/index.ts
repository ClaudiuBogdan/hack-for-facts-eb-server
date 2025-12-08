import { makeExecutableSchema, type IExecutableSchemaDefinition } from '@graphql-tools/schema';
import mercuriusPlugin, { type IResolvers, type MercuriusLoaders } from 'mercurius';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

// Re-export common GraphQL utilities
export {
  CommonDirectives,
  CommonEnums,
  CommonScalars,
  CommonTypes,
  CommonGraphQLSchema,
  commonGraphQLResolvers,
  EnumResolvers,
} from './common/index.js';

/**
 * Context builder function type for Mercurius.
 * Allows custom context creation (e.g., for authentication).
 */
export type GraphQLContextBuilder<TContext = unknown> = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<TContext>;

export interface GraphQLOptions {
  schema: string[];
  resolvers: IResolvers[];
  enableGraphiQL?: boolean;
  /**
   * Optional Mercurius loaders for batching N+1 queries.
   * @see https://github.com/mercurius-js/mercurius/blob/master/docs/loaders.md
   */
  loaders?: MercuriusLoaders;
  /**
   * Optional context builder for adding custom context (e.g., auth).
   * If not provided, Mercurius uses default context (reply only).
   */
  context?: GraphQLContextBuilder;
}

/**
 * Creates the GraphQL plugin with the provided resolvers
 */
export const makeGraphQLPlugin = (options: GraphQLOptions): FastifyPluginAsync => {
  const {
    schema: baseSchema,
    resolvers,
    enableGraphiQL = process.env['NODE_ENV'] !== 'production',
    loaders,
    context,
  } = options;

  const schema = makeExecutableSchema({
    typeDefs: baseSchema,
    resolvers, // TODO: fix conflic with mercurius IResolvers
  } as IExecutableSchemaDefinition);

  return async (fastify) => {
    await fastify.register(mercuriusPlugin, {
      schema,
      graphiql: enableGraphiQL,
      path: '/graphql',
      // Mercurius loaders for batching N+1 queries (only add if defined)
      ...(loaders !== undefined && { loaders }),
      // Custom context builder (e.g., for authentication)
      ...(context !== undefined && { context }),
      errorFormatter: (execution, ctx) => {
        const response = mercuriusPlugin.defaultErrorFormatter(execution, ctx);
        // Here we could map domain errors to GraphQL errors as per Architecture spec
        // For now, we use the default formatter
        return response;
      },
    });
  };
};
