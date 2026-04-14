import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_OUTBOX_ADMIN_REVIEWED_INTERACTION_TYPE,
  PUBLIC_DEBATE_CAMPAIGN_KEY,
} from '@/common/campaign-keys.js';

import { createValidationError, type DeliveryError } from '../errors.js';
import {
  ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
  parseAdminReviewedInteractionOutboxMetadata,
  type AdminReviewedInteractionNextStepLink,
  type AdminReviewedInteractionOutboxMetadata,
} from '../reviewed-interaction.js';
import {
  buildAdminReviewedInteractionDeliveryKey,
  buildAdminReviewedInteractionScopeKey,
} from './admin-reviewed-interaction-keys.js';
import {
  enqueueCreatedOrReusedOutbox,
  type DirectOutboxComposeStatus,
} from './enqueue-created-or-reused-outbox.js';
import {
  type TargetedNotificationEligibility,
  type ComposeJobScheduler,
  type DeliveryRepository,
  type ExtendedNotificationsRepository,
} from '../ports.js';

import type { DeliveryStatus } from '../types.js';

export interface AdminReviewedInteractionNotificationInput {
  runId: string;
  dryRun?: boolean;
  campaignKey?: typeof PUBLIC_DEBATE_CAMPAIGN_KEY;
  userId: string;
  entityCui: string;
  entityName: string;
  recordKey: string;
  interactionId: string;
  interactionLabel: string;
  reviewStatus: AdminReviewedInteractionOutboxMetadata['reviewStatus'];
  reviewedAt: string;
  feedbackText?: string;
  nextStepLinks?: readonly AdminReviewedInteractionNextStepLink[];
  triggerSource?: string;
  triggeredByUserId?: string;
  staleGuard?: () => Promise<Result<AdminReviewedInteractionStaleGuardResult, DeliveryError>>;
}

export interface AdminReviewedInteractionStaleGuardResult {
  isStale: boolean;
  reason?: string;
}

export interface EnqueueAdminReviewedInteractionNotificationDeps {
  notificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export type AdminReviewedInteractionExecutionReason =
  | 'eligible_now'
  | 'ineligible_now'
  | 'existing_pending'
  | 'existing_failed_transient'
  | 'existing_sent'
  | 'existing_not_replayable'
  | 'stale_occurrence'
  | 'enqueue_failed';

export interface EnqueueAdminReviewedInteractionNotificationResult {
  status: 'queued' | 'recorded' | 'skipped' | 'dry_run';
  reason: AdminReviewedInteractionExecutionReason;
  deliveryKey: string;
  scopeKey: string;
  eligibility: TargetedNotificationEligibility;
  outboxId?: string;
  outboxStatus?: DeliveryStatus;
  source?: 'created' | 'reused';
  composeStatus?: DirectOutboxComposeStatus;
  staleReason?: string;
}

const normalizeNextStepLinks = (
  nextStepLinks: readonly AdminReviewedInteractionNextStepLink[] | undefined
): AdminReviewedInteractionNextStepLink[] | undefined => {
  if (nextStepLinks === undefined || nextStepLinks.length === 0) {
    return undefined;
  }

  return [...nextStepLinks];
};

const buildMetadata = (
  input: AdminReviewedInteractionNotificationInput
): Result<AdminReviewedInteractionOutboxMetadata, DeliveryError> => {
  const metadataCandidate: Record<string, unknown> = {
    campaignKey: input.campaignKey ?? PUBLIC_DEBATE_CAMPAIGN_KEY,
    familyId: ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
    recordKey: input.recordKey,
    interactionId: input.interactionId,
    interactionLabel: input.interactionLabel,
    reviewStatus: input.reviewStatus,
    reviewedAt: input.reviewedAt,
    userId: input.userId,
    entityCui: input.entityCui,
    entityName: input.entityName,
    ...(input.feedbackText !== undefined ? { feedbackText: input.feedbackText } : {}),
    ...(input.triggerSource !== undefined ? { triggerSource: input.triggerSource } : {}),
    ...(input.triggeredByUserId !== undefined
      ? { triggeredByUserId: input.triggeredByUserId }
      : {}),
  };

  const nextStepLinks = normalizeNextStepLinks(input.nextStepLinks);
  if (nextStepLinks !== undefined) {
    metadataCandidate['nextStepLinks'] = nextStepLinks;
  }

  const metadataResult = parseAdminReviewedInteractionOutboxMetadata(metadataCandidate);
  if (metadataResult.isErr()) {
    return err(createValidationError(metadataResult.error));
  }

  return ok(metadataResult.value);
};

const getExistingReason = (status: DeliveryStatus): AdminReviewedInteractionExecutionReason => {
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

export const enqueueAdminReviewedInteractionNotification = async (
  deps: EnqueueAdminReviewedInteractionNotificationDeps,
  input: AdminReviewedInteractionNotificationInput
): Promise<Result<EnqueueAdminReviewedInteractionNotificationResult, DeliveryError>> => {
  const metadataResult = buildMetadata(input);
  if (metadataResult.isErr()) {
    return err(metadataResult.error);
  }

  const metadata = metadataResult.value;
  const deliveryKey = buildAdminReviewedInteractionDeliveryKey({
    campaignKey: metadata.campaignKey,
    userId: metadata.userId,
    interactionId: metadata.interactionId,
    recordKey: metadata.recordKey,
    reviewedAt: metadata.reviewedAt,
    reviewStatus: metadata.reviewStatus,
  });
  const scopeKey = buildAdminReviewedInteractionScopeKey({
    campaignKey: metadata.campaignKey,
    userId: metadata.userId,
    interactionId: metadata.interactionId,
    recordKey: metadata.recordKey,
    reviewedAt: metadata.reviewedAt,
    reviewStatus: metadata.reviewStatus,
  });

  if (input.staleGuard !== undefined) {
    const staleGuardResult = await input.staleGuard();
    if (staleGuardResult.isErr()) {
      return err(staleGuardResult.error);
    }

    if (staleGuardResult.value.isStale) {
      return ok({
        status: 'skipped',
        reason: 'stale_occurrence',
        deliveryKey,
        scopeKey,
        eligibility: {
          isEligible: false,
          reason: 'missing_preference',
          notification: null,
        },
        ...(staleGuardResult.value.reason !== undefined
          ? { staleReason: staleGuardResult.value.reason }
          : {}),
      });
    }
  }

  const eligibilityResult = await deps.notificationsRepo.findEligibleByUserTypeAndEntity(
    metadata.userId,
    FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
    metadata.entityCui
  );
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
    const reason = getExistingReason(existingOutboxResult.value.status);
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
          existingOutboxResult.value.status === 'failed_transient'
            ? 'compose_enqueued'
            : 'skipped_not_replayable',
      });
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
        notificationType: FUNKY_OUTBOX_ADMIN_REVIEWED_INTERACTION_TYPE,
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
    } satisfies EnqueueAdminReviewedInteractionNotificationResult);
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
    } satisfies EnqueueAdminReviewedInteractionNotificationResult);
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
  } satisfies EnqueueAdminReviewedInteractionNotificationResult);
};
