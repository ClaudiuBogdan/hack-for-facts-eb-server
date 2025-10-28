import crypto from 'crypto';
import { AlertConfig } from '../../schemas/alerts';

export type NotificationType =
  | 'newsletter_entity_monthly'
  | 'newsletter_entity_quarterly'
  | 'newsletter_entity_yearly'
  | 'newsletter_entity_annual'
  | 'alert_data_series';

export type UUID = string;

export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

export interface DataSeriesConfiguration {
  type: string;
  label: string;
  [key: string]: unknown;
}

export type NotificationConfig = AlertConfig; // Add more config here if needed with |

export interface Notification {
  id: UUID;
  userId: string;
  entityCui: string | null;
  notificationType: NotificationType;
  isActive: boolean;
  config: NotificationConfig | null;
  hash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationDelivery {
  id: number;
  userId: string;
  notificationId: UUID;
  periodKey: string;
  deliveryKey: string;
  emailBatchId: string;
  sentAt: Date;
  metadata: Record<string, any>;
  createdAt: Date;
}

export interface UnsubscribeToken {
  token: string;
  userId: string;
  notificationId: UUID;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface NotificationTypeConfig {
  type: NotificationType;
  label: string;
  description: string;
  requiresEntity: boolean;
  defaultConfig: NotificationConfig | null;
  generatePeriodKey: (date: Date) => string;
}

function generatePreviousMonthKey(date: Date): string {
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  const year = previous.getUTCFullYear();
  const month = String(previous.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function generatePreviousQuarterKey(date: Date): string {
  const monthIndex = date.getUTCMonth(); // 0-based
  const quarter = Math.floor(monthIndex / 3) + 1;
  const previousQuarter = quarter === 1 ? 4 : quarter - 1;
  const year = quarter === 1 ? date.getUTCFullYear() - 1 : date.getUTCFullYear();
  return `${year}-Q${previousQuarter}`;
}

function generatePreviousYearKey(date: Date): string {
  return String(date.getUTCFullYear() - 1);
}

export const NOTIFICATION_TYPE_CONFIGS: Record<NotificationType, NotificationTypeConfig> = {
  newsletter_entity_monthly: {
    type: 'newsletter_entity_monthly',
    label: 'Monthly Entity Newsletter',
    description: 'Receive monthly updates on entity budget execution',
    requiresEntity: true,
    defaultConfig: null,
    generatePeriodKey: generatePreviousMonthKey,
  },
  newsletter_entity_quarterly: {
    type: 'newsletter_entity_quarterly',
    label: 'Quarterly Entity Newsletter',
    description: 'Receive quarterly updates on entity budget execution',
    requiresEntity: true,
    defaultConfig: null,
    generatePeriodKey: generatePreviousQuarterKey,
  },
  newsletter_entity_yearly: {
    type: 'newsletter_entity_yearly',
    label: 'Yearly Entity Newsletter',
    description: 'Receive yearly summary of entity budget execution',
    requiresEntity: true,
    defaultConfig: null,
    generatePeriodKey: generatePreviousYearKey,
  },
  newsletter_entity_annual: {
    type: 'newsletter_entity_annual',
    label: 'Annual Entity Newsletter',
    description: 'Receive annual summary of entity budget execution',
    requiresEntity: true,
    defaultConfig: null,
    generatePeriodKey: generatePreviousYearKey,
  },
  alert_data_series: {
    type: 'alert_data_series',
    label: 'Data Series Alert',
    description: 'Receive alerts based on custom data series queries',
    requiresEntity: false,
    defaultConfig: null,
    generatePeriodKey: (date: Date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      return `${year}-${month}`;
    },
  },
};

/**
 * Recursively sorts object keys for consistent JSON stringification
 */
function sortObjectKeys(obj: any): any {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  const sorted: any = {};
  const keys = Object.keys(obj).sort();

  for (const key of keys) {
    sorted[key] = sortObjectKeys(obj[key]);
  }

  return sorted;
}

/**
 * Generates a SHA-256 hash for notification uniqueness
 * Format: hash(user_id, notification_type, entity_cui, config)
 */
export function generateNotificationHash(
  userId: string,
  notificationType: NotificationType,
  entityCui: string | null,
  config: NotificationConfig | null
): string {
  const configStr = config ? JSON.stringify(sortObjectKeys(config)) : '';
  const data = `${userId}:${notificationType}:${entityCui || ''}:${configStr}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Generates a delivery key for deduplication
 * Format: user_id:notification_id:period_key
 */
export function generateDeliveryKey(
  userId: string,
  notificationId: UUID,
  periodKey: string
): string {
  return `${userId}:${notificationId}:${periodKey}`;
}

/**
 * Generates a period key for the given notification type and date
 */
export function generatePeriodKey(notificationType: NotificationType, date: Date = new Date()): string {
  const config = NOTIFICATION_TYPE_CONFIGS[notificationType];
  return config.generatePeriodKey(date);
}
