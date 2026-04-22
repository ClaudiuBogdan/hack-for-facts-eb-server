import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_OUTBOX_PUBLIC_DEBATE_ANNOUNCEMENT_TYPE,
  PUBLIC_DEBATE_CAMPAIGN_KEY,
} from '@/common/campaign-keys.js';

import { createValidationError, type DeliveryError } from '../errors.js';
import {
  parsePublicDebateAnnouncementOutboxMetadata,
  PUBLIC_DEBATE_ANNOUNCEMENT_FAMILY_ID,
  type PublicDebateAnnouncementOutboxMetadata,
  type PublicDebateAnnouncementPayload,
} from '../public-debate-announcement.js';
import {
  enqueueCreatedOrReusedOutbox,
  type DirectOutboxComposeStatus,
} from './enqueue-created-or-reused-outbox.js';
import {
  buildPublicDebateAnnouncementDeliveryKey,
  buildPublicDebateAnnouncementScopeKey,
} from './public-debate-announcement-keys.js';

import type {
  ComposeJobScheduler,
  DeliveryRepository,
  ExtendedNotificationsRepository,
  TargetedNotificationEligibility,
} from '../ports.js';
import type { DeliveryStatus } from '../types.js';

export interface PublicDebateAnnouncementNotificationInput {
  runId: string;
  dryRun?: boolean;
  campaignKey?: typeof PUBLIC_DEBATE_CAMPAIGN_KEY;
  userId: string;
  entityCui: string;
  entityName: string;
  publicDebate: PublicDebateAnnouncementPayload;
  announcementFingerprint: string;
  configUpdatedAt: string;
  triggerSource?: string;
  triggeredByUserId?: string;
}

export interface EnqueuePublicDebateAnnouncementNotificationDeps {
  notificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export type PublicDebateAnnouncementExecutionReason =
  | 'eligible_now'
  | 'ineligible_now'
  | 'existing_pending'
  | 'existing_failed_transient'
  | 'existing_sent'
  | 'existing_not_replayable'
  | 'enqueue_failed';

export interface EnqueuePublicDebateAnnouncementNotificationResult {
  status: 'queued' | 'recorded' | 'skipped' | 'dry_run';
  reason: PublicDebateAnnouncementExecutionReason;
  deliveryKey: string;
  scopeKey: string;
  eligibility: TargetedNotificationEligibility;
  outboxId?: string;
  outboxStatus?: DeliveryStatus;
  source?: 'created' | 'reused';
  composeStatus?: DirectOutboxComposeStatus;
}

const buildMetadata = (
  input: PublicDebateAnnouncementNotificationInput
): Result<PublicDebateAnnouncementOutboxMetadata, DeliveryError> => {
  const candidate: Record<string, unknown> = {
    campaignKey: input.campaignKey ?? PUBLIC_DEBATE_CAMPAIGN_KEY,
    familyId: PUBLIC_DEBATE_ANNOUNCEMENT_FAMILY_ID,
    entityCui: input.entityCui,
    entityName: input.entityName,
    publicDebate: input.publicDebate,
    announcementFingerprint: input.announcementFingerprint,
    configUpdatedAt: input.configUpdatedAt,
    ...(input.triggerSource !== undefined ? { triggerSource: input.triggerSource } : {}),
    ...(input.triggeredByUserId !== undefined
      ? { triggeredByUserId: input.triggeredByUserId }
      : {}),
  };

  const metadataResult = parsePublicDebateAnnouncementOutboxMetadata(candidate);
  if (metadataResult.isErr()) {
    return err(createValidationError(metadataResult.error));
  }

  return ok(metadataResult.value);
};

const getExistingReason = (status: DeliveryStatus): PublicDebateAnnouncementExecutionReason => {
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

export const enqueuePublicDebateAnnouncementNotification = async (
  deps: EnqueuePublicDebateAnnouncementNotificationDeps,
  input: PublicDebateAnnouncementNotificationInput
): Promise<Result<EnqueuePublicDebateAnnouncementNotificationResult, DeliveryError>> => {
  const metadataResult = buildMetadata(input);
  if (metadataResult.isErr()) {
    return err(metadataResult.error);
  }

  const metadata = metadataResult.value;
  const scopeKey = buildPublicDebateAnnouncementScopeKey({
    entityCui: metadata.entityCui,
    announcementFingerprint: metadata.announcementFingerprint,
  });
  const deliveryKey = buildPublicDebateAnnouncementDeliveryKey({
    userId: input.userId,
    entityCui: metadata.entityCui,
    announcementFingerprint: metadata.announcementFingerprint,
  });

  const eligibilityResult = await deps.notificationsRepo.findEligibleByUserTypeAndEntity(
    input.userId,
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
        userId: input.userId,
        notificationType: FUNKY_OUTBOX_PUBLIC_DEBATE_ANNOUNCEMENT_TYPE,
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
