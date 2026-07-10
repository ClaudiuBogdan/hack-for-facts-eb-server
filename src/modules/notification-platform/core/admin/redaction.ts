import type {
  RedactedAuditEntry,
  RedactedDelivery,
  RedactedDeliveryAttempt,
  RedactedLogicalNotification,
  RedactedNotificationEvent,
} from './types.js';
import type { AuditEntry } from '../audit/types.js';
import type { Delivery, DeliveryAttempt } from '../delivery/types.js';
import type { NotificationEvent } from '../events/types.js';
import type { LogicalNotification } from '../inbox/types.js';

export const redactNotificationEvent = (event: NotificationEvent): RedactedNotificationEvent => ({
  id: event.id,
  source: event.source,
  eventType: event.eventType,
  schemaVersion: event.eventSchemaVersion,
  occurrenceKey: event.occurrenceKey,
  payloadHash: event.payloadHash,
  status: event.status,
  occurredAt: event.occurredAt,
  createdAt: event.createdAt,
  resolvedAt: event.resolvedAt,
  retentionExpiresAt: event.retentionExpiresAt,
});

export const redactLogicalNotification = (
  logical: LogicalNotification
): RedactedLogicalNotification => ({
  id: logical.id,
  eventId: logical.eventId,
  kindId: logical.kindId,
  kindVersion: logical.kindVersion,
  userId: logical.userId,
  eligibilityReason: logical.eligibilityReason,
  locale: logical.locale,
  inboxVisible: logical.inboxVisible,
  readAt: logical.readAt,
  archivedAt: logical.archivedAt,
  createdAt: logical.createdAt,
  retentionExpiresAt: logical.retentionExpiresAt,
});

export const redactDelivery = (delivery: Delivery): RedactedDelivery => ({
  id: delivery.id,
  deliveryKey: delivery.deliveryKey,
  logicalNotificationId: delivery.logicalNotificationId,
  digestBatchId: delivery.digestBatchId,
  kindId: delivery.kindId,
  userId: delivery.userId,
  channel: delivery.channel,
  status: delivery.status,
  attemptCount: delivery.attemptCount,
  notBefore: delivery.notBefore,
  expiresAt: delivery.expiresAt,
  nextAttemptAt: delivery.nextAttemptAt,
  lastErrorCode: delivery.lastErrorCode,
  providerRef: delivery.providerRef,
  senderMode: delivery.senderMode,
  createdAt: delivery.createdAt,
  updatedAt: delivery.updatedAt,
  acceptedAt: delivery.acceptedAt,
  terminalAt: delivery.terminalAt,
  retentionExpiresAt: delivery.retentionExpiresAt,
});

export const redactDeliveryAttempt = (attempt: DeliveryAttempt): RedactedDeliveryAttempt => ({
  attemptNumber: attempt.attemptNumber,
  result: attempt.result,
  errorCode: attempt.errorCode,
  latencyMs: attempt.latencyMs,
  startedAt: attempt.startedAt,
  completedAt: attempt.completedAt,
});

export const redactAuditEntry = (entry: AuditEntry): RedactedAuditEntry => ({
  action: entry.action,
  actor: entry.actor,
  ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  ...(entry.userId === undefined ? {} : { userId: entry.userId }),
  ...(entry.eventId === undefined ? {} : { eventId: entry.eventId }),
  ...(entry.logicalNotificationId === undefined
    ? {}
    : { logicalNotificationId: entry.logicalNotificationId }),
  ...(entry.deliveryId === undefined ? {} : { deliveryId: entry.deliveryId }),
  ...(entry.batchId === undefined ? {} : { batchId: entry.batchId }),
  ...(entry.subscriptionId === undefined ? {} : { subscriptionId: entry.subscriptionId }),
});
