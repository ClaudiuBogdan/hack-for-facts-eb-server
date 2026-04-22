import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_CAMPAIGN_KEY,
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_NOTIFICATION_GLOBAL_TYPE,
  FUNKY_OUTBOX_ADMIN_FAILURE_TYPE,
  FUNKY_OUTBOX_ADMIN_REVIEWED_INTERACTION_TYPE,
  FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE,
  FUNKY_OUTBOX_ENTITY_UPDATE_TYPE,
  FUNKY_OUTBOX_PUBLIC_DEBATE_ANNOUNCEMENT_TYPE,
  FUNKY_OUTBOX_WELCOME_TYPE,
} from '@/common/campaign-keys.js';
import { setStatementTimeout } from '@/infra/database/query-builders/index.js';
import {
  buildCampaignInteractionFilters,
  getCampaignAdminReviewConfig,
  selectCampaignAdminAuditVisibleInteractions,
  type LearningProgressRepository,
} from '@/modules/learning-progress/index.js';

import {
  createCampaignNotFoundError,
  createDatabaseError,
  type CampaignAdminStatsError,
} from '../../core/errors.js';

import type { CampaignAdminStatsReader } from '../../core/ports.js';
import type {
  CampaignAdminStatsCampaignKey,
  CampaignAdminStatsInteractionsByType,
  CampaignAdminStatsTopEntities,
  CampaignAdminStatsTopEntitiesSortBy,
  CampaignAdminStatsOverview,
  GetCampaignAdminStatsInteractionsByTypeInput,
  GetCampaignAdminStatsOverviewInput,
  GetCampaignAdminStatsTopEntitiesInput,
} from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { CampaignAdminEntitiesRepository } from '@/modules/campaign-admin-entities/index.js';
import type { EntityRepository } from '@/modules/entity/index.js';
import type { Logger } from 'pino';

const QUERY_TIMEOUT_MS = 10_000;
const SUPPORTED_CAMPAIGN_KEYS = new Set<string>([FUNKY_CAMPAIGN_KEY]);
const AUDIT_NOTIFICATION_TYPES = [
  FUNKY_OUTBOX_WELCOME_TYPE,
  FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE,
  FUNKY_OUTBOX_ENTITY_UPDATE_TYPE,
  FUNKY_OUTBOX_ADMIN_FAILURE_TYPE,
  FUNKY_OUTBOX_ADMIN_REVIEWED_INTERACTION_TYPE,
  FUNKY_OUTBOX_PUBLIC_DEBATE_ANNOUNCEMENT_TYPE,
] as const;
const PENDING_DELIVERY_STATUSES = ['pending', 'composing', 'sending'] as const;
const FAILED_DELIVERY_STATUSES = [
  'webhook_timeout',
  'failed_transient',
  'failed_permanent',
] as const;
const GLOBAL_UNSUBSCRIBE_TYPE = 'global_unsubscribe' as const;

interface NotificationOverviewCountsRow {
  pending_delivery_count: string | number | bigint | null;
  failed_delivery_count: string | number | bigint | null;
  delivered_count: string | number | bigint | null;
  opened_count: string | number | bigint | null;
  clicked_count: string | number | bigint | null;
  suppressed_count: string | number | bigint | null;
}

interface InteractionsByTypeRow {
  interaction_id: string;
  total: string | number | bigint | null;
  pending: string | number | bigint | null;
  approved: string | number | bigint | null;
  rejected: string | number | bigint | null;
  not_reviewed: string | number | bigint | null;
}

interface TopEntityRow {
  entity_cui: string;
  interaction_count: string | number | bigint | null;
  user_count: string | number | bigint | null;
  pending_review_count: string | number | bigint | null;
}

const toNullableTrimmedString = (value: string | null | undefined): string | null => {
  const trimmedValue = value?.trim();
  return trimmedValue === undefined || trimmedValue === '' ? null : trimmedValue;
};

const parseCount = (value: string | number | bigint | null | undefined): number => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  if (typeof value === 'bigint') {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : 0;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }

  return 0;
};

const buildInteractionFilters = (campaignKey: CampaignAdminStatsCampaignKey) => {
  const config = getCampaignAdminReviewConfig(campaignKey);
  if (config === null) {
    return null;
  }

  const visibleInteractionConfigs = selectCampaignAdminAuditVisibleInteractions({
    config,
    requiresInstitutionThreadSummary: false,
  });

  const visibleInteractions = buildCampaignInteractionFilters({
    interactions: visibleInteractionConfigs,
    kind: 'visible',
  });
  const reviewableInteractions = buildCampaignInteractionFilters({
    interactions: config.interactions,
    kind: 'reviewable',
  });
  const threadSummaryInteractions = buildCampaignInteractionFilters({
    interactions: selectCampaignAdminAuditVisibleInteractions({
      config,
      requiresInstitutionThreadSummary: true,
    }),
    kind: 'thread_summary',
  });

  return {
    visibleInteractionConfigs,
    visibleInteractions,
    reviewableInteractions,
    threadSummaryInteractions,
  };
};

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

async function loadEntityNameMap(input: {
  readonly entityRepo: EntityRepository;
  readonly entityCuis: readonly string[];
  readonly logger: Logger;
}): Promise<Map<string, string | null>> {
  if (input.entityCuis.length === 0) {
    return new Map();
  }

  const entitiesResult = await input.entityRepo.getByIds([...input.entityCuis]);
  if (entitiesResult.isErr()) {
    input.logger.warn(
      { error: entitiesResult.error, entityCuis: input.entityCuis },
      'Failed to load entity names for campaign admin stats top entities'
    );
    return new Map();
  }

  return new Map(
    input.entityCuis.map((entityCui) => [
      entityCui,
      toNullableTrimmedString(entitiesResult.value.get(entityCui)?.name ?? null),
    ])
  );
}

function buildTopEntitiesOrderBySql(sortBy: CampaignAdminStatsTopEntitiesSortBy) {
  switch (sortBy) {
    case 'userCount':
      return sql`order by user_count desc, entity_cui asc`;
    case 'pendingReviewCount':
      return sql`order by pending_review_count desc, entity_cui asc`;
    case 'interactionCount':
    default:
      return sql`order by interaction_count desc, entity_cui asc`;
  }
}

class CampaignAdminStatsRepo implements CampaignAdminStatsReader {
  private readonly log: Logger;

  constructor(
    private readonly userDb: UserDbClient,
    private readonly learningProgressRepo: LearningProgressRepository,
    private readonly entitiesRepository: CampaignAdminEntitiesRepository,
    private readonly entityRepo: EntityRepository,
    logger: Logger
  ) {
    this.log = logger.child({ repo: 'CampaignAdminStatsRepo' });
  }

  async getOverview(
    input: GetCampaignAdminStatsOverviewInput
  ): Promise<Result<CampaignAdminStatsOverview, CampaignAdminStatsError>> {
    if (!SUPPORTED_CAMPAIGN_KEYS.has(input.campaignKey)) {
      return err(createCampaignNotFoundError(input.campaignKey));
    }

    const filters = buildInteractionFilters(input.campaignKey);
    if (filters === null) {
      return err(createCampaignNotFoundError(input.campaignKey));
    }

    try {
      const [usersResult, interactionsResult, entitiesResult, notificationCountsResult] =
        await Promise.all([
          this.learningProgressRepo.getCampaignAdminUsersMetaCounts({
            campaignKey: input.campaignKey,
            interactions: filters.visibleInteractions,
            reviewableInteractions: filters.reviewableInteractions,
          }),
          this.learningProgressRepo.getCampaignAdminStats({
            campaignKey: input.campaignKey,
            interactions: filters.visibleInteractions,
            reviewableInteractions: filters.reviewableInteractions,
            threadSummaryInteractions: filters.threadSummaryInteractions,
          }),
          this.entitiesRepository.getCampaignAdminEntitiesMetaCounts({
            campaignKey: input.campaignKey,
            interactions: filters.visibleInteractions,
            reviewableInteractions: filters.reviewableInteractions,
          }),
          this.getNotificationOverviewCounts(input.campaignKey),
        ]);

      if (usersResult.isErr()) {
        return err(createDatabaseError(usersResult.error.message, usersResult.error));
      }

      if (interactionsResult.isErr()) {
        return err(createDatabaseError(interactionsResult.error.message, interactionsResult.error));
      }

      if (entitiesResult.isErr()) {
        return err(createDatabaseError(entitiesResult.error.message, entitiesResult.error));
      }

      if (notificationCountsResult.isErr()) {
        return err(notificationCountsResult.error);
      }

      return ok({
        coverage: {
          hasClientTelemetry: false,
          hasNotificationAttribution: true,
        },
        users: {
          totalUsers: usersResult.value.totalUsers,
          usersWithPendingReviews: usersResult.value.usersWithPendingReviews,
        },
        interactions: {
          totalInteractions: interactionsResult.value.stats.total,
          interactionsWithInstitutionThread: interactionsResult.value.stats.withInstitutionThread,
          reviewStatusCounts: {
            pending: interactionsResult.value.stats.reviewStatusCounts.pending,
            approved: interactionsResult.value.stats.reviewStatusCounts.approved,
            rejected: interactionsResult.value.stats.reviewStatusCounts.rejected,
            notReviewed: interactionsResult.value.stats.reviewStatusCounts.notReviewed,
          },
          phaseCounts: {
            idle: interactionsResult.value.stats.phaseCounts.idle,
            draft: interactionsResult.value.stats.phaseCounts.draft,
            pending: interactionsResult.value.stats.phaseCounts.pending,
            resolved: interactionsResult.value.stats.phaseCounts.resolved,
            failed: interactionsResult.value.stats.phaseCounts.failed,
          },
          threadPhaseCounts: {
            sending: interactionsResult.value.stats.threadPhaseCounts.sending,
            awaitingReply: interactionsResult.value.stats.threadPhaseCounts.awaiting_reply,
            replyReceivedUnreviewed:
              interactionsResult.value.stats.threadPhaseCounts.reply_received_unreviewed,
            manualFollowUpNeeded:
              interactionsResult.value.stats.threadPhaseCounts.manual_follow_up_needed,
            resolvedPositive: interactionsResult.value.stats.threadPhaseCounts.resolved_positive,
            resolvedNegative: interactionsResult.value.stats.threadPhaseCounts.resolved_negative,
            closedNoResponse: interactionsResult.value.stats.threadPhaseCounts.closed_no_response,
            failed: interactionsResult.value.stats.threadPhaseCounts.failed,
            none: interactionsResult.value.stats.threadPhaseCounts.none,
          },
        },
        entities: {
          totalEntities: entitiesResult.value.totalEntities,
          entitiesWithPendingReviews: entitiesResult.value.entitiesWithPendingReviews,
          entitiesWithSubscribers: entitiesResult.value.entitiesWithSubscribers,
          entitiesWithNotificationActivity: entitiesResult.value.entitiesWithNotificationActivity,
          entitiesWithFailedNotifications: entitiesResult.value.entitiesWithFailedNotifications,
        },
        notifications: notificationCountsResult.value,
      });
    } catch (error) {
      this.log.error({ err: error, input }, 'Failed to load campaign admin stats overview');
      return err(createDatabaseError('Failed to load campaign admin stats overview', error));
    }
  }

  async getInteractionsByType(
    input: GetCampaignAdminStatsInteractionsByTypeInput
  ): Promise<Result<CampaignAdminStatsInteractionsByType, CampaignAdminStatsError>> {
    if (!SUPPORTED_CAMPAIGN_KEYS.has(input.campaignKey)) {
      return err(createCampaignNotFoundError(input.campaignKey));
    }

    const filters = buildInteractionFilters(input.campaignKey);
    if (filters === null) {
      return err(createCampaignNotFoundError(input.campaignKey));
    }

    const visibleInteractionsSql = buildCampaignAdminInteractionFiltersSql(
      filters.visibleInteractions
    );
    const reviewableInteractionsSql = buildCampaignAdminInteractionFiltersSql(
      filters.reviewableInteractions
    );
    const labelByInteractionId = new Map(
      filters.visibleInteractionConfigs.map((interaction) => [
        interaction.interactionId,
        interaction.label,
      ])
    );

    try {
      const result = await this.userDb.transaction().execute(async (trx) => {
        await setStatementTimeout(trx, QUERY_TIMEOUT_MS);

        return sql<InteractionsByTypeRow>`
          with interaction_rows as (
            select
              record->>'interactionId' as interaction_id,
              case
                when (${reviewableInteractionsSql}) and record->'review'->>'status' is not null then record->'review'->>'status'
                when (${reviewableInteractionsSql}) and record->>'phase' = 'pending' then 'pending'
                else null
              end as review_status
            from userinteractions
            where (${visibleInteractionsSql})
          )
          select
            interaction_id,
            count(*)::int as total,
            count(*) filter (where review_status = 'pending')::int as pending,
            count(*) filter (where review_status = 'approved')::int as approved,
            count(*) filter (where review_status = 'rejected')::int as rejected,
            count(*) filter (where review_status is null)::int as not_reviewed
          from interaction_rows
          group by interaction_id
          order by total desc, interaction_id asc
        `.execute(trx);
      });

      return ok({
        items: result.rows.map((row) => ({
          interactionId: row.interaction_id,
          label: labelByInteractionId.get(row.interaction_id) ?? null,
          total: parseCount(row.total),
          pending: parseCount(row.pending),
          approved: parseCount(row.approved),
          rejected: parseCount(row.rejected),
          notReviewed: parseCount(row.not_reviewed),
        })),
      });
    } catch (error) {
      this.log.error(
        { err: error, input },
        'Failed to load campaign admin stats interactions by type'
      );
      return err(
        createDatabaseError('Failed to load campaign admin stats interactions by type', error)
      );
    }
  }

  async getTopEntities(
    input: GetCampaignAdminStatsTopEntitiesInput
  ): Promise<Result<CampaignAdminStatsTopEntities, CampaignAdminStatsError>> {
    if (!SUPPORTED_CAMPAIGN_KEYS.has(input.campaignKey)) {
      return err(createCampaignNotFoundError(input.campaignKey));
    }

    const filters = buildInteractionFilters(input.campaignKey);
    if (filters === null) {
      return err(createCampaignNotFoundError(input.campaignKey));
    }

    const visibleInteractionsSql = buildCampaignAdminInteractionFiltersSql(
      filters.visibleInteractions
    );
    const reviewableInteractionsSql = buildCampaignAdminInteractionFiltersSql(
      filters.reviewableInteractions
    );

    try {
      const result = await this.userDb.transaction().execute(async (trx) => {
        await setStatementTimeout(trx, QUERY_TIMEOUT_MS);

        return sql<TopEntityRow>`
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
          ),
          interaction_users as (
            select distinct entity_cui, user_id
            from interaction_rows
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
          ),
          interaction_aggregate as (
            select
              entity_cui,
              count(*)::int as interaction_count,
              count(*) filter (where review_status = 'pending')::int as pending_review_count
            from interaction_rows
            group by entity_cui
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
            select entity_cui from user_count_aggregate
          )
          select
            base_entities.entity_cui,
            coalesce(interaction_aggregate.interaction_count, 0)::int as interaction_count,
            coalesce(user_count_aggregate.user_count, 0)::int as user_count,
            coalesce(interaction_aggregate.pending_review_count, 0)::int as pending_review_count
          from base_entities
          left join interaction_aggregate
            on interaction_aggregate.entity_cui = base_entities.entity_cui
          left join user_count_aggregate
            on user_count_aggregate.entity_cui = base_entities.entity_cui
          ${buildTopEntitiesOrderBySql(input.sortBy)}
          limit ${input.limit}
        `.execute(trx);
      });

      const entityNameMap = await loadEntityNameMap({
        entityRepo: this.entityRepo,
        entityCuis: result.rows.map((row) => row.entity_cui),
        logger: this.log,
      });

      return ok({
        sortBy: input.sortBy,
        limit: input.limit,
        items: result.rows.map((row) => ({
          entityCui: row.entity_cui,
          entityName: entityNameMap.get(row.entity_cui) ?? null,
          interactionCount: parseCount(row.interaction_count),
          userCount: parseCount(row.user_count),
          pendingReviewCount: parseCount(row.pending_review_count),
        })),
      });
    } catch (error) {
      this.log.error({ err: error, input }, 'Failed to load campaign admin stats top entities');
      return err(createDatabaseError('Failed to load campaign admin stats top entities', error));
    }
  }

  private async getNotificationOverviewCounts(
    campaignKey: CampaignAdminStatsCampaignKey
  ): Promise<Result<CampaignAdminStatsOverview['notifications'], CampaignAdminStatsError>> {
    try {
      const result = await this.userDb.transaction().execute(async (trx) => {
        await setStatementTimeout(trx, QUERY_TIMEOUT_MS);

        return sql<NotificationOverviewCountsRow>`
          with relevant_outbox as (
            select
              outbox.id,
              outbox.status,
              outbox.resend_email_id
            from notificationsoutbox as outbox
            where outbox.notification_type in (${sql.join(
              AUDIT_NOTIFICATION_TYPES.map((value) => sql`${value}`)
            )})
              and outbox.metadata->>'campaignKey' = ${campaignKey}
          ),
          delivery_engagement as (
            select
              outbox.id as outbox_id,
              bool_or(emails.event_type = 'email.delivered') as has_delivered,
              bool_or(emails.event_type = 'email.complained') as has_complained,
              bool_or(emails.event_type = 'email.opened') as has_opened,
              bool_or(emails.event_type = 'email.clicked') as has_clicked
            from relevant_outbox as outbox
            left join resend_wh_emails as emails
              on emails.email_id = outbox.resend_email_id
            group by outbox.id
          )
          select
            count(*) filter (where outbox.status in (${sql.join(
              PENDING_DELIVERY_STATUSES.map((value) => sql`${value}`)
            )}))::int as pending_delivery_count,
            count(*) filter (where outbox.status in (${sql.join(
              FAILED_DELIVERY_STATUSES.map((value) => sql`${value}`)
            )}))::int as failed_delivery_count,
            count(*) filter (
              where outbox.status = ${'delivered'}
                or coalesce(delivery_engagement.has_delivered, false)
                or coalesce(delivery_engagement.has_complained, false)
                or coalesce(delivery_engagement.has_opened, false)
                or coalesce(delivery_engagement.has_clicked, false)
            )::int as delivered_count,
            count(*) filter (where coalesce(delivery_engagement.has_opened, false))::int as opened_count,
            count(*) filter (where coalesce(delivery_engagement.has_clicked, false))::int as clicked_count,
            count(*) filter (where outbox.status = ${'suppressed'})::int as suppressed_count
          from relevant_outbox as outbox
          left join delivery_engagement
            on delivery_engagement.outbox_id = outbox.id
        `.execute(trx);
      });

      const row = result.rows[0];

      return ok({
        pendingDeliveryCount: parseCount(row?.pending_delivery_count),
        failedDeliveryCount: parseCount(row?.failed_delivery_count),
        deliveredCount: parseCount(row?.delivered_count),
        openedCount: parseCount(row?.opened_count),
        clickedCount: parseCount(row?.clicked_count),
        suppressedCount: parseCount(row?.suppressed_count),
      });
    } catch (error) {
      this.log.error(
        { err: error, campaignKey },
        'Failed to load campaign admin notification overview counts'
      );
      return err(
        createDatabaseError('Failed to load campaign notification overview counts', error)
      );
    }
  }
}

export interface CampaignAdminStatsRepoOptions {
  readonly userDb: UserDbClient;
  readonly learningProgressRepo: LearningProgressRepository;
  readonly entitiesRepository: CampaignAdminEntitiesRepository;
  readonly entityRepo: EntityRepository;
  readonly logger: Logger;
}

export const makeCampaignAdminStatsReader = (
  options: CampaignAdminStatsRepoOptions
): CampaignAdminStatsReader => {
  return new CampaignAdminStatsRepo(
    options.userDb,
    options.learningProgressRepo,
    options.entitiesRepository,
    options.entityRepo,
    options.logger
  );
};
