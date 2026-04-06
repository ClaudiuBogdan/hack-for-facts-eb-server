/**
 * Send Worker
 *
 * Sends emails via Resend with atomic claim and rate limiting.
 */

import { Worker } from 'bullmq';

import { sanitizeResendTagValue } from '@/common/resend-tag-encoding.js';
import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { getErrorMessage, isRetryableError } from '../../../core/errors.js';
import { MAX_RETRY_ATTEMPTS, type SendJobPayload } from '../../../core/types.js';

import type {
  DeliveryRepository,
  UserEmailFetcher,
  EmailSenderPort,
  ExtendedNotificationsRepository,
} from '../../../core/ports.js';
import type { UnsubscribeTokenSigner } from '@/infra/unsubscribe/token.js';
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
  notificationsRepo: ExtendedNotificationsRepository;
  userEmailFetcher: UserEmailFetcher;
  emailSender: EmailSenderPort;
  tokenSigner: UnsubscribeTokenSigner;
  logger: Logger;
  apiBaseUrl: string;
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

export const processSendJob = async (
  deps: Pick<
    SendWorkerDeps,
    | 'deliveryRepo'
    | 'notificationsRepo'
    | 'userEmailFetcher'
    | 'emailSender'
    | 'tokenSigner'
    | 'apiBaseUrl'
    | 'environment'
  > & {
    log: Logger;
  },
  payload: SendJobPayload
) => {
  const {
    deliveryRepo,
    notificationsRepo,
    userEmailFetcher,
    emailSender,
    tokenSigner,
    apiBaseUrl,
    environment,
    log,
  } = deps;
  const { outboxId } = payload;

  log.debug({ outboxId }, 'Processing send job');

  const claimResult = await deliveryRepo.claimForSending(outboxId);

  if (claimResult.isErr()) {
    log.error({ error: claimResult.error, outboxId }, 'Failed to claim outbox row');
    throw new Error(getErrorMessage(claimResult.error));
  }

  const delivery = claimResult.value;

  if (delivery === null) {
    log.info({ outboxId }, 'Outbox row not claimable (already claimed or processed)');
    return { outboxId, status: 'skipped_already_claimed' };
  }

  // Check global unsubscribe before sending
  const globalUnsubResult = await notificationsRepo.isUserGloballyUnsubscribed(delivery.userId);
  if (globalUnsubResult.isErr()) {
    const errorMessage = `Failed to check global unsubscribe: ${getErrorMessage(globalUnsubResult.error)}`;
    const isRetryable = isRetryableError(globalUnsubResult.error);

    log.warn(
      { outboxId, error: globalUnsubResult.error, isRetryable },
      'Failed to check global unsubscribe status'
    );

    await deliveryRepo.updateStatusIfStillSending(
      outboxId,
      isRetryable ? 'failed_transient' : 'failed_permanent',
      { lastError: errorMessage }
    );

    if (isRetryable) {
      throw new Error(errorMessage);
    }

    return { outboxId, status: 'failed_permanent', error: errorMessage };
  }

  if (globalUnsubResult.isOk() && globalUnsubResult.value) {
    log.info({ outboxId, userId: delivery.userId }, 'User globally unsubscribed, skipping');
    await deliveryRepo.updateStatusIfStillSending(outboxId, 'skipped_unsubscribed');
    return { outboxId, status: 'skipped_unsubscribed' };
  }

  if (delivery.attemptCount > MAX_RETRY_ATTEMPTS) {
    log.warn({ outboxId, attemptCount: delivery.attemptCount }, 'Max retry attempts exceeded');

    await deliveryRepo.updateStatusIfCurrentIn(outboxId, ['sending'], 'failed_permanent', {
      lastError: `Exceeded max retry attempts (${String(MAX_RETRY_ATTEMPTS)})`,
    });

    return { outboxId, status: 'failed_max_retries' };
  }

  let userEmail = delivery.toEmail;

  if (userEmail === null) {
    const emailResult = await userEmailFetcher.getEmail(delivery.userId);

    if (emailResult.isErr()) {
      const errorMessage = `Failed to fetch user email: ${getErrorMessage(emailResult.error)}`;
      const isRetryable = isRetryableError(emailResult.error);

      log.warn({ error: emailResult.error, outboxId, isRetryable }, 'Failed to fetch user email');

      await deliveryRepo.updateStatusIfStillSending(
        outboxId,
        isRetryable ? 'failed_transient' : 'failed_permanent',
        { lastError: errorMessage }
      );

      if (isRetryable) {
        throw new Error(errorMessage);
      }

      return { outboxId, status: 'failed_email_fetch', error: errorMessage };
    }

    userEmail = emailResult.value;
  }

  if (userEmail === null) {
    log.info({ outboxId, userId: delivery.userId }, 'User has no email, skipping');

    await deliveryRepo.updateStatusIfStillSending(outboxId, 'skipped_no_email');

    return { outboxId, status: 'skipped_no_email' };
  }

  const unsubscribeUrl = `${apiBaseUrl}/api/v1/notifications/unsubscribe/${tokenSigner.sign(delivery.userId)}`;

  if (
    delivery.renderedSubject === null ||
    delivery.renderedHtml === null ||
    delivery.renderedText === null
  ) {
    log.error({ outboxId }, 'Outbox row missing rendered content');

    await deliveryRepo.updateStatusIfStillSending(outboxId, 'failed_permanent', {
      lastError: 'Missing rendered content',
    });

    return { outboxId, status: 'failed_missing_content' };
  }

  const tags = [
    { name: 'delivery_id', value: sanitizeResendTagValue(delivery.id) },
    { name: 'notification_type', value: sanitizeResendTagValue(delivery.notificationType) },
    { name: 'scope_key', value: sanitizeResendTagValue(delivery.scopeKey) },
    { name: 'env', value: sanitizeResendTagValue(environment) },
  ];

  if (delivery.referenceId !== null) {
    tags.splice(1, 0, {
      name: 'notification_id',
      value: sanitizeResendTagValue(delivery.referenceId),
    });
  }

  if (delivery.templateName !== null) {
    tags.push({ name: 'template_name', value: sanitizeResendTagValue(delivery.templateName) });
  }

  if (delivery.templateVersion !== null) {
    tags.push({
      name: 'template_version',
      value: sanitizeResendTagValue(delivery.templateVersion),
    });
  }

  const sendParams = {
    to: userEmail,
    userId: delivery.userId,
    notificationType: delivery.notificationType,
    referenceId: delivery.referenceId,
    subject: delivery.renderedSubject,
    html: delivery.renderedHtml,
    text: delivery.renderedText,
    idempotencyKey: delivery.id,
    unsubscribeUrl,
    tags,
    templateName: delivery.templateName,
    templateVersion: delivery.templateVersion,
    metadata: delivery.metadata,
  };

  let sendResult: Awaited<ReturnType<EmailSenderPort['send']>>;

  try {
    sendResult = await emailSender.send(sendParams);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown send error';
    const isRetryable = isTransientError(error);

    log.error({ outboxId, error: errorMessage, isRetryable }, 'Send failed with exception');

    await deliveryRepo.updateStatusIfStillSending(
      outboxId,
      isRetryable ? 'failed_transient' : 'failed_permanent',
      { lastError: errorMessage }
    );

    if (isRetryable) {
      throw error;
    }

    return { outboxId, status: 'failed_permanent', error: errorMessage };
  }

  if (sendResult.isErr()) {
    const errorMessage = getErrorMessage(sendResult.error);
    const isRetryable = isRetryableError(sendResult.error);

    log.warn({ outboxId, error: errorMessage, isRetryable }, 'Email send failed');

    await deliveryRepo.updateStatusIfStillSending(
      outboxId,
      isRetryable ? 'failed_transient' : 'failed_permanent',
      { lastError: errorMessage }
    );

    if (isRetryable) {
      throw new Error(errorMessage);
    }

    return { outboxId, status: 'failed_permanent', error: errorMessage };
  }

  const updateResult = await deliveryRepo.updateStatusIfStillSending(outboxId, 'sent', {
    toEmail: userEmail,
    resendEmailId: sendResult.value.emailId,
    sentAt: new Date(),
  });

  if (updateResult.isErr()) {
    log.error({ error: updateResult.error, outboxId }, 'Failed to update outbox status');
  }

  log.info({ outboxId, resendEmailId: sendResult.value.emailId }, 'Email sent successfully');

  return {
    outboxId,
    status: 'sent',
    resendEmailId: sendResult.value.emailId,
  };
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
    notificationsRepo,
    userEmailFetcher,
    emailSender,
    tokenSigner,
    logger,
    apiBaseUrl,
    environment,
    bullmqPrefix,
    maxRps = 2,
    concurrency = 5,
  } = deps;

  const log = logger.child({ worker: 'send' });

  return new Worker<SendJobPayload>(
    QUEUE_NAMES.SEND,
    async (job) =>
      processSendJob(
        {
          deliveryRepo,
          notificationsRepo,
          userEmailFetcher,
          emailSender,
          tokenSigner,
          apiBaseUrl,
          environment,
          log,
        },
        job.data
      ),
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
