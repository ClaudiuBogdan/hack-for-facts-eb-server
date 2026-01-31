/**
 * Notifications Module - Domain Types
 *
 * Contains domain types, constants, and pure functions for the notifications module.
 * TypeBox schemas for REST validation are in shell/rest/schemas.ts.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Hasher Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interface for hashing operations.
 * This allows the core layer to remain pure (no crypto import).
 */
export interface Hasher {
  /**
   * Generates a SHA-256 hash of the input string.
   * @returns Hex-encoded hash string
   */
  sha256(data: string): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default limit for delivery history queries */
export const DEFAULT_DELIVERIES_LIMIT = 50;

/** Maximum limit for delivery history queries */
export const MAX_DELIVERIES_LIMIT = 100;

/** Unsubscribe token expiry in days */
export const UNSUBSCRIBE_TOKEN_EXPIRY_DAYS = 365;

// ─────────────────────────────────────────────────────────────────────────────
// Notification Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All supported notification types.
 */
export type NotificationType =
  | 'newsletter_entity_monthly'
  | 'newsletter_entity_quarterly'
  | 'newsletter_entity_yearly'
  | 'alert_series_analytics'
  | 'alert_series_static';

/**
 * Newsletter notification types (require entity).
 */
export const NEWSLETTER_TYPES: readonly NotificationType[] = [
  'newsletter_entity_monthly',
  'newsletter_entity_quarterly',
  'newsletter_entity_yearly',
] as const;

/**
 * Alert notification types (require config).
 */
export const ALERT_TYPES: readonly NotificationType[] = [
  'alert_series_analytics',
  'alert_series_static',
] as const;

/**
 * Check if notification type is a newsletter type.
 */
export const isNewsletterType = (type: NotificationType): boolean => {
  return NEWSLETTER_TYPES.includes(type);
};

/**
 * Check if notification type is an alert type.
 */
export const isAlertType = (type: NotificationType): boolean => {
  return ALERT_TYPES.includes(type);
};

// ─────────────────────────────────────────────────────────────────────────────
// Alert Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alert condition operators.
 */
export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

/**
 * A single alert condition.
 */
export interface AlertCondition {
  operator: AlertOperator;
  threshold: number;
  unit: string;
}

/**
 * Configuration for analytics-based series alerts.
 */
export interface AnalyticsSeriesAlertConfig {
  title?: string;
  description?: string;
  conditions: AlertCondition[];
  // Stored as a JSON-like object and validated at use-time.
  // TODO(review): validate this against a shared AnalyticsFilter schema (TypeBox) if/when added.
  filter: Record<string, unknown>;
}

/**
 * Configuration for static dataset series alerts.
 */
export interface StaticSeriesAlertConfig {
  title?: string;
  description?: string;
  conditions: AlertCondition[];
  datasetId: string;
}

/**
 * Union of all notification config types.
 */
export type NotificationConfig = AnalyticsSeriesAlertConfig | StaticSeriesAlertConfig | null;

// ─────────────────────────────────────────────────────────────────────────────
// Domain Entities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notification subscription entity.
 */
export interface Notification {
  id: string;
  userId: string;
  entityCui: string | null;
  notificationType: NotificationType;
  isActive: boolean;
  config: NotificationConfig;
  hash: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Delivery status for outbox pattern.
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
 * Notification delivery record.
 */
export interface NotificationDelivery {
  id: string;
  userId: string;
  notificationId: string;
  periodKey: string;
  deliveryKey: string;
  status: DeliveryStatus;
  unsubscribeToken: string | null;
  renderedSubject: string | null;
  renderedHtml: string | null;
  renderedText: string | null;
  contentHash: string | null;
  templateName: string | null;
  templateVersion: string | null;
  toEmail: string | null;
  resendEmailId: string | null;
  lastError: string | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
  sentAt: Date | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Unsubscribe token entity.
 */
export interface UnsubscribeToken {
  token: string;
  userId: string;
  notificationId: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure Functions - Period Key Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates period key for the previous month.
 * Example: If today is Feb 15, 2024, returns "2024-01"
 */
function generatePreviousMonthKey(date: Date): string {
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  const year = previous.getUTCFullYear();
  const month = String(previous.getUTCMonth() + 1).padStart(2, '0');
  return `${String(year)}-${month}`;
}

/**
 * Generates period key for the previous quarter.
 * Example: If today is in Q2 2024, returns "2024-Q1"
 */
function generatePreviousQuarterKey(date: Date): string {
  const monthIndex = date.getUTCMonth();
  const quarter = Math.floor(monthIndex / 3) + 1;
  const previousQuarter = quarter === 1 ? 4 : quarter - 1;
  const year = quarter === 1 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
  return `${String(year)}-Q${String(previousQuarter)}`;
}

/**
 * Generates period key for the previous year.
 * Example: If today is 2024, returns "2023"
 */
function generatePreviousYearKey(date: Date): string {
  return String(date.getUTCFullYear() - 1);
}

/**
 * Generates period key based on notification type.
 * Period keys represent the PREVIOUS period (not current).
 */
export function generatePeriodKey(notificationType: NotificationType, date: Date): string {
  switch (notificationType) {
    case 'newsletter_entity_monthly':
    case 'alert_series_analytics':
    case 'alert_series_static':
      return generatePreviousMonthKey(date);
    case 'newsletter_entity_quarterly':
      return generatePreviousQuarterKey(date);
    case 'newsletter_entity_yearly':
      return generatePreviousYearKey(date);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Notification Type Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for a notification type.
 * Defines metadata and behavior for each notification type.
 */
export interface NotificationTypeConfig {
  /** The notification type identifier */
  type: NotificationType;
  /** Human-readable label */
  label: string;
  /** Description of the notification type */
  description: string;
  /** Whether this notification type requires an entity CUI */
  requiresEntity: boolean;
  /** Whether this notification type requires a config */
  requiresConfig: boolean;
}

/**
 * Configuration for all notification types.
 * Used for validation, UI display, and documentation.
 */
export const NOTIFICATION_TYPE_CONFIGS: Record<NotificationType, NotificationTypeConfig> = {
  newsletter_entity_monthly: {
    type: 'newsletter_entity_monthly',
    label: 'Monthly Entity Newsletter',
    description: 'Receive monthly updates on entity budget execution',
    requiresEntity: true,
    requiresConfig: false,
  },
  newsletter_entity_quarterly: {
    type: 'newsletter_entity_quarterly',
    label: 'Quarterly Entity Newsletter',
    description: 'Receive quarterly updates on entity budget execution',
    requiresEntity: true,
    requiresConfig: false,
  },
  newsletter_entity_yearly: {
    type: 'newsletter_entity_yearly',
    label: 'Yearly Entity Newsletter',
    description: 'Receive yearly summary of entity budget execution',
    requiresEntity: true,
    requiresConfig: false,
  },
  alert_series_analytics: {
    type: 'alert_series_analytics',
    label: 'Analytics Series Alert',
    description: 'Receive alerts based on analytics filter queries',
    requiresEntity: false,
    requiresConfig: true,
  },
  alert_series_static: {
    type: 'alert_series_static',
    label: 'Static Dataset Series Alert',
    description: 'Receive alerts based on static datasets by ID',
    requiresEntity: false,
    requiresConfig: true,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure Functions - Hash Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively sorts object keys for deterministic JSON stringification.
 */
function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();

  for (const key of keys) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }

  return sorted;
}

/**
 * Generates a unique hash for a notification subscription.
 *
 * The hash is used to identify duplicate subscriptions:
 * - For newsletters: hash is based on (user, type, entity)
 * - For alerts: hash is based on (user, type, entity, config)
 *
 * Format: SHA-256 of "{userId}:{notificationType}:{entityCui}:{sortedConfig}"
 *
 * @param hasher - Hasher implementation (injected from shell layer)
 */
export function generateNotificationHash(
  hasher: Hasher,
  userId: string,
  notificationType: NotificationType,
  entityCui: string | null,
  config: NotificationConfig
): string {
  const configStr = config !== null ? JSON.stringify(sortObjectKeys(config)) : '';
  const data = `${userId}:${notificationType}:${entityCui ?? ''}:${configStr}`;
  return hasher.sha256(data);
}

/**
 * Generates delivery key for duplicate prevention.
 * Format: "{userId}:{notificationId}:{periodKey}"
 */
export function generateDeliveryKey(
  userId: string,
  notificationId: string,
  periodKey: string
): string {
  return `${userId}:${notificationId}:${periodKey}`;
}
