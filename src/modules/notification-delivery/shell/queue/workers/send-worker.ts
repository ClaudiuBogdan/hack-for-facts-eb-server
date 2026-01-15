/**
 * Send Worker
 *
 * Sends emails via Resend with atomic claim and rate limiting.
 */

import { Worker } from 'bullmq';

import { getErrorMessage } from '../../../core/errors.js';
import { MAX_RETRY_ATTEMPTS, type SendJobPayload } from '../../../core/types.js';

import type { DeliveryRepository, UserEmailFetcher, EmailSenderPort } from '../../../core/ports.js';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for the send worker.
 */
export interface SendWorkerDeps {
  redis: Redis;
  deliveryRepo: DeliveryRepository;
  userEmailFetcher: UserEmailFetcher;
  emailSender: EmailSenderPort;
  logger: Logger;
  platformBaseUrl: string;
  environment: string;
  bullmqPrefix: string;
  /** Rate limit: max requests per second (default: 2 for Resend) */
  maxRps?: number;
  concurrency?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines if an error is transient (retryable).
 */
const isTransientError = (error: unknown): boolean => {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    // Rate limiting
    if (message.includes('429') || message.includes('rate limit')) {
      return true;
    }

    // Temporary server errors
    if (message.includes('502') || message.includes('503') || message.includes('504')) {
      return true;
    }

    // Network errors
    if (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('connection')
    ) {
      return true;
    }
  }

  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the send worker.
 *
 * The send worker:
 * 1. Atomic claim: Only succeeds if status is 'pending' or 'failed_transient'
 * 2. Fetches user email
 * 3. Sends via Resend with idempotency key
 * 4. Updates delivery status
 * 5. Handles errors with transient/permanent classification
 */
export const createSendWorker = (deps: SendWorkerDeps): Worker<SendJobPayload> => {
  const {
    redis,
    deliveryRepo,
    userEmailFetcher,
    emailSender,
    logger,
    platformBaseUrl,
    environment,
    bullmqPrefix,
    maxRps = 2,
    concurrency = 5,
  } = deps;

  const log = logger.child({ worker: 'send' });

  return new Worker<SendJobPayload>(
    'notification:send',
    async (job) => {
      const { deliveryId } = job.data;

      log.debug({ deliveryId }, 'Processing send job');

      // 1. ATOMIC CLAIM: Only succeeds if status is claimable
      // This prevents double-sends and handles concurrent workers
      const claimResult = await deliveryRepo.claimForSending(deliveryId);

      if (claimResult.isErr()) {
        log.error({ error: claimResult.error, deliveryId }, 'Failed to claim delivery');
        throw new Error(getErrorMessage(claimResult.error));
      }

      const delivery = claimResult.value;

      if (delivery === null) {
        // Already claimed by another worker or already processed
        log.info({ deliveryId }, 'Delivery not claimable (already claimed or processed)');
        return { deliveryId, status: 'skipped_already_claimed' };
      }

      // Check max retry attempts
      if (delivery.attemptCount > MAX_RETRY_ATTEMPTS) {
        log.warn(
          { deliveryId, attemptCount: delivery.attemptCount },
          'Max retry attempts exceeded'
        );

        await deliveryRepo.updateStatus(deliveryId, {
          status: 'failed_permanent',
          lastError: `Exceeded max retry attempts (${String(MAX_RETRY_ATTEMPTS)})`,
        });

        return { deliveryId, status: 'failed_max_retries' };
      }

      // 2. Fetch user email
      const emailResult = await userEmailFetcher.getEmail(delivery.userId);

      if (emailResult.isErr()) {
        log.error({ error: emailResult.error, deliveryId }, 'Failed to fetch user email');

        // Mark as permanent failure - can't retry without valid email
        await deliveryRepo.updateStatus(deliveryId, {
          status: 'failed_permanent',
          lastError: `Failed to fetch user email: ${getErrorMessage(emailResult.error)}`,
        });

        return { deliveryId, status: 'failed_email_fetch' };
      }

      const userEmail = emailResult.value;

      if (userEmail === null) {
        log.info({ deliveryId, userId: delivery.userId }, 'User has no email, skipping');

        await deliveryRepo.updateStatus(deliveryId, {
          status: 'skipped_no_email',
        });

        return { deliveryId, status: 'skipped_no_email' };
      }

      // 3. Build unsubscribe URL
      const unsubscribeUrl =
        delivery.unsubscribeToken !== null
          ? `${platformBaseUrl}/api/v1/notifications/unsubscribe/${delivery.unsubscribeToken}`
          : `${platformBaseUrl}/notifications/preferences`;

      // 4. Validate rendered content
      if (
        delivery.renderedSubject === null ||
        delivery.renderedHtml === null ||
        delivery.renderedText === null
      ) {
        log.error({ deliveryId }, 'Delivery missing rendered content');

        await deliveryRepo.updateStatus(deliveryId, {
          status: 'failed_permanent',
          lastError: 'Missing rendered content',
        });

        return { deliveryId, status: 'failed_missing_content' };
      }

      // 5. Send email via Resend
      try {
        const sendResult = await emailSender.send({
          to: userEmail,
          subject: delivery.renderedSubject,
          html: delivery.renderedHtml,
          text: delivery.renderedText,
          idempotencyKey: delivery.id, // Use delivery UUID (no colons!)
          unsubscribeUrl,
          tags: [
            // Tags must use allowed characters only (letters, numbers, underscores, dashes)
            { name: 'delivery_id', value: delivery.id },
            { name: 'notification_id', value: delivery.notificationId },
            { name: 'period_key', value: delivery.periodKey },
            { name: 'env', value: environment },
          ],
        });

        if (sendResult.isErr()) {
          const error = sendResult.error;
          const errorMessage = getErrorMessage(error);
          const isRetryable = isTransientError(new Error(errorMessage));

          log.warn({ deliveryId, error: errorMessage, isRetryable }, 'Email send failed');

          await deliveryRepo.updateStatusIfStillSending(
            deliveryId,
            isRetryable ? 'failed_transient' : 'failed_permanent',
            { lastError: errorMessage }
          );

          if (isRetryable) {
            // Throw to trigger BullMQ retry
            throw new Error(errorMessage);
          }

          return { deliveryId, status: 'failed_permanent', error: errorMessage };
        }

        // 6. Success - update status
        const updateResult = await deliveryRepo.updateStatusIfStillSending(deliveryId, 'sent', {
          toEmail: userEmail,
          resendEmailId: sendResult.value.emailId,
          sentAt: new Date(),
        });

        if (updateResult.isErr()) {
          log.error({ error: updateResult.error, deliveryId }, 'Failed to update delivery status');
          // Don't throw - email was sent successfully
        }

        log.info(
          { deliveryId, resendEmailId: sendResult.value.emailId },
          'Email sent successfully'
        );

        return {
          deliveryId,
          status: 'sent',
          resendEmailId: sendResult.value.emailId,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown send error';
        const isRetryable = isTransientError(error);

        log.error({ deliveryId, error: errorMessage, isRetryable }, 'Send failed with exception');

        await deliveryRepo.updateStatusIfStillSending(
          deliveryId,
          isRetryable ? 'failed_transient' : 'failed_permanent',
          { lastError: errorMessage }
        );

        if (isRetryable) {
          throw error; // Trigger BullMQ retry
        }

        return { deliveryId, status: 'failed_permanent', error: errorMessage };
      }
    },
    {
      connection: redis,
      prefix: bullmqPrefix,
      concurrency,
      // Rate limiter for Resend (default 2 requests/second)
      limiter: {
        max: maxRps,
        duration: 1000, // 1 second
      },
    }
  );
};
