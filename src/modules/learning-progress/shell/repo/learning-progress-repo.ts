/**
 * Learning Progress Repository - Kysely Implementation
 *
 * Stores one row per user and per client-controlled record key.
 */

import { sql, type Transaction } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { FUNKY_PROGRESS_TERMS_ACCEPTED_PREFIX } from '@/common/campaign-keys.js';
import { acquireLearningProgressAutoReviewReuseTransactionLock } from '@/infra/database/user/advisory-locks.js';
import { INTERNAL_NAMESPACE_PREFIX } from '@/modules/learning-progress/core/internal-records.js';

import { createDatabaseError, type LearningProgressError } from '../../core/errors.js';
import { jsonValuesAreEqual } from '../../core/json-equality.js';

import type { LearningProgressRepository } from '../../core/ports.js';
import type {
  CampaignAdminCampaignKey,
  CampaignAdminPhaseCounts,
  CampaignAdminReviewStatusCounts,
  CampaignAdminInstitutionThreadSummary,
  CampaignAdminRiskFlagCandidate,
  CampaignAdminSortOrder,
  CampaignAdminStatsBase,
  CampaignAdminThreadPhaseCounts,
  CampaignAdminUserListCursor,
  CampaignAdminUserRow,
  CampaignAdminUserSortBy,
  GetCampaignAdminStatsInput,
  GetCampaignAdminStatsOutput,
  GetCampaignAdminUsersMetaCountsInput,
  GetRecordsOptions,
  InteractiveStateRecord,
  ListCampaignAdminInteractionRowsInput,
  ListCampaignAdminInteractionRowsOutput,
  ListCampaignAdminUsersInput,
  ListCampaignAdminUsersOutput,
  CampaignAdminUsersMetaCounts,
  LearningProgressRecordRow,
  StoredInteractiveAuditEvent,
  UpsertInteractiveRecordInput,
  UpsertInteractiveRecordResult,
} from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type {
  LearningProgressAuditEventRow,
  LearningProgressRecordValueRow,
  UserDatabase,
} from '@/infra/database/user/types.js';
import type { Logger } from 'pino';

export interface LearningProgressRepoOptions {
  db: UserDbConnection;
  logger: Logger;
  transactionScoped?: boolean;
}

const USER_INTERACTIONS_TABLE = 'userinteractions' as const;
const LEARNING_PROGRESS_ROW_COLUMNS = [
  'user_id',
  'record_key',
  'record',
  'audit_events',
  'updated_seq',
  'created_at',
  'updated_at',
] as const;

type UserDbConnection = UserDbClient | Transaction<UserDatabase>;

function normalizeRecordValueRow(record: LearningProgressRecordValueRow): InteractiveStateRecord {
  return record;
}

function normalizeAuditEventRow(
  auditEvent: LearningProgressAuditEventRow
): StoredInteractiveAuditEvent {
  return auditEvent as StoredInteractiveAuditEvent;
}

function sortAuditEvents(
  leftEvent: StoredInteractiveAuditEvent,
  rightEvent: StoredInteractiveAuditEvent
): number {
  const leftSeq = BigInt(leftEvent.seq);
  const rightSeq = BigInt(rightEvent.seq);

  if (leftSeq < rightSeq) return -1;
  if (leftSeq > rightSeq) return 1;

  return leftEvent.id.localeCompare(rightEvent.id);
}

function recordsAreEqual(
  leftRecord: LearningProgressRecordValueRow,
  rightRecord: LearningProgressRecordValueRow
): boolean {
  return jsonValuesAreEqual(leftRecord, rightRecord);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function buildCampaignAdminInteractionFiltersSql(
  interactions: readonly {
    interactionId: string;
    submissionPath?: string;
  }[]
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

function getCampaignTermsAcceptedRecordKeyPrefix(campaignKey: CampaignAdminCampaignKey): string {
  void campaignKey;
  return FUNKY_PROGRESS_TERMS_ACCEPTED_PREFIX;
}

function buildCampaignAdminItemsCteSql(input: GetCampaignAdminStatsInput) {
  const visibleInteractionsSql = buildCampaignAdminInteractionFiltersSql(input.interactions);
  const reviewableInteractionsSql = buildCampaignAdminInteractionFiltersSql(
    input.reviewableInteractions
  );
  const threadSummaryInteractionsSql = buildCampaignAdminInteractionFiltersSql(
    input.threadSummaryInteractions
  );

  return sql`
    with campaign_admin_items as (
      select
        record->>'interactionId' as interaction_id,
        record->>'phase' as phase,
        case
          when (${reviewableInteractionsSql}) and record->'review'->>'status' is not null then record->'review'->>'status'
          when (${reviewableInteractionsSql}) and record->>'phase' = 'pending' then 'pending'
          else null
        end as review_status,
        record->'scope'->>'entityCui' as entity_cui,
        case
          when (${reviewableInteractionsSql}) then nullif(btrim(record->'value'->'json'->'value'->>'primariaEmail'), '')
          else null
        end as institution_email,
        case
          when (${threadSummaryInteractionsSql}) then (
            select iet.phase
            from institutionemailthreads as iet
            where iet.entity_cui = record->'scope'->>'entityCui'
              and iet.campaign_key = ${input.campaignKey}
              and iet.record->>'submissionPath' = ${'platform_send'}
            order by iet.created_at desc
            limit 1
          )
          else null
        end as thread_phase
      from userinteractions
      where (${visibleInteractionsSql})
    )
  `;
}

function buildCampaignAdminUserOrderBySql(
  sortBy: CampaignAdminUserSortBy,
  sortOrder: CampaignAdminSortOrder
) {
  switch (sortBy) {
    case 'userId':
      return sortOrder === 'asc'
        ? sql`order by aggregated_user_rows.user_id asc`
        : sql`order by aggregated_user_rows.user_id desc`;
    case 'latestUpdatedAt':
      return sortOrder === 'asc'
        ? sql`order by aggregated_user_rows.latest_updated_at asc, aggregated_user_rows.user_id asc`
        : sql`order by aggregated_user_rows.latest_updated_at desc, aggregated_user_rows.user_id asc`;
    case 'interactionCount':
      return sortOrder === 'asc'
        ? sql`order by aggregated_user_rows.interaction_count asc, aggregated_user_rows.user_id asc`
        : sql`order by aggregated_user_rows.interaction_count desc, aggregated_user_rows.user_id asc`;
    case 'pendingReviewCount':
      return sortOrder === 'asc'
        ? sql`order by aggregated_user_rows.pending_review_count asc, aggregated_user_rows.user_id asc`
        : sql`order by aggregated_user_rows.pending_review_count desc, aggregated_user_rows.user_id asc`;
    default:
      return sql`order by aggregated_user_rows.latest_updated_at desc, aggregated_user_rows.user_id asc`;
  }
}

function buildCampaignAdminUserCursorFilterSql(input: {
  sortBy: CampaignAdminUserSortBy;
  sortOrder: CampaignAdminSortOrder;
  cursor?: CampaignAdminUserListCursor;
}) {
  if (input.cursor === undefined) {
    return sql``;
  }

  switch (input.sortBy) {
    case 'userId':
      return input.sortOrder === 'asc'
        ? sql`and aggregated_user_rows.user_id > ${input.cursor.userId}`
        : sql`and aggregated_user_rows.user_id < ${input.cursor.userId}`;
    case 'latestUpdatedAt':
      return input.sortOrder === 'asc'
        ? sql`
            and (
              aggregated_user_rows.latest_updated_at > ${String(input.cursor.value)}::timestamptz
              or (
                aggregated_user_rows.latest_updated_at = ${String(input.cursor.value)}::timestamptz
                and aggregated_user_rows.user_id > ${input.cursor.userId}
              )
            )
          `
        : sql`
            and (
              aggregated_user_rows.latest_updated_at < ${String(input.cursor.value)}::timestamptz
              or (
                aggregated_user_rows.latest_updated_at = ${String(input.cursor.value)}::timestamptz
                and aggregated_user_rows.user_id > ${input.cursor.userId}
              )
            )
          `;
    case 'interactionCount':
      return input.sortOrder === 'asc'
        ? sql`
            and (
              aggregated_user_rows.interaction_count > ${Number(input.cursor.value)}
              or (
                aggregated_user_rows.interaction_count = ${Number(input.cursor.value)}
                and aggregated_user_rows.user_id > ${input.cursor.userId}
              )
            )
          `
        : sql`
            and (
              aggregated_user_rows.interaction_count < ${Number(input.cursor.value)}
              or (
                aggregated_user_rows.interaction_count = ${Number(input.cursor.value)}
                and aggregated_user_rows.user_id > ${input.cursor.userId}
              )
            )
          `;
    case 'pendingReviewCount':
      return input.sortOrder === 'asc'
        ? sql`
            and (
              aggregated_user_rows.pending_review_count > ${Number(input.cursor.value)}
              or (
                aggregated_user_rows.pending_review_count = ${Number(input.cursor.value)}
                and aggregated_user_rows.user_id > ${input.cursor.userId}
              )
            )
          `
        : sql`
            and (
              aggregated_user_rows.pending_review_count < ${Number(input.cursor.value)}
              or (
                aggregated_user_rows.pending_review_count = ${Number(input.cursor.value)}
                and aggregated_user_rows.user_id > ${input.cursor.userId}
              )
            )
          `;
    default:
      return sql``;
  }
}

function getCampaignAdminUserCursorValue(
  row: CampaignAdminUserRow,
  sortBy: CampaignAdminUserSortBy
): CampaignAdminUserListCursor['value'] {
  switch (sortBy) {
    case 'userId':
      return row.userId;
    case 'latestUpdatedAt':
      return row.latestUpdatedAt;
    case 'interactionCount':
      return row.interactionCount;
    case 'pendingReviewCount':
      return row.pendingReviewCount;
    default:
      return row.latestUpdatedAt;
  }
}

function createEmptyCampaignAdminReviewStatusCounts(): CampaignAdminReviewStatusCounts {
  return {
    pending: 0,
    approved: 0,
    rejected: 0,
    notReviewed: 0,
  };
}

function createEmptyCampaignAdminPhaseCounts(): CampaignAdminPhaseCounts {
  return {
    idle: 0,
    draft: 0,
    pending: 0,
    resolved: 0,
    failed: 0,
  };
}

function createEmptyCampaignAdminThreadPhaseCounts(): CampaignAdminThreadPhaseCounts {
  return {
    sending: 0,
    awaiting_reply: 0,
    reply_received_unreviewed: 0,
    manual_follow_up_needed: 0,
    resolved_positive: 0,
    resolved_negative: 0,
    closed_no_response: 0,
    failed: 0,
    none: 0,
  };
}

function createEmptyCampaignAdminStatsBase(): CampaignAdminStatsBase {
  return {
    total: 0,
    withInstitutionThread: 0,
    reviewStatusCounts: createEmptyCampaignAdminReviewStatusCounts(),
    phaseCounts: createEmptyCampaignAdminPhaseCounts(),
    threadPhaseCounts: createEmptyCampaignAdminThreadPhaseCounts(),
  };
}

function compareTimestamps(leftTimestamp: string, rightTimestamp: string): number {
  const leftValue = Date.parse(leftTimestamp);
  const rightValue = Date.parse(rightTimestamp);

  if (Number.isNaN(leftValue) || Number.isNaN(rightValue)) {
    return leftTimestamp.localeCompare(rightTimestamp);
  }

  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

function mapCampaignAdminThreadSummary(
  row: CampaignAdminQueryRow
): CampaignAdminInstitutionThreadSummary | null {
  if (row.thread_id === null || row.thread_phase === null) {
    return null;
  }

  return {
    threadId: row.thread_id,
    threadPhase: row.thread_phase,
    lastEmailAt: row.thread_last_email_at !== null ? toIsoString(row.thread_last_email_at) : null,
    lastReplyAt: row.thread_last_reply_at !== null ? toIsoString(row.thread_last_reply_at) : null,
    nextActionAt:
      row.thread_next_action_at !== null ? toIsoString(row.thread_next_action_at) : null,
  };
}

class LearningProgressTransactionRollbackError extends Error {
  readonly failure: LearningProgressError;

  constructor(failure: LearningProgressError) {
    super('Learning progress transaction rolled back');
    this.failure = failure;
  }
}

class KyselyLearningProgressRepo implements LearningProgressRepository {
  private readonly db: UserDbConnection;
  private readonly log: Logger;
  private readonly transactionScoped: boolean;

  constructor(options: LearningProgressRepoOptions) {
    this.db = options.db;
    this.log = options.logger.child({ module: 'learning-progress-repo' });
    this.transactionScoped = options.transactionScoped ?? false;
  }

  async getRecords(
    userId: string,
    options?: GetRecordsOptions
  ): Promise<Result<readonly LearningProgressRecordRow[], LearningProgressError>> {
    try {
      let query = this.db
        .selectFrom(USER_INTERACTIONS_TABLE)
        .select(LEARNING_PROGRESS_ROW_COLUMNS)
        .where('user_id', '=', userId);

      if (options?.includeInternal !== true) {
        query = query.where(
          sql<boolean>`record_key NOT LIKE ${`${escapeLikePattern(INTERNAL_NAMESPACE_PREFIX)}%`} ESCAPE '\\'`
        );
      }

      if (options?.recordKeyPrefix !== undefined) {
        query = query.where(
          sql<boolean>`record_key LIKE ${`${escapeLikePattern(options.recordKeyPrefix)}%`} ESCAPE '\\'`
        );
      }

      const rows = await query.orderBy('updated_seq', 'asc').execute();

      return ok(rows.map((row) => this.mapRow(row as unknown as QueryRow)));
    } catch (error) {
      this.log.error({ err: error, userId, options }, 'Failed to load learning progress records');
      return err(createDatabaseError('Failed to load learning progress records', error));
    }
  }

  private async getRecordInternal(
    userId: string,
    recordKey: string,
    forUpdate: boolean
  ): Promise<Result<LearningProgressRecordRow | null, LearningProgressError>> {
    try {
      let query = this.db
        .selectFrom(USER_INTERACTIONS_TABLE)
        .select(LEARNING_PROGRESS_ROW_COLUMNS)
        .where('user_id', '=', userId)
        .where('record_key', '=', recordKey);

      if (forUpdate && this.transactionScoped) {
        query = query.forUpdate();
      }

      const row = await query.executeTakeFirst();
      return ok(row === undefined ? null : this.mapRow(row as unknown as QueryRow));
    } catch (error) {
      this.log.error({ err: error, userId, recordKey }, 'Failed to load learning progress record');
      return err(createDatabaseError('Failed to load learning progress record', error));
    }
  }

  async getRecord(
    userId: string,
    recordKey: string
  ): Promise<Result<LearningProgressRecordRow | null, LearningProgressError>> {
    return this.getRecordInternal(userId, recordKey, false);
  }

  async getRecordForUpdate(
    userId: string,
    recordKey: string
  ): Promise<Result<LearningProgressRecordRow | null, LearningProgressError>> {
    return this.getRecordInternal(userId, recordKey, true);
  }

  async acquireAutoReviewReuseTransactionLock(input: {
    recordKey: string;
    interactionId: string;
    entityCui: string;
  }): Promise<Result<void, LearningProgressError>> {
    try {
      await acquireLearningProgressAutoReviewReuseTransactionLock(this.db, input);
      return ok(undefined);
    } catch (error) {
      this.log.error(
        {
          err: error,
          recordKey: input.recordKey,
          interactionId: input.interactionId,
          entityCui: input.entityCui,
        },
        'Failed to acquire learning progress auto-review reuse transaction lock'
      );
      return err(
        createDatabaseError(
          'Failed to acquire learning progress auto-review reuse transaction lock',
          error
        )
      );
    }
  }

  async findLatestCampaignAdminReviewedExactKeyMatches(input: {
    recordKey: string;
    interactionId: string;
    entityCui: string;
  }): Promise<Result<readonly LearningProgressRecordRow[], LearningProgressError>> {
    try {
      const rows = await this.db
        .with('matching_rows', (db) =>
          db
            .selectFrom(USER_INTERACTIONS_TABLE)
            .select(LEARNING_PROGRESS_ROW_COLUMNS)
            .where('record_key', '=', input.recordKey)
            .where(sql<boolean>`record->>'interactionId' = ${input.interactionId}`)
            .where(sql<boolean>`record->'scope'->>'type' = 'entity'`)
            .where(sql<boolean>`record->'scope'->>'entityCui' = ${input.entityCui}`)
            .where(sql<boolean>`record->>'phase' in ('resolved', 'failed')`)
            .where(sql<boolean>`record->'review'->>'reviewSource' = ${'campaign_admin_api'}`)
            .where(sql<boolean>`record->'review'->>'status' in ('approved', 'rejected')`)
        )
        .with('latest_precedence_group', (db) =>
          db.selectFrom('matching_rows').select('updated_at').orderBy('updated_at', 'desc').limit(1)
        )
        .selectFrom('matching_rows')
        .innerJoin(
          'latest_precedence_group',
          'latest_precedence_group.updated_at',
          'matching_rows.updated_at'
        )
        .selectAll('matching_rows')
        .orderBy('matching_rows.user_id', 'asc')
        .orderBy('matching_rows.record_key', 'asc')
        .execute();

      return ok(rows.map((row) => this.mapRow(row as unknown as QueryRow)));
    } catch (error) {
      this.log.error(
        {
          err: error,
          recordKey: input.recordKey,
          interactionId: input.interactionId,
          entityCui: input.entityCui,
        },
        'Failed to load latest campaign-admin reviewed exact-key matches'
      );
      return err(
        createDatabaseError(
          'Failed to load latest campaign-admin reviewed exact-key matches',
          error
        )
      );
    }
  }

  async listCampaignAdminInteractionRows(
    input: ListCampaignAdminInteractionRowsInput
  ): Promise<Result<ListCampaignAdminInteractionRowsOutput, LearningProgressError>> {
    if (input.interactions.length === 0) {
      return ok({
        rows: [],
        hasMore: false,
        nextCursor: null,
      });
    }

    const interactionFiltersSql = buildCampaignAdminInteractionFiltersSql(input.interactions);
    const entityCuiSql = sql<string | null>`record->'scope'->>'entityCui'`;
    const threadSubquerySql = sql`
      from institutionemailthreads as iet
      where iet.entity_cui = ${entityCuiSql}
        and iet.campaign_key = ${input.campaignKey}
        and iet.record->>'submissionPath' = ${'platform_send'}
      order by iet.created_at desc
      limit 1
    `;
    const hasThreadSql = sql<boolean>`
      exists (
        select 1
        from institutionemailthreads as iet
        where iet.entity_cui = ${entityCuiSql}
          and iet.campaign_key = ${input.campaignKey}
          and iet.record->>'submissionPath' = ${'platform_send'}
      )
    `;

    try {
      let query = this.db
        .selectFrom(USER_INTERACTIONS_TABLE)
        .select(LEARNING_PROGRESS_ROW_COLUMNS)
        .select([
          sql<string | null>`(select iet.id::text ${threadSubquerySql})`.as('thread_id'),
          sql<CampaignAdminQueryRow['thread_phase']>`(select iet.phase ${threadSubquerySql})`.as(
            'thread_phase'
          ),
          sql<Date | string | null>`(select iet.last_email_at ${threadSubquerySql})`.as(
            'thread_last_email_at'
          ),
          sql<Date | string | null>`(select iet.last_reply_at ${threadSubquerySql})`.as(
            'thread_last_reply_at'
          ),
          sql<Date | string | null>`(select iet.next_action_at ${threadSubquerySql})`.as(
            'thread_next_action_at'
          ),
        ])
        .where(sql<boolean>`(${interactionFiltersSql})`);

      if (input.phase !== undefined) {
        query = query.where(sql<boolean>`record->>'phase' = ${input.phase}`);
      }

      if (input.reviewStatus !== undefined) {
        query =
          input.reviewStatus === 'pending'
            ? query.where(sql<boolean>`record->>'phase' = 'pending'`)
            : query.where(sql<boolean>`record->'review'->>'status' = ${input.reviewStatus}`);
      }

      if (input.reviewSource !== undefined) {
        query = query.where(
          sql<boolean>`record->'review'->>'reviewSource' = ${input.reviewSource}`
        );
      }

      if (input.lessonId !== undefined) {
        query = query.where(sql<boolean>`record->>'lessonId' = ${input.lessonId}`);
      }

      if (input.entityCui !== undefined) {
        query = query.where(sql<boolean>`record->'scope'->>'entityCui' = ${input.entityCui}`);
      }

      if (input.scopeType !== undefined) {
        query = query.where(sql<boolean>`record->'scope'->>'type' = ${input.scopeType}`);
      }

      if (input.payloadKind !== undefined) {
        query = query.where(sql<boolean>`record->'value'->>'kind' = ${input.payloadKind}`);
      }

      if (input.submissionPath !== undefined) {
        query = query.where(
          sql<boolean>`record->'value'->'json'->'value'->>'submissionPath' = ${input.submissionPath}`
        );
      }

      if (input.userId !== undefined) {
        query = query.where('user_id', '=', input.userId);
      }

      if (input.recordKey !== undefined) {
        query = query.where('record_key', '=', input.recordKey);
      }

      if (input.recordKeyPrefix !== undefined) {
        query = query.where(
          sql<boolean>`record_key LIKE ${`${escapeLikePattern(input.recordKeyPrefix)}%`} ESCAPE '\\'`
        );
      }

      if (input.submittedAtFrom !== undefined) {
        query = query.where(
          sql<boolean>`(record->>'submittedAt')::timestamptz >= ${input.submittedAtFrom}::timestamptz`
        );
      }

      if (input.submittedAtTo !== undefined) {
        query = query.where(
          sql<boolean>`(record->>'submittedAt')::timestamptz <= ${input.submittedAtTo}::timestamptz`
        );
      }

      if (input.updatedAtFrom !== undefined) {
        query = query.where(sql<boolean>`updated_at >= ${input.updatedAtFrom}::timestamptz`);
      }

      if (input.updatedAtTo !== undefined) {
        query = query.where(sql<boolean>`updated_at <= ${input.updatedAtTo}::timestamptz`);
      }

      if (input.hasInstitutionThread === true) {
        query = query.where(hasThreadSql);
      }

      if (input.hasInstitutionThread === false) {
        query = query.where(sql<boolean>`not (${hasThreadSql})`);
      }

      if (input.threadPhase !== undefined) {
        query = query.where(
          sql<boolean>`(select iet.phase ${threadSubquerySql}) = ${input.threadPhase}`
        );
      }

      if (input.cursor !== undefined) {
        query = query.where(
          sql<boolean>`
            updated_at < ${input.cursor.updatedAt}::timestamptz
            or (
              updated_at = ${input.cursor.updatedAt}::timestamptz
              and user_id > ${input.cursor.userId}
            )
            or (
              updated_at = ${input.cursor.updatedAt}::timestamptz
              and user_id = ${input.cursor.userId}
              and record_key > ${input.cursor.recordKey}
            )
          `
        );
      }

      const rows = await query
        .orderBy('updated_at', 'desc')
        .orderBy('user_id', 'asc')
        .orderBy('record_key', 'asc')
        .limit(input.limit + 1)
        .execute();

      const hasMore = rows.length > input.limit;
      const pageRows = rows.slice(0, input.limit) as unknown as CampaignAdminQueryRow[];
      const lastRow = pageRows.at(-1);

      return ok({
        rows: pageRows.map((row) => ({
          userId: row.user_id,
          recordKey: row.record_key,
          campaignKey: input.campaignKey,
          record: normalizeRecordValueRow(row.record),
          auditEvents: row.audit_events.map(normalizeAuditEventRow).sort(sortAuditEvents),
          createdAt: toIsoString(row.created_at),
          updatedAt: toIsoString(row.updated_at),
          threadSummary: mapCampaignAdminThreadSummary(row),
        })),
        hasMore,
        nextCursor:
          hasMore && lastRow !== undefined
            ? {
                updatedAt: toIsoString(lastRow.updated_at),
                userId: lastRow.user_id,
                recordKey: lastRow.record_key,
              }
            : null,
      });
    } catch (error) {
      this.log.error(
        { err: error, input },
        'Failed to list campaign-admin learning progress interaction rows'
      );
      return err(
        createDatabaseError(
          'Failed to list campaign-admin learning progress interaction rows',
          error
        )
      );
    }
  }

  async listCampaignAdminUsers(
    input: ListCampaignAdminUsersInput
  ): Promise<Result<ListCampaignAdminUsersOutput, LearningProgressError>> {
    const termsAcceptedRecordKeyPrefix = getCampaignTermsAcceptedRecordKeyPrefix(input.campaignKey);

    const visibleInteractionsSql = buildCampaignAdminInteractionFiltersSql(input.interactions);
    const reviewableInteractionsSql = buildCampaignAdminInteractionFiltersSql(
      input.reviewableInteractions
    );
    const queryFilterSql =
      input.query !== undefined
        ? sql<boolean>`and user_id ilike ${`%${escapeLikePattern(input.query)}%`} escape '\\'`
        : sql``;
    const cursorFilterSql = buildCampaignAdminUserCursorFilterSql({
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });
    const orderBySql = buildCampaignAdminUserOrderBySql(input.sortBy, input.sortOrder);

    try {
      const result =
        input.entityCui === undefined
          ? await sql<CampaignAdminUserAggregateQueryRow>`
              with accepted_terms_rows as (
                select
                  user_id,
                  record_key,
                  updated_at,
                  nullif(btrim(record->'value'->'json'->'value'->>'entityCui'), '') as entity_cui,
                  row_number() over (
                    partition by user_id
                    order by updated_at desc, record_key asc
                  ) as latest_row_number
                from userinteractions
                where record_key like ${`${escapeLikePattern(termsAcceptedRecordKeyPrefix)}%`} escape '\\'
                  ${queryFilterSql}
              ),
              accepted_terms_users as (
                select distinct user_id
                from accepted_terms_rows
              ),
              latest_terms_rows as (
                select
                  user_id,
                  updated_at as latest_terms_updated_at,
                  entity_cui as latest_terms_entity_cui
                from accepted_terms_rows
                where latest_row_number = 1
              ),
              filtered_items as (
                select
                  user_id,
                  record_key,
                  updated_at,
                  record->>'interactionId' as interaction_id,
                  record->'scope'->>'entityCui' as entity_cui,
                  case
                    when (${reviewableInteractionsSql}) and record->'review'->>'status' is not null then record->'review'->>'status'
                    when (${reviewableInteractionsSql}) and record->>'phase' = 'pending' then 'pending'
                    else null
                  end as review_status
                from userinteractions
                where (${visibleInteractionsSql})
                  ${queryFilterSql}
              ),
              ranked_items as (
                select
                  user_id,
                  record_key,
                  updated_at,
                  interaction_id,
                  entity_cui,
                  review_status,
                  row_number() over (
                    partition by user_id
                    order by updated_at desc, record_key asc
                  ) as latest_row_number
                from filtered_items
              ),
              aggregated_users as (
                select
                  user_id,
                  count(*)::int as interaction_count,
                  count(*) filter (where review_status = 'pending')::int as pending_review_count
                from ranked_items
                group by user_id
              ),
              latest_rows as (
                select
                  user_id,
                  updated_at as latest_updated_at,
                  interaction_id as latest_interaction_id,
                  entity_cui as latest_entity_cui
                from ranked_items
                where latest_row_number = 1
              ),
              base_users as (
                select user_id from accepted_terms_users
                union
                select user_id from aggregated_users
              ),
              aggregated_user_rows as (
                select
                  base_users.user_id,
                  coalesce(aggregated_users.interaction_count, 0)::int as interaction_count,
                  coalesce(aggregated_users.pending_review_count, 0)::int as pending_review_count,
                  case
                    when latest_rows.latest_updated_at is null then latest_terms_rows.latest_terms_updated_at
                    when latest_terms_rows.latest_terms_updated_at is null then latest_rows.latest_updated_at
                    else greatest(
                      latest_rows.latest_updated_at,
                      latest_terms_rows.latest_terms_updated_at
                    )
                  end as latest_updated_at,
                  latest_rows.latest_interaction_id,
                  case
                    when latest_rows.latest_updated_at is null then latest_terms_rows.latest_terms_entity_cui
                    when latest_terms_rows.latest_terms_updated_at is null then latest_rows.latest_entity_cui
                    when latest_rows.latest_updated_at > latest_terms_rows.latest_terms_updated_at then latest_rows.latest_entity_cui
                    when latest_rows.latest_updated_at < latest_terms_rows.latest_terms_updated_at then latest_terms_rows.latest_terms_entity_cui
                    else coalesce(latest_rows.latest_entity_cui, latest_terms_rows.latest_terms_entity_cui)
                  end as latest_entity_cui
                from base_users
                left join aggregated_users
                  on aggregated_users.user_id = base_users.user_id
                left join latest_rows
                  on latest_rows.user_id = base_users.user_id
                left join latest_terms_rows
                  on latest_terms_rows.user_id = base_users.user_id
              ),
              filtered_aggregated_user_rows as (
                select *
                from aggregated_user_rows
                where aggregated_user_rows.latest_updated_at is not null
              ),
              counted_user_rows as (
                select
                  filtered_aggregated_user_rows.*,
                  count(*) over ()::int as total_count
                from filtered_aggregated_user_rows
              )
              select
                aggregated_user_rows.user_id,
                aggregated_user_rows.interaction_count,
                aggregated_user_rows.pending_review_count,
                aggregated_user_rows.latest_updated_at,
                aggregated_user_rows.latest_interaction_id,
                aggregated_user_rows.latest_entity_cui,
                aggregated_user_rows.total_count
              from counted_user_rows as aggregated_user_rows
              where true
                ${cursorFilterSql}
              ${orderBySql}
              limit ${input.limit + 1}
            `.execute(this.db)
          : await sql<CampaignAdminUserAggregateQueryRow>`
              with accepted_terms_rows as (
                select
                  user_id,
                  record_key,
                  updated_at,
                  row_number() over (
                    partition by user_id
                    order by updated_at desc, record_key asc
                  ) as latest_row_number
                from userinteractions
                where record_key like ${`${escapeLikePattern(termsAcceptedRecordKeyPrefix)}%`} escape '\\'
                  and nullif(btrim(record->'value'->'json'->'value'->>'entityCui'), '') = ${input.entityCui}
                  ${queryFilterSql}
              ),
              accepted_terms_users as (
                select distinct user_id
                from accepted_terms_rows
              ),
              latest_terms_rows as (
                select
                  user_id,
                  updated_at as latest_terms_updated_at
                from accepted_terms_rows
                where latest_row_number = 1
              ),
              interaction_rows as (
                select
                  user_id,
                  record_key,
                  updated_at,
                  record->>'interactionId' as interaction_id,
                  case
                    when (${reviewableInteractionsSql}) and record->'review'->>'status' is not null then record->'review'->>'status'
                    when (${reviewableInteractionsSql}) and record->>'phase' = 'pending' then 'pending'
                    else null
                  end as review_status
                from userinteractions
                where record->'scope'->>'type' = 'entity'
                  and nullif(btrim(record->'scope'->>'entityCui'), '') = ${input.entityCui}
                  and (${visibleInteractionsSql})
                  ${queryFilterSql}
              ),
              ranked_interaction_rows as (
                select
                  user_id,
                  record_key,
                  updated_at,
                  interaction_id,
                  review_status,
                  row_number() over (
                    partition by user_id
                    order by updated_at desc, record_key asc
                  ) as latest_row_number
                from interaction_rows
              ),
              interaction_aggregate as (
                select
                  user_id,
                  count(*)::int as interaction_count,
                  count(*) filter (where review_status = 'pending')::int as pending_review_count
                from ranked_interaction_rows
                group by user_id
              ),
              latest_interaction_rows as (
                select
                  user_id,
                  updated_at as latest_updated_at,
                  interaction_id as latest_interaction_id
                from ranked_interaction_rows
                where latest_row_number = 1
              ),
              base_users as (
                select user_id from accepted_terms_users
              ),
              aggregated_user_rows as (
                select
                  base_users.user_id,
                  coalesce(interaction_aggregate.interaction_count, 0)::int as interaction_count,
                  coalesce(interaction_aggregate.pending_review_count, 0)::int as pending_review_count,
                  case
                    when latest_interaction_rows.latest_updated_at is null then latest_terms_rows.latest_terms_updated_at
                    when latest_terms_rows.latest_terms_updated_at is null then latest_interaction_rows.latest_updated_at
                    else greatest(
                      latest_interaction_rows.latest_updated_at,
                      latest_terms_rows.latest_terms_updated_at
                    )
                  end as latest_updated_at,
                  latest_interaction_rows.latest_interaction_id,
                  ${input.entityCui}::text as latest_entity_cui
                from base_users
                left join interaction_aggregate
                  on interaction_aggregate.user_id = base_users.user_id
                left join latest_interaction_rows
                  on latest_interaction_rows.user_id = base_users.user_id
                left join latest_terms_rows
                  on latest_terms_rows.user_id = base_users.user_id
              ),
              filtered_aggregated_user_rows as (
                select *
                from aggregated_user_rows
                where aggregated_user_rows.latest_updated_at is not null
              ),
              counted_user_rows as (
                select
                  filtered_aggregated_user_rows.*,
                  count(*) over ()::int as total_count
                from filtered_aggregated_user_rows
              )
              select
                aggregated_user_rows.user_id,
                aggregated_user_rows.interaction_count,
                aggregated_user_rows.pending_review_count,
                aggregated_user_rows.latest_updated_at,
                aggregated_user_rows.latest_interaction_id,
                aggregated_user_rows.latest_entity_cui,
                aggregated_user_rows.total_count
              from counted_user_rows as aggregated_user_rows
              where true
                ${cursorFilterSql}
              ${orderBySql}
              limit ${input.limit + 1}
            `.execute(this.db);

      const hasMore = result.rows.length > input.limit;
      const pageRows = result.rows.slice(0, input.limit);
      const totalCount = pageRows[0]?.total_count ?? 0;
      const items = pageRows.map(
        (row): CampaignAdminUserRow => ({
          userId: row.user_id,
          interactionCount: row.interaction_count,
          pendingReviewCount: row.pending_review_count,
          latestUpdatedAt: toIsoString(row.latest_updated_at),
          latestInteractionId: row.latest_interaction_id,
          latestEntityCui: row.latest_entity_cui,
        })
      );
      const lastItem = items.at(-1);

      return ok({
        items,
        totalCount,
        hasMore,
        nextCursor:
          hasMore && lastItem !== undefined
            ? {
                sortBy: input.sortBy,
                sortOrder: input.sortOrder,
                userId: lastItem.userId,
                value: getCampaignAdminUserCursorValue(lastItem, input.sortBy),
              }
            : null,
      });
    } catch (error) {
      this.log.error({ err: error, input }, 'Failed to list campaign-admin users');
      return err(createDatabaseError('Failed to list campaign-admin users', error));
    }
  }

  async getCampaignAdminUsersMetaCounts(
    input: GetCampaignAdminUsersMetaCountsInput
  ): Promise<Result<CampaignAdminUsersMetaCounts, LearningProgressError>> {
    const termsAcceptedRecordKeyPrefix = getCampaignTermsAcceptedRecordKeyPrefix(input.campaignKey);

    const visibleInteractionsSql = buildCampaignAdminInteractionFiltersSql(input.interactions);
    const reviewableInteractionsSql = buildCampaignAdminInteractionFiltersSql(
      input.reviewableInteractions
    );

    try {
      const result = await sql<CampaignAdminUserMetaCountsQueryRow>`
        with accepted_terms_users as (
          select distinct user_id
          from userinteractions
          where record_key like ${`${escapeLikePattern(termsAcceptedRecordKeyPrefix)}%`} escape '\\'
        ),
        filtered_items as (
          select
            user_id,
            case
              when (${reviewableInteractionsSql}) and record->'review'->>'status' is not null then record->'review'->>'status'
              when (${reviewableInteractionsSql}) and record->>'phase' = 'pending' then 'pending'
              else null
            end as review_status
          from userinteractions
          where (${visibleInteractionsSql})
        ),
        aggregated_interactions as (
          select
            user_id,
            count(*) filter (where review_status = 'pending')::int as pending_review_count
          from filtered_items
          group by user_id
        ),
        base_users as (
          select user_id from accepted_terms_users
          union
          select user_id from aggregated_interactions
        )
        select
          count(*)::int as total_users,
          count(*) filter (where coalesce(aggregated_interactions.pending_review_count, 0) > 0)::int as users_with_pending_reviews
        from base_users
        left join aggregated_interactions
          on aggregated_interactions.user_id = base_users.user_id
      `.execute(this.db);

      const row = result.rows[0];
      return ok({
        totalUsers: row?.total_users ?? 0,
        usersWithPendingReviews: row?.users_with_pending_reviews ?? 0,
      });
    } catch (error) {
      this.log.error({ err: error, input }, 'Failed to get campaign-admin user meta counts');
      return err(createDatabaseError('Failed to get campaign-admin user meta counts', error));
    }
  }

  async getCampaignAdminStats(
    input: GetCampaignAdminStatsInput
  ): Promise<Result<GetCampaignAdminStatsOutput, LearningProgressError>> {
    if (input.interactions.length === 0) {
      return ok({
        stats: createEmptyCampaignAdminStatsBase(),
        riskFlagCandidates: [],
      });
    }

    const campaignAdminItemsCteSql = buildCampaignAdminItemsCteSql(input);

    try {
      const statsResult = await sql<CampaignAdminStatsAggregateQueryRow>`
        ${campaignAdminItemsCteSql}
        select
          count(*)::int as total,
          count(*) filter (where thread_phase is not null)::int as with_institution_thread,
          count(*) filter (where review_status = 'pending')::int as review_status_pending,
          count(*) filter (where review_status = 'approved')::int as review_status_approved,
          count(*) filter (where review_status = 'rejected')::int as review_status_rejected,
          count(*) filter (where review_status is null)::int as review_status_not_reviewed,
          count(*) filter (where phase = 'idle')::int as phase_idle,
          count(*) filter (where phase = 'draft')::int as phase_draft,
          count(*) filter (where phase = 'pending')::int as phase_pending,
          count(*) filter (where phase = 'resolved')::int as phase_resolved,
          count(*) filter (where phase = 'failed')::int as phase_failed,
          count(*) filter (where thread_phase = 'sending')::int as thread_phase_sending,
          count(*) filter (where thread_phase = 'awaiting_reply')::int as thread_phase_awaiting_reply,
          count(*) filter (where thread_phase = 'reply_received_unreviewed')::int as thread_phase_reply_received_unreviewed,
          count(*) filter (where thread_phase = 'manual_follow_up_needed')::int as thread_phase_manual_follow_up_needed,
          count(*) filter (where thread_phase = 'resolved_positive')::int as thread_phase_resolved_positive,
          count(*) filter (where thread_phase = 'resolved_negative')::int as thread_phase_resolved_negative,
          count(*) filter (where thread_phase = 'closed_no_response')::int as thread_phase_closed_no_response,
          count(*) filter (where thread_phase = 'failed')::int as thread_phase_failed,
          count(*) filter (where thread_phase is null)::int as thread_phase_none
        from campaign_admin_items
      `.execute(this.db);

      const riskCandidateResult = await sql<CampaignAdminRiskFlagCandidateQueryRow>`
        ${campaignAdminItemsCteSql}
        select
          interaction_id,
          entity_cui,
          institution_email,
          thread_phase,
          count(*)::int as item_count
        from campaign_admin_items
        group by interaction_id, entity_cui, institution_email, thread_phase
      `.execute(this.db);

      const statsRow = statsResult.rows[0];
      if (statsRow === undefined) {
        return ok({
          stats: createEmptyCampaignAdminStatsBase(),
          riskFlagCandidates: [],
        });
      }

      return ok({
        stats: {
          total: statsRow.total,
          withInstitutionThread: statsRow.with_institution_thread,
          reviewStatusCounts: {
            pending: statsRow.review_status_pending,
            approved: statsRow.review_status_approved,
            rejected: statsRow.review_status_rejected,
            notReviewed: statsRow.review_status_not_reviewed,
          },
          phaseCounts: {
            idle: statsRow.phase_idle,
            draft: statsRow.phase_draft,
            pending: statsRow.phase_pending,
            resolved: statsRow.phase_resolved,
            failed: statsRow.phase_failed,
          },
          threadPhaseCounts: {
            sending: statsRow.thread_phase_sending,
            awaiting_reply: statsRow.thread_phase_awaiting_reply,
            reply_received_unreviewed: statsRow.thread_phase_reply_received_unreviewed,
            manual_follow_up_needed: statsRow.thread_phase_manual_follow_up_needed,
            resolved_positive: statsRow.thread_phase_resolved_positive,
            resolved_negative: statsRow.thread_phase_resolved_negative,
            closed_no_response: statsRow.thread_phase_closed_no_response,
            failed: statsRow.thread_phase_failed,
            none: statsRow.thread_phase_none,
          },
        },
        riskFlagCandidates: riskCandidateResult.rows.map(
          (row): CampaignAdminRiskFlagCandidate => ({
            interactionId: row.interaction_id,
            entityCui: row.entity_cui,
            institutionEmail: row.institution_email,
            threadPhase: row.thread_phase,
            count: row.item_count,
          })
        ),
      });
    } catch (error) {
      this.log.error({ err: error, input }, 'Failed to load campaign-admin interaction stats');
      return err(createDatabaseError('Failed to load campaign-admin interaction stats', error));
    }
  }

  async upsertInteractiveRecord(
    input: UpsertInteractiveRecordInput
  ): Promise<Result<UpsertInteractiveRecordResult, LearningProgressError>> {
    try {
      if (!this.transactionScoped) {
        return await this.withTransaction((transactionalRepo) =>
          transactionalRepo.upsertInteractiveRecord(input)
        );
      }

      return await this.doUpsertInteractiveRecord(input);
    } catch (error) {
      this.log.error(
        { err: error, userId: input.userId, recordKey: input.record.key },
        'Failed to upsert learning progress record'
      );
      return err(createDatabaseError('Failed to upsert learning progress record', error));
    }
  }

  async resetProgress(userId: string): Promise<Result<void, LearningProgressError>> {
    try {
      await this.db
        .deleteFrom(USER_INTERACTIONS_TABLE)
        .where('user_id', '=', userId)
        .where(
          sql<boolean>`record_key NOT LIKE ${`${escapeLikePattern(INTERNAL_NAMESPACE_PREFIX)}%`} ESCAPE '\\'`
        )
        .execute();
      return ok(undefined);
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to reset learning progress');
      return err(createDatabaseError('Failed to reset learning progress', error));
    }
  }

  async withTransaction<T>(
    callback: (repo: LearningProgressRepository) => Promise<Result<T, LearningProgressError>>
  ): Promise<Result<T, LearningProgressError>> {
    if (this.transactionScoped) {
      return callback(this);
    }

    try {
      const value = await this.db.transaction().execute(async (transaction) => {
        const transactionalRepo = new KyselyLearningProgressRepo({
          db: transaction,
          logger: this.log,
          transactionScoped: true,
        });
        const result = await callback(transactionalRepo);

        if (result.isErr()) {
          throw new LearningProgressTransactionRollbackError(result.error);
        }

        return result.value;
      });

      return ok(value);
    } catch (error) {
      if (error instanceof LearningProgressTransactionRollbackError) {
        return err(error.failure);
      }

      this.log.error({ err: error }, 'Failed to execute learning progress transaction');
      return err(createDatabaseError('Failed to execute learning progress transaction', error));
    }
  }

  private mapRow(row: QueryRow): LearningProgressRecordRow {
    return {
      userId: row.user_id,
      recordKey: row.record_key,
      record: normalizeRecordValueRow(row.record),
      auditEvents: row.audit_events.map(normalizeAuditEventRow).sort(sortAuditEvents),
      updatedSeq: row.updated_seq,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    };
  }

  private async doUpsertInteractiveRecord(
    input: UpsertInteractiveRecordInput
  ): Promise<Result<UpsertInteractiveRecordResult, LearningProgressError>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existingRow = await this.db
        .selectFrom(USER_INTERACTIONS_TABLE)
        .select(LEARNING_PROGRESS_ROW_COLUMNS)
        .where('user_id', '=', input.userId)
        .where('record_key', '=', input.record.key)
        .forUpdate()
        .executeTakeFirst();

      if (existingRow === undefined) {
        const updatedSeq = await this.allocateSequence();
        const rowTimestamp = new Date();
        const insertedRow = await this.db
          .insertInto(USER_INTERACTIONS_TABLE)
          .values({
            user_id: input.userId,
            record_key: input.record.key,
            record: sql`${JSON.stringify(input.record)}::jsonb`,
            audit_events: sql`${JSON.stringify(
              input.auditEvents.map(
                (auditEvent): StoredInteractiveAuditEvent => ({
                  ...auditEvent,
                  seq: updatedSeq,
                  sourceClientEventId: input.eventId,
                  sourceClientId: input.clientId,
                })
              )
            )}::jsonb`,
            updated_seq: sql`${updatedSeq}::bigint`,
            created_at: rowTimestamp,
            updated_at: rowTimestamp,
          } as never)
          .onConflict((conflict) => conflict.columns(['user_id', 'record_key']).doNothing())
          .returning(LEARNING_PROGRESS_ROW_COLUMNS)
          .executeTakeFirst();

        if (insertedRow !== undefined) {
          return ok({
            applied: true,
            row: this.mapRow(insertedRow as unknown as QueryRow),
          });
        }

        continue;
      }

      const existingRecord = this.mapRow(existingRow as unknown as QueryRow);
      const hasDuplicateAuditEvent =
        input.auditEvents.length > 0 &&
        existingRecord.auditEvents.some(
          (auditEvent) => auditEvent.sourceClientEventId === input.eventId
        );
      const hasDuplicateRecordOnlyUpdate =
        input.auditEvents.length === 0 && recordsAreEqual(existingRecord.record, input.record);
      const isIncomingRecordStale =
        compareTimestamps(input.record.updatedAt, existingRecord.record.updatedAt) < 0;
      const hasNewAuditEvents = input.auditEvents.length > 0 && !hasDuplicateAuditEvent;
      const shouldReplaceRecord = !hasDuplicateRecordOnlyUpdate && !isIncomingRecordStale;

      if (hasDuplicateAuditEvent || (!shouldReplaceRecord && !hasNewAuditEvents)) {
        return ok({
          applied: false,
          row: existingRecord,
        });
      }

      const updatedSeq = await this.allocateSequence();
      const nextAuditEvents = [
        ...existingRecord.auditEvents,
        ...input.auditEvents.map(
          (auditEvent): StoredInteractiveAuditEvent => ({
            ...auditEvent,
            seq: updatedSeq,
            sourceClientEventId: input.eventId,
            sourceClientId: input.clientId,
          })
        ),
      ].sort(sortAuditEvents);

      const nextRecord = shouldReplaceRecord ? input.record : existingRecord.record;
      const rowTimestamp = new Date();

      const updatedRow = await this.db
        .updateTable(USER_INTERACTIONS_TABLE)
        .set({
          record: sql`${JSON.stringify(nextRecord)}::jsonb`,
          audit_events: sql`${JSON.stringify(nextAuditEvents)}::jsonb`,
          updated_seq: sql`${updatedSeq}::bigint`,
          updated_at: rowTimestamp,
        } as never)
        .where('user_id', '=', input.userId)
        .where('record_key', '=', input.record.key)
        .returning(LEARNING_PROGRESS_ROW_COLUMNS)
        .executeTakeFirstOrThrow();

      return ok({
        applied: true,
        row: this.mapRow(updatedRow as unknown as QueryRow),
      });
    }

    throw new Error('Failed to upsert learning progress record after concurrent insert retry');
  }

  private async allocateSequence(): Promise<string> {
    const sequenceResult = await sql<{ updated_seq: string }>`
      select nextval('userinteractions_updated_seq')::text as updated_seq
    `.execute(this.db);

    const updatedSeq = sequenceResult.rows[0]?.updated_seq;
    if (updatedSeq === undefined) {
      throw new Error('Failed to allocate learning progress sequence value');
    }

    return updatedSeq;
  }
}

interface QueryRow {
  user_id: string;
  record_key: string;
  record: LearningProgressRecordValueRow;
  audit_events: LearningProgressAuditEventRow[];
  updated_seq: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CampaignAdminQueryRow extends QueryRow {
  thread_id: string | null;
  thread_phase: CampaignAdminInstitutionThreadSummary['threadPhase'] | null;
  thread_last_email_at: Date | string | null;
  thread_last_reply_at: Date | string | null;
  thread_next_action_at: Date | string | null;
}

interface CampaignAdminStatsAggregateQueryRow {
  total: number;
  with_institution_thread: number;
  review_status_pending: number;
  review_status_approved: number;
  review_status_rejected: number;
  review_status_not_reviewed: number;
  phase_idle: number;
  phase_draft: number;
  phase_pending: number;
  phase_resolved: number;
  phase_failed: number;
  thread_phase_sending: number;
  thread_phase_awaiting_reply: number;
  thread_phase_reply_received_unreviewed: number;
  thread_phase_manual_follow_up_needed: number;
  thread_phase_resolved_positive: number;
  thread_phase_resolved_negative: number;
  thread_phase_closed_no_response: number;
  thread_phase_failed: number;
  thread_phase_none: number;
}

interface CampaignAdminUserAggregateQueryRow {
  user_id: string;
  interaction_count: number;
  pending_review_count: number;
  latest_updated_at: Date | string;
  latest_interaction_id: string | null;
  latest_entity_cui: string | null;
  total_count: number;
}

interface CampaignAdminUserMetaCountsQueryRow {
  total_users: number;
  users_with_pending_reviews: number;
}

interface CampaignAdminRiskFlagCandidateQueryRow {
  interaction_id: string;
  entity_cui: string | null;
  institution_email: string | null;
  thread_phase: CampaignAdminInstitutionThreadSummary['threadPhase'] | null;
  item_count: number;
}

export const makeLearningProgressRepo = (
  options: LearningProgressRepoOptions
): LearningProgressRepository => {
  return new KyselyLearningProgressRepo(options);
};
