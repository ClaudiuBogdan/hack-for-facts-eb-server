import { err, ok } from 'neverthrow';

import { createValidationError } from '../errors.js';
import {
  assertReadableStoredPlan,
  decodeStoredPlanCursor,
  encodeStoredPlanCursor,
  getRunnablePlanPageLimit,
  sliceStoredPlanRows,
  toCampaignNotificationRunnablePlanView,
} from './runnable-plan-view.js';

import type { CampaignNotificationRunnablePlanRepository } from '../ports.js';
import type {
  CampaignNotificationAdminCampaignKey,
  CampaignNotificationRunnablePlanView,
} from '../types.js';

export interface GetCampaignNotificationRunnablePlanInput {
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly planId: string;
  readonly actorUserId: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export const getCampaignNotificationRunnablePlan = async (
  deps: {
    planRepository: CampaignNotificationRunnablePlanRepository;
  },
  input: GetCampaignNotificationRunnablePlanInput
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

  let offset = 0;
  if (input.cursor !== undefined) {
    const decodedCursor = decodeStoredPlanCursor(input.cursor);
    if ('type' in decodedCursor) {
      return err(decodedCursor);
    }

    if (decodedCursor.planId !== readablePlan.planId) {
      return err(createValidationError('Invalid campaign notification plan cursor.'));
    }

    offset = decodedCursor.offset;
  }

  const page = sliceStoredPlanRows({
    plan: readablePlan,
    offset,
    limit: getRunnablePlanPageLimit(input.limit),
  });

  return ok<CampaignNotificationRunnablePlanView>(
    toCampaignNotificationRunnablePlanView({
      plan: readablePlan,
      rows: page.rows,
      nextCursor:
        page.nextOffset === null
          ? null
          : encodeStoredPlanCursor({
              planId: readablePlan.planId,
              offset: page.nextOffset,
            }),
      hasMore: page.hasMore,
    })
  );
};
