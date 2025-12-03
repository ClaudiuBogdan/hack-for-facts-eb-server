import { makeExecutableSchema, type IExecutableSchemaDefinition } from '@graphql-tools/schema';
import mercuriusPlugin, { type IResolvers } from 'mercurius';

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
}

/**
 * Creates the GraphQL plugin with the provided resolvers
 */
export const makeGraphQLPlugin = (options: GraphQLOptions): FastifyPluginAsync => {
  const {
    schema: baseSchema,
    resolvers,
    enableGraphiQL = process.env['NODE_ENV'] !== 'production',
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
      errorFormatter: (execution, context) => {
        const response = mercuriusPlugin.defaultErrorFormatter(execution, context);
        // Here we could map domain errors to GraphQL errors as per Architecture spec
        // For now, we use the default formatter
        return response;
      },
    });
  };
};
