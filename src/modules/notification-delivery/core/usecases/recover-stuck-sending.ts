/**
 * Recover Stuck Sending Use Case
 *
 * Finds deliveries stuck in 'sending' status for too long and moves them
 * back to 'failed_transient' so they can be retried.
 */

import { ok, err, type Result } from 'neverthrow';

import { type DeliveryError } from '../errors.js';
import { STUCK_SENDING_THRESHOLD_MINUTES } from '../types.js';

import type { DeliveryRepository } from '../ports.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for the recover stuck sending use case.
 */
export interface RecoverStuckSendingDeps {
  deliveryRepo: DeliveryRepository;
  logger: Logger;
}

/**
 * Input for the recover stuck sending use case.
 */
export interface RecoverStuckSendingInput {
  /**
   * Threshold in minutes after which a 'sending' delivery is considered stuck.
   * Defaults to STUCK_SENDING_THRESHOLD_MINUTES (15).
   */
  thresholdMinutes?: number;
}

/**
 * Result of the recover stuck sending use case.
 */
export interface RecoverStuckSendingResult {
  /** Number of deliveries found stuck */
  foundCount: number;
  /** Number of deliveries successfully recovered */
  recoveredCount: number;
  /** IDs of deliveries that were recovered */
  recoveredIds: string[];
  /** Errors encountered during recovery (delivery ID -> error message) */
  errors: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recovers deliveries stuck in 'sending' status.
 *
 * This sweeper function:
 * 1. Finds deliveries that have been in 'sending' status for longer than the threshold
 * 2. Moves them back to 'failed_transient' so they can be retried
 * 3. Resend idempotency keys are valid for 24h, so retry is safe
 *
 * Use cases:
 * - Recover after worker crashes
 * - Recover after network partitions
 * - Clean up orphaned deliveries
 */
export const recoverStuckSending = async (
  deps: RecoverStuckSendingDeps,
  input: RecoverStuckSendingInput
): Promise<Result<RecoverStuckSendingResult, DeliveryError>> => {
  const { deliveryRepo, logger } = deps;
  const thresholdMinutes = input.thresholdMinutes ?? STUCK_SENDING_THRESHOLD_MINUTES;

  const log = logger.child({ usecase: 'recoverStuckSending' });

  log.info({ thresholdMinutes }, 'Starting stuck sending recovery');

  // Find deliveries stuck in 'sending' status
  const findResult = await deliveryRepo.findStuckSending(thresholdMinutes);

  if (findResult.isErr()) {
    log.error({ error: findResult.error }, 'Failed to find stuck deliveries');
    return err(findResult.error);
  }

  const stuckDeliveries = findResult.value;
  const foundCount = stuckDeliveries.length;

  if (foundCount === 0) {
    log.info('No stuck deliveries found');
    return ok({
      foundCount: 0,
      recoveredCount: 0,
      recoveredIds: [],
      errors: {},
    });
  }

  log.warn({ count: foundCount }, 'Found stuck deliveries');

  // Recover each stuck delivery
  const recoveredIds: string[] = [];
  const errors: Record<string, string> = {};

  for (const delivery of stuckDeliveries) {
    const updateResult = await deliveryRepo.updateStatus(delivery.id, {
      status: 'failed_transient',
      lastError: `Recovered from stuck sending state (threshold: ${String(thresholdMinutes)} minutes)`,
    });

    if (updateResult.isErr()) {
      log.error(
        { deliveryId: delivery.id, error: updateResult.error },
        'Failed to recover stuck delivery'
      );
      errors[delivery.id] = updateResult.error.type;
    } else {
      log.info({ deliveryId: delivery.id }, 'Recovered stuck delivery');
      recoveredIds.push(delivery.id);
    }
  }

  const recoveredCount = recoveredIds.length;

  log.info(
    { foundCount, recoveredCount, errorCount: Object.keys(errors).length },
    'Stuck sending recovery completed'
  );

  return ok({
    foundCount,
    recoveredCount,
    recoveredIds,
    errors,
  });
};
