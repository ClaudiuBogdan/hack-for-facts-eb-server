/**
 * Recover Stuck Sending Use Case
 *
 * Finds deliveries stuck in 'sending' status for too long and moves them
 * back to 'failed_transient' so they can be retried.
 */

import { ok, err, type Result } from 'neverthrow';

import { type DeliveryError } from '../errors.js';
import { STUCK_SENDING_THRESHOLD_MINUTES } from '../types.js';

import type { DeliveryRepository, LoggerPort } from '../ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for the recover stuck sending use case.
 */
export interface RecoverStuckSendingDeps {
  deliveryRepo: DeliveryRepository;
  logger: LoggerPort;
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
  /** Outbox rows that should be re-enqueued for compose */
  composeRetryIds: string[];
  /** Outbox rows that should be re-enqueued for send */
  sendRetryIds: string[];
  /** Sent rows that timed out waiting for webhook confirmation */
  timedOutIds: string[];
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
  const resendIdempotencyWindowMs = 24 * 60 * 60 * 1000;

  const log = logger.child({ usecase: 'recoverStuckSending' });

  log.info({ thresholdMinutes }, 'Starting stuck sending recovery');

  const [stuckSendingResult, pendingComposeResult, readyToSendResult, sentAwaitingWebhookResult] =
    await Promise.all([
      deliveryRepo.findStuckSending(thresholdMinutes),
      deliveryRepo.findPendingComposeOrphans(thresholdMinutes),
      deliveryRepo.findReadyToSendOrphans(thresholdMinutes),
      deliveryRepo.findSentAwaitingWebhook(thresholdMinutes),
    ]);

  if (stuckSendingResult.isErr()) {
    log.error({ error: stuckSendingResult.error }, 'Failed to find stuck sending deliveries');
    return err(stuckSendingResult.error);
  }

  if (pendingComposeResult.isErr()) {
    log.error({ error: pendingComposeResult.error }, 'Failed to find pending compose orphans');
    return err(pendingComposeResult.error);
  }

  if (readyToSendResult.isErr()) {
    log.error({ error: readyToSendResult.error }, 'Failed to find ready-to-send orphans');
    return err(readyToSendResult.error);
  }

  if (sentAwaitingWebhookResult.isErr()) {
    log.error(
      { error: sentAwaitingWebhookResult.error },
      'Failed to find sent deliveries awaiting webhook'
    );
    return err(sentAwaitingWebhookResult.error);
  }

  const stuckDeliveries = stuckSendingResult.value;
  const pendingComposeOrphans = pendingComposeResult.value;
  const readyToSendOrphans = readyToSendResult.value;
  const sentAwaitingWebhook = sentAwaitingWebhookResult.value;
  const foundCount =
    stuckDeliveries.length +
    pendingComposeOrphans.length +
    readyToSendOrphans.length +
    sentAwaitingWebhook.length;

  if (foundCount === 0) {
    log.info('No stuck deliveries found');
    return ok({
      foundCount: 0,
      recoveredCount: 0,
      recoveredIds: [],
      composeRetryIds: [],
      sendRetryIds: [],
      timedOutIds: [],
      errors: {},
    });
  }

  log.warn({ count: foundCount }, 'Found stuck deliveries');

  // Recover each stuck delivery
  const recoveredIds: string[] = [];
  const composeRetryIds: string[] = [];
  const sendRetryIds: string[] = [];
  const timedOutIds: string[] = [];
  const errors: Record<string, string> = {};

  for (const delivery of stuckDeliveries) {
    const updateResult = await deliveryRepo.updateStatusIfStillSending(
      delivery.id,
      'failed_transient',
      {
        lastError: `Recovered from stuck sending state (threshold: ${String(thresholdMinutes)} minutes)`,
      }
    );

    if (updateResult.isErr()) {
      log.error(
        { deliveryId: delivery.id, error: updateResult.error },
        'Failed to recover stuck delivery'
      );
      errors[delivery.id] = updateResult.error.type;
    } else if (!updateResult.value) {
      log.info(
        { deliveryId: delivery.id },
        'Skipped stuck delivery recovery because state changed concurrently'
      );
    } else {
      log.info({ deliveryId: delivery.id }, 'Recovered stuck delivery');
      recoveredIds.push(delivery.id);
      sendRetryIds.push(delivery.id);
    }
  }

  for (const delivery of pendingComposeOrphans) {
    if (delivery.status === 'composing') {
      const updateResult = await deliveryRepo.updateStatusIfCurrentIn(
        delivery.id,
        ['composing'],
        'pending',
        {
          lastError: `Recovered stale composing delivery (threshold: ${String(thresholdMinutes)} minutes)`,
        }
      );

      if (updateResult.isErr()) {
        log.error(
          { deliveryId: delivery.id, error: updateResult.error },
          'Failed to reset stale composing delivery'
        );
        errors[delivery.id] = updateResult.error.type;
        continue;
      }

      if (!updateResult.value) {
        log.info(
          { deliveryId: delivery.id },
          'Skipped stale composing delivery because state changed concurrently'
        );
        continue;
      }
    }

    log.info({ deliveryId: delivery.id, status: delivery.status }, 'Found compose orphan');
    recoveredIds.push(delivery.id);
    composeRetryIds.push(delivery.id);
  }

  for (const delivery of readyToSendOrphans) {
    log.info({ deliveryId: delivery.id }, 'Found ready-to-send orphan');
    recoveredIds.push(delivery.id);
    sendRetryIds.push(delivery.id);
  }

  for (const delivery of sentAwaitingWebhook) {
    if (delivery.sentAt === null) {
      errors[delivery.id] = 'Missing sentAt for sent delivery';
      continue;
    }

    const ageMs = Date.now() - delivery.sentAt.getTime();
    const nextStatus = ageMs < resendIdempotencyWindowMs ? 'failed_transient' : 'webhook_timeout';
    const lastError =
      nextStatus === 'failed_transient'
        ? `Recovered stale sent delivery awaiting webhook (threshold: ${String(thresholdMinutes)} minutes)`
        : 'Timed out waiting for delivery webhook confirmation after 24 hours';

    const updateResult = await deliveryRepo.updateStatusIfCurrentIn(
      delivery.id,
      ['sent'],
      nextStatus,
      { lastError }
    );

    if (updateResult.isErr()) {
      log.error(
        { deliveryId: delivery.id, error: updateResult.error },
        'Failed to recover sent delivery awaiting webhook'
      );
      errors[delivery.id] = updateResult.error.type;
    } else if (!updateResult.value) {
      log.info(
        { deliveryId: delivery.id },
        'Skipped sent delivery recovery because state changed concurrently'
      );
    } else {
      recoveredIds.push(delivery.id);

      if (nextStatus === 'failed_transient') {
        sendRetryIds.push(delivery.id);
        log.info({ deliveryId: delivery.id }, 'Recovered stale sent delivery for resend');
      } else {
        timedOutIds.push(delivery.id);
        log.info({ deliveryId: delivery.id }, 'Marked sent delivery as webhook timeout');
      }
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
    composeRetryIds,
    sendRetryIds,
    timedOutIds,
    errors,
  });
};
