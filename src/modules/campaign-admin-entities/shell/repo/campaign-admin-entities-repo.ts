import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_NOTIFICATION_GLOBAL_TYPE,
} from '@/common/campaign-keys.js';
import { parseDbTimestamp } from '@/common/utils/parse-db-timestamp.js';
import { setStatementTimeout } from '@/infra/database/query-builders/index.js';

import {
  createDatabaseError,
  createValidationError,
  type CampaignAdminEntitiesError,
} from '../../core/errors.js';
import {
  CAMPAIGN_ADMIN_ENTITY_FAILED_NOTIFICATION_STATUSES,
  CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_STATUSES,
  CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_TYPES,
  CAMPAIGN_ADMIN_ENTITY_SORT_FIELDS,
  CampaignAdminEntitiesMetaCounts,
  CampaignAdminEntityListCursor,
  CampaignAdminEntityRow,
  CampaignAdminEntitySortBy,
  CampaignAdminEntitySortOrder,
  GetCampaignAdminEntitiesMetaCountsInput,
  ListCampaignAdminEntitiesInput,
  ListCampaignAdminEntitiesOutput,
} from '../../core/types.js';

import type { CampaignAdminEntitiesRepository } from '../../core/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { EntityRepository } from '@/modules/entity/index.js';
import type { Logger } from 'pino';

const QUERY_TIMEOUT_MS = 10_000;
const TIMESTAMP_CURSOR_FLOOR = new Date(0);
const GLOBAL_UNSUBSCRIBE_TYPE = 'global_unsubscribe' as const;

const SUPPORTED_NOTIFICATION_TYPES = CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_TYPES;
const SUPPORTED_NOTIFICATION_STATUSES = CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_STATUSES;

const FAILED_NOTIFICATION_STATUSES = CAMPAIGN_ADMIN_ENTITY_FAILED_NOTIFICATION_STATUSES;

type SupportedNotificationType = (typeof SUPPORTED_NOTIFICATION_TYPES)[number];
type SupportedNotificationStatus = (typeof SUPPORTED_NOTIFICATION_STATUSES)[number];

export interface CampaignAdminEntitiesRepoOptions {
  readonly db: UserDbClient;
  readonly logger: Logger;
  readonly entityRepo: EntityRepository;
}

interface EntityAggregateRow {
  entity_cui: string;
  user_count: number | string;
  interaction_count: number | string;
  pending_review_count: number | string;
  notification_subscriber_count: number | string;
  notification_outbox_count: number | string;
  failed_notification_count: number | string;
  latest_interaction_at: unknown;
  latest_interaction_id: string | null;
  latest_notification_at: unknown;
  latest_notification_type: string | null;
  latest_notification_status: string | null;
}

interface MetaRow {
  total_entities: number | string;
  entities_with_pending_reviews: number | string;
  entities_with_subscribers: number | string;
  entities_with_notification_activity: number | string;
  entities_with_failed_notifications: number | string;
}

const SUPPORTED_NOTIFICATION_TYPE_SET = new Set<string>(SUPPORTED_NOTIFICATION_TYPES);
const SUPPORTED_NOTIFICATION_STATUS_SET = new Set<string>(SUPPORTED_NOTIFICATION_STATUSES);
const SUPPORTED_SORT_SET = new Set<string>(CAMPAIGN_ADMIN_ENTITY_SORT_FIELDS);
const FAILED_NOTIFICATION_STATUS_SQL = sql.join(
  FAILED_NOTIFICATION_STATUSES.map((status) => sql`${status}`),
  sql`, `
);

function parseCount(value: number | string | bigint | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
}

function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function parseOptionalTimestamp(
  value: string | undefined,
  fieldName: 'updatedAtFrom' | 'updatedAtTo'
): Result<Date | undefined, CampaignAdminEntitiesError> {
  if (value === undefined) {
    return ok(undefined);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return err(createValidationError(`Invalid ${fieldName} timestamp.`));
  }

  return ok(parsed);
}

function buildCampaignAdminInteractionFiltersSql(
  interactions: ListCampaignAdminEntitiesInput['interactions']
) {
  if (interactions.length === 0) {
    return sql<boolean>`false`;
  }

  return sql.join(
    interactions.map((interaction) =>
      interaction.submissionPath === undefined
        ? sql<boolean>`record->>'interactionId' = ${interaction.interactionId}`
        : sql<boolean>`
            record->>'interactionId' = ${interaction.interactionId}
            and record->'value'->'json'->'value'->>'submissionPath' = ${interaction.submissionPath}
          `
    ),
    sql<boolean>` or `
  );
}

function buildInteractionRowsEntityFilterSql(input: { query?: string; entityCui?: string }) {
  if (input.entityCui !== undefined) {
    return sql`
      and record->'scope'->>'entityCui' = ${input.entityCui}
    `;
  }

  if (input.query === undefined) {
    return sql``;
  }

  return sql`
    and record->'scope'->>'entityCui' ilike ${`%${escapeLikePattern(input.query)}%`} escape '\\'
  `;
}

function buildSubscriberRowsEntityFilterSql(input: { query?: string; entityCui?: string }) {
  if (input.entityCui !== undefined) {
    return sql`
      and nullif(btrim(entity_subscriptions.entity_cui), '') = ${input.entityCui}
    `;
  }

  if (input.query === undefined) {
    return sql``;
  }

  return sql`
    and nullif(btrim(entity_subscriptions.entity_cui), '') ilike ${`%${escapeLikePattern(input.query)}%`} escape '\\'
  `;
}

function buildOutboxRowsEntityFilterSql(input: { query?: string; entityCui?: string }) {
  if (input.entityCui !== undefined) {
    return sql`
      and nullif(btrim(outbox.metadata->>'entityCui'), '') = ${input.entityCui}
    `;
  }

  if (input.query === undefined) {
    return sql``;
  }

  return sql`
    and nullif(btrim(outbox.metadata->>'entityCui'), '') ilike ${`%${escapeLikePattern(input.query)}%`} escape '\\'
  `;
}

function buildAggregatedEntityRowsCteSql(input: {
  campaignKey: string;
  interactions: ListCampaignAdminEntitiesInput['interactions'];
  reviewableInteractions: ListCampaignAdminEntitiesInput['reviewableInteractions'];
  query?: string;
  interactionId?: string;
  entityCui?: string;
}) {
  const visibleInteractionsSql = buildCampaignAdminInteractionFiltersSql(input.interactions);
  const reviewableInteractionsSql = buildCampaignAdminInteractionFiltersSql(
    input.reviewableInteractions
  );
  const interactionIdFilterSql =
    input.interactionId === undefined
      ? sql``
      : sql`and record->>'interactionId' = ${input.interactionId}`;

  return sql`
    with active_global_users as (
      select distinct n.user_id
      from notifications as n
      where n.notification_type = ${FUNKY_NOTIFICATION_GLOBAL_TYPE}
        and n.is_active = true
    ),
    globally_unsubscribed_users as (
      select distinct n.user_id
      from notifications as n
      where n.notification_type = ${GLOBAL_UNSUBSCRIBE_TYPE}
        and (
          n.is_active = false
          or n.config->'channels'->>'email' = 'false'
        )
    ),
    interaction_rows as (
      select
        user_id,
        record_key,
        updated_at,
        record->>'interactionId' as interaction_id,
        nullif(btrim(record->'scope'->>'entityCui'), '') as entity_cui,
        case
          when (${reviewableInteractionsSql}) and record->'review'->>'status' is not null then record->'review'->>'status'
          when (${reviewableInteractionsSql}) and record->>'phase' = 'pending' then 'pending'
          else null
        end as review_status
      from userinteractions
      where record->'scope'->>'type' = 'entity'
        and nullif(btrim(record->'scope'->>'entityCui'), '') is not null
        and (${visibleInteractionsSql})
        ${interactionIdFilterSql}
        ${buildInteractionRowsEntityFilterSql({
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.entityCui !== undefined ? { entityCui: input.entityCui } : {}),
        })}
    ),
    interaction_users as (
      select distinct entity_cui, user_id
      from interaction_rows
    ),
    ranked_interaction_rows as (
      select
        entity_cui,
        interaction_id,
        updated_at,
        record_key,
        row_number() over (
          partition by entity_cui
          order by updated_at desc, record_key asc
        ) as latest_row_number
      from interaction_rows
    ),
    interaction_aggregate as (
      select
        entity_cui,
        count(*)::int as interaction_count,
        count(*) filter (where review_status = 'pending')::int as pending_review_count
      from interaction_rows
      group by entity_cui
    ),
    latest_interaction_rows as (
      select
        entity_cui,
        updated_at as latest_interaction_at,
        interaction_id as latest_interaction_id
      from ranked_interaction_rows
      where latest_row_number = 1
    ),
    subscriber_rows as (
      select distinct
        nullif(btrim(entity_subscriptions.entity_cui), '') as entity_cui,
        entity_subscriptions.user_id
      from notifications as entity_subscriptions
      inner join active_global_users
        on active_global_users.user_id = entity_subscriptions.user_id
      left join globally_unsubscribed_users
        on globally_unsubscribed_users.user_id = entity_subscriptions.user_id
      where entity_subscriptions.notification_type = ${FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE}
        and entity_subscriptions.is_active = true
        and nullif(btrim(entity_subscriptions.entity_cui), '') is not null
        and globally_unsubscribed_users.user_id is null
        ${buildSubscriberRowsEntityFilterSql({
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.entityCui !== undefined ? { entityCui: input.entityCui } : {}),
        })}
    ),
    subscriber_aggregate as (
      select
        entity_cui,
        count(*)::int as notification_subscriber_count
      from subscriber_rows
      group by entity_cui
    ),
    outbox_rows as (
      select
        outbox.id,
        nullif(btrim(outbox.metadata->>'entityCui'), '') as entity_cui,
        outbox.created_at,
        outbox.notification_type,
        outbox.status
      from notificationsoutbox as outbox
      where outbox.metadata->>'campaignKey' = ${input.campaignKey}
        and outbox.notification_type in (${sql.join(
          SUPPORTED_NOTIFICATION_TYPES.map((type) => sql`${type}`),
          sql`, `
        )})
        and nullif(btrim(outbox.metadata->>'entityCui'), '') is not null
        ${buildOutboxRowsEntityFilterSql({
          ...(input.query !== undefined ? { query: input.query } : {}),
          ...(input.entityCui !== undefined ? { entityCui: input.entityCui } : {}),
        })}
    ),
    ranked_outbox_rows as (
      select
        entity_cui,
        created_at,
        notification_type,
        status,
        id,
        row_number() over (
          partition by entity_cui
          order by created_at desc, id asc
        ) as latest_row_number
      from outbox_rows
    ),
    outbox_aggregate as (
      select
        entity_cui,
        count(*)::int as notification_outbox_count,
        count(*) filter (where status in (${FAILED_NOTIFICATION_STATUS_SQL}))::int as failed_notification_count
      from outbox_rows
      group by entity_cui
    ),
    latest_outbox_rows as (
      select
        entity_cui,
        created_at as latest_notification_at,
        notification_type as latest_notification_type,
        status as latest_notification_status
      from ranked_outbox_rows
      where latest_row_number = 1
    ),
    combined_users as (
      select entity_cui, user_id from interaction_users
      union
      select entity_cui, user_id from subscriber_rows
    ),
    user_count_aggregate as (
      select
        entity_cui,
        count(*)::int as user_count
      from combined_users
      group by entity_cui
    ),
    base_entities as (
      select entity_cui from interaction_aggregate
      union
      select entity_cui from subscriber_aggregate
      union
      select entity_cui from outbox_aggregate
    ),
    aggregated_entity_rows as (
      select
        base_entities.entity_cui,
        coalesce(user_count_aggregate.user_count, 0)::int as user_count,
        coalesce(interaction_aggregate.interaction_count, 0)::int as interaction_count,
        coalesce(interaction_aggregate.pending_review_count, 0)::int as pending_review_count,
        coalesce(subscriber_aggregate.notification_subscriber_count, 0)::int as notification_subscriber_count,
        coalesce(outbox_aggregate.notification_outbox_count, 0)::int as notification_outbox_count,
        coalesce(outbox_aggregate.failed_notification_count, 0)::int as failed_notification_count,
        latest_interaction_rows.latest_interaction_at,
        latest_interaction_rows.latest_interaction_id,
        latest_outbox_rows.latest_notification_at,
        latest_outbox_rows.latest_notification_type,
        latest_outbox_rows.latest_notification_status,
        case
          when latest_interaction_rows.latest_interaction_at is null then latest_outbox_rows.latest_notification_at
          when latest_outbox_rows.latest_notification_at is null then latest_interaction_rows.latest_interaction_at
          else greatest(
            latest_interaction_rows.latest_interaction_at,
            latest_outbox_rows.latest_notification_at
          )
        end as latest_activity_at
      from base_entities
      left join user_count_aggregate
        on user_count_aggregate.entity_cui = base_entities.entity_cui
      left join interaction_aggregate
        on interaction_aggregate.entity_cui = base_entities.entity_cui
      left join latest_interaction_rows
        on latest_interaction_rows.entity_cui = base_entities.entity_cui
      left join subscriber_aggregate
        on subscriber_aggregate.entity_cui = base_entities.entity_cui
      left join outbox_aggregate
        on outbox_aggregate.entity_cui = base_entities.entity_cui
      left join latest_outbox_rows
        on latest_outbox_rows.entity_cui = base_entities.entity_cui
    )
  `;
}

function buildEntityListFiltersSql(input: {
  interactionId?: string;
  hasPendingReviews?: boolean;
  hasSubscribers?: boolean;
  hasNotificationActivity?: boolean;
  hasFailedNotifications?: boolean;
  updatedAtFrom?: Date;
  updatedAtTo?: Date;
  latestNotificationType?: SupportedNotificationType;
  latestNotificationStatus?: SupportedNotificationStatus;
}) {
  const filters = [
    input.interactionId !== undefined ? sql`and interaction_count > 0` : sql``,
    input.hasPendingReviews === undefined
      ? sql``
      : input.hasPendingReviews
        ? sql`and pending_review_count > 0`
        : sql`and pending_review_count = 0`,
    input.hasSubscribers === undefined
      ? sql``
      : input.hasSubscribers
        ? sql`and notification_subscriber_count > 0`
        : sql`and notification_subscriber_count = 0`,
    input.hasNotificationActivity === undefined
      ? sql``
      : input.hasNotificationActivity
        ? sql`and notification_outbox_count > 0`
        : sql`and notification_outbox_count = 0`,
    input.hasFailedNotifications === undefined
      ? sql``
      : input.hasFailedNotifications
        ? sql`and failed_notification_count > 0`
        : sql`and failed_notification_count = 0`,
    input.updatedAtFrom === undefined
      ? sql``
      : sql`and latest_activity_at >= ${input.updatedAtFrom}`,
    input.updatedAtTo === undefined ? sql`` : sql`and latest_activity_at <= ${input.updatedAtTo}`,
    input.latestNotificationType === undefined
      ? sql``
      : sql`and latest_notification_type = ${input.latestNotificationType}`,
    input.latestNotificationStatus === undefined
      ? sql``
      : sql`and latest_notification_status = ${input.latestNotificationStatus}`,
  ];

  return sql.join(filters, sql` `);
}

function buildSortExpressionSql(sortBy: CampaignAdminEntitySortBy) {
  switch (sortBy) {
    case 'entityCui':
      return sql`entity_cui`;
    case 'userCount':
      return sql`user_count`;
    case 'interactionCount':
      return sql`interaction_count`;
    case 'pendingReviewCount':
      return sql`pending_review_count`;
    case 'notificationSubscriberCount':
      return sql`notification_subscriber_count`;
    case 'notificationOutboxCount':
      return sql`notification_outbox_count`;
    case 'latestInteractionAt':
      return sql`coalesce(latest_interaction_at, ${TIMESTAMP_CURSOR_FLOOR})`;
    case 'latestNotificationAt':
      return sql`coalesce(latest_notification_at, ${TIMESTAMP_CURSOR_FLOOR})`;
  }
}

function buildOrderBySql(
  sortBy: CampaignAdminEntitySortBy,
  sortOrder: CampaignAdminEntitySortOrder
) {
  if (sortBy === 'entityCui') {
    return sortOrder === 'asc' ? sql`order by entity_cui asc` : sql`order by entity_cui desc`;
  }

  const sortExpressionSql = buildSortExpressionSql(sortBy);

  return sortOrder === 'asc'
    ? sql`order by ${sortExpressionSql} asc, entity_cui asc`
    : sql`order by ${sortExpressionSql} desc, entity_cui asc`;
}

function normalizeCursorValue(
  sortBy: CampaignAdminEntitySortBy,
  value: string | number | null
): Result<string | number | Date, CampaignAdminEntitiesError> {
  if (sortBy === 'entityCui') {
    if (typeof value !== 'string') {
      return err(createValidationError('Entity cursor value must be a string.'));
    }

    return ok(value);
  }

  if (
    sortBy === 'userCount' ||
    sortBy === 'interactionCount' ||
    sortBy === 'pendingReviewCount' ||
    sortBy === 'notificationSubscriberCount' ||
    sortBy === 'notificationOutboxCount'
  ) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return err(createValidationError('Entity cursor value must be a number for numeric sorts.'));
    }

    return ok(value);
  }

  if (value === null) {
    return ok(TIMESTAMP_CURSOR_FLOOR);
  }

  if (typeof value !== 'string') {
    return err(
      createValidationError('Entity cursor value must be a string or null for timestamp sorts.')
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return err(createValidationError('Entity cursor value must be a valid timestamp.'));
  }

  return ok(parsed);
}

function buildCursorFilterSql(
  sortBy: CampaignAdminEntitySortBy,
  sortOrder: CampaignAdminEntitySortOrder,
  cursor: CampaignAdminEntityListCursor | undefined
): Result<ReturnType<typeof sql>, CampaignAdminEntitiesError> {
  if (cursor === undefined) {
    return ok(sql``);
  }

  if (cursor.sortBy !== sortBy || cursor.sortOrder !== sortOrder) {
    return err(createValidationError('Entity cursor sort does not match the requested sort.'));
  }

  if (sortBy === 'entityCui') {
    return ok(
      sortOrder === 'asc'
        ? sql`and entity_cui > ${cursor.entityCui}`
        : sql`and entity_cui < ${cursor.entityCui}`
    );
  }

  const cursorValueResult = normalizeCursorValue(sortBy, cursor.value);
  if (cursorValueResult.isErr()) {
    return err(cursorValueResult.error);
  }

  const sortExpressionSql = buildSortExpressionSql(sortBy);
  const cursorValue = cursorValueResult.value;

  return ok(
    sortOrder === 'asc'
      ? sql`
          and (
            ${sortExpressionSql} > ${cursorValue}
            or (${sortExpressionSql} = ${cursorValue} and entity_cui > ${cursor.entityCui})
          )
        `
      : sql`
          and (
            ${sortExpressionSql} < ${cursorValue}
            or (${sortExpressionSql} = ${cursorValue} and entity_cui > ${cursor.entityCui})
          )
        `
  );
}

function validateListInput(input: ListCampaignAdminEntitiesInput): Result<
  {
    entityCui?: string;
    query?: string;
    updatedAtFrom?: Date;
    updatedAtTo?: Date;
  },
  CampaignAdminEntitiesError
> {
  if (!SUPPORTED_SORT_SET.has(input.sortBy)) {
    return err(createValidationError(`Unsupported entity sort "${input.sortBy}".`));
  }

  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    return err(createValidationError('Entity list limit must be a positive integer.'));
  }

  if (
    input.latestNotificationType !== undefined &&
    !SUPPORTED_NOTIFICATION_TYPE_SET.has(input.latestNotificationType)
  ) {
    return err(
      createValidationError(`Unsupported latestNotificationType "${input.latestNotificationType}".`)
    );
  }

  if (
    input.latestNotificationStatus !== undefined &&
    !SUPPORTED_NOTIFICATION_STATUS_SET.has(input.latestNotificationStatus)
  ) {
    return err(
      createValidationError(
        `Unsupported latestNotificationStatus "${input.latestNotificationStatus}".`
      )
    );
  }

  if (
    input.interactionId !== undefined &&
    !input.interactions.some((interaction) => interaction.interactionId === input.interactionId)
  ) {
    return err(createValidationError(`Unsupported interactionId "${input.interactionId}".`));
  }

  const updatedAtFromResult = parseOptionalTimestamp(input.updatedAtFrom, 'updatedAtFrom');
  if (updatedAtFromResult.isErr()) {
    return err(updatedAtFromResult.error);
  }

  const updatedAtToResult = parseOptionalTimestamp(input.updatedAtTo, 'updatedAtTo');
  if (updatedAtToResult.isErr()) {
    return err(updatedAtToResult.error);
  }

  if (
    updatedAtFromResult.value !== undefined &&
    updatedAtToResult.value !== undefined &&
    updatedAtFromResult.value > updatedAtToResult.value
  ) {
    return err(createValidationError('updatedAtFrom must be less than or equal to updatedAtTo.'));
  }

  const query = input.query?.trim();
  const entityCui = input.entityCui?.trim();

  if (input.entityCui !== undefined && entityCui === '') {
    return err(createValidationError('Entity CUI is required.'));
  }

  return ok({
    ...(entityCui !== undefined ? { entityCui } : {}),
    ...(query !== undefined && query !== '' ? { query } : {}),
    ...(updatedAtFromResult.value !== undefined
      ? { updatedAtFrom: updatedAtFromResult.value }
      : {}),
    ...(updatedAtToResult.value !== undefined ? { updatedAtTo: updatedAtToResult.value } : {}),
  });
}

async function loadEntityNameMap(input: {
  readonly entityCuis: readonly string[];
  readonly entityRepo: EntityRepository;
  readonly logger: Pick<Logger, 'warn'>;
}): Promise<Map<string, string | null>> {
  if (input.entityCuis.length === 0) {
    return new Map();
  }

  const entitiesResult = await input.entityRepo.getByIds([...input.entityCuis]);
  if (entitiesResult.isErr()) {
    input.logger.warn(
      { error: entitiesResult.error, entityCuis: input.entityCuis },
      'Failed to load canonical entity names for campaign-admin entities'
    );
    return new Map();
  }

  return new Map(
    input.entityCuis.map((entityCui) => {
      const entity = entitiesResult.value.get(entityCui);
      return [entityCui, entity === undefined ? null : entity.name.trim()] as const;
    })
  );
}
function mapEntityRow(input: {
  readonly row: EntityAggregateRow;
  readonly entityName: string | null;
}): CampaignAdminEntityRow {
  const { row } = input;
  const userCount = parseCount(row.user_count);
  const interactionCount = parseCount(row.interaction_count);
  const pendingReviewCount = parseCount(row.pending_review_count);
  const notificationSubscriberCount = parseCount(row.notification_subscriber_count);
  const notificationOutboxCount = parseCount(row.notification_outbox_count);
  const failedNotificationCount = parseCount(row.failed_notification_count);

  return {
    entityCui: row.entity_cui,
    entityName: input.entityName,
    userCount,
    interactionCount,
    pendingReviewCount,
    notificationSubscriberCount,
    notificationOutboxCount,
    failedNotificationCount,
    hasPendingReviews: pendingReviewCount > 0,
    hasSubscribers: notificationSubscriberCount > 0,
    hasNotificationActivity: notificationOutboxCount > 0,
    hasFailedNotifications: failedNotificationCount > 0,
    latestInteractionAt:
      row.latest_interaction_at === null
        ? null
        : parseDbTimestamp(row.latest_interaction_at, 'latest_interaction_at').toISOString(),
    latestInteractionId: row.latest_interaction_id,
    latestNotificationAt:
      row.latest_notification_at === null
        ? null
        : parseDbTimestamp(row.latest_notification_at, 'latest_notification_at').toISOString(),
    latestNotificationType:
      row.latest_notification_type === null
        ? null
        : (row.latest_notification_type as SupportedNotificationType),
    latestNotificationStatus:
      row.latest_notification_status === null
        ? null
        : (row.latest_notification_status as SupportedNotificationStatus),
  };
}

function getCursorValue(
  row: CampaignAdminEntityRow,
  sortBy: CampaignAdminEntitySortBy
): CampaignAdminEntityListCursor['value'] {
  switch (sortBy) {
    case 'entityCui':
      return row.entityCui;
    case 'userCount':
      return row.userCount;
    case 'interactionCount':
      return row.interactionCount;
    case 'pendingReviewCount':
      return row.pendingReviewCount;
    case 'notificationSubscriberCount':
      return row.notificationSubscriberCount;
    case 'notificationOutboxCount':
      return row.notificationOutboxCount;
    case 'latestInteractionAt':
      return row.latestInteractionAt;
    case 'latestNotificationAt':
      return row.latestNotificationAt;
  }
}

function buildNextCursor(
  row: CampaignAdminEntityRow,
  sortBy: CampaignAdminEntitySortBy,
  sortOrder: CampaignAdminEntitySortOrder
): CampaignAdminEntityListCursor {
  switch (sortBy) {
    case 'entityCui':
      return {
        sortBy,
        sortOrder,
        entityCui: row.entityCui,
        value: row.entityCui,
      };
    case 'userCount':
    case 'interactionCount':
    case 'pendingReviewCount':
    case 'notificationSubscriberCount':
    case 'notificationOutboxCount':
    case 'latestInteractionAt':
    case 'latestNotificationAt':
      return {
        sortBy,
        sortOrder,
        entityCui: row.entityCui,
        value: getCursorValue(row, sortBy),
      };
  }
}

class KyselyCampaignAdminEntitiesRepo implements CampaignAdminEntitiesRepository {
  private readonly log: Logger;

  constructor(
    private readonly db: UserDbClient,
    private readonly entityRepo: EntityRepository,
    logger: Logger
  ) {
    this.log = logger.child({ repo: 'CampaignAdminEntitiesRepo' });
  }

  async listCampaignAdminEntities(
    input: ListCampaignAdminEntitiesInput
  ): Promise<Result<ListCampaignAdminEntitiesOutput, CampaignAdminEntitiesError>> {
    const validationResult = validateListInput(input);
    if (validationResult.isErr()) {
      return err(validationResult.error);
    }

    const cursorFilterSqlResult = buildCursorFilterSql(input.sortBy, input.sortOrder, input.cursor);
    if (cursorFilterSqlResult.isErr()) {
      return err(cursorFilterSqlResult.error);
    }

    try {
      return await this.db.transaction().execute(async (trx) => {
        await setStatementTimeout(trx, QUERY_TIMEOUT_MS);

        const result = await sql<EntityAggregateRow>`
          ${buildAggregatedEntityRowsCteSql({
            campaignKey: input.campaignKey,
            interactions: input.interactions,
            reviewableInteractions: input.reviewableInteractions,
            ...(validationResult.value.entityCui !== undefined
              ? { entityCui: validationResult.value.entityCui }
              : {}),
            ...(validationResult.value.query !== undefined
              ? { query: validationResult.value.query }
              : {}),
            ...(input.interactionId !== undefined ? { interactionId: input.interactionId } : {}),
          })}
          select
            entity_cui,
            user_count,
            interaction_count,
            pending_review_count,
            notification_subscriber_count,
            notification_outbox_count,
            failed_notification_count,
            latest_interaction_at,
            latest_interaction_id,
            latest_notification_at,
            latest_notification_type,
            latest_notification_status
          from aggregated_entity_rows
          where true
            ${buildEntityListFiltersSql({
              ...(input.interactionId !== undefined ? { interactionId: input.interactionId } : {}),
              ...(input.hasPendingReviews !== undefined
                ? { hasPendingReviews: input.hasPendingReviews }
                : {}),
              ...(input.hasSubscribers !== undefined
                ? { hasSubscribers: input.hasSubscribers }
                : {}),
              ...(input.hasNotificationActivity !== undefined
                ? { hasNotificationActivity: input.hasNotificationActivity }
                : {}),
              ...(input.hasFailedNotifications !== undefined
                ? { hasFailedNotifications: input.hasFailedNotifications }
                : {}),
              ...(validationResult.value.updatedAtFrom !== undefined
                ? { updatedAtFrom: validationResult.value.updatedAtFrom }
                : {}),
              ...(validationResult.value.updatedAtTo !== undefined
                ? { updatedAtTo: validationResult.value.updatedAtTo }
                : {}),
              ...(input.latestNotificationType !== undefined
                ? { latestNotificationType: input.latestNotificationType }
                : {}),
              ...(input.latestNotificationStatus !== undefined
                ? { latestNotificationStatus: input.latestNotificationStatus }
                : {}),
            })}
            ${cursorFilterSqlResult.value}
          ${buildOrderBySql(input.sortBy, input.sortOrder)}
          limit ${input.limit + 1}
        `.execute(trx);

        const hasMore = result.rows.length > input.limit;
        const pageRows = result.rows.slice(0, input.limit);
        const entityNameMap = await loadEntityNameMap({
          entityCuis: pageRows.map((row) => row.entity_cui),
          entityRepo: this.entityRepo,
          logger: this.log,
        });
        const items = pageRows.map((row) =>
          mapEntityRow({
            row,
            entityName: entityNameMap.get(row.entity_cui) ?? null,
          })
        );
        const lastItem = items.at(-1);

        return ok({
          items,
          hasMore,
          nextCursor:
            hasMore && lastItem !== undefined
              ? buildNextCursor(lastItem, input.sortBy, input.sortOrder)
              : null,
        });
      });
    } catch (error) {
      this.log.error({ err: error, input }, 'Failed to list campaign-admin entities');
      return err(createDatabaseError('Failed to list campaign-admin entities'));
    }
  }

  async getCampaignAdminEntitiesMetaCounts(
    input: GetCampaignAdminEntitiesMetaCountsInput
  ): Promise<Result<CampaignAdminEntitiesMetaCounts, CampaignAdminEntitiesError>> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await setStatementTimeout(trx, QUERY_TIMEOUT_MS);

        const result = await sql<MetaRow>`
          ${buildAggregatedEntityRowsCteSql({
            campaignKey: input.campaignKey,
            interactions: input.interactions,
            reviewableInteractions: input.reviewableInteractions,
          })}
          select
            count(*)::int as total_entities,
            count(*) filter (where pending_review_count > 0)::int as entities_with_pending_reviews,
            count(*) filter (where notification_subscriber_count > 0)::int as entities_with_subscribers,
            count(*) filter (where notification_outbox_count > 0)::int as entities_with_notification_activity,
            count(*) filter (where failed_notification_count > 0)::int as entities_with_failed_notifications
          from aggregated_entity_rows
        `.execute(trx);

        const row = result.rows[0];

        return ok({
          totalEntities: parseCount(row?.total_entities),
          entitiesWithPendingReviews: parseCount(row?.entities_with_pending_reviews),
          entitiesWithSubscribers: parseCount(row?.entities_with_subscribers),
          entitiesWithNotificationActivity: parseCount(row?.entities_with_notification_activity),
          entitiesWithFailedNotifications: parseCount(row?.entities_with_failed_notifications),
        });
      });
    } catch (error) {
      this.log.error({ err: error, input }, 'Failed to load campaign-admin entities meta');
      return err(createDatabaseError('Failed to load campaign-admin entities meta'));
    }
  }
}

export const makeCampaignAdminEntitiesRepo = (
  options: CampaignAdminEntitiesRepoOptions
): CampaignAdminEntitiesRepository =>
  new KyselyCampaignAdminEntitiesRepo(options.db, options.entityRepo, options.logger);
