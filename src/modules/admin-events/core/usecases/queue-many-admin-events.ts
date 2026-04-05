import { err, ok, type Result } from 'neverthrow';

import { validateSchema } from '../validation.js';

import type { AdminEventError } from '../errors.js';
import type { AdminEventQueuePort } from '../ports.js';
import type { AdminEventRegistry } from '../registry.js';

export interface QueueManyAdminEventsDeps {
  registry: AdminEventRegistry;
  queue: AdminEventQueuePort;
}

export interface QueueManyAdminEventsInput {
  items: readonly {
    eventType: string;
    payload: Record<string, unknown>;
  }[];
}

export interface QueueManyAdminEventsOutput {
  queuedJobIds: string[];
}

export const queueManyAdminEvents = async (
  deps: QueueManyAdminEventsDeps,
  input: QueueManyAdminEventsInput
): Promise<Result<QueueManyAdminEventsOutput, AdminEventError>> => {
  const uniqueJobs = new Map<
    string,
    {
      jobId: string;
      envelope: {
        eventType: string;
        schemaVersion: number;
        payload: Record<string, unknown>;
      };
    }
  >();

  for (const item of input.items) {
    const definitionResult = deps.registry.get(item.eventType);
    if (definitionResult.isErr()) {
      return err(definitionResult.error);
    }

    const definition = definitionResult.value;
    const payloadResult = validateSchema(
      definition.payloadSchema,
      item.payload,
      `Invalid admin event payload for "${item.eventType}"`
    );
    if (payloadResult.isErr()) {
      return err(payloadResult.error);
    }

    const payload = payloadResult.value as Record<string, unknown>;
    const jobId = definition.getJobId(payload);
    uniqueJobs.set(jobId, {
      jobId,
      envelope: {
        eventType: definition.eventType,
        schemaVersion: definition.schemaVersion,
        payload,
      },
    });
  }

  const jobs = [...uniqueJobs.values()];
  const enqueueResult = await deps.queue.enqueueMany(jobs);
  if (enqueueResult.isErr()) {
    return err(enqueueResult.error);
  }

  return ok({
    queuedJobIds: jobs.map((job) => job.jobId),
  });
};
