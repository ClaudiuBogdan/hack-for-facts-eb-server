import type { AuditEntry } from '../audit/types.js';
import type { Delivery, DeliveryAttempt, DeliveryState } from '../delivery/types.js';
import type { NotificationEvent } from '../events/types.js';
import type { ExternalChannel, Locale } from '../shared/types.js';

export interface RedactedNotificationEvent {
  id: string;
  source: string;
  eventType: string;
  schemaVersion: number;
  occurrenceKey: string;
  payloadHash: string;
  status: NotificationEvent['status'];
  occurredAt: Date;
  createdAt: Date;
  resolvedAt: Date | null;
  retentionExpiresAt: Date;
}

export interface RedactedLogicalNotification {
  id: string;
  eventId: string;
  kindId: string;
  kindVersion: number;
  userId: string;
  eligibilityReason: string;
  locale: Locale;
  inboxVisible: boolean;
  readAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  retentionExpiresAt: Date;
}

export interface RedactedDelivery {
  id: string;
  deliveryKey: string;
  logicalNotificationId: string | null;
  digestBatchId: string | null;
  kindId: string;
  userId: string;
  channel: ExternalChannel;
  status: DeliveryState;
  attemptCount: number;
  notBefore: Date | null;
  expiresAt: Date | null;
  nextAttemptAt: Date | null;
  lastErrorCode: string | null;
  providerRef: string | null;
  senderMode: Delivery['senderMode'];
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
  terminalAt: Date | null;
  retentionExpiresAt: Date;
}

export interface RedactedDeliveryAttempt {
  attemptNumber: number;
  result: DeliveryAttempt['result'];
  errorCode: string | null;
  latencyMs: number | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface RedactedAuditEntry {
  action: AuditEntry['action'];
  actor: string;
  reason?: string;
  userId?: string;
  eventId?: string;
  logicalNotificationId?: string;
  deliveryId?: string;
  batchId?: string;
  subscriptionId?: string;
}

export interface EventTraceDelivery {
  delivery: RedactedDelivery;
  attempts: RedactedDeliveryAttempt[];
}

export interface EventTraceLogicalNotification {
  logicalNotification: RedactedLogicalNotification;
  deliveries: EventTraceDelivery[];
}

export interface EventTrace {
  event: RedactedNotificationEvent;
  logicalNotifications: EventTraceLogicalNotification[];
  auditEntries: RedactedAuditEntry[];
}

export interface DeadLetterSearchFilter {
  kindId?: string;
  channel?: ExternalChannel;
  status?: DeliveryState;
  eventId?: string;
  userId?: string;
}

export interface ShadowComparisonSummary {
  kindId: string;
  periodKey: string | null;
  legacyRecipientCount: number;
  shadowRecipientCount: number;
  matchingRecipientCount: number;
  legacyOnlyRecipientCount: number;
  shadowOnlyRecipientCount: number;
  matchingContentCount: number;
  contentMismatchCount: number;
}

export interface SuppressionView {
  userId: string;
  channel: ExternalChannel;
  fingerprint: string;
  generation: number;
  suppressedAt: Date | null;
  suppressionReason: string | null;
}

export interface RevealedDeliveryContent {
  deliveryId: string;
  templateId: string | null;
  templateVersion: string | null;
  subject: string | null;
  html: string | null;
  text: string | null;
  contentHash: string | null;
}
