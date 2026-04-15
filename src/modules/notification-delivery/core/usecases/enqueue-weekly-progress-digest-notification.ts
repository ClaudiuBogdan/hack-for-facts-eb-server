import { err, ok, type Result } from 'neverthrow';

import { FUNKY_NOTIFICATION_GLOBAL_TYPE } from '@/common/campaign-keys.js';

import { createValidationError, getErrorMessage, type DeliveryError } from '../errors.js';
import {
  FUNKY_WEEKLY_PROGRESS_DIGEST_OUTBOX_TYPE,
  buildWeeklyProgressDigestDeliveryKey,
  buildWeeklyProgressDigestScopeKey,
  parseWeeklyProgressDigestOutboxMetadata,
  type WeeklyProgressDigestOutboxMetadata,
  type WeeklyProgressDigestSnapshot,
} from '../weekly-progress-digest.js';
import {
  enqueueCreatedOrReusedOutbox,
  type DirectOutboxComposeStatus,
} from './enqueue-created-or-reused-outbox.js';

import type {
  ComposeJobScheduler,
  DeliveryRepository,
  ExtendedNotificationsRepository,
  UserScopedNotificationEligibility,
} from '../ports.js';
import type { DeliveryStatus } from '../types.js';

export interface WeeklyProgressDigestNotificationInput extends WeeklyProgressDigestSnapshot {
  runId: string;
  userId: string;
  dryRun?: boolean;
  triggerSource?: string;
  triggeredByUserId?: string;
}

export interface EnqueueWeeklyProgressDigestNotificationDeps {
  notificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export type WeeklyProgressDigestExecutionReason =
  | 'eligible_now'
  | 'ineligible_now'
  | 'existing_pending'
  | 'existing_failed_transient'
  | 'existing_sent'
  | 'existing_not_replayable'
  | 'no_items'
  | 'enqueue_failed';

export interface EnqueueWeeklyProgressDigestNotificationResult {
  status: 'queued' | 'recorded' | 'skipped' | 'dry_run';
  reason: WeeklyProgressDigestExecutionReason;
  deliveryKey: string;
  scopeKey: string;
  eligibility: UserScopedNotificationEligibility;
  outboxId?: string;
  outboxStatus?: DeliveryStatus;
  source?: 'created' | 'reused';
  composeStatus?: DirectOutboxComposeStatus;
}

const resolveEligibility = async (
  notificationsRepo: ExtendedNotificationsRepository,
  userId: string
): Promise<Result<UserScopedNotificationEligibility, DeliveryError>> => {
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

const normalizeSecondaryCtas = (
  metadata: WeeklyProgressDigestOutboxMetadata
): WeeklyProgressDigestOutboxMetadata['secondaryCtas'] => {
  const seen = new Set<string>([metadata.primaryCta.url]);
  const unique: WeeklyProgressDigestOutboxMetadata['secondaryCtas'] = [];

  for (const cta of metadata.secondaryCtas) {
    if (seen.has(cta.url)) {
      continue;
    }

    seen.add(cta.url);
    unique.push(cta);

    if (unique.length >= 2) {
      break;
    }
  }

  return unique;
};

const buildMetadata = (
  input: WeeklyProgressDigestNotificationInput
): Result<WeeklyProgressDigestOutboxMetadata, DeliveryError> => {
  const metadataCandidate: Record<string, unknown> = {
    digestType: 'weekly_progress_digest',
    campaignKey: 'funky',
    userId: input.userId,
    weekKey: input.weekKey,
    periodLabel: input.periodLabel,
    watermarkAt: input.watermarkAt,
    summary: input.summary,
    items: input.items,
    primaryCta: input.primaryCta,
    secondaryCtas: input.secondaryCtas,
    ...(input.allUpdatesUrl !== undefined ? { allUpdatesUrl: input.allUpdatesUrl } : {}),
    ...(input.triggerSource !== undefined ? { triggerSource: input.triggerSource } : {}),
    ...(input.triggeredByUserId !== undefined
      ? { triggeredByUserId: input.triggeredByUserId }
      : {}),
  };

  const metadataResult = parseWeeklyProgressDigestOutboxMetadata(metadataCandidate);
  if (metadataResult.isErr()) {
    return err(createValidationError(metadataResult.error));
  }

  if (
    metadataResult.value.summary.totalItemCount === 0 ||
    metadataResult.value.items.length === 0
  ) {
    return err(createValidationError('Weekly progress digest requires at least one item.'));
  }

  return ok({
    ...metadataResult.value,
    secondaryCtas: normalizeSecondaryCtas(metadataResult.value),
  });
};

const getExistingReason = (status: DeliveryStatus): WeeklyProgressDigestExecutionReason => {
  if (status === 'pending') {
    return 'existing_pending';
  }

  if (status === 'failed_transient') {
    return 'existing_failed_transient';
  }

  if (status === 'sent' || status === 'delivered' || status === 'webhook_timeout') {
    return 'existing_sent';
  }

  return 'existing_not_replayable';
};

const isReplayableSkippedStatus = (status: DeliveryStatus): boolean => {
  return status === 'skipped_no_email' || status === 'skipped_unsubscribed';
};

export const enqueueWeeklyProgressDigestNotification = async (
  deps: EnqueueWeeklyProgressDigestNotificationDeps,
  input: WeeklyProgressDigestNotificationInput
): Promise<Result<EnqueueWeeklyProgressDigestNotificationResult, DeliveryError>> => {
  const deliveryKey = buildWeeklyProgressDigestDeliveryKey({
    userId: input.userId,
    weekKey: input.weekKey,
  });
  const scopeKey = buildWeeklyProgressDigestScopeKey(input.weekKey);

  const metadataResult = buildMetadata(input);
  if (metadataResult.isErr()) {
    if (
      getErrorMessage(metadataResult.error) === 'Weekly progress digest requires at least one item.'
    ) {
      return ok({
        status: 'skipped',
        reason: 'no_items',
        deliveryKey,
        scopeKey,
        eligibility: {
          isEligible: false,
          reason: 'missing_preference',
          notification: null,
        },
      });
    }

    return err(metadataResult.error);
  }

  const metadata = metadataResult.value;
  const eligibilityResult = await resolveEligibility(deps.notificationsRepo, metadata.userId);
  if (eligibilityResult.isErr()) {
    return err(eligibilityResult.error);
  }

  if (!eligibilityResult.value.isEligible || eligibilityResult.value.notification === null) {
    return ok({
      status: 'skipped',
      reason: 'ineligible_now',
      deliveryKey,
      scopeKey,
      eligibility: eligibilityResult.value,
    });
  }

  const existingOutboxResult = await deps.deliveryRepo.findByDeliveryKey(deliveryKey);
  if (existingOutboxResult.isErr()) {
    return err(existingOutboxResult.error);
  }

  if (existingOutboxResult.value !== null) {
    const reason = isReplayableSkippedStatus(existingOutboxResult.value.status)
      ? 'existing_failed_transient'
      : getExistingReason(existingOutboxResult.value.status);
    if (reason === 'existing_sent' || reason === 'existing_not_replayable') {
      return ok({
        status: 'skipped',
        reason,
        deliveryKey,
        scopeKey,
        eligibility: eligibilityResult.value,
        outboxId: existingOutboxResult.value.id,
        outboxStatus: existingOutboxResult.value.status,
      });
    }

    if (input.dryRun === true) {
      return ok({
        status: 'dry_run',
        reason,
        deliveryKey,
        scopeKey,
        eligibility: eligibilityResult.value,
        outboxId: existingOutboxResult.value.id,
        outboxStatus: existingOutboxResult.value.status,
        source: 'reused',
        composeStatus:
          existingOutboxResult.value.status === 'pending' ||
          existingOutboxResult.value.status === 'failed_transient' ||
          isReplayableSkippedStatus(existingOutboxResult.value.status)
            ? 'compose_enqueued'
            : 'skipped_not_replayable',
      });
    }

    if (isReplayableSkippedStatus(existingOutboxResult.value.status)) {
      const resetResult = await deps.deliveryRepo.updateStatusIfCurrentIn(
        existingOutboxResult.value.id,
        [existingOutboxResult.value.status],
        'pending'
      );
      if (resetResult.isErr()) {
        return err(resetResult.error);
      }

      if (resetResult.value) {
        const composeEnqueueResult = await deps.composeJobScheduler.enqueue({
          runId: input.runId,
          kind: 'outbox',
          outboxId: existingOutboxResult.value.id,
        });
        if (composeEnqueueResult.isErr()) {
          return ok({
            status: 'recorded',
            reason: 'enqueue_failed',
            deliveryKey,
            scopeKey,
            eligibility: eligibilityResult.value,
            outboxId: existingOutboxResult.value.id,
            outboxStatus: 'pending',
            source: 'reused',
            composeStatus: 'compose_enqueue_failed',
          });
        }

        return ok({
          status: 'queued',
          reason: 'existing_failed_transient',
          deliveryKey,
          scopeKey,
          eligibility: eligibilityResult.value,
          outboxId: existingOutboxResult.value.id,
          outboxStatus: 'pending',
          source: 'reused',
          composeStatus: 'compose_enqueued',
        });
      }
    }
  } else if (input.dryRun === true) {
    return ok({
      status: 'dry_run',
      reason: 'eligible_now',
      deliveryKey,
      scopeKey,
      eligibility: eligibilityResult.value,
      source: 'created',
      composeStatus: 'compose_enqueued',
    });
  }

  const enqueueResult = await enqueueCreatedOrReusedOutbox(
    {
      deliveryRepo: deps.deliveryRepo,
      composeJobScheduler: deps.composeJobScheduler,
    },
    {
      runId: input.runId,
      deliveryKey,
      reusedOutboxComposeStrategy: 'enqueue_if_claimable',
      createInput: {
        userId: metadata.userId,
        notificationType: FUNKY_WEEKLY_PROGRESS_DIGEST_OUTBOX_TYPE,
        referenceId: eligibilityResult.value.notification.id,
        scopeKey,
        deliveryKey,
        metadata,
      },
    }
  );
  if (enqueueResult.isErr()) {
    return err(enqueueResult.error);
  }

  const result = enqueueResult.value;
  const outboxResult = await deps.deliveryRepo.findById(result.outboxId);
  if (outboxResult.isErr()) {
    return err(outboxResult.error);
  }

  const outboxStatus = outboxResult.value?.status;
  if (result.composeStatus === 'compose_enqueue_failed') {
    return ok({
      status: 'recorded',
      reason: 'enqueue_failed',
      deliveryKey,
      scopeKey,
      eligibility: eligibilityResult.value,
      outboxId: result.outboxId,
      source: result.source,
      composeStatus: result.composeStatus,
      ...(outboxStatus !== undefined ? { outboxStatus } : {}),
    });
  }

  if (
    result.composeStatus === 'skipped_not_replayable' ||
    result.composeStatus === 'skipped_terminal'
  ) {
    return ok({
      status: 'skipped',
      reason: getExistingReason(outboxStatus ?? 'pending'),
      deliveryKey,
      scopeKey,
      eligibility: eligibilityResult.value,
      outboxId: result.outboxId,
      source: result.source,
      composeStatus: result.composeStatus,
      ...(outboxStatus !== undefined ? { outboxStatus } : {}),
    });
  }

  return ok({
    status: 'queued',
    reason:
      result.source === 'created' ? 'eligible_now' : getExistingReason(outboxStatus ?? 'pending'),
    deliveryKey,
    scopeKey,
    eligibility: eligibilityResult.value,
    outboxId: result.outboxId,
    source: result.source,
    composeStatus: result.composeStatus,
    ...(outboxStatus !== undefined ? { outboxStatus } : {}),
  });
};
