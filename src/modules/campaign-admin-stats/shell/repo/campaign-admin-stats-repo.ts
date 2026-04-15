import { sql } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_CAMPAIGN_KEY,
  FUNKY_OUTBOX_ADMIN_FAILURE_TYPE,
  FUNKY_OUTBOX_ADMIN_REVIEWED_INTERACTION_TYPE,
  FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE,
  FUNKY_OUTBOX_ENTITY_UPDATE_TYPE,
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
  CampaignAdminStatsOverview,
  GetCampaignAdminStatsOverviewInput,
} from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { CampaignAdminEntitiesRepository } from '@/modules/campaign-admin-entities/index.js';
import type { Logger } from 'pino';

const QUERY_TIMEOUT_MS = 10_000;
const SUPPORTED_CAMPAIGN_KEYS = new Set<string>([FUNKY_CAMPAIGN_KEY]);
const AUDIT_NOTIFICATION_TYPES = [
  FUNKY_OUTBOX_WELCOME_TYPE,
  FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE,
  FUNKY_OUTBOX_ENTITY_UPDATE_TYPE,
  FUNKY_OUTBOX_ADMIN_FAILURE_TYPE,
  FUNKY_OUTBOX_ADMIN_REVIEWED_INTERACTION_TYPE,
] as const;
const PENDING_DELIVERY_STATUSES = ['pending', 'composing', 'sending'] as const;
const FAILED_DELIVERY_STATUSES = [
  'webhook_timeout',
  'failed_transient',
  'failed_permanent',
] as const;

interface NotificationOverviewCountsRow {
  pending_delivery_count: string | number | bigint | null;
  failed_delivery_count: string | number | bigint | null;
  delivered_count: string | number | bigint | null;
  opened_count: string | number | bigint | null;
  clicked_count: string | number | bigint | null;
  suppressed_count: string | number | bigint | null;
}

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

  const visibleInteractions = buildCampaignInteractionFilters({
    interactions: selectCampaignAdminAuditVisibleInteractions({
      config,
      requiresInstitutionThreadSummary: false,
    }),
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
    visibleInteractions,
    reviewableInteractions,
    threadSummaryInteractions,
  };
};

class CampaignAdminStatsRepo implements CampaignAdminStatsReader {
  private readonly log: Logger;

  constructor(
    private readonly userDb: UserDbClient,
    private readonly learningProgressRepo: LearningProgressRepository,
    private readonly entitiesRepository: CampaignAdminEntitiesRepository,
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
  readonly logger: Logger;
}

export const makeCampaignAdminStatsReader = (
  options: CampaignAdminStatsRepoOptions
): CampaignAdminStatsReader => {
  return new CampaignAdminStatsRepo(
    options.userDb,
    options.learningProgressRepo,
    options.entitiesRepository,
    options.logger
  );
};
