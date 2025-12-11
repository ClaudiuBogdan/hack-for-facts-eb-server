/**
 * Unsubscribe Via Token Use Case
 *
 * Deactivates a notification subscription using a one-time token.
 * This endpoint is unauthenticated - tokens are included in email links.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  createTokenNotFoundError,
  createTokenInvalidError,
  createNotificationNotFoundError,
  type NotificationError,
} from '../errors.js';

import type { NotificationsRepository, UnsubscribeTokensRepository } from '../ports.js';
import type { Notification } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface UnsubscribeViaTokenDeps {
  notificationsRepo: NotificationsRepository;
  tokensRepo: UnsubscribeTokensRepository;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

export interface UnsubscribeViaTokenInput {
  token: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of unsubscribe operation.
 * Includes the deactivated notification and any warnings.
 */
export interface UnsubscribeViaTokenResult {
  notification: Notification;
  /**
   * If true, the token could not be marked as used.
   * The notification was still deactivated, but the token might be reusable.
   * The shell layer should log this warning.
   */
  tokenMarkingFailed: boolean;
  /**
   * Error details if tokenMarkingFailed is true.
   */
  tokenMarkingError?: NotificationError;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unsubscribes from a notification using a one-time token.
 *
 * - Validates the token exists
 * - Checks the token is not expired or already used
 * - Deactivates the associated notification
 * - Marks the token as used
 * - Returns the deactivated notification and any warnings
 */
export async function unsubscribeViaToken(
  deps: UnsubscribeViaTokenDeps,
  input: UnsubscribeViaTokenInput
): Promise<Result<UnsubscribeViaTokenResult, NotificationError>> {
  const { notificationsRepo, tokensRepo } = deps;
  const { token } = input;

  // Find the token
  const findTokenResult = await tokensRepo.findByToken(token);
  if (findTokenResult.isErr()) {
    return err(findTokenResult.error);
  }

  const tokenRecord = findTokenResult.value;
  if (tokenRecord === null) {
    return err(createTokenNotFoundError(token));
  }

  // Check if token is valid (not expired, not used)
  const now = new Date();
  if (tokenRecord.expiresAt < now) {
    return err(createTokenInvalidError(token));
  }

  if (tokenRecord.usedAt !== null) {
    return err(createTokenInvalidError(token));
  }

  // Find the notification
  const findNotificationResult = await notificationsRepo.findById(tokenRecord.notificationId);
  if (findNotificationResult.isErr()) {
    return err(findNotificationResult.error);
  }

  const notification = findNotificationResult.value;
  if (notification === null) {
    return err(createNotificationNotFoundError(tokenRecord.notificationId));
  }

  // Deactivate the notification
  const updateResult = await notificationsRepo.update(notification.id, { isActive: false });
  if (updateResult.isErr()) {
    return err(updateResult.error);
  }

  // Mark token as used (best-effort - don't fail if this fails)
  const markUsedResult = await tokensRepo.markAsUsed(token);

  // Return result with warning if token marking failed
  if (markUsedResult.isErr()) {
    return ok({
      notification: updateResult.value,
      tokenMarkingFailed: true,
      tokenMarkingError: markUsedResult.error,
    });
  }

  return ok({
    notification: updateResult.value,
    tokenMarkingFailed: false,
  });
}
