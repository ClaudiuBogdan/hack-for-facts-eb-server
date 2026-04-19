import { err, ok, type Result } from 'neverthrow';

import { buildNextCampaignEntityConfigCursor } from '../config-record.js';
import { createValidationError, type CampaignEntityConfigError } from '../errors.js';
import {
  loadEntityNameMapForEntityCuis,
  mapLearningProgressError,
  materializeCampaignEntityConfigCollectionRows,
  normalizeEntityCui,
  normalizeOptionalQuery,
  validateListCursor,
  validateUpdatedAtRange,
  type CampaignEntityConfigDeps,
} from './shared.js';

import type { ListCampaignEntityConfigsInput, ListCampaignEntityConfigsOutput } from '../types.js';

export type ListCampaignEntityConfigsDeps = Pick<
  CampaignEntityConfigDeps,
  'entityRepo' | 'learningProgressRepo'
> & {
  readonly audienceReader?: unknown;
};

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

  const pageResult = await deps.learningProgressRepo.listCampaignEntityConfigCollectionRows({
    campaignKey: input.campaignKey,
    ...(entityCui !== undefined ? { entityCui } : {}),
    ...(input.budgetPublicationDate !== undefined
      ? { budgetPublicationDate: input.budgetPublicationDate }
      : {}),
    ...(input.hasBudgetPublicationDate !== undefined
      ? { hasBudgetPublicationDate: input.hasBudgetPublicationDate }
      : {}),
    ...(input.officialBudgetUrl !== undefined
      ? { officialBudgetUrl: input.officialBudgetUrl }
      : {}),
    ...(input.hasOfficialBudgetUrl !== undefined
      ? { hasOfficialBudgetUrl: input.hasOfficialBudgetUrl }
      : {}),
    ...(input.updatedAtFrom !== undefined ? { updatedAtFrom: input.updatedAtFrom } : {}),
    ...(input.updatedAtTo !== undefined ? { updatedAtTo: input.updatedAtTo } : {}),
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
    limit: input.limit,
    ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
  });
  if (pageResult.isErr()) {
    return err(mapLearningProgressError(pageResult.error));
  }

  const itemsResult = materializeCampaignEntityConfigCollectionRows({
    campaignKey: input.campaignKey,
    rows: pageResult.value.rows,
  });
  if (itemsResult.isErr()) {
    return err(itemsResult.error);
  }

  const entityNameMapResult = await loadEntityNameMapForEntityCuis(
    deps,
    itemsResult.value.map((item) => item.entityCui)
  );

  const items = entityNameMapResult.isOk()
    ? itemsResult.value.map((item) => ({
        ...item,
        entityName: entityNameMapResult.value.get(item.entityCui) ?? null,
      }))
    : itemsResult.value.map((item) => ({
        ...item,
        entityName: null,
      }));

  return ok({
    items,
    totalCount: pageResult.value.totalCount,
    hasMore: pageResult.value.hasMore,
    nextCursor: buildNextCampaignEntityConfigCursor({
      items,
      hasMore: pageResult.value.hasMore,
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
    }),
  });
};
