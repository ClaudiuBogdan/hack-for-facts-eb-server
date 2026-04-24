/**
 * Notifications Module - Port Interfaces
 *
 * Defines repository contracts that the shell layer must implement.
 */

import type { NotificationError } from './errors.js';
import type {
  Notification,
  NotificationConfig,
  NotificationDeliveryHistory,
  NotificationType,
} from './types.js';
import type { Result } from 'neverthrow';

// Re-export Hasher for backwards compatibility with existing imports
export type { Hasher } from './types.js';

/**
 * Signs and verifies stateless unsubscribe tokens.
 */
export interface UnsubscribeTokenSigner {
  sign(userId: string): string;
  verify(token: string): { userId: string } | null;
}

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

export interface UpdateCampaignGlobalPreferenceRepoInput {
  isActive: boolean;
  config?: NotificationConfig;
  hash?: string;
}

export interface ManualNotificationOptInInput {
  userId: string;
  notificationType: NotificationType;
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
   * Creates a notification from an explicit manual preference API opt-in and
   * applies only the parent/global rows required to make that preference
   * deliverable. Automatic flows must keep using create().
   */
  createWithManualOptIn(
    input: CreateNotificationInput
  ): Promise<Result<Notification, NotificationError>>;

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
   * Updates a notification from an explicit manual preference API opt-in and
   * applies only the parent/global rows required to make that preference
   * deliverable. Automatic flows must keep using update().
   */
  updateWithManualOptIn(
    id: string,
    input: UpdateNotificationRepoInput
  ): Promise<Result<Notification, NotificationError>>;

  /**
   * Updates the public debate campaign master preference. When disabling the
   * master preference, also disables campaign-scoped child preferences for the
   * same user in one transaction. Enabling the master preference does not
   * restore children.
   */
  updateCampaignGlobalPreference(
    id: string,
    input: UpdateCampaignGlobalPreferenceRepoInput
  ): Promise<Result<Notification, NotificationError>>;

  /**
   * Applies manual opt-in parent/global behavior for an explicit subscribe
   * request that found an already active notification. If global_unsubscribe is
   * absent, the user is already implicitly enabled and no row is created.
   */
  applyManualNotificationOptIn(
    input: ManualNotificationOptInInput
  ): Promise<Result<void, NotificationError>>;

  /**
   * Deletes a notification and cascades to deliveries and tokens.
   * Returns the deleted notification or null if not found.
   */
  deleteCascade(id: string): Promise<Result<Notification | null, NotificationError>>;

  /**
   * Finds or creates the global_unsubscribe row for a user, stores email disabled,
   * and sets is_active = false. Delivery treats is_active = false or
   * config.channels.email = false as globally unsubscribed. Idempotent: calling
   * multiple times has the same effect.
   */
  deactivateGlobalUnsubscribe(userId: string): Promise<Result<void, NotificationError>>;
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
  ): Promise<Result<NotificationDeliveryHistory[], NotificationError>>;
}
