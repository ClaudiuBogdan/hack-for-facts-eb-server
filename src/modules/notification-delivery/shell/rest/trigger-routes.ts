/**
 * Trigger Routes
 *
 * Manual trigger endpoint for notification collection.
 */

import { randomUUID } from 'node:crypto';

import { Type, type Static } from '@sinclair/typebox';

import { buildBullmqJobId } from '@/infra/queue/job-id.js';

import { createTriggerApiKeyPreHandler } from './trigger-auth.js';
import { generatePeriodKey, type NotificationType } from '../../../notifications/core/types.js';

import type { ExtendedNotificationsRepository } from '../../core/ports.js';
import type { CollectJobPayload, TriggerResponse } from '../../core/types.js';
import type { Queue } from 'bullmq';
import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const TriggerRequestSchema = Type.Object({
  notificationType: Type.Union([
    Type.Literal('newsletter_entity_monthly'),
    Type.Literal('newsletter_entity_quarterly'),
    Type.Literal('newsletter_entity_yearly'),
    Type.Literal('alert_series_analytics'),
    Type.Literal('alert_series_static'),
  ]),
  periodKey: Type.Optional(Type.String({ minLength: 4, maxLength: 10 })),
  dryRun: Type.Optional(Type.Boolean({ default: false })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 10000 })),
  force: Type.Optional(Type.Boolean({ default: false })),
});

type TriggerRequest = Static<typeof TriggerRequestSchema>;

const TriggerResponseSchema = Type.Object({
  runId: Type.String(),
  notificationType: Type.String(),
  periodKey: Type.String(),
  dryRun: Type.Boolean(),
  eligibleCount: Type.Number(),
  collectJobEnqueued: Type.Boolean(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for the trigger routes.
 */
export interface TriggerRoutesDeps {
  collectQueue: Queue<CollectJobPayload>;
  notificationsRepo: ExtendedNotificationsRepository;
  triggerApiKey: string;
  logger: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the trigger routes plugin.
 */
export const makeTriggerRoutes = (deps: TriggerRoutesDeps): FastifyPluginAsync => {
  const { collectQueue, notificationsRepo, triggerApiKey, logger } = deps;
  const log = logger.child({ routes: 'trigger' });
  const triggerApiKeyBuffer = Buffer.from(triggerApiKey, 'utf-8');

  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync pattern requires async
  return async (fastify) => {
    const authenticateApiKey = createTriggerApiKeyPreHandler(triggerApiKeyBuffer, log);

    // POST /api/v1/notifications/trigger
    fastify.post<{ Body: TriggerRequest }>(
      '/trigger',
      {
        preHandler: authenticateApiKey,
        schema: {
          body: TriggerRequestSchema,
          response: { 200: TriggerResponseSchema },
        },
      },
      async (request, reply) => {
        const {
          notificationType,
          periodKey: inputPeriodKey,
          dryRun = false,
          limit,
          force = false,
        } = request.body;

        const runId = randomUUID();
        const periodKey =
          inputPeriodKey ?? generatePeriodKey(notificationType as NotificationType, new Date());

        log.info(
          { runId, notificationType, periodKey, dryRun, limit, force },
          'Processing trigger request'
        );

        // Find eligible notifications
        const eligibleResult = await notificationsRepo.findEligibleForDelivery(
          notificationType as NotificationType,
          periodKey,
          limit,
          force
        );

        if (eligibleResult.isErr()) {
          log.error({ error: eligibleResult.error }, 'Failed to find eligible notifications');
          return reply.status(500).send({ error: 'Failed to find eligible notifications' });
        }

        const eligible = eligibleResult.value;
        const eligibleCount = eligible.length;

        log.info({ runId, eligibleCount, periodKey }, 'Found eligible notifications');

        // If dry run, just return counts
        if (dryRun) {
          const response: TriggerResponse = {
            runId,
            notificationType,
            periodKey,
            dryRun: true,
            eligibleCount,
            collectJobEnqueued: false,
          };

          return reply.send(response);
        }

        // If no eligible notifications, skip enqueue
        if (eligibleCount === 0) {
          const response: TriggerResponse = {
            runId,
            notificationType,
            periodKey,
            dryRun: false,
            eligibleCount: 0,
            collectJobEnqueued: false,
          };

          return reply.send(response);
        }

        // Generate job ID for deduplication
        // Default: dedupe by notificationType + periodKey (prevents accidental double-trigger)
        // With force=true: includes runId (allows intentional re-runs)
        const jobId = buildBullmqJobId(
          'collect',
          `${notificationType}\n${periodKey}`,
          force ? runId : 'dedupe'
        );

        // Enqueue collect job
        // BullMQ's add() always returns a Job (creates new or returns existing for duplicate jobId)
        await collectQueue.add(
          'collect',
          {
            runId,
            notificationType: notificationType as NotificationType,
            periodKey,
            notificationIds: eligible.map((n) => n.id),
          },
          {
            jobId,
            removeOnComplete: true,
            removeOnFail: true,
          }
        );

        // Note: BullMQ returns existing job for duplicate jobId, so we always report true
        const collectJobEnqueued = true;

        log.info({ runId, jobId, collectJobEnqueued, eligibleCount }, 'Collect job enqueued');

        const response: TriggerResponse = {
          runId,
          notificationType,
          periodKey,
          dryRun: false,
          eligibleCount,
          collectJobEnqueued,
        };

        return reply.send(response);
      }
    );
  };
};
