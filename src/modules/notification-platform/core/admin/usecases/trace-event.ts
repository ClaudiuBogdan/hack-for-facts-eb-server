import { err, ok, type Result } from 'neverthrow';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { PlatformDeliveryError } from '../../delivery/errors.js';
import type { DeliveryAttemptRepo, DeliveryRepo } from '../../delivery/ports.js';
import type { Delivery } from '../../delivery/types.js';
import type { EventError } from '../../events/errors.js';
import type { NotificationEventRepo } from '../../events/ports.js';
import type { NotificationEvent } from '../../events/types.js';
import type { InboxError } from '../../inbox/errors.js';
import type { LogicalNotificationRepo } from '../../inbox/ports.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { EventTrace } from '../types.js';

export interface NotificationEventTraceReader {
  findByOccurrence(input: {
    source: string;
    eventType: string;
    occurrenceKey: string;
  }): Promise<Result<NotificationEvent | null, EventError>>;
}

export interface DeliveryTraceReader {
  listByLogicalNotification(
    logicalNotificationId: string
  ): Promise<Result<Delivery[], PlatformDeliveryError>>;
}

export interface TraceEventDeps {
  events: NotificationEventRepo & NotificationEventTraceReader;
  logicalNotifications: LogicalNotificationRepo;
  deliveries: DeliveryRepo & DeliveryTraceReader;
  attempts: DeliveryAttemptRepo;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export type TraceEventInput =
  | { eventId: string }
  | { source: string; eventType: string; occurrenceKey: string };

export type TraceEventResult = EventTrace;
export type TraceEventError = EventError | InboxError | PlatformDeliveryError | AuditError;

const redactDelivery = (delivery: Delivery): Delivery => ({
  ...delivery,
  destinationFingerprint: null,
  destinationGeneration: null,
  renderedSubject: null,
  renderedHtml: null,
  renderedText: null,
  contentHash: null,
});

export const traceEvent = async (
  deps: TraceEventDeps,
  input: TraceEventInput
): Promise<Result<TraceEventResult, TraceEventError>> => {
  // DESIGN NOTE: the committed repos omit composite event lookup and delivery-by-
  // logical queries required by the inventory. These read-only interfaces document
  // the missing adapter surface without changing the committed contracts.
  const found =
    'eventId' in input
      ? await deps.events.findById(input.eventId)
      : await deps.events.findByOccurrence(input);
  if (found.isErr()) {
    return err(found.error);
  }
  if (found.value === null) {
    return err({
      type: 'NotFound',
      entity: 'notification event',
      id: 'eventId' in input ? input.eventId : input.occurrenceKey,
    });
  }
  const logicals = await deps.logicalNotifications.listByEvent(found.value.id);
  if (logicals.isErr()) {
    return err(logicals.error);
  }

  const logicalNotifications: EventTrace['logicalNotifications'] = [];
  for (const logical of logicals.value) {
    const deliveries = await deps.deliveries.listByLogicalNotification(logical.id);
    if (deliveries.isErr()) {
      return err(deliveries.error);
    }
    const tracedDeliveries: EventTrace['logicalNotifications'][number]['deliveries'] = [];
    for (const delivery of deliveries.value) {
      const attempts = await deps.attempts.listByDelivery(delivery.id);
      if (attempts.isErr()) {
        return err(attempts.error);
      }
      tracedDeliveries.push({
        delivery: redactDelivery(delivery),
        attempts: attempts.value.map((attempt) => ({ ...attempt, destinationFingerprint: null })),
      });
    }
    logicalNotifications.push({ logicalNotification: logical, deliveries: tracedDeliveries });
  }
  const auditEntries = await deps.audit.listByEntity({
    eventId: found.value.id,
    cursor: null,
    limit: 100,
  });
  if (auditEntries.isErr()) {
    return err(auditEntries.error);
  }
  return ok({
    event: found.value,
    logicalNotifications,
    auditEntries: auditEntries.value.items,
  });
};
