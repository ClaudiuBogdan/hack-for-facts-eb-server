import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../utils/auth-hook';
import { notificationService } from '../services/notifications/notificationService';
import { unsubscribeTokensRepository } from '../db/repositories/unsubscribeTokensRepository';
import { notificationsRepository } from '../db/repositories/notificationsRepository';
import { z } from 'zod';
import type { NotificationType, NotificationConfig } from '../services/notifications/types';
import { ValidationError } from '../utils/errors';
import { formatZodError } from '../utils/validation';
import { analyticsSeriesAlertConfigSchema, staticSeriesAlertConfigSchema } from '../schemas/alerts';

// Validation schemas

// Strong, per-type request body validation using discriminated union
const createNotificationBodySchema = z.discriminatedUnion('notificationType', [
  z.object({
    notificationType: z.literal('newsletter_entity_monthly'),
    entityCui: z.string().min(1),
    config: z.null().optional(),
  }),
  z.object({
    notificationType: z.literal('newsletter_entity_quarterly'),
    entityCui: z.string().min(1),
    config: z.null().optional(),
  }),
  z.object({
    notificationType: z.literal('newsletter_entity_yearly'),
    entityCui: z.string().min(1),
    config: z.null().optional(),
  }),
  z.object({
    notificationType: z.literal('alert_series_analytics'),
    entityCui: z.string().optional().nullable(),
    config: analyticsSeriesAlertConfigSchema,
  }),
  z.object({
    notificationType: z.literal('alert_series_static'),
    entityCui: z.string().optional().nullable(),
    config: staticSeriesAlertConfigSchema,
  }),
]);

const updateNotificationSchema = z.object({
  isActive: z.boolean().optional(),
  config: z.unknown().optional(),
});

const notificationIdParamsSchema = z.object({
  id: z.uuid(),
});

export default async function notificationRoutes(fastify: FastifyInstance) {
  await fastify.register(async function (fastify) {
    /**
     * POST /api/v1/notifications/subscribe
     * Subscribe to a notification
     */
    fastify.post(
      '/api/v1/notifications',
      {
        preHandler: [authenticate],
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const parsed = createNotificationBodySchema.safeParse(request.body);
          if (!parsed.success) {
            return reply
              .code(400)
              .send({ ok: false, error: 'Invalid request body', details: formatZodError(parsed.error) });
          }
          const { notificationType, entityCui } = parsed.data as any;
          const config: NotificationConfig = (parsed.data as any).config ?? null;

          const notification = await notificationService.subscribe(
            userId,
            notificationType as NotificationType,
            entityCui,
            config
          );

          return reply.code(200).send({ ok: true, data: notification });
        } catch (err: any) {
          if (err instanceof ValidationError) {
            return reply
              .code(400)
              .send({ ok: false, error: err.message, details: err.issues ?? [] });
          }
          request.log.error(err, 'Failed to subscribe to notification');
          return reply.code(500).send({ ok: false, error: err.message || 'Internal server error' });
        }
      }
    );

    /**
     * POST /api/v1/notifications/:id/unsubscribe
     * Unsubscribe from a notification (deactivate)
     */
    /**
     * GET /api/v1/notifications
     * Get all notifications for the authenticated user
     */
    fastify.get(
      '/api/v1/notifications',
      {
        preHandler: [authenticate],
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const notifications = await notificationService.getUserNotifications(userId, false);
          return reply.code(200).send({ ok: true, data: notifications });
        } catch (err: any) {
          request.log.error(err, 'Failed to get notifications');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

    /**
     * GET /api/v1/notifications/entity/:cui
     * Get notifications for a specific entity (user's notifications for that entity)
     */
    fastify.get<{ Params: { cui: string } }>(
      '/api/v1/notifications/entity/:cui',
      {
        preHandler: [authenticate],
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const { cui } = request.params;
          const notifications = await notificationService.getUserEntityNotifications(userId, cui);

          return reply.code(200).send({ ok: true, data: notifications });
        } catch (err: any) {
          request.log.error(err, 'Failed to get entity notifications');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

    /**
     * PATCH /api/v1/notifications/:id/config
     * Update notification configuration
     */
    fastify.patch<{ Params: { id: string } }>(
      '/api/v1/notifications/:id',
      {
        preHandler: [authenticate],
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const parsedParams = notificationIdParamsSchema.safeParse(request.params);
          if (!parsedParams.success) {
            return reply
              .code(400)
              .send({
                ok: false,
                error: 'Invalid notification ID',
                details: formatZodError(parsedParams.error),
              });
          }
          const notificationId = parsedParams.data.id;

          const parsed = updateNotificationSchema.safeParse(request.body);
          if (!parsed.success) {
            return reply
              .code(400)
              .send({ ok: false, error: 'Invalid request body', details: formatZodError(parsed.error) });
          }

          // Verify ownership
          const notification = await notificationsRepository.findById(notificationId);
          if (!notification) {
            return reply.code(404).send({ ok: false, error: 'Notification not found' });
          }

          if (notification.userId !== userId) {
            return reply.code(403).send({ ok: false, error: 'Forbidden' });
          }

          // If config provided, validate per notification type
          let updates: { isActive?: boolean; config?: NotificationConfig | null } = {};
          if (parsed.data.isActive !== undefined) {
            updates.isActive = parsed.data.isActive;
          }

          if (parsed.data.config !== undefined) {
            const cfg = parsed.data.config;
            if (notification.notificationType === 'alert_series_analytics') {
              const result = analyticsSeriesAlertConfigSchema.safeParse(cfg);
              if (!result.success) {
                return reply
                  .code(400)
                  .send({ ok: false, error: 'Invalid analytics alert config', details: formatZodError(result.error) });
              }
              updates.config = result.data;
            } else if (notification.notificationType === 'alert_series_static') {
              const result = staticSeriesAlertConfigSchema.safeParse(cfg);
              if (!result.success) {
                return reply
                  .code(400)
                  .send({ ok: false, error: 'Invalid static alert config', details: formatZodError(result.error) });
              }
              updates.config = result.data;
            } else {
              updates.config = null;
            }
          }

          const updated = await notificationService.update(notificationId, updates);

          return reply.code(200).send({ ok: true, data: updated });
        } catch (err: any) {
          if (err instanceof ValidationError) {
            return reply
              .code(400)
              .send({ ok: false, error: err.message, details: err.issues ?? [] });
          }
          request.log.error(err, 'Failed to update notification config');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

    /**
     * GET /api/v1/notifications/deliveries
     * Get delivery history for authenticated user
     */
    fastify.get<{ Querystring: { limit?: string; offset?: string } }>(
      '/api/v1/notifications/deliveries',
      {
        preHandler: [authenticate],
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
          const offset = request.query.offset ? parseInt(request.query.offset, 10) : 0;

          const deliveries = await notificationService.getUserDeliveryHistory(userId, limit, offset);

          return reply.code(200).send({ ok: true, data: deliveries });
        } catch (err: any) {
          request.log.error(err, 'Failed to get delivery history');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

    /**
     * GET /api/v1/notifications/unsubscribe/:token
     * Unsubscribe via email link (no authentication required)
     */
    fastify.get<{ Params: { token: string } }>(
      '/api/v1/notifications/unsubscribe/:token',
      async (request, reply) => {
        try {
          const { token } = request.params;

          // Validate token
          const isValid = await unsubscribeTokensRepository.isTokenValid(token);
          if (!isValid) {
            return reply.code(400).send({ ok: false, error: 'Invalid or expired token' });
          }

          // Get token details
          const tokenData = await unsubscribeTokensRepository.findByToken(token);
          if (!tokenData) {
            return reply.code(404).send({ ok: false, error: 'Token not found' });
          }

          // Mark token as used
          await unsubscribeTokensRepository.markAsUsed(token);

          // Deactivate notification
          await notificationService.unsubscribe(tokenData.notificationId);

          return reply.code(200).send({
            ok: true,
            message: 'Successfully unsubscribed from notifications',
          });
        } catch (err: any) {
          request.log.error(err, 'Failed to process unsubscribe');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

    /**
     * DELETE /api/v1/notifications/:id
     * Delete a notification and related data
     */
    fastify.delete<{ Params: { id: string } }>(
      '/api/v1/notifications/:id',
      {
        preHandler: [authenticate],
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const parsedParams = notificationIdParamsSchema.safeParse(request.params);
          if (!parsedParams.success) {
            return reply
              .code(400)
              .send({
                ok: false,
                error: 'Invalid notification ID',
                details: formatZodError(parsedParams.error),
              });
          }
          const notificationId = parsedParams.data.id;

          const notification = await notificationsRepository.findById(notificationId);
          if (!notification) {
            return reply.code(404).send({ ok: false, error: 'Notification not found' });
          }

          if (notification.userId !== userId) {
            return reply.code(403).send({ ok: false, error: 'Forbidden' });
          }

          await notificationService.deleteNotification(notificationId);

          return reply.code(200).send({ ok: true });
        } catch (err: any) {
          request.log.error(err, 'Failed to delete notification');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );
  });
}
