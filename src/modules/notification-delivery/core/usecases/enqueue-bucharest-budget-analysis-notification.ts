import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_OUTBOX_BUCHAREST_BUDGET_ANALYSIS_TYPE,
} from '@/common/campaign-keys.js';

import {
  BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI,
  BUCHAREST_BUDGET_ANALYSIS_ENTITY_NAME,
  BUCHAREST_BUDGET_ANALYSIS_FAMILY_ID,
  BUCHAREST_BUDGET_ANALYSIS_ID,
  BUCHAREST_BUDGET_ANALYSIS_PUBLISHED_AT,
  BUCHAREST_BUDGET_ANALYSIS_URL,
  parseBucharestBudgetAnalysisOutboxMetadata,
  type BucharestBudgetAnalysisOutboxMetadata,
} from '../bucharest-budget-analysis.js';
import { createValidationError, type DeliveryError } from '../errors.js';
import {
  buildBucharestBudgetAnalysisDeliveryKey,
  buildBucharestBudgetAnalysisScopeKey,
} from './bucharest-budget-analysis-keys.js';
import {
  enqueueCreatedOrReusedOutbox,
  type DirectOutboxComposeStatus,
} from './enqueue-created-or-reused-outbox.js';

import type {
  ComposeJobScheduler,
  DeliveryRepository,
  ExtendedNotificationsRepository,
  TargetedNotificationEligibility,
} from '../ports.js';
import type { DeliveryStatus } from '../types.js';

export interface BucharestBudgetAnalysisNotificationInput {
  runId: string;
  dryRun?: boolean;
  userId: string;
  analysisFingerprint: string;
  triggerSource?: string;
  triggeredByUserId?: string;
}

export interface EnqueueBucharestBudgetAnalysisNotificationDeps {
  notificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export type BucharestBudgetAnalysisExecutionReason =
  | 'eligible_now'
  | 'ineligible_now'
  | 'existing_pending'
  | 'existing_failed_transient'
  | 'existing_sent'
  | 'existing_not_replayable'
  | 'enqueue_failed';

export interface EnqueueBucharestBudgetAnalysisNotificationResult {
  status: 'queued' | 'recorded' | 'skipped' | 'dry_run';
  reason: BucharestBudgetAnalysisExecutionReason;
  deliveryKey: string;
  scopeKey: string;
  eligibility: TargetedNotificationEligibility;
  outboxId?: string;
  outboxStatus?: DeliveryStatus;
  source?: 'created' | 'reused';
  composeStatus?: DirectOutboxComposeStatus;
}

const buildMetadata = (
  input: BucharestBudgetAnalysisNotificationInput
): Result<BucharestBudgetAnalysisOutboxMetadata, DeliveryError> => {
  const candidate: Record<string, unknown> = {
    campaignKey: 'funky',
    familyId: BUCHAREST_BUDGET_ANALYSIS_FAMILY_ID,
    entityCui: BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI,
    entityName: BUCHAREST_BUDGET_ANALYSIS_ENTITY_NAME,
    analysisId: BUCHAREST_BUDGET_ANALYSIS_ID,
    analysisUrl: BUCHAREST_BUDGET_ANALYSIS_URL,
    analysisPublishedAt: BUCHAREST_BUDGET_ANALYSIS_PUBLISHED_AT,
    analysisFingerprint: input.analysisFingerprint,
    ...(input.triggerSource !== undefined ? { triggerSource: input.triggerSource } : {}),
    ...(input.triggeredByUserId !== undefined
      ? { triggeredByUserId: input.triggeredByUserId }
      : {}),
  };

  const metadataResult = parseBucharestBudgetAnalysisOutboxMetadata(candidate);
  if (metadataResult.isErr()) {
    return err(createValidationError(metadataResult.error));
  }

  return ok(metadataResult.value);
};

const getExistingReason = (status: DeliveryStatus): BucharestBudgetAnalysisExecutionReason => {
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

export const enqueueBucharestBudgetAnalysisNotification = async (
  deps: EnqueueBucharestBudgetAnalysisNotificationDeps,
  input: BucharestBudgetAnalysisNotificationInput
): Promise<Result<EnqueueBucharestBudgetAnalysisNotificationResult, DeliveryError>> => {
  const metadataResult = buildMetadata(input);
  if (metadataResult.isErr()) {
    return err(metadataResult.error);
  }

  const metadata = metadataResult.value;
  const scopeKey = buildBucharestBudgetAnalysisScopeKey(metadata.analysisFingerprint);
  const deliveryKey = buildBucharestBudgetAnalysisDeliveryKey({
    userId: input.userId,
    analysisFingerprint: metadata.analysisFingerprint,
  });

  const eligibilityResult = await deps.notificationsRepo.findEligibleByUserTypeAndEntity(
    input.userId,
    FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
    BUCHAREST_BUDGET_ANALYSIS_ENTITY_CUI
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
        notificationType: FUNKY_OUTBOX_BUCHAREST_BUDGET_ANALYSIS_TYPE,
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
      ...(outboxStatus !== undefined ? { outboxStatus } : {}),
      source: result.source,
      composeStatus: result.composeStatus,
    });
  }

  return ok({
    status: 'queued',
    reason: result.source === 'reused' ? 'existing_failed_transient' : 'eligible_now',
    deliveryKey,
    scopeKey,
    eligibility: eligibilityResult.value,
    outboxId: result.outboxId,
    ...(outboxStatus !== undefined ? { outboxStatus } : {}),
    source: result.source,
    composeStatus: result.composeStatus,
  });
};
