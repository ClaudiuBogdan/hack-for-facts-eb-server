/**
 * Notifications Module - Port Interfaces
 *
 * Defines repository contracts that the shell layer must implement.
 */

import type { NotificationError } from './errors.js';
import type {
  Notification,
  NotificationConfig,
  NotificationDelivery,
  NotificationType,
  UnsubscribeToken,
} from './types.js';
import type { Result } from 'neverthrow';

// Re-export Hasher for backwards compatibility with existing imports
export type { Hasher } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Notifications Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for creating a notification.
 */
export interface CreateNotificationInput {
  userId: string;
  notificationType: NotificationType;
  entityCui: string | null;
  config: NotificationConfig;
  hash: string;
}

/**
 * Input for updating a notification.
 */
export interface UpdateNotificationRepoInput {
  isActive?: boolean;
  config?: NotificationConfig;
  hash?: string;
}

/**
 * Repository interface for notifications.
 */
export interface NotificationsRepository {
  /**
   * Creates a new notification.
   */
  create(input: CreateNotificationInput): Promise<Result<Notification, NotificationError>>;

  /**
   * Finds a notification by ID.
   */
  findById(id: string): Promise<Result<Notification | null, NotificationError>>;

  /**
   * Finds a notification by hash.
   */
  findByHash(hash: string): Promise<Result<Notification | null, NotificationError>>;

  /**
   * Finds all notifications for a user.
   * @param userId - User ID
   * @param activeOnly - If true, only returns active notifications
   */
  findByUserId(
    userId: string,
    activeOnly: boolean
  ): Promise<Result<Notification[], NotificationError>>;

  /**
   * Finds notifications for a user and entity combination.
   * Uses null-safe comparison for entityCui.
   */
  findByUserAndEntity(
    userId: string,
    entityCui: string | null,
    activeOnly: boolean
  ): Promise<Result<Notification[], NotificationError>>;

  /**
   * Finds a single notification by user, type, and entity.
   * Used for newsletter deduplication.
   */
  findByUserTypeAndEntity(
    userId: string,
    notificationType: NotificationType,
    entityCui: string | null
  ): Promise<Result<Notification | null, NotificationError>>;

  /**
   * Updates a notification.
   */
  update(
    id: string,
    input: UpdateNotificationRepoInput
  ): Promise<Result<Notification, NotificationError>>;

  /**
   * Deletes a notification and cascades to deliveries and tokens.
   * Returns the deleted notification or null if not found.
   */
  deleteCascade(id: string): Promise<Result<Notification | null, NotificationError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deliveries Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository interface for notification deliveries.
 */
export interface DeliveriesRepository {
  /**
   * Finds deliveries for a user with pagination.
   */
  findByUserId(
    userId: string,
    limit: number,
    offset: number
  ): Promise<Result<NotificationDelivery[], NotificationError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unsubscribe Tokens Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository interface for unsubscribe tokens.
 */
export interface UnsubscribeTokensRepository {
  /**
   * Finds a token by its value.
   */
  findByToken(token: string): Promise<Result<UnsubscribeToken | null, NotificationError>>;

  /**
   * Checks if a token is valid (exists, not expired, not used).
   */
  isTokenValid(token: string): Promise<Result<boolean, NotificationError>>;

  /**
   * Marks a token as used.
   */
  markAsUsed(token: string): Promise<Result<UnsubscribeToken, NotificationError>>;
}
