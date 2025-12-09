/**
 * List Notifications Use Cases
 *
 * Lists notifications for a user or for a specific entity.
 */

import type { NotificationError } from '../errors.js';
import type { NotificationsRepository } from '../ports.js';
import type { Notification } from '../types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface ListNotificationsDeps {
  notificationsRepo: NotificationsRepository;
}

// ─────────────────────────────────────────────────────────────────────────────
// List User Notifications
// ─────────────────────────────────────────────────────────────────────────────

export interface ListUserNotificationsInput {
  userId: string;
  activeOnly?: boolean;
}

/**
 * Lists all notifications for a user.
 * Returns both active and inactive by default.
 */
export async function listUserNotifications(
  deps: ListNotificationsDeps,
  input: ListUserNotificationsInput
): Promise<Result<Notification[], NotificationError>> {
  const { notificationsRepo } = deps;
  const { userId, activeOnly = false } = input;

  return notificationsRepo.findByUserId(userId, activeOnly);
}

// ─────────────────────────────────────────────────────────────────────────────
// List Entity Notifications
// ─────────────────────────────────────────────────────────────────────────────

export interface ListEntityNotificationsInput {
  userId: string;
  entityCui: string;
  activeOnly?: boolean;
}

/**
 * Lists a user's notifications for a specific entity.
 */
export async function listEntityNotifications(
  deps: ListNotificationsDeps,
  input: ListEntityNotificationsInput
): Promise<Result<Notification[], NotificationError>> {
  const { notificationsRepo } = deps;
  const { userId, entityCui, activeOnly = false } = input;

  return notificationsRepo.findByUserAndEntity(userId, entityCui, activeOnly);
}
