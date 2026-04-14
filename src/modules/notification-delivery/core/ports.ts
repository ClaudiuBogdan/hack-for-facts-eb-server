/**
 * Notification Delivery Module - Ports (Interfaces)
 *
 * Repository and adapter contracts for the delivery pipeline.
 */

import type { DeliveryError } from './errors.js';
import type {
  NotificationOutboxRecord,
  NotificationOutboxType,
  DeliveryStatus,
  ResendWebhookEvent,
  ComposeJobPayload,
} from './types.js';
import type { Notification, NotificationType } from '@/modules/notifications/core/types.js';
import type { Decimal } from 'decimal.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Notification Outbox Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for creating a notification outbox row.
 */
export interface CreateNotificationOutboxInput {
  userId: string;
  notificationType: NotificationOutboxType;
  referenceId: string | null;
  scopeKey: string;
  deliveryKey: string;
  toEmail?: string | null;
  renderedSubject?: string;
  renderedHtml?: string;
  renderedText?: string;
  contentHash?: string;
  templateName?: string;
  templateVersion?: string;
  metadata?: Record<string, unknown>;
}

export type CreateDeliveryInput = CreateNotificationOutboxInput;

/**
 * Input for updating rendered notification content on an existing outbox row.
 */
export interface UpdateRenderedContentInput {
  renderedSubject: string;
  renderedHtml: string;
  renderedText: string;
  contentHash: string;
  templateName: string;
  templateVersion: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for updating delivery status.
 */
export interface UpdateDeliveryStatusInput {
  status: DeliveryStatus;
  toEmail?: string;
  resendEmailId?: string;
  lastError?: string;
  sentAt?: Date;
}

/**
 * Repository for notification outbox records.
 */
export interface NotificationOutboxRepository {
  /**
   * Creates an outbox record with unique constraint protection.
   * Returns DuplicateDelivery error if delivery_key already exists.
   */
  create(
    input: CreateNotificationOutboxInput
  ): Promise<Result<NotificationOutboxRecord, DeliveryError>>;

  /**
   * Finds an outbox record by ID.
   */
  findById(outboxId: string): Promise<Result<NotificationOutboxRecord | null, DeliveryError>>;

  /**
   * Finds an outbox record by delivery key.
   */
  findByDeliveryKey(
    deliveryKey: string
  ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>>;

  /**
   * Updates rendered content on an existing outbox row.
   */
  updateRenderedContent(
    outboxId: string,
    input: UpdateRenderedContentInput
  ): Promise<Result<void, DeliveryError>>;

  /**
   * Atomic claim for compose.
   * Only succeeds if the row is pending and missing rendered content.
   *
   * Returns null if already claimed, already composed, or otherwise not claimable.
   */
  claimForCompose(
    outboxId: string
  ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>>;

  /**
   * Atomic claim for sending.
   * Only succeeds if status is 'pending' or 'failed_transient' and rendered
   * content is already present.
   * Increments attempt_count in SQL.
   *
   * Returns null if already claimed/processed (no error).
   */
  claimForSending(
    outboxId: string
  ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>>;

  /**
   * Updates delivery status with optional metadata.
   */
  updateStatus(
    outboxId: string,
    input: UpdateDeliveryStatusInput
  ): Promise<Result<void, DeliveryError>>;

  /**
   * Updates delivery status only if the current status is in the allowed set.
   * Returns true when the row was updated, false when state changed concurrently.
   */
  updateStatusIfCurrentIn(
    outboxId: string,
    allowedStatuses: readonly DeliveryStatus[],
    nextStatus: DeliveryStatus,
    input?: Partial<UpdateDeliveryStatusInput>
  ): Promise<Result<boolean, DeliveryError>>;

  /**
   * Updates status only if current status is 'sending'.
   * Used for reconciliation after crashes.
   */
  updateStatusIfStillSending(
    outboxId: string,
    status: DeliveryStatus,
    input?: Partial<UpdateDeliveryStatusInput>
  ): Promise<Result<boolean, DeliveryError>>;

  /**
   * Finds deliveries stuck in 'sending' state.
   */
  findStuckSending(
    olderThanMinutes: number
  ): Promise<Result<NotificationOutboxRecord[], DeliveryError>>;

  /**
   * Finds pending outbox rows that still need compose work.
   */
  findPendingComposeOrphans(
    olderThanMinutes: number
  ): Promise<Result<NotificationOutboxRecord[], DeliveryError>>;

  /**
   * Finds composed rows that are ready to send but appear orphaned.
   */
  findReadyToSendOrphans(
    olderThanMinutes: number
  ): Promise<Result<NotificationOutboxRecord[], DeliveryError>>;

  /**
   * Finds sent rows still awaiting a webhook callback.
   */
  findSentAwaitingWebhook(
    olderThanMinutes: number
  ): Promise<Result<NotificationOutboxRecord[], DeliveryError>>;

  /**
   * Checks if a delivery exists by key.
   */
  existsByDeliveryKey(deliveryKey: string): Promise<Result<boolean, DeliveryError>>;
}

export type DeliveryRepository = NotificationOutboxRepository;

/**
 * Minimal logger port for core use cases.
 */
export interface LoggerPort {
  child(bindings: Record<string, unknown>): LoggerPort;
  debug(bindings: Record<string, unknown> | string, message?: string): void;
  info(bindings: Record<string, unknown> | string, message?: string): void;
  warn(bindings: Record<string, unknown> | string, message?: string): void;
  error(bindings: Record<string, unknown> | string, message?: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications Repository Extensions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended notifications repository for delivery pipeline.
 */
export interface ExtendedNotificationsRepository {
  /**
   * Finds a notification by ID.
   */
  findById(notificationId: string): Promise<Result<Notification | null, DeliveryError>>;

  /**
   * Finds notifications eligible for delivery.
   * Returns active notifications that are still deliverable for this period.
   * Globally unsubscribed users are excluded before queueing.
   */
  findEligibleForDelivery(
    notificationType: NotificationType,
    periodKey: string,
    limit?: number,
    ignoreMaterialized?: boolean
  ): Promise<Result<Notification[], DeliveryError>>;

  /**
   * Finds active notifications for a specific type and entity.
   * Used for event-driven entity updates.
   */
  findActiveByTypeAndEntity(
    notificationType: NotificationType,
    entityCui: string
  ): Promise<Result<Notification[], DeliveryError>>;

  /**
   * Evaluates whether one user is currently eligible for an entity-scoped
   * notification. Returns the matching entity preference row when present, even
   * if eligibility is blocked by a higher-level preference.
   */
  findEligibleByUserTypeAndEntity(
    userId: string,
    notificationType: NotificationType,
    entityCui: string
  ): Promise<Result<TargetedNotificationEligibility, DeliveryError>>;

  /**
   * Finds active notifications for a specific type across all entities/users.
   * Used for recovery scans.
   */
  findActiveByType(
    notificationType: NotificationType
  ): Promise<Result<Notification[], DeliveryError>>;

  /**
   * Deactivates a notification.
   */
  deactivate(notificationId: string): Promise<Result<void, DeliveryError>>;

  /**
   * Checks if a user is globally unsubscribed from email delivery.
   * Returns true if the global_unsubscribe row exists AND either:
   * - isActive is false (master kill switch), OR
   * - config.channels.email is false (email channel disabled)
   */
  isUserGloballyUnsubscribed(userId: string): Promise<Result<boolean, DeliveryError>>;
}

export type TargetedNotificationEligibilityReason =
  | 'eligible'
  | 'missing_preference'
  | 'inactive_preference'
  | 'global_unsubscribe'
  | 'campaign_disabled';

export interface TargetedNotificationEligibility {
  isEligible: boolean;
  reason: TargetedNotificationEligibilityReason;
  notification: Notification | null;
}

/**
 * Adapter for enqueueing compose jobs.
 */
export interface ComposeJobScheduler {
  enqueue(job: ComposeJobPayload): Promise<Result<void, DeliveryError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// User Email Fetcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adapter for fetching user email addresses.
 */
export interface UserEmailFetcher {
  /**
   * Gets the email address for a user.
   * Returns null if user not found or has no email.
   */
  getEmail(userId: string): Promise<Result<string | null, DeliveryError>>;

  /**
   * Gets email addresses for multiple users.
   * Returns one map entry per requested user ID.
   */
  getEmailsByUserIds(userIds: string[]): Promise<Result<Map<string, string | null>, DeliveryError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Email Sender
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parameters for sending an email.
 */
export interface SendEmailParams {
  /** Recipient email address */
  to: string;
  /** User ID associated with the outbox row */
  userId?: string;
  /** Notification type associated with the outbox row */
  notificationType?: string;
  /** Optional reference ID associated with the outbox row */
  referenceId?: string | null;
  /** Email subject */
  subject: string;
  /** HTML content */
  html: string;
  /** Plain text content */
  text: string;
  /** Idempotency key (use delivery UUID) */
  idempotencyKey: string;
  /** Unsubscribe URL */
  unsubscribeUrl: string;
  /** Tags for tracking */
  tags: { name: string; value: string }[];
  /** Template name used for rendering */
  templateName?: string | null;
  /** Template version used for rendering */
  templateVersion?: string | null;
  /** Additional metadata for mock/debug senders */
  metadata?: Record<string, unknown>;
}

/**
 * Result of sending an email.
 */
export interface SendEmailResult {
  /** Resend email ID */
  emailId: string;
}

/**
 * Adapter for sending emails.
 */
export interface EmailSenderPort {
  /**
   * Sends an email via Resend.
   */
  send(params: SendEmailParams): Promise<Result<SendEmailResult, DeliveryError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Verifier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Svix headers from Resend webhooks.
 */
export interface SvixHeaders {
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}

/**
 * Webhook signature verification error.
 * Note: Different from DeliveryError's WebhookVerificationError.
 */
export interface WebhookSignatureError {
  type: 'INVALID_SIGNATURE' | 'INVALID_PAYLOAD' | 'EXPIRED' | 'UNKNOWN';
  message: string;
}

/**
 * Adapter for verifying webhook signatures.
 */
export interface WebhookVerifier {
  /**
   * Verifies a Resend webhook signature.
   */
  verify(
    rawBody: string,
    headers: SvixHeaders
  ): Promise<Result<ResendWebhookEvent, WebhookSignatureError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data Fetcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top expense category data.
 */
export interface NewsletterTopCategory {
  name: string;
  amount: Decimal;
  percentage: Decimal;
}

/**
 * Funding source breakdown.
 */
export interface NewsletterFundingSource {
  name: string;
  percentage: Decimal;
}

/**
 * Period-over-period comparison data.
 */
export interface NewsletterPeriodComparison {
  incomeChangePercent: Decimal;
  expensesChangePercent: Decimal;
  balanceChangePercent: Decimal;
}

/**
 * Per capita metrics.
 */
export interface NewsletterPerCapita {
  income: Decimal;
  expenses: Decimal;
}

/**
 * Newsletter data for rendering.
 */
export interface NewsletterData {
  // Core entity info
  entityName: string;
  entityCui: string;
  periodLabel: string;

  // Extended entity info (optional)
  entityType?: string | undefined;
  countyName?: string | undefined;
  population?: number | undefined;

  // Financial summary
  totalIncome: Decimal;
  totalExpenses: Decimal;
  budgetBalance: Decimal;
  currency: string;

  // Period comparison (optional)
  previousPeriodComparison?: NewsletterPeriodComparison | undefined;

  // Detailed breakdowns (optional)
  topExpenseCategories?: NewsletterTopCategory[] | undefined;
  fundingSources?: NewsletterFundingSource[] | undefined;
  perCapita?: NewsletterPerCapita | undefined;

  // Links (optional)
  mapUrl?: string | undefined;
}

/**
 * Alert data for rendering.
 *
 * Always returned when data exists for the period, even if no conditions
 * are triggered. `triggeredConditions` is empty when monitoring only.
 */
export interface AlertData {
  title: string;
  description?: string;
  /** Current monitored value for the period */
  actualValue: Decimal;
  /** Unit for the monitored value */
  unit: string;
  /** Conditions that were triggered (empty when monitoring only) */
  triggeredConditions: {
    operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
    threshold: Decimal;
    actualValue: Decimal;
    unit: string;
  }[];
}

/**
 * Adapter for fetching notification content data.
 */
export interface DataFetcher {
  /**
   * Fetches data for a newsletter notification.
   */
  fetchNewsletterData(
    entityCui: string,
    periodKey: string,
    periodType: 'monthly' | 'quarterly' | 'yearly'
  ): Promise<Result<NewsletterData, DeliveryError>>;

  /**
   * Fetches data for an alert notification.
   */
  fetchAlertData(
    config: Record<string, unknown>,
    periodKey: string
  ): Promise<Result<AlertData | null, DeliveryError>>;
}
