/**
 * Fastify Authentication Middleware
 *
 * Provides preHandler hooks for REST route authentication.
 */

import { AUTH_ERROR_HTTP_STATUS } from '../../core/errors.js';
import { authenticate, type AuthenticateDeps } from '../../core/usecases/authenticate.js';
import { requireAuth } from '../../core/usecases/require-auth.js';
import { httpSessionExtractor } from '../extractors/http-extractor.js';

import type { AuthContext } from '../../core/types.js';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

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
export function makeAuthMiddleware(deps: MakeAuthMiddlewareDeps): preHandlerHookHandler {
  // Fastify preHandler hooks support async functions that return Promise<void>
  // The type assertion is needed due to strict type checking with exactOptionalPropertyTypes
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = httpSessionExtractor.extractToken(request);

    const result = await authenticate(deps, { token });

    if (result.isErr()) {
      const error = result.error;
      const statusCode = AUTH_ERROR_HTTP_STATUS[error.type];

      await reply.status(statusCode).send({
        ok: false,
        error: error.type,
        message: error.message,
      });
      return;
    }

    // Attach to request for downstream handlers
    request.auth = result.value;
  };

  return handler as preHandlerHookHandler;
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
    });
  }
};

// Type assertion needed for async preHandler hooks with strictFunctionTypes
export const requireAuthHandler = requireAuthHandlerImpl as preHandlerHookHandler;
