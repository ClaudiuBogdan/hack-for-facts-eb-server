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
  UnsubscribeTokenSigner,
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
  tokenSigner: UnsubscribeTokenSigner;
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

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates notification REST routes.
 */
export const makeNotificationRoutes = (deps: MakeNotificationRoutesDeps): FastifyPluginAsync => {
  const { notificationsRepo, deliveriesRepo, tokenSigner, hasher } = deps;

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
        const config = request.body.config ?? null;
        const userId = request.auth.userId as string;

        const result = await subscribe(
          { notificationsRepo, hasher },
          {
            userId,
            notificationType,
            entityCui: entityCui ?? null,
            config,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          if (status === 400 || status === 500) {
            return reply.status(status).send({
              ok: false,
              error: result.error.type,
              message: result.error.message,
            });
          }

          // Defensive fallback: this route shouldn't return other status codes.
          return reply.status(500).send({
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
          return reply.status(500).send({
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
          return reply.status(500).send({
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
    // PATCH/PUT /api/v1/notifications/:id - Update subscription
    // ─────────────────────────────────────────────────────────────────────────
    fastify.route<{ Params: NotificationIdParams; Body: UpdateNotificationBody }>({
      method: ['PATCH', 'PUT'],
      url: '/api/v1/notifications/:id',
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
      handler: async (request, reply) => {
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
          updates.config = config;
        }

        const result = await updateNotification(
          { notificationsRepo, hasher },
          { notificationId: id, userId, updates }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          if (status === 400 || status === 403 || status === 404 || status === 500) {
            return reply.status(status).send({
              ok: false,
              error: result.error.type,
              message: result.error.message,
            });
          }

          return reply.status(500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: formatNotification(result.value),
        });
      },
    });

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
          if (status === 403 || status === 404 || status === 500) {
            return reply.status(status).send({
              ok: false,
              error: result.error.type,
              message: result.error.message,
            });
          }

          return reply.status(500).send({
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
        const limit = parseOptionalInt(request.query.limit);
        const offset = parseOptionalInt(request.query.offset);

        const result = await listDeliveries(
          { deliveriesRepo },
          {
            userId,
            limit: limit ?? DEFAULT_DELIVERIES_LIMIT,
            ...(offset !== undefined && { offset }),
          }
        );

        if (result.isErr()) {
          return reply.status(500).send({
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
            scopeKey: d.scopeKey,
            sentAt: d.sentAt.toISOString(),
            status: d.status,
            metadata: d.metadata,
          })),
        });
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // GET/POST /api/v1/notifications/unsubscribe/:token - Token-based unsubscribe
    // (NO AUTH REQUIRED - token authenticates the request)
    //
    // Content negotiation:
    // - GET with Accept: text/html → HTML success page (browser click from email)
    // - GET with Accept: application/json → JSON response
    // - POST → JSON response (Gmail one-click unsubscribe per RFC 8058)
    //
    // Errors always return success to prevent token enumeration.
    // ─────────────────────────────────────────────────────────────────────────
    fastify.route<{ Params: UnsubscribeTokenParams }>({
      method: ['GET', 'POST'],
      url: '/api/v1/notifications/unsubscribe/:token',
      schema: {
        params: UnsubscribeTokenParamsSchema,
      },
      handler: async (request, reply) => {
        const { token } = request.params;
        const isOneClickPost = request.method === 'POST';
        const acceptsJson =
          isOneClickPost || request.headers.accept?.includes('application/json') === true;

        const result = await unsubscribeViaToken({ notificationsRepo, tokenSigner }, { token });

        // For errors, still show success to prevent token enumeration
        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          request.log.warn(
            { error: result.error.type, status },
            'Unsubscribe failed, but showing success response for security'
          );

          if (isOneClickPost) {
            return reply.status(200).send();
          }

          if (acceptsJson) {
            return reply.status(200).send({ ok: true, unsubscribed: true });
          }

          return reply.type('text/html').send(renderUnsubscribeSuccessPage());
        }

        if (isOneClickPost) {
          return reply.status(200).send();
        }

        if (acceptsJson) {
          return reply.status(200).send({ ok: true, unsubscribed: true });
        }

        return reply.type('text/html').send(renderUnsubscribeSuccessPage());
      },
    });
  };
};

/**
 * Renders a simple HTML page for successful unsubscribe.
 */
function renderUnsubscribeSuccessPage(): string {
  return `<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dezabonare reușită - Transparența.eu</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      max-width: 600px;
      margin: 0 auto;
      padding: 40px 20px;
      background-color: #f8f9fa;
      color: #333;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      text-align: center;
    }
    h1 {
      color: #2563eb;
      font-size: 24px;
      margin-bottom: 16px;
    }
    p {
      color: #666;
      margin-bottom: 24px;
    }
    .icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    a {
      color: #2563eb;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">✓</div>
    <h1>Dezabonare reușită</h1>
    <p>Ați fost dezabonat de la această notificare. Nu veți mai primi emailuri pentru această abonare.</p>
    <p>Dacă v-ați răzgândit, puteți gestiona notificările din <a href="https://transparenta.eu/settings/notifications">setări</a>.</p>
  </div>
</body>
</html>`;
}
