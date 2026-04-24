/**
 * Notification Outbox Repository Implementation
 *
 * Kysely-based implementation with atomic claim pattern.
 */

import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import { parseDbTimestamp } from '@/common/utils/parse-db-timestamp.js';

import {
  type DeliveryError,
  createDatabaseError,
  createDuplicateDeliveryError,
} from '../../core/errors.js';
import {
  buildAnafForexebugDigestScopeKey,
  type DeliveryStatus,
  type NotificationOutboxRecord,
} from '../../core/types.js';

import type {
  DeliveryRepository,
  CreateDeliveryInput,
  UpdateRenderedContentInput,
  UpdateDeliveryStatusInput,
} from '../../core/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { NotificationType } from '@/modules/notifications/core/types.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the delivery repository.
 */
export interface DeliveryRepoConfig {
  db: UserDbClient;
  logger: Logger;
}

const COMPOSE_CLAIM_METADATA_KEY = '__composeClaimId';
const ANONYMIZED_USER_ID_PREFIX = 'deleted-user:';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a database row to NotificationOutboxRecord.
 */
const mapRow = (row: Record<string, unknown>): NotificationOutboxRecord => ({
  id: row['id'] as string,
  userId: row['user_id'] as string,
  toEmail: (row['to_email'] as string | null) ?? null,
  notificationType: row['notification_type'] as NotificationOutboxRecord['notificationType'],
  referenceId: (row['reference_id'] as string | null) ?? null,
  scopeKey: row['scope_key'] as string,
  deliveryKey: row['delivery_key'] as string,
  status: row['status'] as DeliveryStatus,
  renderedSubject: (row['rendered_subject'] as string | null) ?? null,
  renderedHtml: (row['rendered_html'] as string | null) ?? null,
  renderedText: (row['rendered_text'] as string | null) ?? null,
  contentHash: (row['content_hash'] as string | null) ?? null,
  templateName: (row['template_name'] as string | null) ?? null,
  templateVersion: (row['template_version'] as string | null) ?? null,
  resendEmailId: (row['resend_email_id'] as string | null) ?? null,
  lastError: (row['last_error'] as string | null) ?? null,
  attemptCount: row['attempt_count'] as number,
  lastAttemptAt:
    row['last_attempt_at'] !== null
      ? parseDbTimestamp(row['last_attempt_at'], 'last_attempt_at')
      : null,
  sentAt: row['sent_at'] !== null ? parseDbTimestamp(row['sent_at'], 'sent_at') : null,
  metadata: (row['metadata'] as Record<string, unknown> | null) ?? {},
  createdAt: parseDbTimestamp(row['created_at'], 'created_at'),
});

const hashUserId = (userId: string): string => createHash('sha256').update(userId).digest('hex');

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Kysely-based notification outbox repository.
 */
export const makeDeliveryRepo = (config: DeliveryRepoConfig): DeliveryRepository => {
  const { db, logger } = config;
  const log = logger.child({ repo: 'DeliveryRepo' });

  return {
    async create(
      input: CreateDeliveryInput
    ): Promise<Result<NotificationOutboxRecord, DeliveryError>> {
      log.debug({ deliveryKey: input.deliveryKey }, 'Creating notification outbox record');

      try {
        const result = await db
          .insertInto('notificationsoutbox')
          .values({
            user_id: input.userId,
            notification_type: input.notificationType,
            reference_id: input.referenceId,
            scope_key: input.scopeKey,
            delivery_key: input.deliveryKey,
            status: 'pending',
            to_email: input.toEmail ?? null,
            rendered_subject: input.renderedSubject ?? null,
            rendered_html: input.renderedHtml ?? null,
            rendered_text: input.renderedText ?? null,
            content_hash: input.contentHash ?? null,
            template_name: input.templateName ?? null,
            template_version: input.templateVersion ?? null,
            metadata: JSON.stringify(input.metadata ?? {}),
          })
          .returningAll()
          .executeTakeFirst();

        if (result === undefined) {
          return err(createDatabaseError('Insert returned no result'));
        }

        log.info(
          { outboxId: result.id, deliveryKey: input.deliveryKey },
          'Notification outbox row created'
        );
        return ok(mapRow(result as unknown as Record<string, unknown>));
      } catch (error) {
        // Check for unique constraint violation
        if (
          error instanceof Error &&
          (error.message.includes('unique constraint') ||
            error.message.includes('duplicate key') ||
            error.message.includes('UNIQUE constraint'))
        ) {
          log.warn({ deliveryKey: input.deliveryKey }, 'Duplicate delivery key');
          return err(createDuplicateDeliveryError(input.deliveryKey));
        }

        log.error({ error, deliveryKey: input.deliveryKey }, 'Failed to create outbox row');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findById(
      outboxId: string
    ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>> {
      try {
        const result = await db
          .selectFrom('notificationsoutbox')
          .selectAll()
          .where('id', '=', outboxId)
          .executeTakeFirst();

        return ok(
          result !== undefined ? mapRow(result as unknown as Record<string, unknown>) : null
        );
      } catch (error) {
        log.error({ error, outboxId }, 'Failed to find outbox row by ID');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findByDeliveryKey(
      deliveryKey: string
    ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>> {
      try {
        const result = await db
          .selectFrom('notificationsoutbox')
          .selectAll()
          .where('delivery_key', '=', deliveryKey)
          .executeTakeFirst();

        return ok(
          result !== undefined ? mapRow(result as unknown as Record<string, unknown>) : null
        );
      } catch (error) {
        log.error({ error, deliveryKey }, 'Failed to find delivery by key');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async refreshMetadataForRecomposeIfReplayable(
      outboxId: string,
      metadata: Record<string, unknown>
    ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>> {
      log.debug({ outboxId }, 'Refreshing metadata on replayable outbox row');

      try {
        const result = await sql<Record<string, unknown>>`
          UPDATE notificationsoutbox
          SET metadata = ${JSON.stringify(metadata)},
              status = 'pending',
              to_email = NULL,
              rendered_subject = NULL,
              rendered_html = NULL,
              rendered_text = NULL,
              content_hash = NULL,
              template_name = NULL,
              template_version = NULL,
              resend_email_id = NULL,
              last_error = NULL,
              attempt_count = 0,
              last_attempt_at = NULL,
              sent_at = NULL
          WHERE id = ${outboxId}
            AND status IN ('pending', 'failed_transient', 'composing')
          RETURNING *
        `.execute(db);

        const row = result.rows[0];
        if (row === undefined) {
          log.debug(
            { outboxId },
            'Outbox row metadata not refreshed because row is not replayable'
          );
          return ok(null);
        }

        return ok(mapRow(row));
      } catch (error) {
        log.error({ error, outboxId }, 'Failed to refresh outbox metadata');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async refreshSendingDigestMetadataForRecompose(
      outboxId: string,
      metadata: Record<string, unknown>
    ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>> {
      log.debug({ outboxId }, 'Refreshing metadata on sending digest outbox row');

      try {
        const result = await sql<Record<string, unknown>>`
          UPDATE notificationsoutbox
          SET metadata = ${JSON.stringify(metadata)},
              status = 'pending',
              to_email = NULL,
              rendered_subject = NULL,
              rendered_html = NULL,
              rendered_text = NULL,
              content_hash = NULL,
              template_name = NULL,
              template_version = NULL,
              resend_email_id = NULL,
              last_error = NULL,
              attempt_count = 0,
              last_attempt_at = NULL,
              sent_at = NULL
          WHERE id = ${outboxId}
            AND notification_type = 'anaf_forexebug_digest'
            AND status = 'sending'
          RETURNING *
        `.execute(db);

        const row = result.rows[0];
        if (row === undefined) {
          log.debug(
            { outboxId },
            'Digest outbox row metadata not refreshed because row is not sending'
          );
          return ok(null);
        }

        return ok(mapRow(row));
      } catch (error) {
        log.error({ error, outboxId }, 'Failed to refresh sending digest metadata');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findAnafForexebugDigestForSource(
      sourceNotificationId: string,
      periodKey: string
    ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>> {
      log.debug({ sourceNotificationId, periodKey }, 'Finding digest row for source notification');

      try {
        const row = await db
          .selectFrom('notificationsoutbox')
          .selectAll()
          .where('notification_type', '=', 'anaf_forexebug_digest')
          .where('scope_key', 'in', [periodKey, buildAnafForexebugDigestScopeKey(periodKey)])
          .where(
            sql<boolean>`notificationsoutbox.metadata -> 'sourceNotificationIds' ? ${sourceNotificationId}`
          )
          .orderBy('created_at', 'asc')
          .executeTakeFirst();

        return ok(row !== undefined ? mapRow(row as unknown as Record<string, unknown>) : null);
      } catch (error) {
        log.error(
          { error, sourceNotificationId, periodKey },
          'Failed to find digest row for source notification'
        );
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findDirectDeliveryForSource(
      notificationType: NotificationType,
      sourceNotificationId: string,
      periodKey: string
    ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>> {
      log.debug(
        { notificationType, sourceNotificationId, periodKey },
        'Finding direct delivery row for source notification'
      );

      try {
        const row = await db
          .selectFrom('notificationsoutbox')
          .selectAll()
          .where('notification_type', '=', notificationType)
          .where('reference_id', '=', sourceNotificationId)
          .where('scope_key', '=', periodKey)
          .orderBy('created_at', 'asc')
          .executeTakeFirst();

        return ok(row !== undefined ? mapRow(row as unknown as Record<string, unknown>) : null);
      } catch (error) {
        log.error(
          { error, notificationType, sourceNotificationId, periodKey },
          'Failed to find direct delivery row for source notification'
        );
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async updateRenderedContent(
      outboxId: string,
      input: UpdateRenderedContentInput
    ): Promise<Result<boolean, DeliveryError>> {
      log.debug({ outboxId }, 'Updating rendered content on outbox row');

      try {
        const expectedComposeClaimId = input.expectedComposeClaimId;
        const result = await db
          .updateTable('notificationsoutbox')
          .set({
            rendered_subject: input.renderedSubject,
            rendered_html: input.renderedHtml,
            rendered_text: input.renderedText,
            content_hash: input.contentHash,
            template_name: input.templateName,
            template_version: input.templateVersion,
            ...(input.metadata !== undefined ? { metadata: JSON.stringify(input.metadata) } : {}),
          })
          .where('id', '=', outboxId)
          .where('status', '=', 'composing')
          .$if(expectedComposeClaimId !== undefined, (query) =>
            query.where(
              sql<boolean>`notificationsoutbox.metadata->>${COMPOSE_CLAIM_METADATA_KEY} = ${expectedComposeClaimId}`
            )
          )
          .executeTakeFirst();

        return ok(Number(result.numUpdatedRows) > 0);
      } catch (error) {
        log.error({ error, outboxId }, 'Failed to update rendered content');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async claimForCompose(
      outboxId: string
    ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>> {
      log.debug({ outboxId }, 'Claiming outbox row for compose');

      try {
        const composeClaimId = randomUUID();
        const result = await sql<Record<string, unknown>>`
          UPDATE notificationsoutbox
          SET status = 'composing',
              last_attempt_at = NOW(),
              metadata = jsonb_set(
                COALESCE(notificationsoutbox.metadata, '{}'::jsonb),
                '{__composeClaimId}'::text[],
                to_jsonb(${composeClaimId}::text),
                true
              )
          WHERE id = ${outboxId}
            AND status = 'pending'
            AND (
              rendered_subject IS NULL
              OR rendered_html IS NULL
              OR rendered_text IS NULL
            )
          RETURNING *
        `.execute(db);

        const row = result.rows[0];
        if (row === undefined) {
          log.debug({ outboxId }, 'Outbox row not claimable for compose');
          return ok(null);
        }

        log.info({ outboxId }, 'Outbox row claimed for compose');
        return ok(mapRow(row));
      } catch (error) {
        log.error({ error, outboxId }, 'Failed to claim outbox row for compose');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async claimForSending(
      outboxId: string
    ): Promise<Result<NotificationOutboxRecord | null, DeliveryError>> {
      log.debug({ outboxId }, 'Claiming outbox row for sending');

      try {
        // ATOMIC CLAIM: Only succeeds if status is claimable
        // Increments attempt_count in SQL to prevent race conditions
        const result = await sql<Record<string, unknown>>`
          UPDATE notificationsoutbox
          SET status = 'sending',
              attempt_count = attempt_count + 1,
              last_attempt_at = NOW()
          WHERE id = ${outboxId}
            AND status IN ('pending', 'failed_transient')
            AND rendered_subject IS NOT NULL
            AND rendered_html IS NOT NULL
            AND rendered_text IS NOT NULL
          RETURNING *
        `.execute(db);

        const row = result.rows[0];
        if (row === undefined) {
          log.debug({ outboxId }, 'Outbox row not claimable (already claimed or processed)');
          return ok(null);
        }

        log.info({ outboxId }, 'Outbox row claimed for sending');
        return ok(mapRow(row));
      } catch (error) {
        log.error({ error, outboxId }, 'Failed to claim outbox row');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async isUserAnonymizationStarted(userId: string): Promise<Result<boolean, DeliveryError>> {
      if (userId.startsWith(ANONYMIZED_USER_ID_PREFIX)) {
        return ok(true);
      }

      const userIdHash = hashUserId(userId);
      try {
        const row = await db
          .selectFrom('userdataanonymizationaudit')
          .select('id')
          .where((eb) =>
            eb.or([
              eb('user_id_hash', '=', userIdHash),
              eb('anonymized_user_id', '=', `${ANONYMIZED_USER_ID_PREFIX}${userIdHash}`),
            ])
          )
          .executeTakeFirst();

        return ok(row !== undefined);
      } catch (error) {
        log.error({ error }, 'Failed to check user anonymization state');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async updateStatusIfCurrentIn(
      outboxId: string,
      allowedStatuses: readonly DeliveryStatus[],
      nextStatus: DeliveryStatus,
      input?: Partial<UpdateDeliveryStatusInput>
    ): Promise<Result<boolean, DeliveryError>> {
      log.debug({ outboxId, allowedStatuses, nextStatus }, 'Updating status conditionally');

      if (allowedStatuses.length === 0) {
        return ok(false);
      }

      try {
        const expectedComposeClaimId = input?.expectedComposeClaimId;
        const result = await db
          .updateTable('notificationsoutbox')
          .set({
            status: nextStatus,
            ...(input?.toEmail !== undefined ? { to_email: input.toEmail } : {}),
            ...(input?.resendEmailId !== undefined ? { resend_email_id: input.resendEmailId } : {}),
            ...(input?.lastError !== undefined ? { last_error: input.lastError } : {}),
            ...(input?.sentAt !== undefined ? { sent_at: input.sentAt } : {}),
          })
          .where('id', '=', outboxId)
          .where('status', 'in', [...allowedStatuses])
          .$if(expectedComposeClaimId !== undefined, (query) =>
            query.where(
              sql<boolean>`notificationsoutbox.metadata->>${COMPOSE_CLAIM_METADATA_KEY} = ${expectedComposeClaimId}`
            )
          )
          .executeTakeFirst();

        return ok(result.numUpdatedRows > 0n);
      } catch (error) {
        log.error({ error, outboxId }, 'Failed to update outbox status conditionally');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async updateStatus(
      outboxId: string,
      input: UpdateDeliveryStatusInput
    ): Promise<Result<void, DeliveryError>> {
      log.debug({ outboxId, status: input.status }, 'Updating outbox status');

      try {
        await db
          .updateTable('notificationsoutbox')
          .set({
            status: input.status,
            ...(input.toEmail !== undefined ? { to_email: input.toEmail } : {}),
            ...(input.resendEmailId !== undefined ? { resend_email_id: input.resendEmailId } : {}),
            ...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
            ...(input.sentAt !== undefined ? { sent_at: input.sentAt } : {}),
          })
          .where('id', '=', outboxId)
          .execute();

        log.debug({ outboxId, status: input.status }, 'Outbox status updated');
        return ok(undefined);
      } catch (error) {
        log.error({ error, outboxId }, 'Failed to update outbox status');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async updateStatusIfStillSending(
      outboxId: string,
      status: DeliveryStatus,
      input?: Partial<UpdateDeliveryStatusInput>
    ): Promise<Result<boolean, DeliveryError>> {
      return this.updateStatusIfCurrentIn(outboxId, ['sending'], status, input);
    },

    async findStuckSending(
      olderThanMinutes: number
    ): Promise<Result<NotificationOutboxRecord[], DeliveryError>> {
      log.debug({ olderThanMinutes }, 'Finding stuck sending deliveries');

      try {
        // Compute threshold timestamp (parameterized, not sql.raw())
        const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();

        const result = await db
          .selectFrom('notificationsoutbox')
          .selectAll()
          .where('status', '=', 'sending')
          .where(
            sql<boolean>`last_attempt_at IS NULL OR last_attempt_at < ${threshold}::timestamptz`
          )
          .orderBy(sql`COALESCE(last_attempt_at, created_at)`, 'asc')
          .execute();

        log.info({ count: result.length }, 'Found stuck sending deliveries');
        return ok(result.map((row) => mapRow(row as unknown as Record<string, unknown>)));
      } catch (error) {
        log.error({ error }, 'Failed to find stuck sending deliveries');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findPendingComposeOrphans(
      olderThanMinutes: number
    ): Promise<Result<NotificationOutboxRecord[], DeliveryError>> {
      log.debug({ olderThanMinutes }, 'Finding pending compose orphans');

      try {
        const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();

        const result = await db
          .selectFrom('notificationsoutbox')
          .selectAll()
          .where('status', 'in', ['pending', 'composing'])
          .where(
            sql<boolean>`(
              rendered_subject IS NULL
              OR rendered_html IS NULL
              OR rendered_text IS NULL
            )`
          )
          .where(sql<boolean>`COALESCE(last_attempt_at, created_at) < ${threshold}::timestamptz`)
          .orderBy(sql`COALESCE(last_attempt_at, created_at)`, 'asc')
          .execute();

        return ok(result.map((row) => mapRow(row as unknown as Record<string, unknown>)));
      } catch (error) {
        log.error({ error }, 'Failed to find pending compose orphans');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findReadyToSendOrphans(
      olderThanMinutes: number
    ): Promise<Result<NotificationOutboxRecord[], DeliveryError>> {
      log.debug({ olderThanMinutes }, 'Finding ready-to-send orphans');

      try {
        const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();

        const result = await db
          .selectFrom('notificationsoutbox')
          .selectAll()
          .where('status', 'in', ['pending', 'failed_transient'])
          .where(
            sql<boolean>`(
              rendered_subject IS NOT NULL
              AND rendered_html IS NOT NULL
              AND rendered_text IS NOT NULL
            )`
          )
          .where(sql<boolean>`COALESCE(last_attempt_at, created_at) < ${threshold}::timestamptz`)
          .orderBy(sql`COALESCE(last_attempt_at, created_at)`, 'asc')
          .execute();

        return ok(result.map((row) => mapRow(row as unknown as Record<string, unknown>)));
      } catch (error) {
        log.error({ error }, 'Failed to find ready-to-send orphans');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findSentAwaitingWebhook(
      olderThanMinutes: number
    ): Promise<Result<NotificationOutboxRecord[], DeliveryError>> {
      log.debug({ olderThanMinutes }, 'Finding sent deliveries awaiting webhook');

      try {
        const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();

        const result = await db
          .selectFrom('notificationsoutbox')
          .selectAll()
          .where('status', '=', 'sent')
          .where('sent_at', 'is not', null)
          .where(sql<boolean>`sent_at < ${threshold}::timestamptz`)
          .orderBy('sent_at', 'asc')
          .execute();

        return ok(result.map((row) => mapRow(row as unknown as Record<string, unknown>)));
      } catch (error) {
        log.error({ error }, 'Failed to find sent deliveries awaiting webhook');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async existsByDeliveryKey(deliveryKey: string): Promise<Result<boolean, DeliveryError>> {
      try {
        const result = await db
          .selectFrom('notificationsoutbox')
          .select('id')
          .where('delivery_key', '=', deliveryKey)
          .executeTakeFirst();

        return ok(result !== undefined);
      } catch (error) {
        log.error({ error, deliveryKey }, 'Failed to check delivery existence');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },
  };
};
