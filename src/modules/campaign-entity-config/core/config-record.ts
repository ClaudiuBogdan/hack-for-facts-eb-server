import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';
import {
  type InteractiveStateRecord,
  type LearningProgressRecordRow,
} from '@/modules/learning-progress/index.js';

import {
  createDatabaseError,
  createValidationError,
  type CampaignEntityConfigError,
} from './errors.js';

import type {
  CampaignEntityConfigCampaignKey,
  CampaignEntityConfigDto,
  CampaignEntityConfigListItem,
  CampaignEntityConfigListCursor,
  CampaignEntityConfigSortBy,
  CampaignEntityConfigSortOrder,
  CampaignEntityConfigValues,
} from './types.js';

const INTERNAL_USER_ID_PREFIX = 'internal:campaign-config:' as const;
const INTERNAL_RECORD_KEY_PREFIX = 'internal:entity-config::' as const;
const INTERNAL_INTERACTION_ID = 'internal:campaign-entity-config' as const;
const INTERNAL_CLIENT_ID = 'server-internal-campaign-entity-config' as const;

const NullableStringSchema = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

export const CampaignEntityConfigValuesSchema = Type.Object(
  {
    budgetPublicationDate: NullableStringSchema,
    officialBudgetUrl: NullableStringSchema,
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigStoredPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    campaignKey: Type.Literal(FUNKY_CAMPAIGN_KEY),
    entityCui: Type.String({ minLength: 1 }),
    values: CampaignEntityConfigValuesSchema,
    meta: Type.Object(
      {
        updatedByUserId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export type CampaignEntityConfigStoredPayload = Static<
  typeof CampaignEntityConfigStoredPayloadSchema
>;

interface ParsedCampaignEntityConfigRecord {
  readonly payload: CampaignEntityConfigStoredPayload;
  readonly dto: CampaignEntityConfigDto;
  readonly row: LearningProgressRecordRow;
}

function getTimestampMilliseconds(timestamp: string): number | null {
  const milliseconds = Date.parse(timestamp);
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

function compareTimestampInstants(leftTimestamp: string, rightTimestamp: string): number {
  const leftMilliseconds = getTimestampMilliseconds(leftTimestamp);
  const rightMilliseconds = getTimestampMilliseconds(rightTimestamp);

  if (leftMilliseconds !== null && rightMilliseconds !== null) {
    if (leftMilliseconds < rightMilliseconds) return -1;
    if (leftMilliseconds > rightMilliseconds) return 1;
    return 0;
  }

  return leftTimestamp.localeCompare(rightTimestamp);
}

function getValueErrorMessage(schema: TSchema, candidate: unknown, fallback: string): string {
  const [firstError] = [...Value.Errors(schema, candidate)];
  return firstError?.message ?? fallback;
}

function normalizeDateOnly(candidate: string): string | null {
  const trimmedCandidate = candidate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedCandidate)) {
    return null;
  }

  const [yearString = '', monthString = '', dayString = ''] = trimmedCandidate.split('-');
  const year = Number.parseInt(yearString, 10);
  const month = Number.parseInt(monthString, 10);
  const day = Number.parseInt(dayString, 10);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return trimmedCandidate;
}

function normalizeUrl(candidate: string): string | null {
  const trimmedCandidate = candidate.trim();
  if (trimmedCandidate === '') {
    return null;
  }

  try {
    const normalizedUrl = new URL(trimmedCandidate);
    if (normalizedUrl.protocol !== 'http:' && normalizedUrl.protocol !== 'https:') {
      return null;
    }

    return normalizedUrl.toString();
  } catch {
    return null;
  }
}

function hasConfiguredValue(values: CampaignEntityConfigValues): boolean {
  return values.budgetPublicationDate !== null || values.officialBudgetUrl !== null;
}

function createDefaultValues(): CampaignEntityConfigValues {
  return {
    budgetPublicationDate: null,
    officialBudgetUrl: null,
  };
}

function buildConfigDto(input: {
  campaignKey: CampaignEntityConfigCampaignKey;
  entityCui: string;
  entityName?: string | null;
  values: CampaignEntityConfigValues;
  updatedAt: string | null;
  updatedByUserId: string | null;
}): CampaignEntityConfigDto {
  return {
    campaignKey: input.campaignKey,
    entityCui: input.entityCui,
    entityName: input.entityName ?? null,
    isConfigured: hasConfiguredValue(input.values),
    values: input.values,
    updatedAt: input.updatedAt,
    updatedByUserId: input.updatedByUserId,
  };
}

export function createDefaultCampaignEntityConfig(input: {
  campaignKey: CampaignEntityConfigCampaignKey;
  entityCui: string;
  entityName?: string | null;
}): CampaignEntityConfigDto {
  return buildConfigDto({
    campaignKey: input.campaignKey,
    entityCui: input.entityCui,
    entityName: input.entityName ?? null,
    values: createDefaultValues(),
    updatedAt: null,
    updatedByUserId: null,
  });
}

export function normalizeCampaignEntityConfigValues(
  candidate: unknown
): Result<CampaignEntityConfigValues, CampaignEntityConfigError> {
  if (!Value.Check(CampaignEntityConfigValuesSchema, candidate)) {
    return err(
      createValidationError(
        getValueErrorMessage(
          CampaignEntityConfigValuesSchema,
          candidate,
          'Invalid campaign entity config values.'
        )
      )
    );
  }

  const valuesCandidate = candidate as CampaignEntityConfigValues;
  const budgetPublicationDate =
    valuesCandidate.budgetPublicationDate === null
      ? null
      : normalizeDateOnly(valuesCandidate.budgetPublicationDate);
  if (valuesCandidate.budgetPublicationDate !== null && budgetPublicationDate === null) {
    return err(
      createValidationError('budgetPublicationDate must be a valid YYYY-MM-DD business date.')
    );
  }

  const officialBudgetUrl =
    valuesCandidate.officialBudgetUrl === null
      ? null
      : normalizeUrl(valuesCandidate.officialBudgetUrl);
  if (valuesCandidate.officialBudgetUrl !== null && officialBudgetUrl === null) {
    return err(createValidationError('officialBudgetUrl must be a valid absolute URL.'));
  }

  const normalizedValues: CampaignEntityConfigValues = {
    budgetPublicationDate,
    officialBudgetUrl,
  };

  if (!hasConfiguredValue(normalizedValues)) {
    return err(
      createValidationError('At least one campaign entity config value must be configured.')
    );
  }

  return ok(normalizedValues);
}

export function buildCampaignEntityConfigUserId(
  campaignKey: CampaignEntityConfigCampaignKey
): string {
  return `${INTERNAL_USER_ID_PREFIX}${campaignKey}`;
}

export function buildCampaignEntityConfigRecordKey(entityCui: string): string {
  return `${INTERNAL_RECORD_KEY_PREFIX}${entityCui}`;
}

export function getCampaignEntityConfigRecordKeyPrefix(): string {
  return INTERNAL_RECORD_KEY_PREFIX;
}

export function getCampaignEntityConfigClientId(): string {
  return INTERNAL_CLIENT_ID;
}

export function createCampaignEntityConfigEventId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `internal:campaign-entity-config:${crypto.randomUUID()}`;
  }

  return `internal:campaign-entity-config:${Date.now().toString(36)}:${Math.random()
    .toString(16)
    .slice(2)}`;
}

export function getNextCampaignEntityConfigRecordUpdatedAt(
  previousTimestamp?: string | null
): string {
  const currentTime = Date.now();
  const previousTime =
    previousTimestamp !== undefined && previousTimestamp !== null && previousTimestamp !== ''
      ? getTimestampMilliseconds(previousTimestamp)
      : null;
  const nextTime = previousTime !== null ? Math.max(currentTime, previousTime + 1) : currentTime;
  return new Date(nextTime).toISOString();
}

export function createCampaignEntityConfigRecord(input: {
  campaignKey: CampaignEntityConfigCampaignKey;
  entityCui: string;
  values: CampaignEntityConfigValues;
  actorUserId: string;
  recordUpdatedAt: string;
}): InteractiveStateRecord {
  const payload: CampaignEntityConfigStoredPayload = {
    version: 1,
    campaignKey: input.campaignKey,
    entityCui: input.entityCui,
    values: input.values,
    meta: {
      updatedByUserId: input.actorUserId,
    },
  };

  return {
    key: buildCampaignEntityConfigRecordKey(input.entityCui),
    interactionId: INTERNAL_INTERACTION_ID,
    lessonId: 'internal',
    kind: 'custom',
    scope: { type: 'global' },
    completionRule: { type: 'resolved' },
    phase: 'resolved',
    value: {
      kind: 'json',
      json: {
        value: payload,
      },
    },
    result: null,
    updatedAt: input.recordUpdatedAt,
  };
}

export function parseCampaignEntityConfigRecord(input: {
  campaignKey: CampaignEntityConfigCampaignKey;
  row: LearningProgressRecordRow;
  expectedEntityCui?: string;
}): Result<ParsedCampaignEntityConfigRecord, CampaignEntityConfigError> {
  const expectedUserId = buildCampaignEntityConfigUserId(input.campaignKey);
  if (input.row.userId !== expectedUserId) {
    return err(createDatabaseError('Invalid persisted campaign entity config row.', false));
  }

  if (
    input.row.recordKey !== input.row.record.key ||
    !input.row.recordKey.startsWith(INTERNAL_RECORD_KEY_PREFIX)
  ) {
    return err(createDatabaseError('Invalid persisted campaign entity config row.', false));
  }

  if (
    input.row.record.interactionId !== INTERNAL_INTERACTION_ID ||
    input.row.record.lessonId !== 'internal' ||
    input.row.record.kind !== 'custom' ||
    input.row.record.scope.type !== 'global' ||
    input.row.record.phase !== 'resolved' ||
    input.row.record.completionRule.type !== 'resolved' ||
    input.row.record.result !== null ||
    input.row.auditEvents.length !== 0
  ) {
    return err(createDatabaseError('Invalid persisted campaign entity config row.', false));
  }

  if (input.row.record.value?.kind !== 'json') {
    return err(createDatabaseError('Invalid persisted campaign entity config row.', false));
  }

  const payloadCandidate = input.row.record.value.json.value;
  if (!Value.Check(CampaignEntityConfigStoredPayloadSchema, payloadCandidate)) {
    return err(
      createDatabaseError(
        getValueErrorMessage(
          CampaignEntityConfigStoredPayloadSchema,
          payloadCandidate,
          'Invalid persisted campaign entity config payload.'
        ),
        false
      )
    );
  }

  const payload = payloadCandidate;
  if (
    input.row.recordKey !== buildCampaignEntityConfigRecordKey(payload.entityCui) ||
    (input.expectedEntityCui !== undefined && payload.entityCui !== input.expectedEntityCui)
  ) {
    return err(createDatabaseError('Invalid persisted campaign entity config identity.', false));
  }

  const normalizedValuesResult = normalizeCampaignEntityConfigValues(payload.values);
  if (normalizedValuesResult.isErr()) {
    return err(createDatabaseError(normalizedValuesResult.error.message, false));
  }

  if (
    payload.values.budgetPublicationDate !== normalizedValuesResult.value.budgetPublicationDate ||
    payload.values.officialBudgetUrl !== normalizedValuesResult.value.officialBudgetUrl
  ) {
    return err(createDatabaseError('Invalid persisted campaign entity config payload.', false));
  }

  if (getTimestampMilliseconds(input.row.record.updatedAt) === null) {
    return err(createDatabaseError('Invalid persisted campaign entity config timestamp.', false));
  }

  return ok({
    payload,
    dto: buildConfigDto({
      campaignKey: input.campaignKey,
      entityCui: payload.entityCui,
      values: normalizedValuesResult.value,
      updatedAt: input.row.updatedAt,
      updatedByUserId: payload.meta.updatedByUserId,
    }),
    row: input.row,
  });
}

function compareNullableUpdatedAt(left: string | null, right: string | null): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return -1;
  }

  if (right === null) {
    return 1;
  }

  return compareTimestampInstants(left, right);
}

function compareNullableString(left: string | null, right: string | null): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return -1;
  }

  if (right === null) {
    return 1;
  }

  return left.localeCompare(right);
}

function getCampaignEntityConfigSortValue(
  item: CampaignEntityConfigListItem,
  sortBy: CampaignEntityConfigSortBy
): string | number | null {
  switch (sortBy) {
    case 'updatedAt':
      return item.updatedAt;
    case 'budgetPublicationDate':
      return item.values.budgetPublicationDate;
    case 'officialBudgetUrl':
      return item.values.officialBudgetUrl;
    case 'usersCount':
      return item.usersCount;
    case 'entityCui':
      return item.entityCui;
    default:
      return item.entityCui;
  }
}

export function compareCampaignEntityConfigDtos(input: {
  left: CampaignEntityConfigListItem;
  right: CampaignEntityConfigListItem;
  sortBy: CampaignEntityConfigSortBy;
  sortOrder: CampaignEntityConfigSortOrder;
}): number {
  if (input.sortBy === 'entityCui') {
    const entityComparison = input.left.entityCui.localeCompare(input.right.entityCui);
    return input.sortOrder === 'asc' ? entityComparison : -entityComparison;
  }

  const leftValue = getCampaignEntityConfigSortValue(input.left, input.sortBy);
  const rightValue = getCampaignEntityConfigSortValue(input.right, input.sortBy);
  let valueComparison: number;
  if (input.sortBy === 'updatedAt') {
    valueComparison = compareNullableUpdatedAt(
      leftValue as string | null,
      rightValue as string | null
    );
  } else if (input.sortBy === 'usersCount') {
    valueComparison = Number(leftValue) - Number(rightValue);
  } else {
    valueComparison = compareNullableString(
      leftValue as string | null,
      rightValue as string | null
    );
  }
  if (valueComparison !== 0) {
    return input.sortOrder === 'asc' ? valueComparison : -valueComparison;
  }

  return input.left.entityCui.localeCompare(input.right.entityCui);
}

export function resolveCampaignEntityConfigPageStartIndex(input: {
  items: readonly CampaignEntityConfigListItem[];
  sortBy: CampaignEntityConfigSortBy;
  sortOrder: CampaignEntityConfigSortOrder;
  cursor: CampaignEntityConfigListCursor | undefined;
}): Result<number, CampaignEntityConfigError> {
  if (input.cursor === undefined) {
    return ok(0);
  }

  const cursor = input.cursor;
  if (cursor.sortBy !== input.sortBy || cursor.sortOrder !== input.sortOrder) {
    return err(createValidationError('Invalid campaign entity config cursor.'));
  }

  const cursorItem: CampaignEntityConfigListItem = {
    campaignKey: 'funky',
    entityCui: cursor.entityCui,
    entityName: null,
    usersCount: cursor.sortBy === 'usersCount' ? Number(cursor.value) : 0,
    isConfigured: true,
    values: {
      budgetPublicationDate:
        cursor.sortBy === 'budgetPublicationDate' && typeof cursor.value === 'string'
          ? cursor.value
          : null,
      officialBudgetUrl:
        cursor.sortBy === 'officialBudgetUrl' && typeof cursor.value === 'string'
          ? cursor.value
          : null,
    },
    updatedAt:
      cursor.sortBy === 'updatedAt' && typeof cursor.value === 'string' ? cursor.value : null,
    updatedByUserId: null,
  };

  const index = input.items.findIndex((item) => {
    return (
      compareCampaignEntityConfigDtos({
        left: item,
        right: cursorItem,
        sortBy: input.sortBy,
        sortOrder: input.sortOrder,
      }) > 0
    );
  });

  return ok(index === -1 ? input.items.length : index);
}

export function buildNextCampaignEntityConfigCursor(input: {
  items: readonly CampaignEntityConfigListItem[];
  hasMore: boolean;
  sortBy: CampaignEntityConfigSortBy;
  sortOrder: CampaignEntityConfigSortOrder;
}): CampaignEntityConfigListCursor | null {
  if (!input.hasMore || input.items.length === 0) {
    return null;
  }

  const lastItem = input.items.at(-1);
  if (lastItem === undefined) {
    return null;
  }

  return {
    sortBy: input.sortBy,
    sortOrder: input.sortOrder,
    value: getCampaignEntityConfigSortValue(lastItem, input.sortBy),
    entityCui: lastItem.entityCui,
  };
}
