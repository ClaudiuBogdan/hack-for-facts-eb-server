/**
 * Delete Notification Use Case
 *
 * Permanently deletes a notification subscription.
 * Also cascades deletion to related deliveries and tokens.
 */

import { ok, err, type Result } from 'neverthrow';

import {
  createNotificationNotFoundError,
  createNotificationForbiddenError,
  type NotificationError,
} from '../errors.js';

import type { NotificationsRepository } from '../ports.js';
import type { Notification } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface DeleteNotificationDeps {
  notificationsRepo: NotificationsRepository;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

export interface DeleteNotificationInput {
  notificationId: string;
  userId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deletes a notification subscription.
 *
 * - Verifies the notification exists
 * - Verifies the user owns the notification
 * - Cascades deletion to related deliveries and unsubscribe tokens
 * - Returns the deleted notification
 */
export async function deleteNotification(
  deps: DeleteNotificationDeps,
  input: DeleteNotificationInput
): Promise<Result<Notification, NotificationError>> {
  const { notificationsRepo } = deps;
  const { notificationId, userId } = input;

  // Find the notification first to verify ownership
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

  // Delete with cascade (deliveries, tokens)
  const deleteResult = await notificationsRepo.deleteCascade(notificationId);
  if (deleteResult.isErr()) {
    return err(deleteResult.error);
  }

  // deleteCascade returns null if not found, but we already verified it exists
  const deleted = deleteResult.value;
  if (deleted === null) {
    return err(createNotificationNotFoundError(notificationId));
  }

  return ok(deleted);
}
