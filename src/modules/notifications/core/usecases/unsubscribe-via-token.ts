/**
 * Unsubscribe Via Token Use Case
 *
 * Verifies an HMAC-signed token, extracts the user ID, and sets
 * is_active = false on the user's global_unsubscribe notification row.
 */

import { err, ok, type Result } from 'neverthrow';

import { createTokenInvalidError, type NotificationError } from '../errors.js';

import type { NotificationsRepository, UnsubscribeTokenSigner } from '../ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface UnsubscribeViaTokenDeps {
  notificationsRepo: NotificationsRepository;
  tokenSigner: UnsubscribeTokenSigner;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export interface UnsubscribeViaTokenInput {
  token: string;
}

export interface UnsubscribeViaTokenResult {
  userId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unsubscribes a user from all email notifications using an HMAC-signed token.
 *
 * 1. Verifies the HMAC signature and extracts the user ID
 * 2. Finds or creates the global_unsubscribe notification row
 * 3. Sets is_active = false on that row
 */
export async function unsubscribeViaToken(
  deps: UnsubscribeViaTokenDeps,
  input: UnsubscribeViaTokenInput
): Promise<Result<UnsubscribeViaTokenResult, NotificationError>> {
  const { notificationsRepo, tokenSigner } = deps;
  const { token } = input;

  const verified = tokenSigner.verify(token);
  if (verified === null) {
    return err(createTokenInvalidError());
  }

  const { userId } = verified;

  const deactivateResult = await notificationsRepo.deactivateGlobalUnsubscribe(userId);
  if (deactivateResult.isErr()) {
    return err(deactivateResult.error);
  }

  return ok({ userId });
}
