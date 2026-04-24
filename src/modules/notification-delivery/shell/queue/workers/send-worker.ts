/**
 * Send Worker
 *
 * Sends emails via Resend with atomic claim and rate limiting.
 */

import { Worker } from 'bullmq';
import { err, ok } from 'neverthrow';

import {
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_NOTIFICATION_GLOBAL_TYPE,
  FUNKY_OUTBOX_PUBLIC_DEBATE_ANNOUNCEMENT_TYPE,
} from '@/common/campaign-keys.js';
import { hashResendTagValue, sanitizeResendTagValue } from '@/common/resend-tag-encoding.js';
import { isNonEmptyString } from '@/common/utils/is-non-empty-string.js';
import { QUEUE_NAMES } from '@/infra/queue/client.js';

import { parsePublicDebateAdminResponseOutboxMetadata } from '../../../core/admin-response.js';
import { getErrorMessage, isRetryableError } from '../../../core/errors.js';
import {
  isPublicDebateAnnouncementAfterTriggerTime,
  parsePublicDebateAnnouncementOutboxMetadata,
} from '../../../core/public-debate-announcement.js';
import { parseAdminReviewedInteractionOutboxMetadata } from '../../../core/reviewed-interaction.js';
import {
  MAX_RETRY_ATTEMPTS,
  parseAnafForexebugDigestScopeKey,
  type NotificationOutboxRecord,
  type SendJobPayload,
} from '../../../core/types.js';
import {
  FUNKY_WEEKLY_PROGRESS_DIGEST_OUTBOX_TYPE,
  parseWeeklyProgressDigestOutboxMetadata,
  type WeeklyProgressDigestOutboxMetadata,
} from '../../../core/weekly-progress-digest.js';

import type {
  DeliveryRepository,
  UserEmailFetcher,
  EmailSenderPort,
  ExtendedNotificationsRepository,
  ComposeJobScheduler,
  WeeklyProgressDigestPostSendReconciler,
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
  weeklyProgressDigestPostSendReconciler?: WeeklyProgressDigestPostSendReconciler;
  composeJobScheduler?: ComposeJobScheduler;
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

const resolveWeeklyProgressDigestEligibility = async (
  notificationsRepo: ExtendedNotificationsRepository,
  userId: string
) => {
  if (notificationsRepo.findEligibleByUserType !== undefined) {
    return notificationsRepo.findEligibleByUserType(userId, FUNKY_NOTIFICATION_GLOBAL_TYPE);
  }

  const activeResult = await notificationsRepo.findActiveByType(FUNKY_NOTIFICATION_GLOBAL_TYPE);
  if (activeResult.isErr()) {
    return err(activeResult.error);
  }

  const notification = activeResult.value.find((candidate) => candidate.userId === userId) ?? null;

  return ok({
    isEligible: notification !== null,
    reason: notification === null ? 'missing_preference' : 'eligible',
    notification,
  });
};

const parseAnafForexebugDigestSourceIds = (metadata: NotificationOutboxRecord['metadata']) => {
  const value = metadata['sourceNotificationIds'];

  if (!Array.isArray(value) || value.length === 0) {
    return err('sourceNotificationIds must be a non-empty string array');
  }

  const sourceNotificationIds = value.filter(isNonEmptyString);
  if (sourceNotificationIds.length !== value.length) {
    return err('sourceNotificationIds must be a non-empty string array');
  }

  return ok([...new Set(sourceNotificationIds)]);
};

interface SourceNotificationVersion {
  notificationType: string;
  hash: string;
}

const parseAnafForexebugDigestSourceVersions = (
  metadata: NotificationOutboxRecord['metadata']
): Record<string, SourceNotificationVersion> => {
  const value = metadata['sourceNotificationVersions'];
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const versions: Record<string, SourceNotificationVersion> = {};
  for (const [notificationId, rawVersion] of Object.entries(value as Record<string, unknown>)) {
    if (rawVersion === null || typeof rawVersion !== 'object' || Array.isArray(rawVersion)) {
      continue;
    }

    const version = rawVersion as Record<string, unknown>;
    const notificationType = version['notificationType'];
    const hash = version['hash'];
    if (
      isNonEmptyString(notificationId) &&
      isNonEmptyString(notificationType) &&
      isNonEmptyString(hash)
    ) {
      versions[notificationId] = { notificationType, hash };
    }
  }

  return versions;
};

const isBlockingDirectDeliveryForDigest = (delivery: NotificationOutboxRecord): boolean => {
  return (
    delivery.status === 'sending' ||
    delivery.status === 'sent' ||
    delivery.status === 'delivered' ||
    delivery.status === 'webhook_timeout'
  );
};

const shouldSuppressDirectNewsletterForDigest = (
  digest: NotificationOutboxRecord | null
): digest is NotificationOutboxRecord => {
  return digest !== null && digest.status !== 'failed_permanent';
};

const getDigestRecomposeRunId = (delivery: NotificationOutboxRecord): string => {
  const runId = delivery.metadata['runId'];
  if (typeof runId === 'string' && runId.trim() !== '') {
    return runId;
  }

  return `send-recompose-${delivery.id}`;
};

const skipIfUserAnonymizationStarted = async (input: {
  deliveryRepo: DeliveryRepository;
  delivery: NotificationOutboxRecord;
  log: Logger;
}): Promise<boolean> => {
  if (input.deliveryRepo.isUserAnonymizationStarted === undefined) {
    return false;
  }

  const anonymizationResult = await input.deliveryRepo.isUserAnonymizationStarted(
    input.delivery.userId
  );

  if (anonymizationResult.isErr()) {
    const errorMessage = `Failed to check user anonymization state before send: ${getErrorMessage(
      anonymizationResult.error
    )}`;
    input.log.error(
      {
        error: anonymizationResult.error,
        outboxId: input.delivery.id,
      },
      'Failed to check user anonymization state before send'
    );
    await input.deliveryRepo.updateStatusIfStillSending(input.delivery.id, 'failed_transient', {
      lastError: errorMessage,
    });
    throw new Error(errorMessage);
  }

  if (!anonymizationResult.value) {
    return false;
  }

  input.log.info(
    { outboxId: input.delivery.id },
    'User deletion anonymization has started, skipping send'
  );
  await input.deliveryRepo.updateStatusIfStillSending(input.delivery.id, 'skipped_no_email', {
    lastError: 'User deletion anonymization has started; delivery skipped',
  });

  return true;
};

export const processSendJob = async (
  deps: {
    deliveryRepo: DeliveryRepository;
    notificationsRepo: ExtendedNotificationsRepository;
    userEmailFetcher: UserEmailFetcher;
    emailSender: EmailSenderPort;
    tokenSigner: UnsubscribeTokenSigner;
    apiBaseUrl: string;
    environment: string;
    weeklyProgressDigestPostSendReconciler?: WeeklyProgressDigestPostSendReconciler;
    composeJobScheduler?: ComposeJobScheduler;
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
    weeklyProgressDigestPostSendReconciler,
    composeJobScheduler,
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

  if (await skipIfUserAnonymizationStarted({ deliveryRepo, delivery, log })) {
    return { outboxId, status: 'skipped_no_email' };
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

  if (delivery.notificationType.startsWith('newsletter_entity_')) {
    if (delivery.referenceId === null) {
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'failed_permanent', {
        lastError: 'Newsletter delivery is missing source notification reference',
      });
      return {
        outboxId,
        status: 'failed_permanent',
        error: 'Newsletter delivery is missing source notification reference',
      };
    }

    const sourceNotificationResult = await notificationsRepo.findById(delivery.referenceId);
    if (sourceNotificationResult.isErr()) {
      const errorMessage = `Failed to re-check newsletter eligibility: ${getErrorMessage(
        sourceNotificationResult.error
      )}`;
      const retryable = isRetryableError(sourceNotificationResult.error);

      await deliveryRepo.updateStatusIfStillSending(
        outboxId,
        retryable ? 'failed_transient' : 'failed_permanent',
        { lastError: errorMessage }
      );

      if (retryable) {
        throw new Error(errorMessage);
      }

      return { outboxId, status: 'failed_permanent', error: errorMessage };
    }

    const sourceNotification = sourceNotificationResult.value;
    if (
      sourceNotification === null ||
      !sourceNotification.isActive ||
      sourceNotification.userId !== delivery.userId ||
      sourceNotification.notificationType !== delivery.notificationType
    ) {
      log.info(
        {
          outboxId,
          userId: delivery.userId,
          referenceId: delivery.referenceId,
        },
        'Newsletter source notification no longer eligible at send time, skipping'
      );
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'skipped_unsubscribed');
      return { outboxId, status: 'skipped_unsubscribed' };
    }

    if (delivery.notificationType === 'newsletter_entity_monthly') {
      const digestResult = await deliveryRepo.findAnafForexebugDigestForSource(
        delivery.referenceId,
        delivery.scopeKey
      );

      if (digestResult.isErr()) {
        const errorMessage = `Failed to check digest materialization for direct newsletter: ${getErrorMessage(
          digestResult.error
        )}`;
        const retryable = isRetryableError(digestResult.error);

        await deliveryRepo.updateStatusIfStillSending(
          outboxId,
          retryable ? 'failed_transient' : 'failed_permanent',
          { lastError: errorMessage }
        );

        if (retryable) {
          throw new Error(errorMessage);
        }

        return { outboxId, status: 'failed_permanent', error: errorMessage };
      }

      if (shouldSuppressDirectNewsletterForDigest(digestResult.value)) {
        log.info(
          {
            outboxId,
            digestOutboxId: digestResult.value.id,
            referenceId: delivery.referenceId,
            periodKey: delivery.scopeKey,
          },
          'Direct monthly newsletter source already bundled in digest, suppressing direct send'
        );
        await deliveryRepo.updateStatusIfStillSending(outboxId, 'suppressed', {
          lastError: `Suppressed because source notification is bundled in digest ${digestResult.value.id}.`,
        });
        return { outboxId, status: 'skipped_digest_duplicate' };
      }
    }
  }

  if (delivery.notificationType === 'anaf_forexebug_digest') {
    const sourceIdsResult = parseAnafForexebugDigestSourceIds(delivery.metadata);
    if (sourceIdsResult.isErr()) {
      const errorMessage = `Invalid ANAF / Forexebug digest metadata: ${sourceIdsResult.error}`;
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'failed_permanent', {
        lastError: errorMessage,
      });
      return { outboxId, status: 'failed_permanent', error: errorMessage };
    }

    const periodKey = parseAnafForexebugDigestScopeKey(delivery.scopeKey);
    if (periodKey === null) {
      const errorMessage = `Invalid ANAF / Forexebug digest scope: ${delivery.scopeKey}`;
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'failed_permanent', {
        lastError: errorMessage,
      });
      return { outboxId, status: 'failed_permanent', error: errorMessage };
    }

    const sourceIds = sourceIdsResult.value;
    const sourceVersions = parseAnafForexebugDigestSourceVersions(delivery.metadata);
    const activeSourceIds: string[] = [];
    const changedSourceIds: string[] = [];
    const sourceNotificationVersions: Record<string, SourceNotificationVersion> = {};

    for (const sourceId of sourceIds) {
      const sourceNotificationResult = await notificationsRepo.findById(sourceId);
      if (sourceNotificationResult.isErr()) {
        const errorMessage = `Failed to re-check digest source notification '${sourceId}': ${getErrorMessage(
          sourceNotificationResult.error
        )}`;
        const retryable = isRetryableError(sourceNotificationResult.error);

        await deliveryRepo.updateStatusIfStillSending(
          outboxId,
          retryable ? 'failed_transient' : 'failed_permanent',
          { lastError: errorMessage }
        );

        if (retryable) {
          throw new Error(errorMessage);
        }

        return { outboxId, status: 'failed_permanent', error: errorMessage };
      }

      const sourceNotification = sourceNotificationResult.value;
      if (
        sourceNotification !== null &&
        sourceNotification.isActive &&
        sourceNotification.userId === delivery.userId
      ) {
        const directDeliveryResult = await deliveryRepo.findDirectDeliveryForSource(
          sourceNotification.notificationType,
          sourceId,
          periodKey
        );

        if (directDeliveryResult.isErr()) {
          const errorMessage = `Failed to check direct source delivery '${sourceId}': ${getErrorMessage(
            directDeliveryResult.error
          )}`;
          const retryable = isRetryableError(directDeliveryResult.error);

          await deliveryRepo.updateStatusIfStillSending(
            outboxId,
            retryable ? 'failed_transient' : 'failed_permanent',
            { lastError: errorMessage }
          );

          if (retryable) {
            throw new Error(errorMessage);
          }

          return { outboxId, status: 'failed_permanent', error: errorMessage };
        }

        if (
          directDeliveryResult.value !== null &&
          isBlockingDirectDeliveryForDigest(directDeliveryResult.value)
        ) {
          continue;
        }

        const currentVersion = {
          notificationType: sourceNotification.notificationType,
          hash: sourceNotification.hash,
        };
        const composedVersion = sourceVersions[sourceId];
        if (
          composedVersion?.notificationType !== currentVersion.notificationType ||
          composedVersion.hash !== currentVersion.hash
        ) {
          changedSourceIds.push(sourceId);
        }

        activeSourceIds.push(sourceId);
        sourceNotificationVersions[sourceId] = currentVersion;
      }
    }

    if (activeSourceIds.length === 0) {
      log.info(
        { outboxId, userId: delivery.userId },
        'All digest source notifications are inactive, missing, or already direct-delivered at send time, skipping'
      );
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'skipped_unsubscribed', {
        lastError:
          'All digest source notifications are inactive, missing, or already direct-delivered at send time.',
      });
      return { outboxId, status: 'skipped_unsubscribed' };
    }

    if (activeSourceIds.length !== sourceIds.length || changedSourceIds.length > 0) {
      const staleSourceIds = sourceIds.filter((sourceId) => !activeSourceIds.includes(sourceId));
      const metadata = {
        ...delivery.metadata,
        sourceNotificationIds: activeSourceIds,
        itemCount: activeSourceIds.length,
        sourceNotificationVersions,
        staleSourceNotificationIds: staleSourceIds,
        changedSourceNotificationIds: changedSourceIds,
      };
      const refreshResult = await deliveryRepo.refreshSendingDigestMetadataForRecompose(
        outboxId,
        metadata
      );

      if (refreshResult.isErr()) {
        const errorMessage = `Failed to reset stale digest for recompose: ${getErrorMessage(
          refreshResult.error
        )}`;
        const retryable = isRetryableError(refreshResult.error);

        await deliveryRepo.updateStatusIfStillSending(
          outboxId,
          retryable ? 'failed_transient' : 'failed_permanent',
          { lastError: errorMessage }
        );

        if (retryable) {
          throw new Error(errorMessage);
        }

        return { outboxId, status: 'failed_permanent', error: errorMessage };
      }

      if (refreshResult.value === null) {
        log.info({ outboxId }, 'Digest outbox changed state before stale recompose reset');
        return { outboxId, status: 'skipped_status' };
      }

      if (composeJobScheduler === undefined) {
        const errorMessage = 'Digest source preferences changed; compose scheduler unavailable';
        await deliveryRepo.updateStatusIfCurrentIn(outboxId, ['pending'], 'failed_permanent', {
          lastError: errorMessage,
        });
        return { outboxId, status: 'failed_permanent', error: errorMessage };
      }

      const enqueueResult = await composeJobScheduler.enqueue({
        runId: getDigestRecomposeRunId(delivery),
        kind: 'outbox',
        outboxId,
      });

      if (enqueueResult.isErr()) {
        const errorMessage = `Failed to enqueue stale digest recompose: ${getErrorMessage(
          enqueueResult.error
        )}`;
        await deliveryRepo.updateStatusIfCurrentIn(outboxId, ['pending'], 'failed_permanent', {
          lastError: errorMessage,
        });
        return { outboxId, status: 'failed_permanent', error: errorMessage };
      }

      log.info(
        {
          outboxId,
          activeSourceCount: activeSourceIds.length,
          staleSourceCount: staleSourceIds.length,
          changedSourceCount: changedSourceIds.length,
        },
        'Digest source preferences changed at send time, requeued compose'
      );
      return { outboxId, status: 'requeued_compose_due_to_stale_sources' };
    }
  }

  if (delivery.notificationType === 'funky:outbox:admin_reviewed_interaction') {
    const metadataResult = parseAdminReviewedInteractionOutboxMetadata(delivery.metadata);
    if (metadataResult.isErr()) {
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'failed_permanent', {
        lastError: `Invalid reviewed interaction metadata: ${metadataResult.error}`,
      });
      return {
        outboxId,
        status: 'failed_permanent',
        error: `Invalid reviewed interaction metadata: ${metadataResult.error}`,
      };
    }

    const eligibilityResult = await notificationsRepo.findEligibleByUserTypeAndEntity(
      delivery.userId,
      FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
      metadataResult.value.entityCui
    );
    if (eligibilityResult.isErr()) {
      const errorMessage = `Failed to re-check reviewed interaction eligibility: ${getErrorMessage(eligibilityResult.error)}`;
      const retryable = isRetryableError(eligibilityResult.error);

      await deliveryRepo.updateStatusIfStillSending(
        outboxId,
        retryable ? 'failed_transient' : 'failed_permanent',
        { lastError: errorMessage }
      );

      if (retryable) {
        throw new Error(errorMessage);
      }

      return { outboxId, status: 'failed_permanent', error: errorMessage };
    }

    if (!eligibilityResult.value.isEligible) {
      log.info(
        {
          outboxId,
          userId: delivery.userId,
          reason: eligibilityResult.value.reason,
        },
        'Reviewed interaction no longer eligible at send time, skipping'
      );
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'skipped_unsubscribed');
      return { outboxId, status: 'skipped_unsubscribed' };
    }
  }

  if (delivery.notificationType === 'funky:outbox:admin_response') {
    const metadataResult = parsePublicDebateAdminResponseOutboxMetadata(delivery.metadata);
    if (metadataResult.isErr()) {
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'failed_permanent', {
        lastError: `Invalid admin response metadata: ${metadataResult.error}`,
      });
      return {
        outboxId,
        status: 'failed_permanent',
        error: `Invalid admin response metadata: ${metadataResult.error}`,
      };
    }

    const eligibilityResult = await notificationsRepo.findEligibleByUserTypeAndEntity(
      delivery.userId,
      FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
      metadataResult.value.entityCui
    );
    if (eligibilityResult.isErr()) {
      const errorMessage = `Failed to re-check admin response eligibility: ${getErrorMessage(
        eligibilityResult.error
      )}`;
      const retryable = isRetryableError(eligibilityResult.error);

      await deliveryRepo.updateStatusIfStillSending(
        outboxId,
        retryable ? 'failed_transient' : 'failed_permanent',
        { lastError: errorMessage }
      );

      if (retryable) {
        throw new Error(errorMessage);
      }

      return { outboxId, status: 'failed_permanent', error: errorMessage };
    }

    if (!eligibilityResult.value.isEligible) {
      log.info(
        {
          outboxId,
          userId: delivery.userId,
          reason: eligibilityResult.value.reason,
        },
        'Admin response no longer eligible at send time, skipping'
      );
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'skipped_unsubscribed');
      return { outboxId, status: 'skipped_unsubscribed' };
    }
  }

  if (delivery.notificationType === FUNKY_OUTBOX_PUBLIC_DEBATE_ANNOUNCEMENT_TYPE) {
    const metadataResult = parsePublicDebateAnnouncementOutboxMetadata(delivery.metadata);
    if (metadataResult.isErr()) {
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'failed_permanent', {
        lastError: `Invalid public debate announcement metadata: ${metadataResult.error}`,
      });
      return {
        outboxId,
        status: 'failed_permanent',
        error: `Invalid public debate announcement metadata: ${metadataResult.error}`,
      };
    }

    if (
      !isPublicDebateAnnouncementAfterTriggerTime({
        publicDebate: metadataResult.value.publicDebate,
        triggerTime: new Date(),
      })
    ) {
      log.info(
        {
          outboxId,
          userId: delivery.userId,
          entityCui: metadataResult.value.entityCui,
        },
        'Public debate announcement already took place at send time, skipping'
      );
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'skipped_unsubscribed', {
        lastError: 'Public debate announcement already took place at send time.',
      });
      return { outboxId, status: 'skipped_unsubscribed' };
    }

    const eligibilityResult = await notificationsRepo.findEligibleByUserTypeAndEntity(
      delivery.userId,
      FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
      metadataResult.value.entityCui
    );
    if (eligibilityResult.isErr()) {
      const errorMessage = `Failed to re-check public debate announcement eligibility: ${getErrorMessage(
        eligibilityResult.error
      )}`;
      const retryable = isRetryableError(eligibilityResult.error);

      await deliveryRepo.updateStatusIfStillSending(
        outboxId,
        retryable ? 'failed_transient' : 'failed_permanent',
        { lastError: errorMessage }
      );

      if (retryable) {
        throw new Error(errorMessage);
      }

      return { outboxId, status: 'failed_permanent', error: errorMessage };
    }

    if (!eligibilityResult.value.isEligible) {
      log.info(
        {
          outboxId,
          userId: delivery.userId,
          reason: eligibilityResult.value.reason,
        },
        'Public debate announcement no longer eligible at send time, skipping'
      );
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'skipped_unsubscribed');
      return { outboxId, status: 'skipped_unsubscribed' };
    }
  }

  let weeklyProgressDigestMetadata: WeeklyProgressDigestOutboxMetadata | null = null;

  if (delivery.notificationType === FUNKY_WEEKLY_PROGRESS_DIGEST_OUTBOX_TYPE) {
    const metadataResult = parseWeeklyProgressDigestOutboxMetadata(delivery.metadata);
    if (metadataResult.isErr()) {
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'failed_permanent', {
        lastError: `Invalid weekly progress digest metadata: ${metadataResult.error}`,
      });
      return {
        outboxId,
        status: 'failed_permanent',
        error: `Invalid weekly progress digest metadata: ${metadataResult.error}`,
      };
    }

    weeklyProgressDigestMetadata = metadataResult.value;
    const eligibilityResult = await resolveWeeklyProgressDigestEligibility(
      notificationsRepo,
      delivery.userId
    );
    if (eligibilityResult.isErr()) {
      const errorMessage = `Failed to re-check weekly digest eligibility: ${getErrorMessage(
        eligibilityResult.error
      )}`;
      const retryable = isRetryableError(eligibilityResult.error);

      await deliveryRepo.updateStatusIfStillSending(
        outboxId,
        retryable ? 'failed_transient' : 'failed_permanent',
        { lastError: errorMessage }
      );

      if (retryable) {
        throw new Error(errorMessage);
      }

      return { outboxId, status: 'failed_permanent', error: errorMessage };
    }

    if (!eligibilityResult.value.isEligible) {
      log.info(
        {
          outboxId,
          userId: delivery.userId,
          reason: eligibilityResult.value.reason,
        },
        'Weekly progress digest no longer eligible at send time, skipping'
      );
      await deliveryRepo.updateStatusIfStillSending(outboxId, 'skipped_unsubscribed');
      return { outboxId, status: 'skipped_unsubscribed' };
    }
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

  if (await skipIfUserAnonymizationStarted({ deliveryRepo, delivery, log })) {
    return { outboxId, status: 'skipped_no_email' };
  }

  const tags = [
    { name: 'delivery_id', value: sanitizeResendTagValue(delivery.id) },
    { name: 'notification_type', value: sanitizeResendTagValue(delivery.notificationType) },
    { name: 'scope_key', value: hashResendTagValue(delivery.scopeKey) },
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

  const sentAt = new Date();
  const updateResult = await deliveryRepo.updateStatusIfStillSending(outboxId, 'sent', {
    toEmail: userEmail,
    resendEmailId: sendResult.value.emailId,
    sentAt,
  });

  if (updateResult.isErr()) {
    log.error({ error: updateResult.error, outboxId }, 'Failed to update outbox status');
  }

  if (
    weeklyProgressDigestMetadata !== null &&
    weeklyProgressDigestPostSendReconciler !== undefined &&
    updateResult.isOk() &&
    updateResult.value
  ) {
    const reconcileResult = await weeklyProgressDigestPostSendReconciler.reconcile({
      outboxId,
      userId: delivery.userId,
      sentAt,
      metadata: weeklyProgressDigestMetadata,
    });
    if (reconcileResult.isErr()) {
      log.error(
        { outboxId, error: reconcileResult.error },
        'Failed to reconcile weekly progress digest cursor after send'
      );
    }
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
    weeklyProgressDigestPostSendReconciler,
    composeJobScheduler,
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
          ...(weeklyProgressDigestPostSendReconciler !== undefined
            ? { weeklyProgressDigestPostSendReconciler }
            : {}),
          ...(composeJobScheduler !== undefined ? { composeJobScheduler } : {}),
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
