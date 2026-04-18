import { err, ok, type Result } from 'neverthrow';

import {
  buildCampaignEntityConfigUserId,
  getCampaignEntityConfigRecordKeyPrefix,
  parseCampaignEntityConfigRecord,
} from '../config-record.js';
import {
  createDatabaseError,
  createNotFoundError,
  createValidationError,
  type CampaignEntityConfigError,
} from '../errors.js';

import type {
  CampaignEntityConfigCampaignKey,
  CampaignEntityConfigDto,
  CampaignEntityConfigListCursor,
  CampaignEntityConfigSortBy,
  CampaignEntityConfigSortOrder,
} from '../types.js';
import type { EntityError, EntityRepository } from '@/modules/entity/index.js';
import type {
  LearningProgressError,
  LearningProgressRecordRow,
  LearningProgressRepository,
} from '@/modules/learning-progress/index.js';

export interface CampaignEntityConfigDeps {
  readonly learningProgressRepo: LearningProgressRepository;
  readonly entityRepo: EntityRepository;
}

export function normalizeEntityCui(entityCui: string): Result<string, CampaignEntityConfigError> {
  const normalizedEntityCui = entityCui.trim();
  if (normalizedEntityCui === '') {
    return err(createValidationError('Entity CUI is required.'));
  }

  return ok(normalizedEntityCui);
}

export function mapLearningProgressError(error: LearningProgressError): CampaignEntityConfigError {
  return createDatabaseError(error.message, 'retryable' in error ? error.retryable : true);
}

export function mapEntityError(error: EntityError): CampaignEntityConfigError {
  return createDatabaseError(error.message, 'retryable' in error ? error.retryable : true);
}

export function normalizeOptionalQuery(query: string | undefined): string | undefined {
  if (query === undefined) {
    return undefined;
  }

  const normalizedQuery = query.trim();
  return normalizedQuery === '' ? undefined : normalizedQuery;
}

export function getTimestampMilliseconds(timestamp: string): number | null {
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

export function compareTimestampInstants(leftTimestamp: string, rightTimestamp: string): number {
  const leftMilliseconds = getTimestampMilliseconds(leftTimestamp);
  const rightMilliseconds = getTimestampMilliseconds(rightTimestamp);

  if (leftMilliseconds !== null && rightMilliseconds !== null) {
    if (leftMilliseconds < rightMilliseconds) return -1;
    if (leftMilliseconds > rightMilliseconds) return 1;
    return 0;
  }

  return leftTimestamp.localeCompare(rightTimestamp);
}

export function validateUpdatedAtRange(input: {
  updatedAtFrom?: string;
  updatedAtTo?: string;
}): Result<void, CampaignEntityConfigError> {
  if (input.updatedAtFrom !== undefined && getTimestampMilliseconds(input.updatedAtFrom) === null) {
    return err(createValidationError('updatedAtFrom must be a valid timestamp.'));
  }

  if (input.updatedAtTo !== undefined && getTimestampMilliseconds(input.updatedAtTo) === null) {
    return err(createValidationError('updatedAtTo must be a valid timestamp.'));
  }

  if (
    input.updatedAtFrom !== undefined &&
    input.updatedAtTo !== undefined &&
    compareTimestampInstants(input.updatedAtFrom, input.updatedAtTo) > 0
  ) {
    return err(createValidationError('updatedAtFrom must be less than or equal to updatedAtTo.'));
  }

  return ok(undefined);
}

export function validateListCursor(input: {
  cursor?: CampaignEntityConfigListCursor;
  sortBy: CampaignEntityConfigSortBy;
  sortOrder: CampaignEntityConfigSortOrder;
}): Result<void, CampaignEntityConfigError> {
  if (input.cursor === undefined) {
    return ok(undefined);
  }

  if (
    input.cursor.sortBy !== input.sortBy ||
    input.cursor.sortOrder !== input.sortOrder ||
    (input.sortBy === 'updatedAt' && input.cursor.updatedAt === null)
  ) {
    return err(createValidationError('Invalid campaign entity config cursor.'));
  }

  return ok(undefined);
}

export function parseConfiguredCampaignEntityConfigRows(input: {
  campaignKey: CampaignEntityConfigCampaignKey;
  rows: readonly LearningProgressRecordRow[];
  expectedEntityCui?: string;
}): Result<readonly CampaignEntityConfigDto[], CampaignEntityConfigError> {
  const items: CampaignEntityConfigDto[] = [];

  for (const row of input.rows) {
    const parsedRowResult = parseCampaignEntityConfigRecord({
      campaignKey: input.campaignKey,
      row,
      ...(input.expectedEntityCui !== undefined
        ? { expectedEntityCui: input.expectedEntityCui }
        : {}),
    });
    if (parsedRowResult.isErr()) {
      return err(parsedRowResult.error);
    }

    items.push(parsedRowResult.value.dto);
  }

  return ok(items);
}

export async function loadConfiguredCampaignEntityConfigDtos(
  deps: Pick<CampaignEntityConfigDeps, 'learningProgressRepo'>,
  campaignKey: CampaignEntityConfigCampaignKey
): Promise<Result<readonly CampaignEntityConfigDto[], CampaignEntityConfigError>> {
  const rowsResult = await deps.learningProgressRepo.getRecords(
    buildCampaignEntityConfigUserId(campaignKey),
    {
      includeInternal: true,
      recordKeyPrefix: getCampaignEntityConfigRecordKeyPrefix(),
    }
  );
  if (rowsResult.isErr()) {
    return err(mapLearningProgressError(rowsResult.error));
  }

  return parseConfiguredCampaignEntityConfigRows({
    campaignKey,
    rows: rowsResult.value,
  });
}

export async function loadEntityNameMapForEntityCuis(
  deps: Pick<CampaignEntityConfigDeps, 'entityRepo'>,
  entityCuis: readonly string[]
): Promise<Result<Map<string, string>, CampaignEntityConfigError>> {
  if (entityCuis.length === 0) {
    return ok(new Map());
  }

  const entitiesResult = await deps.entityRepo.getByIds([...new Set(entityCuis)]);
  if (entitiesResult.isErr()) {
    return err(mapEntityError(entitiesResult.error));
  }

  return ok(
    new Map(
      [...entitiesResult.value.entries()].map(([entityCui, entity]) => [
        entityCui,
        entity.name.trim(),
      ])
    )
  );
}

export async function ensureEntityExists(
  deps: Pick<CampaignEntityConfigDeps, 'entityRepo'>,
  entityCui: string
): Promise<Result<void, CampaignEntityConfigError>> {
  const entityResult = await deps.entityRepo.getById(entityCui);
  if (entityResult.isErr()) {
    return err(mapEntityError(entityResult.error));
  }

  if (entityResult.value === null) {
    return err(createNotFoundError(`Campaign entity config "${entityCui}" not found.`));
  }

  return ok(undefined);
}
