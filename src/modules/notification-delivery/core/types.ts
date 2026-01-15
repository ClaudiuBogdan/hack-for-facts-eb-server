/**
 * Notification Delivery Module - Core Types
 *
 * Types for the delivery pipeline (outbox pattern).
 */

import type { NotificationType } from '@/modules/notifications/core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Delivery Status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delivery status for outbox pattern.
 *
 * Lifecycle: pending → sending → sent → delivered (via webhook)
 *                    ↘ failed_transient (retryable)
 *                    ↘ failed_permanent (no retry)
 *                    ↘ suppressed (from webhook)
 *                    ↘ skipped_unsubscribed
 *                    ↘ skipped_no_email
 */
export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'failed_transient'
  | 'failed_permanent'
  | 'suppressed'
  | 'skipped_unsubscribed'
  | 'skipped_no_email';

/**
 * Statuses that indicate the delivery is complete.
 */
export const TERMINAL_STATUSES: readonly DeliveryStatus[] = [
  'delivered',
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

// ─────────────────────────────────────────────────────────────────────────────
// Delivery Record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A delivery record in the outbox.
 */
export interface DeliveryRecord {
  /** UUID - use for Resend tags and idempotency key */
  id: string;
  /** User ID */
  userId: string;
  /** Snapshot of email used at send time */
  toEmail: string | null;
  /** FK to Notifications table */
  notificationId: string;
  /** Period key (e.g., '2025-01', '2025-Q1') */
  periodKey: string;
  /** Composite deduplication key: userId:notificationId:periodKey */
  deliveryKey: string;
  /** Current status */
  status: DeliveryStatus;
  /** FK to UnsubscribeTokens */
  unsubscribeToken: string | null;
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
  /** Notification IDs to process */
  notificationIds: string[];
}

/**
 * Payload for the compose job.
 */
export interface ComposeJobPayload {
  /** Unique run identifier */
  runId: string;
  /** Notification ID to compose */
  notificationId: string;
  /** Period key */
  periodKey: string;
}

/**
 * Payload for the send job.
 */
export interface SendJobPayload {
  /** Delivery ID to send */
  deliveryId: string;
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

/**
 * Stored webhook event.
 */
export interface StoredWebhookEvent {
  id: string;
  svixId: string;
  eventType: string;
  resendEmailId: string;
  deliveryId: string | null;
  payload: Record<string, unknown>;
  processedAt: Date | null;
  createdAt: Date;
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
