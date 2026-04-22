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
  CampaignEntityConfigPublicDebate,
  CampaignEntityConfigSortBy,
  CampaignEntityConfigSortOrder,
  CampaignEntityConfigValues,
} from './types.js';

const INTERNAL_USER_ID_PREFIX = 'internal:campaign-config:' as const;
const INTERNAL_RECORD_KEY_PREFIX = 'internal:entity-config::' as const;
const INTERNAL_INTERACTION_ID = 'internal:campaign-entity-config' as const;
const INTERNAL_CLIENT_ID = 'server-internal-campaign-entity-config' as const;

const NullableStringSchema = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

export const CampaignEntityConfigPublicDebateSchema = Type.Object(
  {
    date: Type.String(),
    time: Type.String(),
    location: Type.String(),
    online_participation_link: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    announcement_link: Type.String(),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false }
);

const CampaignEntityConfigValuesV1Schema = Type.Object(
  {
    budgetPublicationDate: NullableStringSchema,
    officialBudgetUrl: NullableStringSchema,
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigValuesSchema = Type.Object(
  {
    budgetPublicationDate: NullableStringSchema,
    officialBudgetUrl: NullableStringSchema,
    public_debate: Type.Union([CampaignEntityConfigPublicDebateSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigStoredPayloadV1Schema = Type.Object(
  {
    version: Type.Literal(1),
    campaignKey: Type.Literal(FUNKY_CAMPAIGN_KEY),
    entityCui: Type.String({ minLength: 1 }),
    values: CampaignEntityConfigValuesV1Schema,
    meta: Type.Object(
      {
        updatedByUserId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignEntityConfigStoredPayloadV2Schema = Type.Object(
  {
    version: Type.Literal(2),
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

export const CampaignEntityConfigStoredPayloadSchema = Type.Union([
  CampaignEntityConfigStoredPayloadV1Schema,
  CampaignEntityConfigStoredPayloadV2Schema,
]);

export type CampaignEntityConfigStoredPayloadV1 = Static<
  typeof CampaignEntityConfigStoredPayloadV1Schema
>;
export type CampaignEntityConfigStoredPayloadV2 = Static<
  typeof CampaignEntityConfigStoredPayloadV2Schema
>;
export type CampaignEntityConfigStoredPayload =
  | CampaignEntityConfigStoredPayloadV1
  | CampaignEntityConfigStoredPayloadV2;

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

function normalizeTimeOnly(candidate: string): string | null {
  const trimmedCandidate = candidate.trim();
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(trimmedCandidate) ? trimmedCandidate : null;
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

function normalizeRequiredTrimmedString(candidate: string): string | null {
  const normalizedCandidate = candidate.trim();
  return normalizedCandidate === '' ? null : normalizedCandidate;
}

function normalizeOptionalTrimmedString(candidate: string | null | undefined): string | undefined {
  if (candidate === undefined || candidate === null) {
    return undefined;
  }

  const normalizedCandidate = candidate.trim();
  return normalizedCandidate === '' ? undefined : normalizedCandidate;
}

function normalizeOptionalUrl(candidate: string | null | undefined): string | undefined | null {
  if (candidate === undefined || candidate === null) {
    return undefined;
  }

  if (candidate.trim() === '') {
    return undefined;
  }

  const normalizedCandidate = normalizeUrl(candidate);
  return normalizedCandidate ?? null;
}

function normalizePublicDebate(
  candidate: CampaignEntityConfigPublicDebate | null
): Result<CampaignEntityConfigPublicDebate | null, CampaignEntityConfigError> {
  if (candidate === null) {
    return ok(null);
  }

  const date = normalizeDateOnly(candidate.date);
  if (date === null) {
    return err(
      createValidationError('public_debate.date must be a valid YYYY-MM-DD business date.')
    );
  }

  const time = normalizeTimeOnly(candidate.time);
  if (time === null) {
    return err(createValidationError('public_debate.time must use strict HH:MM 24-hour format.'));
  }

  const location = normalizeRequiredTrimmedString(candidate.location);
  if (location === null) {
    return err(createValidationError('public_debate.location must be a non-empty string.'));
  }

  const announcementLink = normalizeUrl(candidate.announcement_link);
  if (announcementLink === null) {
    return err(
      createValidationError('public_debate.announcement_link must be a valid absolute URL.')
    );
  }

  const onlineParticipationLink = normalizeOptionalUrl(candidate.online_participation_link);
  if (onlineParticipationLink === null) {
    return err(
      createValidationError('public_debate.online_participation_link must be a valid absolute URL.')
    );
  }

  const description = normalizeOptionalTrimmedString(candidate.description);

  return ok({
    date,
    time,
    location,
    announcement_link: announcementLink,
    ...(onlineParticipationLink !== undefined
      ? { online_participation_link: onlineParticipationLink }
      : {}),
    ...(description !== undefined ? { description } : {}),
  });
}

function hasEqualPublicDebate(
  left: CampaignEntityConfigPublicDebate | null,
  right: CampaignEntityConfigPublicDebate | null
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return (
    left.date === right.date &&
    left.time === right.time &&
    left.location === right.location &&
    left.announcement_link === right.announcement_link &&
    left.online_participation_link === right.online_participation_link &&
    left.description === right.description
  );
}

function hasEqualCampaignEntityConfigValues(
  left: CampaignEntityConfigValues,
  right: CampaignEntityConfigValues
): boolean {
  return (
    left.budgetPublicationDate === right.budgetPublicationDate &&
    left.officialBudgetUrl === right.officialBudgetUrl &&
    hasEqualPublicDebate(left.public_debate, right.public_debate)
  );
}

function hasConfiguredValue(values: CampaignEntityConfigValues): boolean {
  return (
    values.budgetPublicationDate !== null ||
    values.officialBudgetUrl !== null ||
    values.public_debate !== null
  );
}

function createDefaultValues(): CampaignEntityConfigValues {
  return {
    budgetPublicationDate: null,
    officialBudgetUrl: null,
    public_debate: null,
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

  const publicDebateResult = normalizePublicDebate(valuesCandidate.public_debate);
  if (publicDebateResult.isErr()) {
    return err(publicDebateResult.error);
  }

  const normalizedValues: CampaignEntityConfigValues = {
    budgetPublicationDate,
    officialBudgetUrl,
    public_debate: publicDebateResult.value,
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
  const payload: CampaignEntityConfigStoredPayloadV2 = {
    version: 2,
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

  const payload = payloadCandidate as CampaignEntityConfigStoredPayload;
  if (
    input.row.recordKey !== buildCampaignEntityConfigRecordKey(payload.entityCui) ||
    (input.expectedEntityCui !== undefined && payload.entityCui !== input.expectedEntityCui)
  ) {
    return err(createDatabaseError('Invalid persisted campaign entity config identity.', false));
  }

  const valuesCandidate =
    payload.version === 1
      ? {
          budgetPublicationDate: payload.values.budgetPublicationDate,
          officialBudgetUrl: payload.values.officialBudgetUrl,
          public_debate: null,
        }
      : (payload.values as unknown as CampaignEntityConfigValues);

  const normalizedValuesResult = normalizeCampaignEntityConfigValues(valuesCandidate);
  if (normalizedValuesResult.isErr()) {
    return err(createDatabaseError(normalizedValuesResult.error.message, false));
  }

  const isCanonicalPayload =
    payload.version === 1
      ? payload.values.budgetPublicationDate ===
          normalizedValuesResult.value.budgetPublicationDate &&
        payload.values.officialBudgetUrl === normalizedValuesResult.value.officialBudgetUrl
      : hasEqualCampaignEntityConfigValues(
          payload.values as unknown as CampaignEntityConfigValues,
          normalizedValuesResult.value
        );
  if (!isCanonicalPayload) {
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
      public_debate: null,
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
