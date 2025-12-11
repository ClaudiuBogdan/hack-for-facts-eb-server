/**
 * GraphQL Authentication Context
 *
 * Builds Mercurius context with authentication information.
 */

import { AUTH_ERROR_GQL_CODE, type AuthError } from '../../core/errors.js';
import { ANONYMOUS_SESSION, type AuthContext, type UserId } from '../../core/types.js';
import { authenticate, type AuthenticateDeps } from '../../core/usecases/authenticate.js';
import { requireAuth } from '../../core/usecases/require-auth.js';
import { httpSessionExtractor } from '../extractors/http-extractor.js';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MercuriusContext } from 'mercurius';

// ─────────────────────────────────────────────────────────────────────────────
// Extended Context Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended Mercurius context with authentication.
 */
export interface AuthenticatedMercuriusContext extends MercuriusContext {
  auth: AuthContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for creating GraphQL context.
 */
export type MakeGraphQLContextDeps = AuthenticateDeps;

// ─────────────────────────────────────────────────────────────────────────────
// Context Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates Mercurius context builder with authentication.
 *
 * For GraphQL, we don't reject requests with invalid tokens - we let
 * resolvers decide how to handle anonymous requests. This allows
 * public queries even when authentication fails.
 *
 * @example
 * // In app setup
 * const buildContext = makeGraphQLContext({ authProvider });
 *
 * app.register(mercurius, {
 *   schema,
 *   resolvers,
 *   context: buildContext,
 * });
 */
export const makeGraphQLContext = (deps: MakeGraphQLContextDeps) => {
  return async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<AuthenticatedMercuriusContext> => {
    const token = httpSessionExtractor.extractToken(request);

    const result = await authenticate(deps, { token });

    // For GraphQL, we don't reject - we let resolvers decide
    // Invalid tokens result in anonymous context
    const auth: AuthContext = result.isOk() ? result.value : ANONYMOUS_SESSION;

    return {
      reply,
      auth,
    } as AuthenticatedMercuriusContext;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL Error
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GraphQL error with proper extensions for auth failures.
 */
export class AuthGraphQLError extends Error {
  extensions: { code: string };

  constructor(error: AuthError) {
    super(error.message);
    this.name = 'AuthGraphQLError';
    this.extensions = {
      code: AUTH_ERROR_GQL_CODE[error.type],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Require authentication in a resolver. Throws GraphQL error if anonymous.
 * Returns the authenticated user ID.
 *
 * @example
 * // In resolver
 * const resolvers = {
 *   Mutation: {
 *     createNotification: async (_, args, context: AuthenticatedMercuriusContext) => {
 *       const userId = requireAuthOrThrow(context.auth);
 *       return notificationRepo.create({ userId, ...args });
 *     },
 *   },
 * };
 */
export const requireAuthOrThrow = (auth: AuthContext): UserId => {
  const result = requireAuth(auth);

  if (result.isErr()) {
    throw new AuthGraphQLError(result.error);
  }

  return result.value;
};

/**
 * Higher-order function to wrap resolver with auth requirement.
 * Passes userId as the last argument to the resolver.
 *
 * @example
 * const resolvers = {
 *   Mutation: {
 *     createNotification: withAuth(async (_, args, context, userId) => {
 *       // userId is guaranteed to be valid here
 *       return notificationRepo.create({ userId, ...args });
 *     }),
 *   },
 * };
 */
export const withAuth = <TParent, TArgs, TResult>(
  resolver: (
    parent: TParent,
    args: TArgs,
    context: AuthenticatedMercuriusContext,
    userId: UserId
  ) => Promise<TResult>
) => {
  return async (
    parent: TParent,
    args: TArgs,
    context: AuthenticatedMercuriusContext
  ): Promise<TResult> => {
    const userId = requireAuthOrThrow(context.auth);
    return resolver(parent, args, context, userId);
  };
};
