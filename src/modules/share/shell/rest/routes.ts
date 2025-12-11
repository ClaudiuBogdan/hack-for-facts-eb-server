/**
 * Share Module REST Routes
 *
 * REST API for creating and resolving short links.
 * - POST /api/v1/short-links: Create (requires auth)
 * - GET /api/v1/short-links/:code: Resolve (public)
 */

import {
  CreateShortLinkBodySchema,
  ResolveShortLinkParamsSchema,
  CreateShortLinkResponseSchema,
  ResolveShortLinkResponseSchema,
  ErrorResponseSchema,
  type CreateShortLinkBody,
  type ResolveShortLinkParams,
} from './schemas.js';
import { isAuthenticated } from '../../../auth/core/types.js';
import { requireAuthHandler } from '../../../auth/shell/middleware/fastify-auth.js';
import {
  getHttpStatusForError,
  createUrlNotAllowedError,
  createRateLimitExceededError,
} from '../../core/errors.js';
import { isApprovedUrl } from '../../core/url-utils.js';
import { createShortLink } from '../../core/usecases/create-short-link.js';
import { resolveShortLink } from '../../core/usecases/resolve-short-link.js';

import type { Hasher, ShortLinkCache, ShortLinkRepository } from '../../core/ports.js';
import type { ShareConfig } from '../../core/types.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for share routes.
 */
export interface MakeShareRoutesDeps {
  shortLinkRepo: ShortLinkRepository;
  cache: ShortLinkCache;
  hasher: Hasher;
  config: ShareConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends an unauthorized error response.
 */
function sendUnauthorized(reply: FastifyReply) {
  return reply.status(401).send({
    ok: false,
    error: 'Unauthorized',
    message: 'Authentication required',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates share REST routes.
 */
export const makeShareRoutes = (deps: MakeShareRoutesDeps): FastifyPluginAsync => {
  const { shortLinkRepo, cache, hasher, config } = deps;

  return async (fastify) => {
    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/short-links - Create short link
    // ─────────────────────────────────────────────────────────────────────────
    fastify.post<{ Body: CreateShortLinkBody }>(
      '/api/v1/short-links',
      {
        preHandler: requireAuthHandler,
        schema: {
          body: CreateShortLinkBodySchema,
          response: {
            200: CreateShortLinkResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            429: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        // Check authentication
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const userId = request.auth.userId as string;
        const { url } = request.body;

        // Validate domain whitelist
        if (!isApprovedUrl(url, config.allowedOrigins)) {
          const error = createUrlNotAllowedError(url);
          return reply.status(400).send({
            ok: false,
            error: error.type,
            message: error.message,
          });
        }

        // Check rate limit
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const countResult = await shortLinkRepo.countRecentForUser(userId, since);

        if (countResult.isErr()) {
          const status = getHttpStatusForError(countResult.error);
          return reply.status(status as 500).send({
            ok: false,
            error: countResult.error.type,
            message: countResult.error.message,
          });
        }

        if (countResult.value >= config.dailyLimit) {
          const error = createRateLimitExceededError(userId, config.dailyLimit);
          return reply.status(429).send({
            ok: false,
            error: error.type,
            message: error.message,
          });
        }

        // Create short link
        const result = await createShortLink({ shortLinkRepo, hasher }, { userId, url });

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: { code: result.value.code },
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/v1/short-links/:code - Resolve short link
    // ─────────────────────────────────────────────────────────────────────────
    fastify.get<{ Params: ResolveShortLinkParams }>(
      '/api/v1/short-links/:code',
      {
        schema: {
          params: ResolveShortLinkParamsSchema,
          response: {
            200: ResolveShortLinkResponseSchema,
            400: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { code } = request.params;

        const result = await resolveShortLink({ shortLinkRepo, cache }, { code });

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 404 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: { url: result.value.url },
        });
      }
    );
  };
};
