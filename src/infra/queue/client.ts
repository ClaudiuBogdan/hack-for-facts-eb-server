/**
 * BullMQ Queue Client
 *
 * Provides queue and worker factories with proper configuration.
 * IMPORTANT: Uses BullMQ's own prefix option, NOT ioredis keyPrefix.
 */

import { Queue, Worker, type Job, type Processor, type WorkerOptions } from 'bullmq';

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Queue client configuration.
 */
export interface QueueClientConfig {
  /** Redis connection (must NOT have keyPrefix set) */
  redis: Redis;
  /** BullMQ queue key prefix */
  prefix: string;
  /** Logger instance */
  logger: Logger;
}

/**
 * Worker creation options.
 */
export interface CreateWorkerOptions<T> {
  /** Queue name */
  name: string;
  /** Job processor function */
  processor: Processor<T>;
  /** Worker-specific options */
  options?: Partial<WorkerOptions>;
}

/**
 * Queue client interface.
 */
export interface QueueClient {
  /** Get or create a queue instance */
  getQueue<T = unknown>(name: string): Queue<T>;
  /** Create a worker for a queue */
  createWorker<T = unknown>(options: CreateWorkerOptions<T>): Worker<T>;
  /** Close all queues and workers */
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue Names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard queue names for notification delivery pipeline.
 */
export const QUEUE_NAMES = {
  /** Collects eligible notifications for a period */
  COLLECT: 'notification:collect',
  /** Composes email content and persists delivery records */
  COMPOSE: 'notification:compose',
  /** Sends emails via Resend (rate-limited) */
  SEND: 'notification:send',
  /** Dead letter queue for failed jobs */
  DLQ: 'notification:dlq',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a BullMQ queue client.
 *
 * CRITICAL: The Redis connection must NOT have ioredis keyPrefix set.
 * BullMQ uses its own prefix mechanism which is incompatible with ioredis keyPrefix.
 */
export const makeQueueClient = (config: QueueClientConfig): QueueClient => {
  const { redis, prefix, logger } = config;
  const log = logger.child({ component: 'QueueClient' });

  const queues = new Map<string, Queue>();
  const workers: Worker[] = [];

  log.info({ prefix }, 'Initializing BullMQ queue client');

  return {
    getQueue<T = unknown>(name: string): Queue<T> {
      let queue = queues.get(name) as Queue<T> | undefined;
      if (queue === undefined) {
        log.debug({ name, prefix }, 'Creating queue');
        queue = new Queue<T>(name, {
          connection: redis,
          prefix, // Use BullMQ's prefix, NOT ioredis keyPrefix
        });
        queues.set(name, queue as Queue);
      }
      return queue;
    },

    createWorker<T = unknown>(options: CreateWorkerOptions<T>): Worker<T> {
      const { name, processor, options: workerOptions = {} } = options;

      log.info({ name, prefix }, 'Creating worker');

      const worker = new Worker<T>(name, processor, {
        connection: redis,
        prefix, // Use BullMQ's prefix, NOT ioredis keyPrefix
        ...workerOptions,
      });

      // Set up event handlers
      worker.on('completed', (job: Job<T>) => {
        log.debug({ jobId: job.id, queue: name }, 'Job completed');
      });

      worker.on('failed', (job: Job<T> | undefined, error: Error) => {
        log.error({ jobId: job?.id, queue: name, error: error.message }, 'Job failed');
      });

      worker.on('error', (error: Error) => {
        log.error({ queue: name, error: error.message }, 'Worker error');
      });

      workers.push(worker as Worker);
      return worker;
    },

    async close(): Promise<void> {
      log.info('Closing queue client');

      // Close all workers first
      await Promise.all(
        workers.map(async (worker) => {
          try {
            await worker.close();
          } catch (error) {
            log.error({ error }, 'Error closing worker');
          }
        })
      );

      // Close all queues
      await Promise.all(
        [...queues.values()].map(async (queue) => {
          try {
            await queue.close();
          } catch (error) {
            log.error({ error }, 'Error closing queue');
          }
        })
      );

      log.info('Queue client closed');
    },
  };
};
