import { makeExecutableSchema, type IExecutableSchemaDefinition } from '@graphql-tools/schema';
import mercuriusPlugin, { type IResolvers, type MercuriusLoaders } from 'mercurius';

import type { FastifyPluginAsync } from 'fastify';

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

export interface GraphQLOptions {
  schema: string[];
  resolvers: IResolvers[];
  enableGraphiQL?: boolean;
  /**
   * Optional Mercurius loaders for batching N+1 queries.
   * @see https://github.com/mercurius-js/mercurius/blob/master/docs/loaders.md
   */
  loaders?: MercuriusLoaders;
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
      errorFormatter: (execution, context) => {
        const response = mercuriusPlugin.defaultErrorFormatter(execution, context);
        // Here we could map domain errors to GraphQL errors as per Architecture spec
        // For now, we use the default formatter
        return response;
      },
    });
  };
};
