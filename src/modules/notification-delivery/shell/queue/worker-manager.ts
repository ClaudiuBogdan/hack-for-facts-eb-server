/**
 * Worker Manager
 *
 * Manages lifecycle of BullMQ workers.
 */

import type { Worker } from 'bullmq';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the worker manager.
 */
export interface WorkerManagerConfig {
  logger: Logger;
}

/**
 * Worker manager interface.
 */
export interface WorkerManager {
  /**
   * Registers a worker for management.
   */
  register(name: string, worker: Worker): void;

  /**
   * Registers multiple workers.
   */
  registerAll(workers: Record<string, Worker>): void;

  /**
   * Gracefully stops all workers.
   */
  stopAll(): Promise<void>;

  /**
   * Gets a registered worker by name.
   */
  getWorker(name: string): Worker | undefined;

  /**
   * Gets all registered worker names.
   */
  getWorkerNames(): string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a worker manager.
 */
export const createWorkerManager = (config: WorkerManagerConfig): WorkerManager => {
  const { logger } = config;
  const log = logger.child({ component: 'WorkerManager' });
  const workers = new Map<string, Worker>();

  return {
    register(name: string, worker: Worker): void {
      if (workers.has(name)) {
        log.warn({ name }, 'Worker already registered, replacing');
      }

      workers.set(name, worker);

      // Set up event listeners
      worker.on('completed', (job) => {
        log.debug({ name, jobId: job.id }, 'Job completed');
      });

      worker.on('failed', (job, error) => {
        log.warn({ name, jobId: job?.id, error: error.message }, 'Job failed');
      });

      worker.on('error', (error) => {
        log.error({ name, error: error.message }, 'Worker error');
      });

      log.info({ name }, 'Worker registered');
    },

    registerAll(workerMap: Record<string, Worker>): void {
      for (const [name, worker] of Object.entries(workerMap)) {
        this.register(name, worker);
      }
    },

    async stopAll(): Promise<void> {
      log.info({ count: workers.size }, 'Stopping all workers');

      const stopPromises = Array.from(workers.entries()).map(async ([name, worker]) => {
        try {
          await worker.close();
          log.info({ name }, 'Worker stopped');
        } catch (error) {
          log.error({ name, error }, 'Failed to stop worker');
        }
      });

      await Promise.all(stopPromises);
      workers.clear();

      log.info('All workers stopped');
    },

    getWorker(name: string): Worker | undefined {
      return workers.get(name);
    },

    getWorkerNames(): string[] {
      return Array.from(workers.keys());
    },
  };
};
