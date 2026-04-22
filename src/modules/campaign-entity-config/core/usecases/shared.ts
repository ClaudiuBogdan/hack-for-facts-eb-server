import { err, ok, type Result } from 'neverthrow';

import {
  compareCampaignEntityConfigDtos,
  createDefaultCampaignEntityConfig,
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
  CampaignEntityConfigListItem,
  CampaignEntityConfigListCursor,
  CampaignEntityConfigSortBy,
  CampaignEntityConfigSortOrder,
} from '../types.js';
import type { Entity, EntityError, EntityRepository } from '@/modules/entity/index.js';
import type { LearningProgressError } from '@/modules/learning-progress/core/errors.js';
import type { LearningProgressRepository } from '@/modules/learning-progress/core/ports.js';
import type {
  CampaignEntityConfigCollectionRow,
  LearningProgressRecordRow,
} from '@/modules/learning-progress/core/types.js';

export interface CampaignEntityConfigDeps {
  readonly learningProgressRepo: LearningProgressRepository;
  readonly entityRepo: EntityRepository;
}

function normalizeEntityName(name: string): string | null {
  const normalizedName = name.trim();
  return normalizedName === '' ? null : normalizedName;
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

  if (input.cursor.sortBy !== input.sortBy || input.cursor.sortOrder !== input.sortOrder) {
    return err(createValidationError('Invalid campaign entity config cursor.'));
  }

  if (input.sortBy === 'entityCui') {
    if (input.cursor.value !== input.cursor.entityCui) {
      return err(createValidationError('Invalid campaign entity config cursor.'));
    }

    return ok(undefined);
  }

  if (input.sortBy === 'usersCount') {
    if (
      typeof input.cursor.value !== 'number' ||
      !Number.isFinite(input.cursor.value) ||
      !Number.isInteger(input.cursor.value) ||
      input.cursor.value < 0
    ) {
      return err(createValidationError('Invalid campaign entity config cursor.'));
    }

    return ok(undefined);
  }

  if (input.sortBy === 'updatedAt') {
    if (
      input.cursor.value !== null &&
      (typeof input.cursor.value !== 'string' ||
        getTimestampMilliseconds(input.cursor.value) === null)
    ) {
      return err(createValidationError('Invalid campaign entity config cursor.'));
    }

    return ok(undefined);
  }

  if (input.sortBy === 'budgetPublicationDate') {
    if (
      input.cursor.value !== null &&
      (typeof input.cursor.value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.cursor.value))
    ) {
      return err(createValidationError('Invalid campaign entity config cursor.'));
    }

    return ok(undefined);
  }

  if (input.cursor.value !== null) {
    try {
      if (typeof input.cursor.value !== 'string') {
        return err(createValidationError('Invalid campaign entity config cursor.'));
      }

      const url = new URL(input.cursor.value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return err(createValidationError('Invalid campaign entity config cursor.'));
      }
    } catch {
      return err(createValidationError('Invalid campaign entity config cursor.'));
    }
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

export function materializeCampaignEntityConfigCollectionRows(input: {
  campaignKey: CampaignEntityConfigCampaignKey;
  rows: readonly CampaignEntityConfigCollectionRow[];
}): Result<readonly CampaignEntityConfigListItem[], CampaignEntityConfigError> {
  const items: CampaignEntityConfigListItem[] = [];

  for (const row of input.rows) {
    if (row.configuredRow === null) {
      items.push({
        ...createDefaultCampaignEntityConfig({
          campaignKey: input.campaignKey,
          entityCui: row.entityCui,
        }),
        usersCount: row.usersCount,
      });
      continue;
    }

    const parsedRowResult = parseCampaignEntityConfigRecord({
      campaignKey: input.campaignKey,
      row: row.configuredRow,
      expectedEntityCui: row.entityCui,
    });
    if (parsedRowResult.isErr()) {
      return err(parsedRowResult.error);
    }

    items.push({
      ...parsedRowResult.value.dto,
      usersCount: row.usersCount,
    });
  }

  return ok(items);
}

export function filterCampaignEntityConfigDtosByUpdatedAtRange(
  items: readonly CampaignEntityConfigDto[],
  input: {
    updatedAtFrom?: string;
    updatedAtTo?: string;
  }
): readonly CampaignEntityConfigDto[] {
  if (input.updatedAtFrom === undefined && input.updatedAtTo === undefined) {
    return items;
  }

  return items.filter((item) => {
    if (item.updatedAt === null) {
      return false;
    }

    if (
      input.updatedAtFrom !== undefined &&
      compareTimestampInstants(item.updatedAt, input.updatedAtFrom) < 0
    ) {
      return false;
    }

    if (
      input.updatedAtTo !== undefined &&
      compareTimestampInstants(item.updatedAt, input.updatedAtTo) > 0
    ) {
      return false;
    }

    return true;
  });
}

export function matchesCampaignEntityConfigQuery(input: {
  item: CampaignEntityConfigDto;
  query: string | undefined;
}): boolean {
  if (input.query === undefined) {
    return true;
  }

  const normalizedQuery = input.query.toLocaleLowerCase('en');
  const entityName = input.item.entityName?.trim();

  return (
    input.item.entityCui.toLocaleLowerCase('en').includes(normalizedQuery) ||
    (entityName !== undefined && entityName !== ''
      ? entityName.toLocaleLowerCase('en').includes(normalizedQuery)
      : false)
  );
}

export function matchesCampaignEntityConfigPayloadFilters(input: {
  item: CampaignEntityConfigDto;
  budgetPublicationDate?: string;
  hasBudgetPublicationDate?: boolean;
  officialBudgetUrl?: string;
  hasOfficialBudgetUrl?: boolean;
  hasPublicDebate?: boolean;
}): boolean {
  if (
    input.budgetPublicationDate !== undefined &&
    input.item.values.budgetPublicationDate !== input.budgetPublicationDate
  ) {
    return false;
  }

  if (
    input.hasBudgetPublicationDate !== undefined &&
    (input.item.values.budgetPublicationDate !== null) !== input.hasBudgetPublicationDate
  ) {
    return false;
  }

  if (input.officialBudgetUrl !== undefined) {
    const normalizedUrlQuery = input.officialBudgetUrl.trim().toLocaleLowerCase('en');
    if (
      normalizedUrlQuery !== '' &&
      !(
        input.item.values.officialBudgetUrl?.toLocaleLowerCase('en').includes(normalizedUrlQuery) ??
        false
      )
    ) {
      return false;
    }
  }

  if (
    input.hasOfficialBudgetUrl !== undefined &&
    (input.item.values.officialBudgetUrl !== null) !== input.hasOfficialBudgetUrl
  ) {
    return false;
  }

  if (
    input.hasPublicDebate !== undefined &&
    (input.item.values.public_debate !== null) !== input.hasPublicDebate
  ) {
    return false;
  }

  return true;
}

export function sortCampaignEntityConfigDtos(input: {
  items: readonly CampaignEntityConfigListItem[];
  sortBy: CampaignEntityConfigSortBy;
  sortOrder: CampaignEntityConfigSortOrder;
}): readonly CampaignEntityConfigListItem[] {
  return [...input.items].sort((left, right) =>
    compareCampaignEntityConfigDtos({
      left,
      right,
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
    })
  );
}

export async function loadEntityNameMapForEntityCuis(
  deps: Pick<CampaignEntityConfigDeps, 'entityRepo'>,
  entityCuis: readonly string[]
): Promise<Result<Map<string, string | null>, CampaignEntityConfigError>> {
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
        normalizeEntityName(entity.name),
      ])
    )
  );
}

export async function loadEntityByCui(
  deps: Pick<CampaignEntityConfigDeps, 'entityRepo'>,
  entityCui: string
): Promise<Result<Entity | null, CampaignEntityConfigError>> {
  const entityResult = await deps.entityRepo.getById(entityCui);
  if (entityResult.isErr()) {
    return err(mapEntityError(entityResult.error));
  }

  return ok(entityResult.value);
}

export async function loadRequiredEntityByCui(
  deps: Pick<CampaignEntityConfigDeps, 'entityRepo'>,
  entityCui: string
): Promise<Result<Entity, CampaignEntityConfigError>> {
  const entityResult = await loadEntityByCui(deps, entityCui);
  if (entityResult.isErr()) {
    return err(entityResult.error);
  }

  if (entityResult.value === null) {
    return err(createNotFoundError(`Campaign entity config "${entityCui}" not found.`));
  }

  return ok(entityResult.value);
}

export function withCampaignEntityConfigEntityName(
  dto: CampaignEntityConfigDto,
  entity: Pick<Entity, 'name'> | null
): CampaignEntityConfigDto {
  return {
    ...dto,
    entityName: entity === null ? null : normalizeEntityName(entity.name),
  };
}

export async function ensureEntityExists(
  deps: Pick<CampaignEntityConfigDeps, 'entityRepo'>,
  entityCui: string
): Promise<Result<void, CampaignEntityConfigError>> {
  const entityResult = await loadRequiredEntityByCui(deps, entityCui);
  if (entityResult.isErr()) {
    return err(entityResult.error);
  }

  return ok(undefined);
}
