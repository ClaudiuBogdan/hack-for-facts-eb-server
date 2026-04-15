import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { fromThrowable } from 'neverthrow';

import { createValidationError, type CampaignAdminNotificationError } from '../errors.js';

import type {
  CampaignNotificationRunnablePlanView,
  CampaignNotificationStoredPlan,
} from '../types.js';

export interface CampaignNotificationStoredPlanPageSlice {
  readonly rows: CampaignNotificationStoredPlan['rows'];
  readonly hasMore: boolean;
  readonly nextOffset: number | null;
}

interface StoredPlanCursorPayload {
  readonly planId: string;
  readonly offset: number;
}

const parseJson = fromThrowable(JSON.parse);
const StoredPlanCursorSchema = Type.Object(
  {
    planId: Type.String({ minLength: 1 }),
    offset: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export const DEFAULT_RUNNABLE_PLAN_PAGE_SIZE = 25;
export const MAX_RUNNABLE_PLAN_PAGE_SIZE = 100;

export const sliceStoredPlanRows = (input: {
  readonly plan: CampaignNotificationStoredPlan;
  readonly offset: number;
  readonly limit: number;
}): CampaignNotificationStoredPlanPageSlice => {
  const rows = input.plan.rows.slice(input.offset, input.offset + input.limit);
  const nextOffset =
    input.offset + rows.length < input.plan.rows.length ? input.offset + rows.length : null;

  return {
    rows,
    hasMore: nextOffset !== null,
    nextOffset,
  };
};

export const getRunnablePlanPageLimit = (limit: number | undefined): number => {
  if (limit === undefined) {
    return DEFAULT_RUNNABLE_PLAN_PAGE_SIZE;
  }

  return Math.min(Math.max(limit, 1), MAX_RUNNABLE_PLAN_PAGE_SIZE);
};

export const encodeStoredPlanCursor = (input: StoredPlanCursorPayload): string => {
  return Buffer.from(JSON.stringify(input), 'utf-8').toString('base64url');
};

export const decodeStoredPlanCursor = (
  cursor: string
): StoredPlanCursorPayload | CampaignAdminNotificationError => {
  const parsed = parseJson(Buffer.from(cursor, 'base64url').toString('utf-8'));
  if (parsed.isErr() || !Value.Check(StoredPlanCursorSchema, parsed.value)) {
    return createValidationError('Invalid campaign notification plan cursor.');
  }

  return parsed.value as StoredPlanCursorPayload;
};

export const assertReadableStoredPlan = (input: {
  readonly plan: CampaignNotificationStoredPlan | null;
  readonly actorUserId: string;
  readonly campaignKey: string;
  readonly now: string;
}): CampaignNotificationStoredPlan | CampaignAdminNotificationError => {
  if (input.plan === null) {
    return createValidationError('Invalid campaign notification plan.');
  }

  if (
    input.plan.actorUserId !== input.actorUserId ||
    input.plan.campaignKey !== input.campaignKey
  ) {
    return createValidationError('Invalid campaign notification plan.');
  }

  if (input.plan.consumedAt !== null) {
    return createValidationError('Invalid campaign notification plan.');
  }

  if (Date.parse(input.plan.expiresAt) <= Date.parse(input.now)) {
    return createValidationError('Invalid campaign notification plan.');
  }

  return input.plan;
};

export const toCampaignNotificationRunnablePlanView = (input: {
  readonly plan: CampaignNotificationStoredPlan;
  readonly rows: CampaignNotificationStoredPlan['rows'];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}): CampaignNotificationRunnablePlanView => {
  return {
    planId: input.plan.planId,
    runnableId: input.plan.runnableId,
    templateId: input.plan.templateId,
    watermark: input.plan.watermark,
    summary: input.plan.summary,
    rows: input.rows.map((row) => row.preview),
    page: {
      nextCursor: input.nextCursor,
      hasMore: input.hasMore,
    },
  };
};
