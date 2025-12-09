/**
 * Notifications REST Routes
 *
 * REST API for notification subscriptions.
 * All endpoints except unsubscribe require authentication.
 */

import {
  SubscribeBodySchema,
  UpdateNotificationBodySchema,
  NotificationIdParamsSchema,
  EntityCuiParamsSchema,
  UnsubscribeTokenParamsSchema,
  DeliveriesQuerySchema,
  NotificationResponseSchema,
  NotificationListResponseSchema,
  DeliveryListResponseSchema,
  MessageResponseSchema,
  ErrorResponseSchema,
  OkResponseSchema,
  type SubscribeBody,
  type UpdateNotificationBody,
  type NotificationIdParams,
  type EntityCuiParams,
  type UnsubscribeTokenParams,
  type DeliveriesQuery,
} from './schemas.js';
import { isAuthenticated } from '../../../auth/core/types.js';
import { requireAuthHandler } from '../../../auth/shell/middleware/fastify-auth.js';
import { getHttpStatusForError } from '../../core/errors.js';
import { type NotificationConfig, DEFAULT_DELIVERIES_LIMIT } from '../../core/types.js';
import { deleteNotification } from '../../core/usecases/delete-notification.js';
import { listDeliveries } from '../../core/usecases/list-deliveries.js';
import {
  listUserNotifications,
  listEntityNotifications,
} from '../../core/usecases/list-notifications.js';
import { subscribe } from '../../core/usecases/subscribe.js';
import { unsubscribeViaToken } from '../../core/usecases/unsubscribe-via-token.js';
import { updateNotification } from '../../core/usecases/update-notification.js';

import type {
  Hasher,
  NotificationsRepository,
  DeliveriesRepository,
  UnsubscribeTokensRepository,
} from '../../core/ports.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for notifications routes.
 */
export interface MakeNotificationRoutesDeps {
  notificationsRepo: NotificationsRepository;
  deliveriesRepo: DeliveriesRepository;
  tokensRepo: UnsubscribeTokensRepository;
  hasher: Hasher;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats a notification for API response.
 */
function formatNotification(notification: {
  id: string;
  userId: string;
  entityCui: string | null;
  notificationType: string;
  isActive: boolean;
  config: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: notification.id,
    userId: notification.userId,
    entityCui: notification.entityCui,
    notificationType: notification.notificationType,
    isActive: notification.isActive,
    config: notification.config,
    createdAt: notification.createdAt.toISOString(),
    updatedAt: notification.updatedAt.toISOString(),
  };
}

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
 * Creates notification REST routes.
 */
export const makeNotificationRoutes = (deps: MakeNotificationRoutesDeps): FastifyPluginAsync => {
  const { notificationsRepo, deliveriesRepo, tokensRepo, hasher } = deps;

  return async (fastify) => {
    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/notifications - Create subscription (all types)
    // ─────────────────────────────────────────────────────────────────────────
    fastify.post<{ Body: SubscribeBody }>(
      '/api/v1/notifications',
      {
        preHandler: requireAuthHandler,
        schema: {
          body: SubscribeBodySchema,
          response: {
            200: NotificationResponseSchema,
            201: NotificationResponseSchema,
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

        const { notificationType, entityCui } = request.body;
        const config = 'config' in request.body ? request.body.config : null;
        const userId = request.auth.userId as string;

        const result = await subscribe(
          { notificationsRepo, hasher },
          {
            userId,
            notificationType,
            entityCui: entityCui ?? null,
            config: config as unknown as NotificationConfig,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        const notification = result.value;
        // Return 200 if existing (reactivated), 201 if new
        const isNew = notification.createdAt.getTime() === notification.updatedAt.getTime();
        const statusCode = isNew ? 201 : 200;
        return reply.status(statusCode).send({
          ok: true,
          data: formatNotification(notification),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/v1/notifications - List user's subscriptions
    // ─────────────────────────────────────────────────────────────────────────
    fastify.get(
      '/api/v1/notifications',
      {
        preHandler: requireAuthHandler,
        schema: {
          response: {
            200: NotificationListResponseSchema,
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
        const result = await listUserNotifications({ notificationsRepo }, { userId });

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: result.value.map(formatNotification),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/v1/notifications/entity/:cui - List entity subscriptions
    // ─────────────────────────────────────────────────────────────────────────
    fastify.get<{ Params: EntityCuiParams }>(
      '/api/v1/notifications/entity/:cui',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: EntityCuiParamsSchema,
          response: {
            200: NotificationListResponseSchema,
            401: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const { cui } = request.params;
        const userId = request.auth.userId as string;

        const result = await listEntityNotifications(
          { notificationsRepo },
          { userId, entityCui: cui }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: result.value.map(formatNotification),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // PATCH /api/v1/notifications/:id - Update subscription
    // ─────────────────────────────────────────────────────────────────────────
    fastify.patch<{ Params: NotificationIdParams; Body: UpdateNotificationBody }>(
      '/api/v1/notifications/:id',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: NotificationIdParamsSchema,
          body: UpdateNotificationBodySchema,
          response: {
            200: NotificationResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const { id } = request.params;
        const userId = request.auth.userId as string;
        const { isActive, config } = request.body;

        // Build updates object conditionally
        const updates: { isActive?: boolean; config?: NotificationConfig } = {};
        if (isActive !== undefined) {
          updates.isActive = isActive;
        }
        if (config !== undefined) {
          updates.config = config as unknown as NotificationConfig;
        }

        const result = await updateNotification(
          { notificationsRepo, hasher },
          { notificationId: id, userId, updates }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 403 | 404 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: formatNotification(result.value),
        });
      }
    );

    // Also register PUT as alias for PATCH (backwards compatibility)
    fastify.put<{ Params: NotificationIdParams; Body: UpdateNotificationBody }>(
      '/api/v1/notifications/:id',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: NotificationIdParamsSchema,
          body: UpdateNotificationBodySchema,
          response: {
            200: NotificationResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const { id } = request.params;
        const userId = request.auth.userId as string;
        const { isActive, config } = request.body;

        const updates: { isActive?: boolean; config?: NotificationConfig } = {};
        if (isActive !== undefined) {
          updates.isActive = isActive;
        }
        if (config !== undefined) {
          updates.config = config as unknown as NotificationConfig;
        }

        const result = await updateNotification(
          { notificationsRepo, hasher },
          { notificationId: id, userId, updates }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 403 | 404 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: formatNotification(result.value),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // DELETE /api/v1/notifications/:id - Delete subscription
    // ─────────────────────────────────────────────────────────────────────────
    fastify.delete<{ Params: NotificationIdParams }>(
      '/api/v1/notifications/:id',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: NotificationIdParamsSchema,
          response: {
            200: OkResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const { id } = request.params;
        const userId = request.auth.userId as string;

        const result = await deleteNotification(
          { notificationsRepo },
          { notificationId: id, userId }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 403 | 404 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({ ok: true });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // GET /api/v1/notifications/deliveries - List delivery history
    // ─────────────────────────────────────────────────────────────────────────
    fastify.get<{ Querystring: DeliveriesQuery }>(
      '/api/v1/notifications/deliveries',
      {
        preHandler: requireAuthHandler,
        schema: {
          querystring: DeliveriesQuerySchema,
          response: {
            200: DeliveryListResponseSchema,
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
        const limit =
          request.query.limit !== undefined
            ? parseInt(request.query.limit, 10)
            : DEFAULT_DELIVERIES_LIMIT;
        const offset = request.query.offset !== undefined ? parseInt(request.query.offset, 10) : 0;

        const result = await listDeliveries({ deliveriesRepo }, { userId, limit, offset });

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: result.value.map((d) => ({
            id: d.id,
            notificationId: d.notificationId,
            periodKey: d.periodKey,
            sentAt: d.sentAt.toISOString(),
            metadata: d.metadata,
          })),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // POST /api/v1/notifications/unsubscribe/:token - Token-based unsubscribe
    // (NO AUTH REQUIRED - token authenticates the request)
    // ─────────────────────────────────────────────────────────────────────────
    fastify.post<{ Params: UnsubscribeTokenParams }>(
      '/api/v1/notifications/unsubscribe/:token',
      {
        schema: {
          params: UnsubscribeTokenParamsSchema,
          response: {
            200: MessageResponseSchema,
            400: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { token } = request.params;

        const result = await unsubscribeViaToken({ notificationsRepo, tokensRepo }, { token });

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 404 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        // Log warning if token marking failed (notification was still deactivated)
        if (result.value.tokenMarkingFailed) {
          request.log.warn(
            {
              token,
              notificationId: result.value.notification.id,
              error: result.value.tokenMarkingError,
            },
            'Failed to mark unsubscribe token as used - token may be reusable'
          );
        }

        return reply.status(200).send({
          ok: true,
          data: { message: 'Successfully unsubscribed' },
        });
      }
    );
  };
};
