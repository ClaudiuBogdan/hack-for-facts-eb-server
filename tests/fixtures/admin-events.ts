import { err, ok, type Result } from 'neverthrow';

import {
  createQueueError,
  type AdminEventError,
  type AdminEventPendingJob,
  type AdminEventQueuePort,
} from '@/modules/admin-events/index.js';

export interface InMemoryAdminEventQueue extends AdminEventQueuePort {
  snapshot(): readonly AdminEventPendingJob[];
  deleteJob(jobId: string): void;
}

export interface InMemoryAdminEventQueueOptions {
  failRemoveCount?: number;
}

export const makeInMemoryAdminEventQueue = (
  options: InMemoryAdminEventQueueOptions = {}
): InMemoryAdminEventQueue => {
  const jobs = new Map<string, AdminEventPendingJob>();
  let nextTimestamp = 1;
  let remainingRemoveFailures = options.failRemoveCount ?? 0;

  const upsertJob = (input: {
    jobId: string;
    envelope: {
      eventType: string;
      schemaVersion: number;
      payload: Record<string, unknown>;
    };
  }): void => {
    jobs.set(input.jobId, {
      jobId: input.jobId,
      state: 'waiting',
      timestamp: nextTimestamp,
      envelope: input.envelope,
    });
    nextTimestamp += 1;
  };

  return {
    async enqueue(input): Promise<Result<void, AdminEventError>> {
      upsertJob(input);
      return ok(undefined);
    },
    async enqueueMany(input): Promise<Result<void, AdminEventError>> {
      for (const item of input) {
        upsertJob(item);
      }

      return ok(undefined);
    },
    async get(jobId) {
      return ok(jobs.get(jobId) ?? null);
    },
    async listPending(limit = 100) {
      return ok([...jobs.values()].slice(0, limit));
    },
    async remove(jobId) {
      if (remainingRemoveFailures > 0) {
        remainingRemoveFailures -= 1;
        return err(createQueueError(`Failed to remove admin event job "${jobId}".`, true));
      }

      return ok(jobs.delete(jobId));
    },
    snapshot() {
      return [...jobs.values()];
    },
    deleteJob(jobId) {
      jobs.delete(jobId);
    },
  };
};
