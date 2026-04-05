import { err, ok, type Result } from 'neverthrow';

import { validateSchema } from '../validation.js';

import type { AdminEventError } from '../errors.js';
import type { AdminEventQueuePort } from '../ports.js';
import type { AdminEventRegistry } from '../registry.js';
import type { AdminEventPendingJob } from '../types.js';

export interface ListAdminEventJobsDeps {
  registry: AdminEventRegistry;
  queue: AdminEventQueuePort;
}

export interface ListAdminEventJobsInput {
  limit?: number;
  eventTypes?: readonly string[];
  jobIds?: readonly string[];
}

export const listAdminEventJobs = async (
  deps: ListAdminEventJobsDeps,
  input: ListAdminEventJobsInput = {}
): Promise<Result<readonly AdminEventPendingJob[], AdminEventError>> => {
  if (input.jobIds !== undefined && input.jobIds.length > 0) {
    const jobs: AdminEventPendingJob[] = [];

    for (const jobId of input.jobIds) {
      const result = await deps.queue.get(jobId);
      if (result.isErr()) {
        return err(result.error);
      }

      if (result.value !== null) {
        jobs.push(result.value);
      }
    }

    return validateAndFilterJobs(deps.registry, jobs, input.eventTypes);
  }

  const queuedJobsResult = await deps.queue.listPending(input.limit);
  if (queuedJobsResult.isErr()) {
    return err(queuedJobsResult.error);
  }

  return validateAndFilterJobs(deps.registry, queuedJobsResult.value, input.eventTypes);
};

const validateAndFilterJobs = (
  registry: AdminEventRegistry,
  jobs: readonly AdminEventPendingJob[],
  eventTypes?: readonly string[]
): Result<readonly AdminEventPendingJob[], AdminEventError> => {
  const filteredJobs: AdminEventPendingJob[] = [];

  for (const job of jobs) {
    if (
      eventTypes !== undefined &&
      eventTypes.length > 0 &&
      !eventTypes.includes(job.envelope.eventType)
    ) {
      continue;
    }

    const definitionResult = registry.get(job.envelope.eventType);
    if (definitionResult.isErr()) {
      return err(definitionResult.error);
    }

    const payloadResult = validateSchema(
      definitionResult.value.payloadSchema,
      job.envelope.payload,
      `Invalid admin event payload for "${job.envelope.eventType}"`
    );
    if (payloadResult.isErr()) {
      return err(payloadResult.error);
    }

    const payload = payloadResult.value as Record<string, unknown>;
    filteredJobs.push({
      ...job,
      envelope: {
        ...job.envelope,
        payload,
      },
    });
  }

  return ok(filteredJobs);
};
