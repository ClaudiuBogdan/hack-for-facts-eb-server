/**
 * List Deliveries Use Case
 *
 * Lists notification delivery history for a user.
 */

import {
  type NotificationDelivery,
  DEFAULT_DELIVERIES_LIMIT,
  MAX_DELIVERIES_LIMIT,
} from '../types.js';

import type { NotificationError } from '../errors.js';
import type { DeliveriesRepository } from '../ports.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface ListDeliveriesDeps {
  deliveriesRepo: DeliveriesRepository;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

export interface ListDeliveriesInput {
  userId: string;
  limit?: number;
  offset?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lists notification deliveries for a user.
 *
 * - Clamps pagination parameters to valid ranges
 * - Returns deliveries ordered by sent date (most recent first)
 */
export async function listDeliveries(
  deps: ListDeliveriesDeps,
  input: ListDeliveriesInput
): Promise<Result<NotificationDelivery[], NotificationError>> {
  const { deliveriesRepo } = deps;
  const { userId, limit: inputLimit, offset: inputOffset } = input;

  // Clamp pagination values
  const limit = Math.min(Math.max(inputLimit ?? DEFAULT_DELIVERIES_LIMIT, 1), MAX_DELIVERIES_LIMIT);
  const offset = Math.max(inputOffset ?? 0, 0);

  return deliveriesRepo.findByUserId(userId, limit, offset);
}
