/**
 * Collect Worker
 *
 * Processes collect jobs and enqueues compose jobs for each notification.
 */

import { Worker, type Queue } from 'bullmq';

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
    'notification:collect',
    async (job) => {
      const { runId, notificationType, periodKey, notificationIds } = job.data;

      log.info(
        { runId, notificationType, periodKey, count: notificationIds.length },
        'Processing collect job'
      );

      // Enqueue compose job for each notification
      const composeJobs = notificationIds.map((notificationId) => ({
        name: 'compose',
        data: {
          runId,
          notificationId,
          periodKey,
        } satisfies ComposeJobPayload,
        opts: {
          // Dedupe by notificationId + periodKey to prevent double-compose
          jobId: `compose:${notificationId}:${periodKey}`,
        },
      }));

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
