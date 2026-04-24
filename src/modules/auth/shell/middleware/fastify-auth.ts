/**
 * Fastify Authentication Middleware
 *
 * Provides preHandler hooks for REST route authentication.
 */

import { AUTH_ERROR_HTTP_STATUS } from '../../core/errors.js';
import { isAuthenticated, type AuthContext } from '../../core/types.js';
import { authenticate, type AuthenticateDeps } from '../../core/usecases/authenticate.js';
import { requireAuth } from '../../core/usecases/require-auth.js';
import { httpSessionExtractor } from '../extractors/http-extractor.js';

import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Request Decoration
// ─────────────────────────────────────────────────────────────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    /** Authentication context (set by auth middleware) */
    auth: AuthContext;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for creating auth middleware.
 */
export type MakeAuthMiddlewareDeps = AuthenticateDeps;

function enrichRequestLoggerWithUserId(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string
): void {
  const child = request.log.child({ userId });
  request.log = child;
  reply.log = child;
}

// ─────────────────────────────────────────────────────────────────────────────
// Global Middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates authentication middleware that:
 * 1. Extracts token from request
 * 2. Authenticates (or creates anonymous session)
 * 3. Attaches auth context to request
 *
 * This middleware does NOT reject anonymous requests - it just populates
 * request.auth. Use requireAuthHandler to protect specific routes.
 *
 * @example
 * // In app setup
 * const authMiddleware = makeAuthMiddleware({ authProvider });
 *
 * // Apply globally
 * app.addHook('preHandler', authMiddleware);
 *
 * // In route handler
 * app.get('/my-route', async (request) => {
 *   if (isAuthenticated(request.auth)) {
 *     console.log('User ID:', request.auth.userId);
 *   }
 * });
 */
export function makeAuthMiddleware(deps: MakeAuthMiddlewareDeps): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = httpSessionExtractor.extractToken(request);

    const result = await authenticate(deps, { token });

    if (result.isErr()) {
      const error = result.error;
      const statusCode = AUTH_ERROR_HTTP_STATUS[error.type];

      await reply.status(statusCode).send({
        ok: false,
        error: error.type,
        message: error.message,
        retryable: false,
      });
      return;
    }

    // Attach to request for downstream handlers
    request.auth = result.value;

    if (isAuthenticated(result.value)) {
      enrichRequestLoggerWithUserId(request, reply, result.value.userId);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route-level guard that requires authentication.
 * Use as preHandler on protected routes.
 *
 * Assumes the global auth middleware has already run and set request.auth.
 *
 * @example
 * // Protected route
 * app.post('/api/notifications', {
 *   preHandler: requireAuthHandler,
 * }, async (request) => {
 *   // request.auth is guaranteed to be authenticated here
 *   const userId = request.auth.userId;
 *   // ...
 * });
 */
const requireAuthHandlerImpl = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const result = requireAuth(request.auth);

  if (result.isErr()) {
    await reply.status(401).send({
      ok: false,
      error: result.error.type,
      message: result.error.message,
      retryable: false,
    });
  }
};

export const requireAuthHandler: preHandlerAsyncHookHandler = requireAuthHandlerImpl;
