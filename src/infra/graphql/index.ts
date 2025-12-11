import { makeExecutableSchema, type IExecutableSchemaDefinition } from '@graphql-tools/schema';
import {
  NoSchemaIntrospectionCustomRule,
  Kind,
  type ValidationRule,
  type DocumentNode,
  type OperationDefinitionNode,
  type FieldNode,
} from 'graphql';
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

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL Logging Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts operation info from a GraphQL document AST.
 * Returns the first operation's name and type.
 */
function extractOperationInfo(document: DocumentNode): {
  operationName: string | null;
  operationType: string;
} {
  const operation = document.definitions.find(
    (def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION
  );

  return {
    operationName: operation?.name?.value ?? null,
    operationType: operation?.operation ?? 'unknown',
  };
}

/**
 * Extracts the top-level field names being queried.
 * E.g., for `query { entities { id } health { status } }` returns ['entities', 'health']
 */
function extractFieldNames(document: DocumentNode): string[] {
  const operation = document.definitions.find(
    (def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION
  );

  if (operation?.selectionSet === undefined) {
    return [];
  }

  return operation.selectionSet.selections
    .filter((sel): sel is FieldNode => sel.kind === Kind.FIELD)
    .map((field) => field.name.value);
}

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

    // ─────────────────────────────────────────────────────────────────────────
    // GraphQL Operation Logging
    // ─────────────────────────────────────────────────────────────────────────
    // Log GraphQL operations with useful context for observability.
    // Uses Mercurius hooks to capture operation details after execution.

    // Context extension for storing document between hooks
    interface GraphQLLoggingContext {
      graphqlDocument?: DocumentNode;
    }

    // Store document in context for logging in onResolution
    fastify.graphql.addHook('preExecution', (_schema, document, context) => {
      (context as GraphQLLoggingContext).graphqlDocument = document;
    });

    fastify.graphql.addHook('onResolution', (execution, context) => {
      // Get document from context (stored in preExecution hook)
      const document = (context as GraphQLLoggingContext).graphqlDocument;

      // Extract operation info if document is available
      let operationName: string | null = null;
      let operationType = 'unknown';
      let fields: string[] = [];

      if (document !== undefined) {
        const opInfo = extractOperationInfo(document);
        operationName = opInfo.operationName;
        operationType = opInfo.operationType;
        fields = extractFieldNames(document);
      }

      // Determine if there were errors
      const hasErrors = execution.errors !== undefined && execution.errors.length > 0;
      const errorCount = execution.errors?.length ?? 0;

      // Build log entry
      const logEntry = {
        graphql: {
          operationType,
          operationName,
          fields,
          hasErrors,
          errorCount,
        },
      };

      // Log at appropriate level
      if (hasErrors) {
        context.reply.log.warn(
          { ...logEntry, errors: execution.errors },
          `GraphQL ${operationType} "${operationName ?? 'anonymous'}" completed with ${String(errorCount)} error(s)`
        );
      } else {
        context.reply.log.info(
          logEntry,
          `GraphQL ${operationType} "${operationName ?? 'anonymous'}" [${fields.join(', ')}]`
        );
      }
    });
  };
};
