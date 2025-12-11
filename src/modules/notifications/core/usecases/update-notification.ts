/**
 * Update Notification Use Case
 *
 * Updates a notification's status or configuration.
 * Recalculates hash when config changes.
 */

import { err, type Result } from 'neverthrow';

import {
  createNotificationNotFoundError,
  createNotificationForbiddenError,
  type NotificationError,
} from '../errors.js';
import {
  type Notification,
  type NotificationConfig,
  isNewsletterType,
  generateNotificationHash,
} from '../types.js';
import { validateConfigForNotificationType } from '../validation.js';

import type { Hasher, NotificationsRepository } from '../ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateNotificationDeps {
  notificationsRepo: NotificationsRepository;
  hasher: Hasher;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateNotificationInput {
  notificationId: string;
  userId: string;
  updates: {
    isActive?: boolean;
    config?: NotificationConfig;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Updates a notification.
 *
 * - Verifies ownership
 * - Validates config if provided
 * - Recalculates hash if config changes
 */
export async function updateNotification(
  deps: UpdateNotificationDeps,
  input: UpdateNotificationInput
): Promise<Result<Notification, NotificationError>> {
  const { notificationsRepo, hasher } = deps;
  const { notificationId, userId, updates } = input;

  // Find the notification
  const findResult = await notificationsRepo.findById(notificationId);
  if (findResult.isErr()) {
    return err(findResult.error);
  }

  const notification = findResult.value;
  if (notification === null) {
    return err(createNotificationNotFoundError(notificationId));
  }

  // Check ownership
  if (notification.userId !== userId) {
    return err(createNotificationForbiddenError(userId, notificationId));
  }

  // Build update payload
  const payload: { isActive?: boolean; config?: NotificationConfig; hash?: string } = {};

  if (updates.isActive !== undefined) {
    payload.isActive = updates.isActive;
  }

  // Handle config update
  let resolvedConfig = notification.config;

  if (updates.config !== undefined) {
    // For newsletter types, config should be null
    if (isNewsletterType(notification.notificationType)) {
      payload.config = null;
      resolvedConfig = null;
    } else {
      // Validate the new config
      const validationResult = validateConfigForNotificationType(
        notification.notificationType,
        updates.config
      );
      if (validationResult.isErr()) {
        return err(validationResult.error);
      }

      payload.config = updates.config;
      resolvedConfig = updates.config;
    }
  }

  // Recalculate hash if config changed
  const newHash = generateNotificationHash(
    hasher,
    notification.userId,
    notification.notificationType,
    notification.entityCui,
    resolvedConfig
  );

  if (newHash !== notification.hash) {
    payload.hash = newHash;
  }

  // Update
  return notificationsRepo.update(notificationId, payload);
}
