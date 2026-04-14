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
import { parseDbTimestamp } from '@/common/utils/parse-db-timestamp.js';
import { parseAdminReviewedInteractionOutboxMetadata } from '@/modules/notification-delivery/index.js';

import {
  createDatabaseError,
  createValidationError,
  type CampaignAdminNotificationError,
} from '../../core/errors.js';

import type { CampaignNotificationAuditRepository } from '../../core/ports.js';
import type {
  CampaignNotificationAdminCampaignKey,
  CampaignNotificationAuditCursor,
  CampaignNotificationAuditItem,
  CampaignNotificationAuditSortBy,
  CampaignNotificationAuditSortOrder,
  CampaignNotificationMetaCounts,
  CampaignNotificationProjection,
  CampaignNotificationSafeError,
  CampaignNotificationTriggerSource,
  ListCampaignNotificationAuditInput,
  ListCampaignNotificationAuditOutput,
} from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

interface OutboxAuditRepoDeps {
  db: UserDbClient;
  logger: Logger;
}

interface QueryRow {
  id: string;
  userId: string;
  notificationType: string;
  templateName: string | null;
  templateVersion: string | null;
  status: string;
  attemptCount: number;
  createdAt: unknown;
  sentAt: unknown;
  lastAttemptAt: unknown;
  lastError: string | null;
  entityCui: string | null;
  entityName: string | null;
  acceptedTermsAt: string | null;
  selectedEntitiesCount: number | null;
  threadId: string | null;
  threadKey: string | null;
  eventType: string | null;
  phase: string | null;
  replyEntryId: string | null;
  basedOnEntryId: string | null;
  resolutionCode: string | null;
  triggerSource: string | null;
  recordKey: string | null;
  interactionId: string | null;
  interactionLabel: string | null;
  reviewStatus: 'approved' | 'rejected' | null;
  reviewedAt: string | null;
  feedbackText: string | null;
  nextStepCount: number | null;
  metadata: unknown;
}

interface MetaCountsRow {
  pending_delivery_count: string | number | bigint;
  failed_delivery_count: string | number | bigint;
  reply_received_count: string | number | bigint;
}

const FUNKY_AUDIT_NOTIFICATION_TYPES = [
  FUNKY_OUTBOX_WELCOME_TYPE,
  FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE,
  FUNKY_OUTBOX_ENTITY_UPDATE_TYPE,
  FUNKY_OUTBOX_ADMIN_FAILURE_TYPE,
  FUNKY_OUTBOX_ADMIN_REVIEWED_INTERACTION_TYPE,
] as const;
const FUNKY_AUDIT_NOTIFICATION_TYPE_SET = new Set<string>(FUNKY_AUDIT_NOTIFICATION_TYPES);
const PENDING_DELIVERY_STATUSES = ['pending', 'composing', 'sending'] as const;
const FAILED_DELIVERY_STATUSES = [
  'webhook_timeout',
  'failed_transient',
  'failed_permanent',
] as const;
const MAX_SAFE_INTEGER_AS_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const parseMetaCountValue = (
  value: string | number | bigint,
  fieldName: keyof MetaCountsRow
): Result<number, CampaignAdminNotificationError> => {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      return ok(value);
    }

    return err(createDatabaseError(`Invalid notification meta count for ${fieldName}.`, false));
  }

  if (typeof value === 'bigint') {
    if (value >= 0n && value <= MAX_SAFE_INTEGER_AS_BIGINT) {
      return ok(Number(value));
    }

    return err(createDatabaseError(`Invalid notification meta count for ${fieldName}.`, false));
  }

  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return ok(parsed);
    }
  }

  return err(createDatabaseError(`Invalid notification meta count for ${fieldName}.`, false));
};

const buildTriggerSourceExpression = () => sql<string | null>`
  coalesce(
    outbox.metadata->>'triggerSource',
    case
      when outbox.metadata->>'source' = ${'funky:source:terms_accepted'} then ${'user_event_worker'}
      else null
    end
  )
`;

const mapSafeError = (status: string, lastError: string | null): CampaignNotificationSafeError => {
  if (status === 'skipped_unsubscribed') {
    return { category: 'skipped_unsubscribed', code: 'unsubscribed' };
  }

  if (status === 'skipped_no_email') {
    return { category: 'skipped_no_email', code: 'no_email' };
  }

  if (status === 'suppressed') {
    return { category: 'suppressed', code: 'suppressed' };
  }

  if (status === 'webhook_timeout') {
    return { category: 'webhook_timeout', code: 'webhook_timeout' };
  }

  if (lastError === null || lastError.trim() === '') {
    return { category: null, code: null };
  }

  if (lastError.startsWith('RENDER_ERROR:')) {
    return { category: 'render_error', code: 'render_error' };
  }

  if (
    lastError.startsWith('Invalid ') ||
    lastError === 'Missing rendered content' ||
    lastError === 'No renderable bundle items'
  ) {
    return { category: 'compose_validation', code: 'compose_validation' };
  }

  if (
    lastError.includes('No verified primary email') ||
    lastError.includes('Clerk') ||
    lastError.includes('user email')
  ) {
    return { category: 'email_lookup', code: 'user_email_lookup' };
  }

  if (lastError.startsWith('bounced:')) {
    const bounceCode = lastError.slice('bounced:'.length).trim();
    return {
      category: 'provider_bounce',
      code: bounceCode === '' ? 'unknown_bounce' : bounceCode,
    };
  }

  if (lastError.startsWith('email.suppressed:')) {
    const suppressionCode = lastError.slice('email.suppressed:'.length).trim();
    return {
      category: 'provider_suppressed',
      code: suppressionCode === '' ? 'provider_suppressed' : suppressionCode,
    };
  }

  if (status === 'failed_transient') {
    return { category: 'send_retryable', code: 'retryable_send_error' };
  }

  if (status === 'failed_permanent') {
    return { category: 'send_permanent', code: 'permanent_send_error' };
  }

  return { category: 'unknown', code: 'unknown' };
};

const mapProjection = (row: QueryRow): CampaignNotificationProjection => {
  if (row.notificationType === FUNKY_OUTBOX_WELCOME_TYPE) {
    return {
      kind: 'public_debate_campaign_welcome',
      userId: row.userId,
      entityCui: row.entityCui ?? '',
      entityName: row.entityName,
      acceptedTermsAt: row.acceptedTermsAt,
      triggerSource: (row.triggerSource as CampaignNotificationTriggerSource | null) ?? null,
    };
  }

  if (row.notificationType === FUNKY_OUTBOX_ENTITY_SUBSCRIPTION_TYPE) {
    return {
      kind: 'public_debate_entity_subscription',
      userId: row.userId,
      entityCui: row.entityCui ?? '',
      entityName: row.entityName,
      acceptedTermsAt: row.acceptedTermsAt,
      selectedEntitiesCount: row.selectedEntitiesCount,
      triggerSource: (row.triggerSource as CampaignNotificationTriggerSource | null) ?? null,
    };
  }

  if (row.notificationType === FUNKY_OUTBOX_ENTITY_UPDATE_TYPE) {
    return {
      kind: 'public_debate_entity_update',
      userId: row.userId,
      entityCui: row.entityCui ?? '',
      entityName: row.entityName,
      threadId: row.threadId ?? '',
      threadKey: row.threadKey,
      eventType: row.eventType,
      phase: row.phase,
      replyEntryId: row.replyEntryId,
      basedOnEntryId: row.basedOnEntryId,
      resolutionCode: row.resolutionCode,
      triggerSource: (row.triggerSource as CampaignNotificationTriggerSource | null) ?? null,
    };
  }

  if (row.notificationType === FUNKY_OUTBOX_ADMIN_REVIEWED_INTERACTION_TYPE) {
    const metadataResult = parseAdminReviewedInteractionOutboxMetadata(row.metadata);
    if (metadataResult.isErr()) {
      throw new Error(`Invalid reviewed interaction audit metadata: ${metadataResult.error}`);
    }

    const metadata = metadataResult.value;
    return {
      kind: 'admin_reviewed_interaction',
      userId: row.userId,
      entityCui: metadata.entityCui,
      entityName: metadata.entityName,
      recordKey: metadata.recordKey,
      interactionId: metadata.interactionId,
      interactionLabel: metadata.interactionLabel,
      reviewStatus: metadata.reviewStatus,
      reviewedAt: metadata.reviewedAt,
      hasFeedbackText: metadata.feedbackText !== undefined && metadata.feedbackText.trim() !== '',
      nextStepCount: metadata.nextStepLinks?.length ?? 0,
      triggerSource: (row.triggerSource as CampaignNotificationTriggerSource | null) ?? null,
    };
  }

  return {
    kind: 'public_debate_admin_failure',
    entityCui: row.entityCui ?? '',
    entityName: row.entityName,
    threadId: row.threadId ?? '',
    phase: row.phase,
  };
};

const toCursorValue = (
  sortBy: CampaignNotificationAuditSortBy,
  row: QueryRow
): CampaignNotificationAuditCursor['value'] => {
  switch (sortBy) {
    case 'createdAt':
      return parseDbTimestamp(row.createdAt, 'created_at').toISOString();
    case 'sentAt':
      return parseDbTimestamp(
        row.sentAt ?? row.createdAt,
        row.sentAt === null ? 'created_at' : 'sent_at'
      ).toISOString();
    case 'status':
      return row.status;
    case 'attemptCount':
      return row.attemptCount;
  }
};

const applySort = <T extends { orderBy: (...args: unknown[]) => T }>(
  query: T,
  sortBy: CampaignNotificationAuditSortBy,
  sortOrder: CampaignNotificationAuditSortOrder
): T => {
  if (sortBy === 'createdAt') {
    return query.orderBy('outbox.created_at', sortOrder).orderBy('outbox.id', sortOrder);
  }

  if (sortBy === 'sentAt') {
    return query
      .orderBy(sql`coalesce(outbox.sent_at, outbox.created_at)`, sortOrder)
      .orderBy('outbox.id', sortOrder);
  }

  if (sortBy === 'status') {
    return query.orderBy('outbox.status', sortOrder).orderBy('outbox.id', sortOrder);
  }

  return query.orderBy('outbox.attempt_count', sortOrder).orderBy('outbox.id', sortOrder);
};

const applyCursor = <T extends { where: (...args: unknown[]) => T }>(
  query: T,
  sortBy: CampaignNotificationAuditSortBy,
  sortOrder: CampaignNotificationAuditSortOrder,
  cursor: CampaignNotificationAuditCursor
): T => {
  if (sortBy === 'createdAt') {
    const cursorValue = new Date(String(cursor.value));
    return sortOrder === 'asc'
      ? query.where(sql<boolean>`(outbox.created_at, outbox.id) > (${cursorValue}, ${cursor.id})`)
      : query.where(sql<boolean>`(outbox.created_at, outbox.id) < (${cursorValue}, ${cursor.id})`);
  }

  if (sortBy === 'sentAt') {
    const cursorValue = new Date(String(cursor.value));
    return sortOrder === 'asc'
      ? query.where(
          sql<boolean>`(coalesce(outbox.sent_at, outbox.created_at), outbox.id) > (${cursorValue}, ${cursor.id})`
        )
      : query.where(
          sql<boolean>`(coalesce(outbox.sent_at, outbox.created_at), outbox.id) < (${cursorValue}, ${cursor.id})`
        );
  }

  if (sortBy === 'status') {
    const cursorValue = String(cursor.value);
    return sortOrder === 'asc'
      ? query.where(sql<boolean>`(outbox.status, outbox.id) > (${cursorValue}, ${cursor.id})`)
      : query.where(sql<boolean>`(outbox.status, outbox.id) < (${cursorValue}, ${cursor.id})`);
  }

  const cursorValue = Number(cursor.value);
  return sortOrder === 'asc'
    ? query.where(sql<boolean>`(outbox.attempt_count, outbox.id) > (${cursorValue}, ${cursor.id})`)
    : query.where(sql<boolean>`(outbox.attempt_count, outbox.id) < (${cursorValue}, ${cursor.id})`);
};

export const makeCampaignNotificationOutboxAuditRepo = (
  deps: OutboxAuditRepoDeps
): CampaignNotificationAuditRepository => {
  const log = deps.logger.child({ repo: 'CampaignNotificationOutboxAuditRepo' });

  return {
    async listCampaignNotificationAudit(
      input: ListCampaignNotificationAuditInput
    ): Promise<Result<ListCampaignNotificationAuditOutput, CampaignAdminNotificationError>> {
      if (
        input.notificationType !== undefined &&
        !FUNKY_AUDIT_NOTIFICATION_TYPE_SET.has(input.notificationType)
      ) {
        return err(
          createValidationError(`Unsupported notification type "${input.notificationType}".`)
        );
      }

      try {
        let query = deps.db
          .selectFrom('notificationsoutbox as outbox')
          .select([
            'outbox.id as id',
            'outbox.user_id as userId',
            'outbox.notification_type as notificationType',
            'outbox.template_name as templateName',
            'outbox.template_version as templateVersion',
            'outbox.status as status',
            'outbox.attempt_count as attemptCount',
            'outbox.created_at as createdAt',
            'outbox.sent_at as sentAt',
            'outbox.last_attempt_at as lastAttemptAt',
            'outbox.last_error as lastError',
            'outbox.metadata as metadata',
            sql<string | null>`outbox.metadata->>'entityCui'`.as('entityCui'),
            sql<string | null>`outbox.metadata->>'entityName'`.as('entityName'),
            sql<string | null>`outbox.metadata->>'acceptedTermsAt'`.as('acceptedTermsAt'),
            sql<
              number | null
            >`jsonb_array_length(coalesce(outbox.metadata->'selectedEntities', '[]'::jsonb))`.as(
              'selectedEntitiesCount'
            ),
            sql<string | null>`outbox.metadata->>'threadId'`.as('threadId'),
            sql<string | null>`outbox.metadata->>'threadKey'`.as('threadKey'),
            sql<string | null>`outbox.metadata->>'eventType'`.as('eventType'),
            sql<string | null>`outbox.metadata->>'phase'`.as('phase'),
            sql<string | null>`outbox.metadata->>'replyEntryId'`.as('replyEntryId'),
            sql<string | null>`outbox.metadata->>'basedOnEntryId'`.as('basedOnEntryId'),
            sql<string | null>`outbox.metadata->>'resolutionCode'`.as('resolutionCode'),
            sql<string | null>`outbox.metadata->>'recordKey'`.as('recordKey'),
            sql<string | null>`outbox.metadata->>'interactionId'`.as('interactionId'),
            sql<string | null>`outbox.metadata->>'interactionLabel'`.as('interactionLabel'),
            sql<'approved' | 'rejected' | null>`outbox.metadata->>'reviewStatus'`.as(
              'reviewStatus'
            ),
            sql<string | null>`outbox.metadata->>'reviewedAt'`.as('reviewedAt'),
            sql<string | null>`outbox.metadata->>'feedbackText'`.as('feedbackText'),
            sql<
              number | null
            >`jsonb_array_length(coalesce(outbox.metadata->'nextStepLinks', '[]'::jsonb))`.as(
              'nextStepCount'
            ),
            buildTriggerSourceExpression().as('triggerSource'),
          ])
          .where('outbox.notification_type', 'in', [...FUNKY_AUDIT_NOTIFICATION_TYPES])
          .where(sql<boolean>`outbox.metadata->>'campaignKey' = ${input.campaignKey}`);

        if (input.notificationType !== undefined) {
          query = query.where('outbox.notification_type', '=', input.notificationType);
        }

        if (input.templateId !== undefined) {
          query = query.where('outbox.template_name', '=', input.templateId);
        }

        if (input.userId !== undefined) {
          query = query.where('outbox.user_id', '=', input.userId);
        }

        if (input.status !== undefined) {
          query = query.where(sql<boolean>`outbox.status = ${input.status}`);
        }

        if (input.eventType !== undefined) {
          query = query.where(sql<boolean>`outbox.metadata->>'eventType' = ${input.eventType}`);
        }

        if (input.entityCui !== undefined) {
          query = query.where(sql<boolean>`outbox.metadata->>'entityCui' = ${input.entityCui}`);
        }

        if (input.threadId !== undefined) {
          query = query.where(sql<boolean>`outbox.metadata->>'threadId' = ${input.threadId}`);
        }

        if (input.source !== undefined) {
          query = query.where(sql<boolean>`${buildTriggerSourceExpression()} = ${input.source}`);
        }

        if (input.cursor !== undefined) {
          query = applyCursor(query, input.sortBy, input.sortOrder, input.cursor);
        }

        query = applySort(query, input.sortBy, input.sortOrder);

        const rows = (await query.limit(input.limit + 1).execute()) as unknown as QueryRow[];
        const hasMore = rows.length > input.limit;
        const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
        const lastRow = pageRows[pageRows.length - 1];

        const items: CampaignNotificationAuditItem[] = pageRows.map((row) => ({
          outboxId: row.id,
          campaignKey: FUNKY_CAMPAIGN_KEY as CampaignNotificationAdminCampaignKey,
          notificationType: row.notificationType,
          templateId: row.templateName,
          templateName: row.templateName,
          templateVersion: row.templateVersion,
          status: row.status,
          createdAt: parseDbTimestamp(row.createdAt, 'created_at').toISOString(),
          sentAt:
            row.sentAt === null ? null : parseDbTimestamp(row.sentAt, 'sent_at').toISOString(),
          attemptCount: row.attemptCount,
          safeError: mapSafeError(row.status, row.lastError),
          projection: mapProjection(row),
        }));

        return ok({
          items,
          nextCursor:
            hasMore && lastRow !== undefined
              ? {
                  sortBy: input.sortBy,
                  sortOrder: input.sortOrder,
                  id: lastRow.id,
                  value: toCursorValue(input.sortBy, lastRow),
                }
              : null,
          hasMore,
        });
      } catch (error) {
        log.error({ error, input }, 'Failed to list campaign notification audit rows');
        return err(createDatabaseError('Failed to list campaign notification audit rows'));
      }
    },

    async getCampaignNotificationMetaCounts(
      input
    ): Promise<Result<CampaignNotificationMetaCounts, CampaignAdminNotificationError>> {
      try {
        const result = await deps.db
          .selectFrom('notificationsoutbox as outbox')
          .select((eb) => [
            eb.fn
              .count<number>('outbox.id')
              .filterWhere('outbox.status', 'in', [...PENDING_DELIVERY_STATUSES])
              .as('pending_delivery_count'),
            eb.fn
              .count<number>('outbox.id')
              .filterWhere('outbox.status', 'in', [...FAILED_DELIVERY_STATUSES])
              .as('failed_delivery_count'),
            eb.fn
              .count<number>('outbox.id')
              .filterWhere(sql<boolean>`outbox.metadata->>'eventType' = ${'reply_received'}`)
              .as('reply_received_count'),
          ])
          .where('outbox.notification_type', 'in', [...FUNKY_AUDIT_NOTIFICATION_TYPES])
          .where(sql<boolean>`outbox.metadata->>'campaignKey' = ${input.campaignKey}`)
          .executeTakeFirst();

        const counts = (result as MetaCountsRow | undefined) ?? {
          pending_delivery_count: 0,
          failed_delivery_count: 0,
          reply_received_count: 0,
        };

        const pendingDeliveryCount = parseMetaCountValue(
          counts.pending_delivery_count,
          'pending_delivery_count'
        );
        if (pendingDeliveryCount.isErr()) {
          log.error(
            { input, value: counts.pending_delivery_count },
            'Invalid pending delivery count returned from database'
          );
          return err(pendingDeliveryCount.error);
        }

        const failedDeliveryCount = parseMetaCountValue(
          counts.failed_delivery_count,
          'failed_delivery_count'
        );
        if (failedDeliveryCount.isErr()) {
          log.error(
            { input, value: counts.failed_delivery_count },
            'Invalid failed delivery count returned from database'
          );
          return err(failedDeliveryCount.error);
        }

        const replyReceivedCount = parseMetaCountValue(
          counts.reply_received_count,
          'reply_received_count'
        );
        if (replyReceivedCount.isErr()) {
          log.error(
            { input, value: counts.reply_received_count },
            'Invalid reply received count returned from database'
          );
          return err(replyReceivedCount.error);
        }

        return ok({
          pendingDeliveryCount: pendingDeliveryCount.value,
          failedDeliveryCount: failedDeliveryCount.value,
          replyReceivedCount: replyReceivedCount.value,
        });
      } catch (error) {
        log.error({ error, input }, 'Failed to get campaign notification meta counts');
        return err(createDatabaseError('Failed to get campaign notification meta counts'));
      }
    },
  };
};
