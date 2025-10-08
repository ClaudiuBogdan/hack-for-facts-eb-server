import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../utils/auth-hook';
import { notificationService } from '../services/notifications/notificationService';
import { unsubscribeTokensRepository } from '../db/repositories/unsubscribeTokensRepository';
import { notificationsRepository } from '../db/repositories/notificationsRepository';
import { z } from 'zod';
import type { NotificationType, NotificationConfig } from '../services/notifications/types';

// Validation schemas
const subscribeSchema = z.object({
  notificationType: z.enum([
    'newsletter_entity_monthly',
    'newsletter_entity_quarterly',
    'newsletter_entity_yearly',
    'newsletter_entity_annual',
    'alert_data_series',
  ]),
  entityCui: z.string().optional().nullable(),
  config: z
    .object({
      includeTopCreditors: z.boolean().optional(),
      includeTopDebtors: z.boolean().optional(),
      dataSeriesType: z.enum(['spending', 'income', 'debt']).optional(),
      threshold: z.number().optional(),
      comparison: z.enum(['above', 'below']).optional(),
    })
    .optional()
    .nullable(),
});

const updateConfigSchema = z.object({
  config: z.object({
    includeTopCreditors: z.boolean().optional(),
    includeTopDebtors: z.boolean().optional(),
    dataSeriesType: z.enum(['spending', 'income', 'debt']).optional(),
    threshold: z.number().optional(),
    comparison: z.enum(['above', 'below']).optional(),
  }),
});

export default async function notificationRoutes(fastify: FastifyInstance) {
  await fastify.register(async function (fastify) {
    /**
     * POST /api/v1/notifications/subscribe
     * Subscribe to a notification
     */
    fastify.post(
      '/api/v1/notifications/subscribe',
      {
        preHandler: [authenticate],
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const body = subscribeSchema.parse(request.body);

          const notification = await notificationService.subscribe(
            userId,
            body.notificationType as NotificationType,
            body.entityCui,
            body.config as NotificationConfig | null
          );

          return reply.code(200).send({ ok: true, data: notification });
        } catch (err: any) {
          if (err.name === 'ZodError') {
            return reply.code(400).send({ ok: false, error: 'Invalid request body' });
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
    fastify.post<{ Params: { id: string } }>(
      '/api/v1/notifications/:id/unsubscribe',
      {
        preHandler: [authenticate],
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const notificationId = parseInt(request.params.id, 10);
          if (isNaN(notificationId)) {
            return reply.code(400).send({ ok: false, error: 'Invalid notification ID' });
          }

          // Verify ownership
          const notification = await notificationsRepository.findById(notificationId);
          if (!notification) {
            return reply.code(404).send({ ok: false, error: 'Notification not found' });
          }

          if (notification.userId !== userId) {
            return reply.code(403).send({ ok: false, error: 'Forbidden' });
          }

          const updated = await notificationService.unsubscribe(notificationId);

          return reply.code(200).send({ ok: true, data: updated });
        } catch (err: any) {
          request.log.error(err, 'Failed to unsubscribe from notification');
          return reply.code(500).send({ ok: false, error: 'Internal server error' });
        }
      }
    );

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
      '/api/v1/notifications/:id/config',
      {
        preHandler: [authenticate],
      },
      async (request, reply) => {
        const userId = request.auth?.userId;
        if (!userId) {
          return reply.code(401).send({ ok: false, error: 'Unauthorized' });
        }

        try {
          const notificationId = parseInt(request.params.id, 10);
          if (isNaN(notificationId)) {
            return reply.code(400).send({ ok: false, error: 'Invalid notification ID' });
          }

          const body = updateConfigSchema.parse(request.body);

          // Verify ownership
          const notification = await notificationsRepository.findById(notificationId);
          if (!notification) {
            return reply.code(404).send({ ok: false, error: 'Notification not found' });
          }

          if (notification.userId !== userId) {
            return reply.code(403).send({ ok: false, error: 'Forbidden' });
          }

          const updated = await notificationService.updateConfig(notificationId, body.config);

          return reply.code(200).send({ ok: true, data: updated });
        } catch (err: any) {
          if (err.name === 'ZodError') {
            return reply.code(400).send({ ok: false, error: 'Invalid request body' });
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
          const notificationId = parseInt(request.params.id, 10);
          if (isNaN(notificationId)) {
            return reply.code(400).send({ ok: false, error: 'Invalid notification ID' });
          }

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
