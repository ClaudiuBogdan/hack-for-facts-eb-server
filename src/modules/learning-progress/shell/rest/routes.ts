/**
 * Learning Progress REST Routes
 *
 * REST API endpoints for learning progress sync.
 * All endpoints require authentication.
 */

import {
  GetProgressQuerySchema,
  SyncEventsBodySchema,
  GetProgressResponseSchema,
  SyncEventsResponseSchema,
  ErrorResponseSchema,
  type GetProgressQuery,
  type SyncEventsBody,
} from './schemas.js';
import { isAuthenticated } from '../../../auth/core/types.js';
import { requireAuthHandler } from '../../../auth/shell/middleware/fastify-auth.js';
import { getHttpStatusForError, type LearningProgressError } from '../../core/errors.js';
import { getProgress } from '../../core/usecases/get-progress.js';
import { syncEvents } from '../../core/usecases/sync-events.js';

import type { LearningProgressRepository } from '../../core/ports.js';
import type { LearningProgressEvent } from '../../core/types.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for learning progress routes.
 */
export interface MakeLearningProgressRoutesDeps {
  learningProgressRepo: LearningProgressRepository;
  onSyncEventsApplied?: (input: {
    userId: string;
    events: readonly LearningProgressEvent[];
  }) => Promise<void>;
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
    retryable: false,
  });
}

function buildErrorResponse(error: LearningProgressError) {
  if (error.type === 'TooManyEventsError') {
    return {
      ok: false as const,
      error: error.type,
      message: error.message,
      retryable: false,
      details: {
        limit: error.limit,
        provided: error.provided,
      },
    };
  }

  if (error.type === 'InvalidEventError') {
    return {
      ok: false as const,
      error: error.type,
      message: error.message,
      retryable: false,
      ...(error.eventId === undefined ? {} : { details: { eventId: error.eventId } }),
    };
  }

  return {
    ok: false as const,
    error: error.type,
    message: error.message,
    retryable: 'retryable' in error ? error.retryable : false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates learning progress REST routes.
 */
export const makeLearningProgressRoutes = (
  deps: MakeLearningProgressRoutesDeps
): FastifyPluginAsync => {
  const { learningProgressRepo, onSyncEventsApplied } = deps;

  return async (fastify) => {
    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/v1/learning/progress - Get progress snapshot and events
    // ─────────────────────────────────────────────────────────────────────────
    fastify.get<{ Querystring: GetProgressQuery }>(
      '/api/v1/learning/progress',
      {
        preHandler: requireAuthHandler,
        schema: {
          querystring: GetProgressQuerySchema,
          response: {
            200: GetProgressResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const userId = request.auth.userId as string;
        const { since } = request.query;

        const result = await getProgress({ repo: learningProgressRepo }, { userId, since });

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 500).send(buildErrorResponse(result.error));
        }

        return reply.status(200).send({
          ok: true,
          data: result.value,
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PUT /api/v1/learning/progress - Sync events
    // ─────────────────────────────────────────────────────────────────────────
    fastify.put<{ Body: SyncEventsBody }>(
      '/api/v1/learning/progress',
      {
        preHandler: requireAuthHandler,
        schema: {
          body: SyncEventsBodySchema,
          response: {
            200: SyncEventsResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const userId = request.auth.userId as string;
        const { clientUpdatedAt, events } = request.body;

        const result = await syncEvents(
          { repo: learningProgressRepo },
          {
            userId,
            clientUpdatedAt,
            events: events as LearningProgressEvent[],
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 500).send(buildErrorResponse(result.error));
        }

        if (onSyncEventsApplied !== undefined && result.value.appliedEvents.length > 0) {
          void onSyncEventsApplied({
            userId,
            events: result.value.appliedEvents,
          }).catch((error: unknown) => {
            request.log.error({ error, userId }, 'Learning progress post-sync hook failed');
          });
        }

        return reply.status(200).send({
          ok: true,
          data: {
            newEventsCount: result.value.newEventsCount,
            failedEvents: result.value.failedEvents,
          },
        });
      }
    );
  };
};
