import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { hashEventPayload } from '../hash-event-payload.js';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { KindRegistry } from '../../registry/registry.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { EventError } from '../errors.js';
import type { NotificationEventRepo, EventFanOutScheduler } from '../ports.js';
import type { CreateNotificationEventInput, RecordEventOutcome } from '../types.js';

const EVENT_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export interface RecordNotificationEventDeps {
  events: NotificationEventRepo;
  registry: KindRegistry;
  audit: AuditLedgerPort;
  fanOutScheduler: EventFanOutScheduler;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface RecordNotificationEventInput extends CreateNotificationEventInput {
  /** Reserved for future same-database producers. V1 repositories do not consume it. */
  trx?: unknown;
}

export type RecordNotificationEventResult = RecordEventOutcome;
export type RecordNotificationEventError = EventError | AuditError;

export const recordNotificationEvent = async (
  deps: RecordNotificationEventDeps,
  input: RecordNotificationEventInput
): Promise<Result<RecordNotificationEventResult, RecordNotificationEventError>> => {
  const kind = deps.registry.getByEventType(input.eventType);
  if (kind === undefined) {
    return err({
      type: 'ValidationError',
      message: `Unknown notification event type: ${input.eventType}`,
      field: 'eventType',
    });
  }
  if (input.eventSchemaVersion !== kind.eventSchemaVersion) {
    return err({
      type: 'ValidationError',
      message: `Unsupported schema version for ${input.eventType}`,
      field: 'eventSchemaVersion',
    });
  }
  if (!Value.Check(kind.eventFactsSchema, input.facts)) {
    return err({
      type: 'ValidationError',
      message: `Invalid facts for ${input.eventType}`,
      field: 'facts',
    });
  }

  const payloadHash = hashEventPayload(input.facts);
  if (payloadHash.isErr()) {
    return err(payloadHash.error);
  }

  const streamKey = kind.ordering === null ? null : kind.ordering.streamKey(input.facts);
  const streamSequence = kind.ordering === null ? null : kind.ordering.streamSequence(input.facts);
  if (streamSequence !== null && !Number.isInteger(streamSequence)) {
    return err({
      type: 'ValidationError',
      message: 'Ordering stream sequence must be an integer',
      field: 'facts',
    });
  }

  const now = deps.clock.now();
  const inserted = await deps.events.insertOrFind({
    source: input.source,
    eventType: input.eventType,
    eventSchemaVersion: input.eventSchemaVersion,
    occurrenceKey: input.occurrenceKey,
    occurredAt: input.occurredAt,
    facts: input.facts,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    id: deps.ids.newId(),
    payloadHash: payloadHash.value,
    streamKey,
    streamSequence,
    retentionExpiresAt: new Date(now.getTime() + EVENT_RETENTION_MS),
  });
  if (inserted.isErr()) {
    return err(inserted.error);
  }

  const { event, created, payloadConflict } = inserted.value;
  if (payloadConflict) {
    const marked = await deps.events.markConflicted(event.id);
    if (marked.isErr()) {
      return err(marked.error);
    }
    const audited = await deps.audit.append({
      action: 'event.conflict',
      occurredAt: now,
      actor: 'system',
      eventId: event.id,
      reason: 'occurrence_key_payload_mismatch',
    });
    if (audited.isErr()) {
      return err(audited.error);
    }
    return err({
      type: 'EventPayloadConflict',
      eventId: event.id,
      occurrenceKey: input.occurrenceKey,
    });
  }

  if (!created) {
    const audited = await deps.audit.append({
      action: 'event.duplicate',
      occurredAt: now,
      actor: 'system',
      eventId: event.id,
    });
    if (audited.isErr()) {
      return err(audited.error);
    }
    return ok({ outcome: 'duplicate', event });
  }

  const audited = await deps.audit.append({
    action: 'event.accepted',
    occurredAt: now,
    actor: 'system',
    eventId: event.id,
  });
  if (audited.isErr()) {
    return err(audited.error);
  }

  const enqueued = await deps.fanOutScheduler.enqueue({ eventId: event.id });
  if (enqueued.isErr()) {
    deps.logger.error('Notification event fan-out enqueue failed; recovery will retry', {
      eventId: event.id,
      errorType: enqueued.error.type,
    });
  }
  return ok({ outcome: 'created', event });
};
