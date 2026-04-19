import { err, ok, type Result } from 'neverthrow';

import {
  buildCampaignEntityConfigUserId,
  buildNextCampaignEntityConfigCursor,
  getCampaignEntityConfigRecordKeyPrefix,
} from '../config-record.js';
import { createValidationError, type CampaignEntityConfigError } from '../errors.js';
import {
  mapLearningProgressError,
  loadEntityNameMapForEntityCuis,
  normalizeEntityCui,
  normalizeOptionalQuery,
  parseConfiguredCampaignEntityConfigRows,
  type CampaignEntityConfigDeps,
  validateListCursor,
  validateUpdatedAtRange,
} from './shared.js';

import type { ListCampaignEntityConfigsInput, ListCampaignEntityConfigsOutput } from '../types.js';
import type { LearningProgressRecordRow } from '@/modules/learning-progress/index.js';

export type ListCampaignEntityConfigsDeps = Pick<
  CampaignEntityConfigDeps,
  'entityRepo' | 'learningProgressRepo'
>;

function normalizeListedRowPage(
  input:
    | readonly LearningProgressRecordRow[]
    | {
        rows: readonly LearningProgressRecordRow[];
        totalCount: number;
        hasMore: boolean;
      }
): {
  rows: readonly LearningProgressRecordRow[];
  totalCount: number;
  hasMore: boolean;
} {
  if (Array.isArray(input)) {
    return {
      rows: input,
      totalCount: input.length,
      hasMore: false,
    };
  }

  return input as {
    rows: readonly LearningProgressRecordRow[];
    totalCount: number;
    hasMore: boolean;
  };
}

export const listCampaignEntityConfigs = async (
  deps: ListCampaignEntityConfigsDeps,
  input: ListCampaignEntityConfigsInput
): Promise<Result<ListCampaignEntityConfigsOutput, CampaignEntityConfigError>> => {
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    return err(
      createValidationError('Campaign entity config list limit must be a positive integer.')
    );
  }

  const updatedAtRangeResult = validateUpdatedAtRange({
    ...(input.updatedAtFrom !== undefined ? { updatedAtFrom: input.updatedAtFrom } : {}),
    ...(input.updatedAtTo !== undefined ? { updatedAtTo: input.updatedAtTo } : {}),
  });
  if (updatedAtRangeResult.isErr()) {
    return err(updatedAtRangeResult.error);
  }

  let entityCui: string | undefined;
  if (input.entityCui !== undefined) {
    const normalizedEntityCuiResult = normalizeEntityCui(input.entityCui);
    if (normalizedEntityCuiResult.isErr()) {
      return err(normalizedEntityCuiResult.error);
    }

    entityCui = normalizedEntityCuiResult.value;
  }

  const query = normalizeOptionalQuery(input.query);
  if (query !== undefined) {
    return err(
      createValidationError(
        'Campaign entity config list query filter is not supported for paginated listing.'
      )
    );
  }

  const cursorResult = validateListCursor({
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
  });
  if (cursorResult.isErr()) {
    return err(cursorResult.error);
  }

  const rowsResult = await deps.learningProgressRepo.listCampaignEntityConfigRows({
    userId: buildCampaignEntityConfigUserId(input.campaignKey),
    recordKeyPrefix: getCampaignEntityConfigRecordKeyPrefix(),
    ...(entityCui !== undefined ? { entityCui } : {}),
    ...(input.updatedAtFrom !== undefined ? { updatedAtFrom: input.updatedAtFrom } : {}),
    ...(input.updatedAtTo !== undefined ? { updatedAtTo: input.updatedAtTo } : {}),
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
    limit: input.limit,
    ...(input.cursor !== undefined
      ? {
          cursor: {
            updatedAt: input.cursor.updatedAt,
            entityCui: input.cursor.entityCui,
          },
        }
      : {}),
  });
  if (rowsResult.isErr()) {
    return err(mapLearningProgressError(rowsResult.error));
  }

  const rowPage = normalizeListedRowPage(rowsResult.value);

  const itemsResult = parseConfiguredCampaignEntityConfigRows({
    campaignKey: input.campaignKey,
    rows: rowPage.rows,
    ...(entityCui !== undefined ? { expectedEntityCui: entityCui } : {}),
  });
  if (itemsResult.isErr()) {
    return err(itemsResult.error);
  }

  const entityNameMapResult = await loadEntityNameMapForEntityCuis(
    deps,
    itemsResult.value.map((item) => item.entityCui)
  );
  const entityNameMap: ReadonlyMap<string, string | null> = entityNameMapResult.isOk()
    ? entityNameMapResult.value
    : new Map<string, string | null>();

  const itemsWithEntityName = itemsResult.value.map((item) => ({
    ...item,
    entityName: entityNameMap.get(item.entityCui) ?? null,
  }));

  return ok({
    items: itemsWithEntityName,
    totalCount: rowPage.totalCount,
    hasMore: rowPage.hasMore,
    nextCursor: buildNextCampaignEntityConfigCursor({
      items: itemsWithEntityName,
      hasMore: rowPage.hasMore,
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
    }),
  });
};
