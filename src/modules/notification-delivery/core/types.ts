/**
 * Notification Delivery Module - Core Types
 *
 * Types for the delivery pipeline (outbox pattern).
 */

import type { DeliveryStatus } from '@/common/types/index.js';
import type { NotificationType } from '@/modules/notifications/core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Delivery Status
// ─────────────────────────────────────────────────────────────────────────────

export type { DeliveryStatus } from '@/common/types/index.js';

/**
 * Statuses that indicate the delivery is complete.
 */
export const TERMINAL_STATUSES: readonly DeliveryStatus[] = [
  'delivered',
  'webhook_timeout',
  'failed_permanent',
  'suppressed',
  'skipped_unsubscribed',
  'skipped_no_email',
] as const;

/**
 * Statuses that can be claimed for sending.
 */
export const CLAIMABLE_STATUSES: readonly DeliveryStatus[] = [
  'pending',
  'failed_transient',
] as const;

export const isReadyToSendDelivery = (
  delivery: Pick<
    NotificationOutboxRecord,
    'status' | 'renderedSubject' | 'renderedHtml' | 'renderedText'
  >
): boolean => {
  return (
    CLAIMABLE_STATUSES.includes(delivery.status) &&
    delivery.renderedSubject !== null &&
    delivery.renderedHtml !== null &&
    delivery.renderedText !== null
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Notification Outbox Record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All notification types that can be persisted in the notification outbox.
 */
export type BundleOutboxType = 'anaf_forexebug_digest';

export const BUNDLE_OUTBOX_TYPES: readonly BundleOutboxType[] = ['anaf_forexebug_digest'] as const;
export const ANAF_FOREXEBUG_DIGEST_SCOPE_PREFIX = 'digest:anaf_forexebug:';
const MONTHLY_PERIOD_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;

export const isBundleOutboxType = (value: string): value is BundleOutboxType => {
  return BUNDLE_OUTBOX_TYPES.includes(value as BundleOutboxType);
};

export const buildAnafForexebugDigestScopeKey = (periodKey: string): string => {
  return `${ANAF_FOREXEBUG_DIGEST_SCOPE_PREFIX}${periodKey}`;
};

/**
 * During rollout we still accept legacy raw monthly period scopes for existing
 * digest rows, but new rows should always use the prefixed namespace.
 */
export const parseAnafForexebugDigestScopeKey = (scopeKey: string): string | null => {
  if (scopeKey.startsWith(ANAF_FOREXEBUG_DIGEST_SCOPE_PREFIX)) {
    const periodKey = scopeKey.slice(ANAF_FOREXEBUG_DIGEST_SCOPE_PREFIX.length);
    return MONTHLY_PERIOD_KEY_PATTERN.test(periodKey) ? periodKey : null;
  }

  return MONTHLY_PERIOD_KEY_PATTERN.test(scopeKey) ? scopeKey : null;
};

export type NotificationOutboxType =
  | NotificationType
  | 'transactional_welcome'
  | 'funky:outbox:welcome'
  | 'funky:outbox:entity_subscription'
  | 'funky:outbox:entity_update'
  | 'funky:outbox:admin_response'
  | 'funky:outbox:admin_failure'
  | 'funky:outbox:admin_reviewed_interaction'
  | 'funky:outbox:public_debate_announcement'
  | 'funky:outbox:weekly_progress_digest'
  | BundleOutboxType;

export interface AnafForexebugDigestMetadata {
  digestType: 'anaf_forexebug_digest';
  sourceNotificationIds: string[];
  itemCount: number;
  periodLabel?: string;
  designDoc?: string;
}
export type BundleOutboxMetadata = AnafForexebugDigestMetadata;

/**
 * A durable outbox record used for compose/send/audit/recovery.
 */
export interface NotificationOutboxRecord {
  /** UUID - use for Resend tags and idempotency key */
  id: string;
  /** User ID */
  userId: string;
  /** Snapshot of email used at send time */
  toEmail: string | null;
  /** Notification type for this outbox row */
  notificationType: NotificationOutboxType;
  /** Optional reference object ID interpreted by notificationType */
  referenceId: string | null;
  /** Scope key used for deduplication and replay boundaries */
  scopeKey: string;
  /** Composite deduplication key */
  deliveryKey: string;
  /** Current status */
  status: DeliveryStatus;
  /** Rendered email subject */
  renderedSubject: string | null;
  /** Rendered HTML content */
  renderedHtml: string | null;
  /** Rendered plain text content */
  renderedText: string | null;
  /** Hash of rendered content for change detection */
  contentHash: string | null;
  /** Template name used */
  templateName: string | null;
  /** Template version used */
  templateVersion: string | null;
  /** Resend email ID (returned after send) */
  resendEmailId: string | null;
  /** Last error message */
  lastError: string | null;
  /** Number of send attempts */
  attemptCount: number;
  /** When the last attempt was made */
  lastAttemptAt: Date | null;
  /** When the email was sent */
  sentAt: Date | null;
  /** Additional metadata */
  metadata: Record<string, unknown>;
  /** When the record was created */
  createdAt: Date;
}

export type DeliveryRecord = NotificationOutboxRecord;

// ─────────────────────────────────────────────────────────────────────────────
// Trigger Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request to trigger notification collection.
 */
export interface TriggerRequest {
  /** Type of notification to trigger */
  notificationType: NotificationType;
  /** Period key (defaults to previous period) */
  periodKey?: string;
  /** If true, returns counts without enqueueing */
  dryRun?: boolean;
  /** Cap recipients for safe rollout */
  limit?: number;
  /** Bypass deduplication (use with caution) */
  force?: boolean;
}

/**
 * Response from trigger request.
 */
export interface TriggerResponse {
  /** Unique run identifier */
  runId: string;
  /** Notification type that was triggered */
  notificationType: NotificationType;
  /** Period key used */
  periodKey: string;
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Number of eligible notifications */
  eligibleCount: number;
  /** Whether the collect job was enqueued */
  collectJobEnqueued: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job Payloads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload for the collect job.
 */
export interface CollectJobPayload {
  /** Unique run identifier */
  runId: string;
  /** Notification type */
  notificationType: NotificationType;
  /** Period key */
  periodKey: string;
  /** Notification reference IDs to process */
  notificationIds: string[];
}

/**
 * Payload for a subscription compose job.
 */
export interface ComposeSubscriptionJobPayload {
  /** Unique run identifier */
  runId: string;
  /** Compose strategy */
  kind: 'subscription';
  /** Notification reference ID to compose */
  notificationId: string;
  /** Period key */
  periodKey: string;
}

/**
 * Payload for a direct outbox compose job.
 */
export interface ComposeOutboxJobPayload {
  /** Unique run identifier */
  runId: string;
  /** Compose strategy */
  kind: 'outbox';
  /** Existing outbox row ID */
  outboxId: string;
}

/**
 * Payload for the compose job.
 */
export type ComposeJobPayload = ComposeSubscriptionJobPayload | ComposeOutboxJobPayload;

/**
 * Payload for the send job.
 */
export interface SendJobPayload {
  /** Outbox ID to send */
  outboxId: string;
}

/**
 * Payload for the stuck-sending recovery job.
 */
export interface RecoveryJobPayload {
  /** Threshold in minutes after which a sending delivery is considered stuck */
  thresholdMinutes: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resend webhook event types we handle.
 */
export type ResendEventType =
  | 'email.sent'
  | 'email.delivered'
  | 'email.delivery_delayed'
  | 'email.bounced'
  | 'email.complained'
  | 'email.suppressed'
  | 'email.failed';

/**
 * Resend webhook event.
 */
export interface ResendWebhookEvent {
  type: ResendEventType;
  data: {
    email_id: string;
    to?: string[];
    subject?: string;
    bounce?: {
      type: 'Permanent' | 'Transient';
      subType: string;
    };
    reason?: string;
    error?: string;
    tags?: { name: string; value: string }[] | Record<string, string>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum retry attempts for transient failures.
 */
export const MAX_RETRY_ATTEMPTS = 3;

/**
 * Minutes after which a 'sending' delivery is considered stuck.
 */
export const STUCK_SENDING_THRESHOLD_MINUTES = 15;
