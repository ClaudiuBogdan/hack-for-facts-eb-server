import { err, ok, type Result } from 'neverthrow';

import { validateSchema } from '../validation.js';

import type { AdminEventError } from '../errors.js';
import type { AdminEventQueuePort } from '../ports.js';
import type { AdminEventRegistry } from '../registry.js';

export interface QueueAdminEventDeps {
  registry: AdminEventRegistry;
  queue: AdminEventQueuePort;
}

export interface QueueAdminEventInput {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface QueueAdminEventOutput {
  jobId: string;
  eventType: string;
  schemaVersion: number;
}

export const queueAdminEvent = async (
  deps: QueueAdminEventDeps,
  input: QueueAdminEventInput
): Promise<Result<QueueAdminEventOutput, AdminEventError>> => {
  const definitionResult = deps.registry.get(input.eventType);
  if (definitionResult.isErr()) {
    return err(definitionResult.error);
  }

  const definition = definitionResult.value;
  const payloadResult = validateSchema(
    definition.payloadSchema,
    input.payload,
    `Invalid admin event payload for "${input.eventType}"`
  );
  if (payloadResult.isErr()) {
    return err(payloadResult.error);
  }

  const payload = payloadResult.value as Record<string, unknown>;
  const jobId = definition.getJobId(payload);
  const enqueueResult = await deps.queue.enqueue({
    jobId,
    envelope: {
      eventType: definition.eventType,
      schemaVersion: definition.schemaVersion,
      payload,
    },
  });
  if (enqueueResult.isErr()) {
    return err(enqueueResult.error);
  }

  return ok({
    jobId,
    eventType: definition.eventType,
    schemaVersion: definition.schemaVersion,
  });
};
