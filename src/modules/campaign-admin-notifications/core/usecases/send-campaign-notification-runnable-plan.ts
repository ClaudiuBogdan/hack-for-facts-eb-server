import { err, ok } from 'neverthrow';

import { createDatabaseError, createValidationError } from '../errors.js';
import { assertReadableStoredPlan } from './runnable-plan-view.js';

import type {
  CampaignNotificationRunnablePlanRepository,
  CampaignNotificationRunnableTemplateRegistry,
} from '../ports.js';
import type {
  CampaignNotificationAdminCampaignKey,
  CampaignNotificationRunnablePlanSendResult,
  CampaignNotificationRunnablePlanRowStatus,
} from '../types.js';

interface MutableSendCounts {
  evaluatedCount: number;
  queuedCount: number;
  alreadySentCount: number;
  alreadyPendingCount: number;
  ineligibleCount: number;
  missingDataCount: number;
  enqueueFailedCount: number;
}

const incrementStoredStatus = (
  counts: MutableSendCounts,
  status: CampaignNotificationRunnablePlanRowStatus
): void => {
  switch (status) {
    case 'already_sent':
      counts.alreadySentCount += 1;
      break;
    case 'already_pending':
      counts.alreadyPendingCount += 1;
      break;
    case 'ineligible':
      counts.ineligibleCount += 1;
      break;
    case 'missing_data':
      counts.missingDataCount += 1;
      break;
    case 'will_send':
      break;
  }
};

export interface SendCampaignNotificationRunnablePlanInput {
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly planId: string;
  readonly actorUserId: string;
}

export const sendCampaignNotificationRunnablePlan = async (
  deps: {
    planRepository: CampaignNotificationRunnablePlanRepository;
    runnableTemplateRegistry: CampaignNotificationRunnableTemplateRegistry;
  },
  input: SendCampaignNotificationRunnablePlanInput
) => {
  const storedPlanResult = await deps.planRepository.findPlanById(input.planId);
  if (storedPlanResult.isErr()) {
    return err(storedPlanResult.error);
  }

  const now = new Date().toISOString();
  const readablePlan = assertReadableStoredPlan({
    plan: storedPlanResult.value,
    actorUserId: input.actorUserId,
    campaignKey: input.campaignKey,
    now,
  });
  if ('type' in readablePlan) {
    return err(readablePlan);
  }

  const definition = deps.runnableTemplateRegistry.get(input.campaignKey, readablePlan.runnableId);
  if (
    definition?.templateId !== readablePlan.templateId ||
    definition.templateVersion !== readablePlan.templateVersion
  ) {
    return err(createValidationError('Invalid campaign notification plan.'));
  }

  const consumeResult = await deps.planRepository.consumePlan({
    planId: readablePlan.planId,
    now,
  });
  if (consumeResult.isErr()) {
    return err(consumeResult.error);
  }

  if (!consumeResult.value) {
    return err(createValidationError('Invalid campaign notification plan.'));
  }

  const counts: MutableSendCounts = {
    evaluatedCount: readablePlan.rows.length,
    queuedCount: 0,
    alreadySentCount: 0,
    alreadyPendingCount: 0,
    ineligibleCount: 0,
    missingDataCount: 0,
    enqueueFailedCount: 0,
  };
  let hadExecutionError = false;

  for (const row of readablePlan.rows) {
    if (row.preview.status !== 'will_send') {
      incrementStoredStatus(counts, row.preview.status);
      continue;
    }

    if (row.executionData === null) {
      counts.missingDataCount += 1;
      continue;
    }

    const executeResult = await definition.executeStoredRow({
      actorUserId: input.actorUserId,
      row,
    });
    if (executeResult.isErr()) {
      counts.enqueueFailedCount += 1;
      hadExecutionError = true;
      continue;
    }

    switch (executeResult.value.outcome) {
      case 'queued':
        counts.queuedCount += 1;
        break;
      case 'already_sent':
        counts.alreadySentCount += 1;
        break;
      case 'already_pending':
        counts.alreadyPendingCount += 1;
        break;
      case 'ineligible':
        counts.ineligibleCount += 1;
        break;
      case 'missing_data':
        counts.missingDataCount += 1;
        break;
      case 'enqueue_failed':
        counts.enqueueFailedCount += 1;
        break;
    }
  }

  if (hadExecutionError) {
    const releaseResult = await deps.planRepository.releasePlan({
      planId: readablePlan.planId,
    });
    if (releaseResult.isErr()) {
      return err(releaseResult.error);
    }

    if (!releaseResult.value) {
      return err(createDatabaseError('Failed to release campaign notification run plan.'));
    }
  }

  return ok<CampaignNotificationRunnablePlanSendResult>({
    planId: readablePlan.planId,
    runnableId: readablePlan.runnableId,
    templateId: readablePlan.templateId,
    ...counts,
  });
};
