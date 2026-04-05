import { err, ok, type Result } from 'neverthrow';

import { ADMIN_EVENT_JOB_NAME, getAdminEventJobOptions } from './job-options.js';
import { createQueueError, type AdminEventError } from '../../core/errors.js';

import type { AdminEventQueuePort } from '../../core/ports.js';
import type { AdminEventPendingJob, AdminEventQueueJobState } from '../../core/types.js';
import type { Job, Queue } from 'bullmq';

export interface BullmqAdminEventQueueConfig {
  queue: Queue<{
    eventType: string;
    schemaVersion: number;
    payload: Record<string, unknown>;
  }>;
}

const toQueueError = (message: string, error: unknown): AdminEventError => {
  return createQueueError(
    `${message}: ${error instanceof Error ? error.message : 'Unknown queue error'}`,
    true
  );
};

const toPendingJob = (
  job: Job<{
    eventType: string;
    schemaVersion: number;
    payload: Record<string, unknown>;
  }>
): AdminEventPendingJob | null => {
  if (job.id === undefined) {
    return null;
  }

  const priority = typeof job.opts.priority === 'number' ? job.opts.priority : 0;
  const state: AdminEventQueueJobState = priority > 0 ? 'prioritized' : 'waiting';

  return {
    jobId: job.id,
    state,
    timestamp: job.timestamp,
    envelope: job.data,
  };
};

export const makeBullmqAdminEventQueue = (
  config: BullmqAdminEventQueueConfig
): AdminEventQueuePort => {
  const { queue } = config;

  return {
    async enqueue(input): Promise<Result<void, AdminEventError>> {
      try {
        await queue.add(ADMIN_EVENT_JOB_NAME, input.envelope, getAdminEventJobOptions(input.jobId));
        return ok(undefined);
      } catch (error) {
        return err(toQueueError(`Failed to enqueue admin event job "${input.jobId}"`, error));
      }
    },

    async enqueueMany(input): Promise<Result<void, AdminEventError>> {
      try {
        if (input.length === 0) {
          return ok(undefined);
        }

        await queue.addBulk(
          input.map((item) => ({
            name: ADMIN_EVENT_JOB_NAME,
            data: item.envelope,
            opts: getAdminEventJobOptions(item.jobId),
          }))
        );

        return ok(undefined);
      } catch (error) {
        return err(toQueueError('Failed to enqueue admin event jobs', error));
      }
    },

    async get(jobId): Promise<Result<AdminEventPendingJob | null, AdminEventError>> {
      try {
        const job = await queue.getJob(jobId);
        if (job == null) {
          return ok(null);
        }

        const state = await job.getState();
        if (state !== 'waiting' && state !== 'prioritized') {
          return ok(null);
        }

        return ok(toPendingJob(job));
      } catch (error) {
        return err(toQueueError(`Failed to load admin event job "${jobId}"`, error));
      }
    },

    async listPending(
      limit = 100
    ): Promise<Result<readonly AdminEventPendingJob[], AdminEventError>> {
      try {
        const prioritizedJobs = await queue.getPrioritized(0, Math.max(limit - 1, 0));
        const remaining = Math.max(limit - prioritizedJobs.length, 0);
        const waitingJobs =
          remaining > 0 ? await queue.getWaiting(0, Math.max(remaining - 1, 0)) : [];

        const jobs = [...prioritizedJobs, ...waitingJobs]
          .map((job) => toPendingJob(job))
          .filter((job): job is AdminEventPendingJob => job !== null);

        return ok(jobs);
      } catch (error) {
        return err(toQueueError('Failed to list pending admin event jobs', error));
      }
    },

    async remove(jobId): Promise<Result<boolean, AdminEventError>> {
      try {
        const job = await queue.getJob(jobId);
        if (job == null) {
          return ok(false);
        }

        await job.remove();
        return ok(true);
      } catch (error) {
        return err(toQueueError(`Failed to remove admin event job "${jobId}"`, error));
      }
    },
  };
};
