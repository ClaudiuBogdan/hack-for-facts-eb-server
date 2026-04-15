import { createHash } from 'node:crypto';

import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok } from 'neverthrow';

import { createNotFoundError, createValidationError } from '../errors.js';
import {
  encodeStoredPlanCursor,
  getRunnablePlanPageLimit,
  sliceStoredPlanRows,
  toCampaignNotificationRunnablePlanView,
} from './runnable-plan-view.js';

import type {
  CampaignNotificationRunnablePlanRepository,
  CampaignNotificationRunnableTemplateRegistry,
} from '../ports.js';
import type {
  CampaignNotificationAdminCampaignKey,
  CampaignNotificationRunnablePlanView,
} from '../types.js';

const RUNNABLE_PLAN_TTL_MS = 60 * 60 * 1000;
const RunnablePlanRequestSchema = Type.Object(
  {
    selectors: Type.Optional(Type.Object({}, { additionalProperties: true })),
    filters: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { additionalProperties: false }
);

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    );

    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
};

const getPayloadValidationMessage = (
  schema: TSchema,
  payload: unknown,
  fallback: string
): string => {
  const message = [...Value.Errors(schema, payload)]
    .map((error) => `${error.path}: ${error.message}`)
    .join(', ');

  return message === '' ? fallback : message;
};

export interface CreateCampaignNotificationRunnablePlanInput {
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly runnableId: string;
  readonly actorUserId: string;
  readonly payload: unknown;
}

export const createCampaignNotificationRunnablePlan = async (
  deps: {
    runnableTemplateRegistry: CampaignNotificationRunnableTemplateRegistry;
    planRepository: CampaignNotificationRunnablePlanRepository;
  },
  input: CreateCampaignNotificationRunnablePlanInput
) => {
  const definition = deps.runnableTemplateRegistry.get(input.campaignKey, input.runnableId);
  if (definition === null) {
    return err(
      createNotFoundError(`Campaign notification runnable "${input.runnableId}" was not found.`)
    );
  }

  if (input.payload !== undefined && input.payload !== null && typeof input.payload !== 'object') {
    return err(createValidationError('Invalid runnable dry-run payload.'));
  }

  const payload =
    input.payload === undefined || input.payload === null
      ? {}
      : (input.payload as Record<string, unknown>);
  if (!Value.Check(RunnablePlanRequestSchema, payload)) {
    return err(
      createValidationError(
        getPayloadValidationMessage(
          RunnablePlanRequestSchema,
          payload,
          'Invalid runnable dry-run payload.'
        )
      )
    );
  }
  const selectors = payload.selectors ?? {};
  const filters = payload.filters ?? {};

  if (!Value.Check(definition.selectorSchema, selectors)) {
    return err(
      createValidationError(
        getPayloadValidationMessage(
          definition.selectorSchema,
          selectors,
          'Invalid runnable selector payload.'
        )
      )
    );
  }

  if (!Value.Check(definition.filterSchema, filters)) {
    return err(
      createValidationError(
        getPayloadValidationMessage(
          definition.filterSchema,
          filters,
          'Invalid runnable filter payload.'
        )
      )
    );
  }

  const dryRunResult = await definition.dryRun({
    actorUserId: input.actorUserId,
    selectors,
    filters,
  });
  if (dryRunResult.isErr()) {
    return err(dryRunResult.error);
  }

  const expiresAt = new Date(Date.now() + RUNNABLE_PLAN_TTL_MS).toISOString();
  const payloadHash = createHash('sha256')
    .update(stableStringify({ selectors, filters }))
    .digest('hex');

  const storedPlanResult = await deps.planRepository.createPlan({
    actorUserId: input.actorUserId,
    campaignKey: input.campaignKey,
    runnableId: definition.runnableId,
    templateId: definition.templateId,
    templateVersion: definition.templateVersion,
    payloadHash,
    watermark: dryRunResult.value.watermark,
    summary: dryRunResult.value.summary,
    rows: dryRunResult.value.rows,
    expiresAt,
  });
  if (storedPlanResult.isErr()) {
    return err(storedPlanResult.error);
  }

  const pageLimit = getRunnablePlanPageLimit(definition.defaultPageSize);
  const firstPage = sliceStoredPlanRows({
    plan: storedPlanResult.value,
    offset: 0,
    limit: pageLimit,
  });

  return ok<CampaignNotificationRunnablePlanView>(
    toCampaignNotificationRunnablePlanView({
      plan: storedPlanResult.value,
      rows: firstPage.rows,
      nextCursor:
        firstPage.nextOffset === null
          ? null
          : encodeStoredPlanCursor({
              planId: storedPlanResult.value.planId,
              offset: firstPage.nextOffset,
            }),
      hasMore: firstPage.hasMore,
    })
  );
};
