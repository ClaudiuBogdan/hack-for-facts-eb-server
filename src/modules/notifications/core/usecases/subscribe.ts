/**
 * Subscribe Use Case
 *
 * Creates or reactivates a notification subscription.
 *
 * Business Logic:
 * - For newsletters: lookup by (user, type, entity) - reactivates if exists
 * - For alerts: lookup by hash - returns existing if found
 */

import { ok, err, type Result } from 'neverthrow';

import {
  type Notification,
  type NotificationType,
  type NotificationConfig,
  isNewsletterType,
  generateNotificationHash,
} from '../types.js';
import {
  validateNewsletterEntity,
  validateAnalyticsAlertConfig,
  validateStaticAlertConfig,
} from '../validation.js';

import type { NotificationError } from '../errors.js';
import type { Hasher, NotificationsRepository } from '../ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface SubscribeDeps {
  notificationsRepo: NotificationsRepository;
  hasher: Hasher;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

export interface SubscribeInput {
  userId: string;
  notificationType: NotificationType;
  entityCui?: string | null;
  config?: NotificationConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subscribes a user to a notification.
 *
 * For newsletters:
 * - Looks up by (user, type, entity)
 * - If found (active or inactive), reactivates and returns
 * - If not found, creates new subscription
 *
 * For alerts:
 * - Generates hash from (user, type, entity, config)
 * - If hash exists, returns the existing subscription
 * - If not found, creates new subscription
 */
export async function subscribe(
  deps: SubscribeDeps,
  input: SubscribeInput
): Promise<Result<Notification, NotificationError>> {
  const { notificationsRepo, hasher } = deps;
  const { userId, notificationType, entityCui: inputEntityCui, config: inputConfig } = input;

  const entityCui = inputEntityCui ?? null;
  const config = inputConfig ?? null;

  // ─────────────────────────────────────────────────────────────────────────────
  // Validate based on notification type
  // ─────────────────────────────────────────────────────────────────────────────

  if (isNewsletterType(notificationType)) {
    // Newsletters require an entity
    const validationResult = validateNewsletterEntity(notificationType, entityCui);
    if (validationResult.isErr()) {
      return err(validationResult.error);
    }

    // Newsletter subscription: lookup by (user, type, entity)
    const existingResult = await notificationsRepo.findByUserTypeAndEntity(
      userId,
      notificationType,
      entityCui
    );

    if (existingResult.isErr()) {
      return err(existingResult.error);
    }

    const existing = existingResult.value;

    if (existing !== null) {
      // Reactivate existing subscription
      if (existing.isActive) {
        // Already active, return as-is
        return ok(existing);
      }

      // Reactivate
      const updateResult = await notificationsRepo.update(existing.id, { isActive: true });
      if (updateResult.isOk()) {
        return updateResult;
      }

      // Rare race: notification was deleted between find and update.
      // Treat as "not found" and create a new subscription.
      // TODO(review): decide if we should retry lookup instead of create.
      if (updateResult.error.type === 'NotificationNotFoundError') {
        const hash = generateNotificationHash(hasher, userId, notificationType, entityCui, null);
        return notificationsRepo.create({
          userId,
          notificationType,
          entityCui,
          config: null,
          hash,
        });
      }

      return err(updateResult.error);
    }

    // Create new newsletter subscription
    const hash = generateNotificationHash(hasher, userId, notificationType, entityCui, null);
    return notificationsRepo.create({
      userId,
      notificationType,
      entityCui,
      config: null,
      hash,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Alert subscription
  // ─────────────────────────────────────────────────────────────────────────────

  // Validate alert config
  if (notificationType === 'alert_series_analytics') {
    const validationResult = validateAnalyticsAlertConfig(config, notificationType);
    if (validationResult.isErr()) {
      return err(validationResult.error);
    }
  } else if (notificationType === 'alert_series_static') {
    const validationResult = validateStaticAlertConfig(config, notificationType);
    if (validationResult.isErr()) {
      return err(validationResult.error);
    }
  }

  // Alert subscription: lookup by hash
  const hash = generateNotificationHash(hasher, userId, notificationType, entityCui, config);

  const existingResult = await notificationsRepo.findByHash(hash);
  if (existingResult.isErr()) {
    return err(existingResult.error);
  }

  const existing = existingResult.value;

  if (existing !== null) {
    // Return existing subscription (no duplicate error per spec)
    return ok(existing);
  }

  // Create new alert subscription
  return notificationsRepo.create({
    userId,
    notificationType,
    entityCui,
    config,
    hash,
  });
}
