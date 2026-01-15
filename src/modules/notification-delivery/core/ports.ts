/**
 * Notification Delivery Module - Ports (Interfaces)
 *
 * Repository and adapter contracts for the delivery pipeline.
 */

import type { DeliveryError } from './errors.js';
import type {
  DeliveryRecord,
  DeliveryStatus,
  StoredWebhookEvent,
  ResendWebhookEvent,
} from './types.js';
import type { Notification, NotificationType } from '@/modules/notifications/core/types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Delivery Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for creating a delivery record.
 */
export interface CreateDeliveryInput {
  userId: string;
  notificationId: string;
  periodKey: string;
  deliveryKey: string;
  unsubscribeToken?: string;
  renderedSubject?: string;
  renderedHtml?: string;
  renderedText?: string;
  contentHash?: string;
  templateName?: string;
  templateVersion?: string;
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
 * Repository for delivery records.
 */
export interface DeliveryRepository {
  /**
   * Creates a delivery record with unique constraint protection.
   * Returns DuplicateDelivery error if delivery_key already exists.
   */
  create(input: CreateDeliveryInput): Promise<Result<DeliveryRecord, DeliveryError>>;

  /**
   * Finds a delivery by ID.
   */
  findById(deliveryId: string): Promise<Result<DeliveryRecord | null, DeliveryError>>;

  /**
   * Finds a delivery by delivery key.
   */
  findByDeliveryKey(deliveryKey: string): Promise<Result<DeliveryRecord | null, DeliveryError>>;

  /**
   * Atomic claim for sending.
   * Only succeeds if status is 'pending' or 'failed_transient'.
   * Increments attempt_count in SQL.
   *
   * Returns null if already claimed/processed (no error).
   */
  claimForSending(deliveryId: string): Promise<Result<DeliveryRecord | null, DeliveryError>>;

  /**
   * Updates delivery status with optional metadata.
   */
  updateStatus(
    deliveryId: string,
    input: UpdateDeliveryStatusInput
  ): Promise<Result<void, DeliveryError>>;

  /**
   * Updates status only if current status is 'sending'.
   * Used for reconciliation after crashes.
   */
  updateStatusIfStillSending(
    deliveryId: string,
    status: DeliveryStatus,
    input?: Partial<UpdateDeliveryStatusInput>
  ): Promise<Result<boolean, DeliveryError>>;

  /**
   * Finds deliveries stuck in 'sending' state.
   */
  findStuckSending(olderThanMinutes: number): Promise<Result<DeliveryRecord[], DeliveryError>>;

  /**
   * Checks if a delivery exists by key.
   */
  existsByDeliveryKey(deliveryKey: string): Promise<Result<boolean, DeliveryError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Event Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for inserting a webhook event.
 */
export interface InsertWebhookEventInput {
  svixId: string;
  eventType: string;
  resendEmailId: string;
  deliveryId?: string;
  payload: Record<string, unknown>;
}

/**
 * Repository for Resend webhook events.
 */
export interface WebhookEventRepository {
  /**
   * Inserts a webhook event for idempotent processing.
   * Returns DuplicateWebhookEvent error if svix_id already exists.
   */
  insert(input: InsertWebhookEventInput): Promise<Result<StoredWebhookEvent, DeliveryError>>;

  /**
   * Marks an event as processed.
   */
  markProcessed(svixId: string): Promise<Result<void, DeliveryError>>;

  /**
   * Finds unprocessed events older than threshold.
   */
  findUnprocessed(olderThanMinutes: number): Promise<Result<StoredWebhookEvent[], DeliveryError>>;
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
   * Returns active notifications that haven't been delivered for this period.
   */
  findEligibleForDelivery(
    notificationType: NotificationType,
    periodKey: string,
    limit?: number
  ): Promise<Result<Notification[], DeliveryError>>;

  /**
   * Deactivates a notification.
   */
  deactivate(notificationId: string): Promise<Result<void, DeliveryError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unsubscribe Tokens Repository Extensions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extended tokens repository for delivery pipeline.
 */
export interface ExtendedTokensRepository {
  /**
   * Gets or creates an active unsubscribe token for a notification.
   * If an active token exists, returns it. Otherwise, creates a new one.
   */
  getOrCreateActive(userId: string, notificationId: string): Promise<Result<string, DeliveryError>>;
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
  amount: number;
  percentage: number;
}

/**
 * Funding source breakdown.
 */
export interface NewsletterFundingSource {
  name: string;
  percentage: number;
}

/**
 * Period-over-period comparison data.
 */
export interface NewsletterPeriodComparison {
  incomeChangePercent: number;
  expensesChangePercent: number;
  balanceChangePercent: number;
}

/**
 * Per capita metrics.
 */
export interface NewsletterPerCapita {
  income: number;
  expenses: number;
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
  totalIncome: number;
  totalExpenses: number;
  budgetBalance: number;
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
 */
export interface AlertData {
  title: string;
  description?: string;
  triggeredConditions: {
    operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
    threshold: number;
    actualValue: number;
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
