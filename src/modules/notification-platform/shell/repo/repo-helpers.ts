import { createDatabaseError, type DatabaseError } from '../../core/shared/errors.js';

import type { AuditEntry } from '../../core/audit/types.js';
import type { ChannelDestination, Delivery, DeliveryAttempt } from '../../core/delivery/types.js';
import type { DigestBatch } from '../../core/digest/types.js';
import type { NotificationEvent } from '../../core/events/types.js';
import type { LogicalNotification } from '../../core/inbox/types.js';
import type { Subscription } from '../../core/subscriptions/types.js';

type DbRow = Record<string, unknown>;

const asDate = (value: unknown, column: string): Date => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw new Error(`Invalid timestamp in ${column}`);
};

const asNullableDate = (value: unknown, column: string): Date | null => {
  return value === null || value === undefined ? null : asDate(value, column);
};

const asNumber = (value: unknown, column: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number in ${column}`);
  }
  return parsed;
};

const asNullableNumber = (value: unknown, column: string): number | null => {
  return value === null || value === undefined ? null : asNumber(value, column);
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
};

export const mapNotificationEvent = (row: DbRow): NotificationEvent => ({
  id: row['id'] as string,
  source: row['source'] as string,
  eventType: row['event_type'] as string,
  eventSchemaVersion: asNumber(row['event_schema_version'], 'event_schema_version'),
  occurrenceKey: row['occurrence_key'] as string,
  occurredAt: asDate(row['occurred_at'], 'occurred_at'),
  facts: asRecord(row['facts']),
  payloadHash: row['payload_hash'] as string,
  correlationId: (row['correlation_id'] as string | null) ?? null,
  causationId: (row['causation_id'] as string | null) ?? null,
  streamKey: (row['stream_key'] as string | null) ?? null,
  streamSequence: asNullableNumber(row['stream_sequence'], 'stream_sequence'),
  status: row['status'] as NotificationEvent['status'],
  resolutionCursor: (row['resolution_cursor'] as string | null) ?? null,
  claimToken: (row['claim_token'] as string | null) ?? null,
  claimExpiresAt: asNullableDate(row['claim_expires_at'], 'claim_expires_at'),
  createdAt: asDate(row['created_at'], 'created_at'),
  resolvedAt: asNullableDate(row['resolved_at'], 'resolved_at'),
  retentionExpiresAt: asDate(row['retention_expires_at'], 'retention_expires_at'),
});

export const mapSubscription = (row: DbRow): Subscription => ({
  id: row['id'] as string,
  userId: row['user_id'] as string,
  kindId: row['kind_id'] as string,
  subjectType: row['subject_type'] as string,
  subjectId: row['subject_id'] as string,
  config: asRecord(row['config']),
  normalizedKey: row['normalized_key'] as string,
  state: row['state'] as Subscription['state'],
  createdAt: asDate(row['created_at'], 'created_at'),
  updatedAt: asDate(row['updated_at'], 'updated_at'),
  removedAt: asNullableDate(row['removed_at'], 'removed_at'),
});

export const mapLogicalNotification = (row: DbRow): LogicalNotification => ({
  id: row['id'] as string,
  eventId: row['event_id'] as string,
  kindId: row['kind_id'] as string,
  kindVersion: asNumber(row['kind_version'], 'kind_version'),
  userId: row['user_id'] as string,
  eligibilityReason: row['eligibility_reason'] as string,
  locale: row['locale'] as LogicalNotification['locale'],
  recipientFacts: row['recipient_facts'] === null ? null : asRecord(row['recipient_facts']),
  inboxTemplateId: row['inbox_template_id'] as string,
  inboxTemplateVersion: row['inbox_template_version'] as string,
  inboxTitle: row['inbox_title'] as string,
  inboxBody: row['inbox_body'] as string,
  inboxActionUrl: (row['inbox_action_url'] as string | null) ?? null,
  inboxVisible: row['inbox_visible'] as boolean,
  readAt: asNullableDate(row['read_at'], 'read_at'),
  archivedAt: asNullableDate(row['archived_at'], 'archived_at'),
  streamKey: (row['stream_key'] as string | null) ?? null,
  streamSequence: asNullableNumber(row['stream_sequence'], 'stream_sequence'),
  createdAt: asDate(row['created_at'], 'created_at'),
  retentionExpiresAt: asDate(row['retention_expires_at'], 'retention_expires_at'),
});

export const mapDelivery = (row: DbRow): Delivery => ({
  id: row['id'] as string,
  deliveryKey: row['delivery_key'] as string,
  logicalNotificationId: (row['logical_notification_id'] as string | null) ?? null,
  digestBatchId: (row['digest_batch_id'] as string | null) ?? null,
  kindId: row['kind_id'] as string,
  userId: row['user_id'] as string,
  channel: row['channel'] as Delivery['channel'],
  destinationFingerprint: (row['destination_fingerprint'] as string | null) ?? null,
  destinationGeneration: asNullableNumber(row['destination_generation'], 'destination_generation'),
  templateId: (row['template_id'] as string | null) ?? null,
  templateVersion: (row['template_version'] as string | null) ?? null,
  renderedSubject: (row['rendered_subject'] as string | null) ?? null,
  renderedHtml: (row['rendered_html'] as string | null) ?? null,
  renderedText: (row['rendered_text'] as string | null) ?? null,
  contentHash: (row['content_hash'] as string | null) ?? null,
  status: row['status'] as Delivery['status'],
  notBefore: asNullableDate(row['not_before'], 'not_before'),
  expiresAt: asNullableDate(row['expires_at'], 'expires_at'),
  streamKey: (row['stream_key'] as string | null) ?? null,
  streamSequence: asNullableNumber(row['stream_sequence'], 'stream_sequence'),
  attemptCount: asNumber(row['attempt_count'], 'attempt_count'),
  nextAttemptAt: asNullableDate(row['next_attempt_at'], 'next_attempt_at'),
  claimToken: (row['claim_token'] as string | null) ?? null,
  claimExpiresAt: asNullableDate(row['claim_expires_at'], 'claim_expires_at'),
  providerIdempotencyKey: (row['provider_idempotency_key'] as string | null) ?? null,
  providerRef: (row['provider_ref'] as string | null) ?? null,
  lastErrorCode: (row['last_error_code'] as string | null) ?? null,
  lastErrorMessage: (row['last_error_message'] as string | null) ?? null,
  senderMode: row['sender_mode'] as Delivery['senderMode'],
  createdAt: asDate(row['created_at'], 'created_at'),
  updatedAt: asDate(row['updated_at'], 'updated_at'),
  acceptedAt: asNullableDate(row['accepted_at'], 'accepted_at'),
  terminalAt: asNullableDate(row['terminal_at'], 'terminal_at'),
  retentionExpiresAt: asDate(row['retention_expires_at'], 'retention_expires_at'),
});

export const mapDeliveryAttempt = (row: DbRow): DeliveryAttempt => ({
  id: row['id'] as string,
  deliveryId: row['delivery_id'] as string,
  attemptNumber: asNumber(row['attempt_number'], 'attempt_number'),
  startedAt: asDate(row['started_at'], 'started_at'),
  completedAt: asNullableDate(row['completed_at'], 'completed_at'),
  providerIdempotencyKey: row['provider_idempotency_key'] as string,
  requestCorrelationId: (row['request_correlation_id'] as string | null) ?? null,
  destinationFingerprint: (row['destination_fingerprint'] as string | null) ?? null,
  result: (row['result'] as DeliveryAttempt['result']) ?? null,
  errorCode: (row['error_code'] as string | null) ?? null,
  errorMessage: (row['error_message'] as string | null) ?? null,
  providerRef: (row['provider_ref'] as string | null) ?? null,
  latencyMs: asNullableNumber(row['latency_ms'], 'latency_ms'),
  retryAfterMs: asNullableNumber(row['retry_after_ms'], 'retry_after_ms'),
});

export const mapChannelDestination = (row: DbRow): ChannelDestination => ({
  id: row['id'] as string,
  userId: row['user_id'] as string,
  channel: row['channel'] as ChannelDestination['channel'],
  fingerprint: row['fingerprint'] as string,
  generation: asNumber(row['generation'], 'generation'),
  isCurrent: row['is_current'] as boolean,
  suppressedAt: asNullableDate(row['suppressed_at'], 'suppressed_at'),
  suppressionReason: (row['suppression_reason'] as string | null) ?? null,
  createdAt: asDate(row['created_at'], 'created_at'),
  updatedAt: asDate(row['updated_at'], 'updated_at'),
});

export const mapDigestBatch = (row: DbRow): DigestBatch => ({
  id: row['id'] as string,
  userId: row['user_id'] as string,
  channel: row['channel'] as DigestBatch['channel'],
  cadence: row['cadence'] as DigestBatch['cadence'],
  windowStartUtc: asDate(row['window_start_utc'], 'window_start_utc'),
  windowEndUtc: asDate(row['window_end_utc'], 'window_end_utc'),
  dispatchAtUtc: asDate(row['dispatch_at_utc'], 'dispatch_at_utc'),
  status: row['status'] as DigestBatch['status'],
  renderedItemIds:
    row['rendered_item_ids'] === null || row['rendered_item_ids'] === undefined
      ? null
      : (row['rendered_item_ids'] as string[]),
  overflowCount: asNullableNumber(row['overflow_count'], 'overflow_count'),
  deliveryId: (row['delivery_id'] as string | null) ?? null,
  claimToken: (row['claim_token'] as string | null) ?? null,
  claimExpiresAt: asNullableDate(row['claim_expires_at'], 'claim_expires_at'),
  createdAt: asDate(row['created_at'], 'created_at'),
  updatedAt: asDate(row['updated_at'], 'updated_at'),
});

export const mapAuditEntry = (row: DbRow): AuditEntry => ({
  id: String(row['id']),
  action: row['action'] as AuditEntry['action'],
  occurredAt: asDate(row['occurred_at'], 'occurred_at'),
  actor: row['actor'] as string,
  ...(row['user_id'] === null ? {} : { userId: row['user_id'] as string }),
  ...(row['event_id'] === null ? {} : { eventId: row['event_id'] as string }),
  ...(row['logical_notification_id'] === null
    ? {}
    : { logicalNotificationId: row['logical_notification_id'] as string }),
  ...(row['delivery_id'] === null ? {} : { deliveryId: row['delivery_id'] as string }),
  ...(row['batch_id'] === null ? {} : { batchId: row['batch_id'] as string }),
  ...(row['subscription_id'] === null ? {} : { subscriptionId: row['subscription_id'] as string }),
  ...(row['reason'] === null ? {} : { reason: row['reason'] as string }),
  details: asRecord(row['details']),
});

export const encodeTimestampCursor = (date: Date, id: string): string => {
  return `${date.toISOString()}|${id}`;
};

export const decodeTimestampCursor = (cursor: string): { date: Date; id: string } | null => {
  const separator = cursor.indexOf('|');
  if (separator <= 0 || separator === cursor.length - 1) {
    return null;
  }
  const date = new Date(cursor.slice(0, separator));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return { date, id: cursor.slice(separator + 1) };
};

const postgresCode = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

export const isUniqueViolation = (error: unknown): boolean => postgresCode(error) === '23505';

export const toDatabaseError = (operation: string, error: unknown): DatabaseError => {
  const code = postgresCode(error);
  const retryable = code === null || (!code.startsWith('22') && !code.startsWith('23'));
  const message = error instanceof Error ? error.message : 'Unknown database error';
  return createDatabaseError(`${operation}: ${message}`, retryable);
};
