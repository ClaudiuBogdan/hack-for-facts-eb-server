import { makeExecutableSchema, type IExecutableSchemaDefinition } from '@graphql-tools/schema';
import { NoSchemaIntrospectionCustomRule, type ValidationRule } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import mercuriusPlugin, { type IResolvers, type MercuriusLoaders } from 'mercurius';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Security Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum allowed query depth.
 * SECURITY: SEC-002 - Prevents DoS via deeply nested queries.
 *
 * Value of 10 allows legitimate nested queries like:
 * entities → uat → county_entity → reports → executionLineItems (depth 5)
 * while blocking abusive patterns.
 */
const MAX_QUERY_DEPTH = 10;

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
 *
 * SECURITY FEATURES:
 * - VUL-004: Query depth limiting (max 10 levels)
 * - VUL-005: Introspection disabled in production
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
    resolvers, // TODO: fix conflict with mercurius IResolvers
  } as IExecutableSchemaDefinition);

  // Determine if running in production
  const isProduction = process.env['NODE_ENV'] === 'production';

  // Build validation rules based on environment
  // SECURITY: SEC-002 - Depth limiting always enabled (prevents DoS via nested queries)
  // SECURITY: SEC-001 - Introspection disabled in production only (prevents schema exposure)
  const validationRules: ValidationRule[] = [
    depthLimit(MAX_QUERY_DEPTH) as ValidationRule,
    ...(isProduction ? [NoSchemaIntrospectionCustomRule] : []),
  ];

  return async (fastify) => {
    await fastify.register(mercuriusPlugin, {
      schema,
      graphiql: enableGraphiQL,
      path: '/graphql',
      // SECURITY: Apply validation rules for depth limiting and introspection control
      validationRules,
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
