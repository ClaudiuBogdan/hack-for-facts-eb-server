import mercuriusPlugin, { type IResolvers } from 'mercurius';

import type { FastifyPluginAsync } from 'fastify';

export interface GraphQLOptions {
  schema: string[];
  resolvers: IResolvers;
  enableGraphiQL?: boolean;
}

/**
 * Creates the GraphQL plugin with the provided resolvers
 */
export const makeGraphQLPlugin = (options: GraphQLOptions): FastifyPluginAsync => {
  const { schema, resolvers, enableGraphiQL = process.env['NODE_ENV'] !== 'production' } = options;

  return async (fastify) => {
    await fastify.register(mercuriusPlugin, {
      schema,
      resolvers,
      graphiql: enableGraphiQL,
      path: '/graphql',
      errorFormatter: (execution, context) => {
        const response = mercuriusPlugin.defaultErrorFormatter(execution, context);
        // Here we could map domain errors to GraphQL errors as per Architecture spec
        // For now, we use the default formatter
        return response;
      },
    });
  };
};
