import { err, ok, type Result } from 'neverthrow';

import { listAdminEventJobs } from './list-admin-event-jobs.js';

import type { AdminEventError } from '../errors.js';
import type { AdminEventQueuePort } from '../ports.js';
import type { AdminEventRegistry } from '../registry.js';

export interface ReconcileAdminEventQueueDeps {
  registry: AdminEventRegistry;
  queue: AdminEventQueuePort;
}

export interface ReconcileAdminEventQueueInput {
  limit?: number;
  eventTypes?: readonly string[];
}

export interface ReconcileAdminEventQueueOutput {
  removedJobIds: string[];
  keptJobIds: string[];
}

export const reconcileAdminEventQueue = async (
  deps: ReconcileAdminEventQueueDeps,
  input: ReconcileAdminEventQueueInput = {}
): Promise<Result<ReconcileAdminEventQueueOutput, AdminEventError>> => {
  const jobsResult = await listAdminEventJobs(
    {
      registry: deps.registry,
      queue: deps.queue,
    },
    {
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
    }
  );
  if (jobsResult.isErr()) {
    return err(jobsResult.error);
  }

  const removedJobIds: string[] = [];
  const keptJobIds: string[] = [];

  for (const job of jobsResult.value) {
    const definitionResult = deps.registry.get(job.envelope.eventType);
    if (definitionResult.isErr()) {
      return err(definitionResult.error);
    }

    const contextResult = await definitionResult.value.loadContext(job.envelope.payload);
    if (contextResult.isErr()) {
      return err(contextResult.error);
    }

    const state = definitionResult.value.classifyState({
      payload: job.envelope.payload,
      context: contextResult.value,
    });

    if (state === 'not_actionable') {
      const removeResult = await deps.queue.remove(job.jobId);
      if (removeResult.isErr()) {
        return err(removeResult.error);
      }

      if (removeResult.value) {
        removedJobIds.push(job.jobId);
        continue;
      }
    }

    keptJobIds.push(job.jobId);
  }

  return ok({
    removedJobIds,
    keptJobIds,
  });
};
