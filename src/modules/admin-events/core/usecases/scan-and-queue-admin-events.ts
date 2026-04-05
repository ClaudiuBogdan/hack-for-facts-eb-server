import { err, ok, type Result } from 'neverthrow';

import { queueManyAdminEvents } from './queue-many-admin-events.js';

import type { AdminEventError } from '../errors.js';
import type { AdminEventQueuePort } from '../ports.js';
import type { AdminEventRegistry } from '../registry.js';

export interface ScanAndQueueAdminEventsDeps {
  registry: AdminEventRegistry;
  queue: AdminEventQueuePort;
}

export interface ScanAndQueueAdminEventsInput {
  eventTypes?: readonly string[];
}

export interface ScanAndQueueAdminEventsOutput {
  scannedEventTypes: string[];
  queuedJobIds: string[];
}

export const scanAndQueueAdminEvents = async (
  deps: ScanAndQueueAdminEventsDeps,
  input: ScanAndQueueAdminEventsInput = {}
): Promise<Result<ScanAndQueueAdminEventsOutput, AdminEventError>> => {
  const definitions = [];

  if (input.eventTypes !== undefined && input.eventTypes.length > 0) {
    for (const eventType of input.eventTypes) {
      const definitionResult = deps.registry.get(eventType);
      if (definitionResult.isErr()) {
        return err(definitionResult.error);
      }

      definitions.push(definitionResult.value);
    }
  } else {
    definitions.push(...deps.registry.list());
  }

  const queuedJobIds: string[] = [];
  const scannedEventTypes: string[] = [];

  for (const definition of definitions) {
    const scanResult = await definition.scanPending();
    if (scanResult.isErr()) {
      return err(scanResult.error);
    }

    scannedEventTypes.push(definition.eventType);
    if (scanResult.value.length === 0) {
      continue;
    }

    const queueResult = await queueManyAdminEvents(
      {
        registry: deps.registry,
        queue: deps.queue,
      },
      {
        items: scanResult.value.map((payload) => ({
          eventType: definition.eventType,
          payload,
        })),
      }
    );
    if (queueResult.isErr()) {
      return err(queueResult.error);
    }

    queuedJobIds.push(...queueResult.value.queuedJobIds);
  }

  return ok({
    scannedEventTypes,
    queuedJobIds,
  });
};
