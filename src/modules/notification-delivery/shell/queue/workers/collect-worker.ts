/**
 * Collect Worker
 *
 * Processes collect jobs and enqueues compose jobs for each notification.
 */

import { Value } from '@sinclair/typebox/value';
import { Worker, UnrecoverableError, type Queue } from 'bullmq';

import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { CollectJobPayloadSchema } from '../../../core/schemas.js';
import { buildSubscriptionComposeJob } from '../compose-job-options.js';

import type { CollectJobPayload, ComposeJobPayload } from '../../../core/types.js';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for the collect worker.
 */
export interface CollectWorkerDeps {
  redis: Redis;
  composeQueue: Queue<ComposeJobPayload>;
  logger: Logger;
  bullmqPrefix: string;
  concurrency?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the collect worker.
 *
 * The collect worker receives notification IDs from the trigger endpoint
 * and enqueues a compose job for each one.
 */
export const createCollectWorker = (deps: CollectWorkerDeps): Worker<CollectJobPayload> => {
  const { redis, composeQueue, logger, bullmqPrefix, concurrency = 5 } = deps;
  const log = logger.child({ worker: 'collect' });

  return new Worker<CollectJobPayload>(
    QUEUE_NAMES.COLLECT,
    async (job) => {
      if (!Value.Check(CollectJobPayloadSchema, job.data)) {
        throw new UnrecoverableError('Invalid collect job payload');
      }

      const { runId, notificationType, periodKey, notificationIds } = job.data;

      log.info(
        { runId, notificationType, periodKey, count: notificationIds.length },
        'Processing collect job'
      );

      // Enqueue compose job for each notification
      const composeJobs = notificationIds.map((notificationId) =>
        buildSubscriptionComposeJob({
          runId,
          kind: 'subscription',
          notificationId,
          periodKey,
        })
      );

      if (composeJobs.length > 0) {
        await composeQueue.addBulk(composeJobs);
        log.info({ runId, count: composeJobs.length }, 'Enqueued compose jobs');
      }

      return {
        runId,
        processedCount: notificationIds.length,
        enqueuedCount: composeJobs.length,
      };
    },
    {
      connection: redis,
      prefix: bullmqPrefix,
      concurrency,
    }
  );
};
