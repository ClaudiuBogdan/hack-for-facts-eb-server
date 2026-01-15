/**
 * Delivery Repository Implementation
 *
 * Kysely-based implementation with atomic claim pattern.
 */

import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import {
  type DeliveryError,
  createDatabaseError,
  createDuplicateDeliveryError,
} from '../../core/errors.js';

import type {
  DeliveryRepository,
  CreateDeliveryInput,
  UpdateDeliveryStatusInput,
} from '../../core/ports.js';
import type { DeliveryRecord, DeliveryStatus } from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts Kysely timestamp to Date.
 */
const toDate = (value: unknown): Date => {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  if (typeof value === 'object' && value !== null && 'toISOString' in value) {
    return new Date((value as { toISOString: () => string }).toISOString());
  }
  return new Date();
};

/**
 * Maps a database row to DeliveryRecord.
 */
const mapRow = (row: Record<string, unknown>): DeliveryRecord => ({
  id: row['id'] as string,
  userId: row['user_id'] as string,
  toEmail: (row['to_email'] as string | null) ?? null,
  notificationId: row['notification_id'] as string,
  periodKey: row['period_key'] as string,
  deliveryKey: row['delivery_key'] as string,
  status: row['status'] as DeliveryStatus,
  unsubscribeToken: (row['unsubscribe_token'] as string | null) ?? null,
  renderedSubject: (row['rendered_subject'] as string | null) ?? null,
  renderedHtml: (row['rendered_html'] as string | null) ?? null,
  renderedText: (row['rendered_text'] as string | null) ?? null,
  contentHash: (row['content_hash'] as string | null) ?? null,
  templateName: (row['template_name'] as string | null) ?? null,
  templateVersion: (row['template_version'] as string | null) ?? null,
  resendEmailId: (row['resend_email_id'] as string | null) ?? null,
  lastError: (row['last_error'] as string | null) ?? null,
  attemptCount: row['attempt_count'] as number,
  lastAttemptAt: row['last_attempt_at'] !== null ? toDate(row['last_attempt_at']) : null,
  sentAt: row['sent_at'] !== null ? toDate(row['sent_at']) : null,
  metadata: (row['metadata'] as Record<string, unknown> | null) ?? {},
  createdAt: toDate(row['created_at']),
});

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Kysely-based delivery repository.
 */
export const makeDeliveryRepo = (config: DeliveryRepoConfig): DeliveryRepository => {
  const { db, logger } = config;
  const log = logger.child({ repo: 'DeliveryRepo' });

  return {
    async create(input: CreateDeliveryInput): Promise<Result<DeliveryRecord, DeliveryError>> {
      log.debug({ deliveryKey: input.deliveryKey }, 'Creating delivery record');

      try {
        const result = await db
          .insertInto('notificationdeliveries')
          .values({
            user_id: input.userId,
            notification_id: input.notificationId,
            period_key: input.periodKey,
            delivery_key: input.deliveryKey,
            status: 'pending',
            unsubscribe_token: input.unsubscribeToken ?? null,
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

        log.info({ deliveryId: result.id, deliveryKey: input.deliveryKey }, 'Delivery created');
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

        log.error({ error, deliveryKey: input.deliveryKey }, 'Failed to create delivery');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findById(deliveryId: string): Promise<Result<DeliveryRecord | null, DeliveryError>> {
      try {
        const result = await db
          .selectFrom('notificationdeliveries')
          .selectAll()
          .where('id', '=', deliveryId)
          .executeTakeFirst();

        return ok(
          result !== undefined ? mapRow(result as unknown as Record<string, unknown>) : null
        );
      } catch (error) {
        log.error({ error, deliveryId }, 'Failed to find delivery by ID');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findByDeliveryKey(
      deliveryKey: string
    ): Promise<Result<DeliveryRecord | null, DeliveryError>> {
      try {
        const result = await db
          .selectFrom('notificationdeliveries')
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

    async claimForSending(
      deliveryId: string
    ): Promise<Result<DeliveryRecord | null, DeliveryError>> {
      log.debug({ deliveryId }, 'Claiming delivery for sending');

      try {
        // ATOMIC CLAIM: Only succeeds if status is claimable
        // Increments attempt_count in SQL to prevent race conditions
        const result = await sql<Record<string, unknown>>`
          UPDATE notificationdeliveries
          SET status = 'sending',
              attempt_count = attempt_count + 1,
              last_attempt_at = NOW()
          WHERE id = ${deliveryId}
            AND status IN ('pending', 'failed_transient')
          RETURNING *
        `.execute(db);

        const row = result.rows[0];
        if (row === undefined) {
          log.debug({ deliveryId }, 'Delivery not claimable (already claimed or processed)');
          return ok(null);
        }

        log.info({ deliveryId }, 'Delivery claimed for sending');
        return ok(mapRow(row));
      } catch (error) {
        log.error({ error, deliveryId }, 'Failed to claim delivery');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async updateStatus(
      deliveryId: string,
      input: UpdateDeliveryStatusInput
    ): Promise<Result<void, DeliveryError>> {
      log.debug({ deliveryId, status: input.status }, 'Updating delivery status');

      try {
        await db
          .updateTable('notificationdeliveries')
          .set({
            status: input.status,
            ...(input.toEmail !== undefined ? { to_email: input.toEmail } : {}),
            ...(input.resendEmailId !== undefined ? { resend_email_id: input.resendEmailId } : {}),
            ...(input.lastError !== undefined ? { last_error: input.lastError } : {}),
            ...(input.sentAt !== undefined ? { sent_at: input.sentAt } : {}),
          })
          .where('id', '=', deliveryId)
          .execute();

        log.debug({ deliveryId, status: input.status }, 'Delivery status updated');
        return ok(undefined);
      } catch (error) {
        log.error({ error, deliveryId }, 'Failed to update delivery status');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async updateStatusIfStillSending(
      deliveryId: string,
      status: DeliveryStatus,
      input?: Partial<UpdateDeliveryStatusInput>
    ): Promise<Result<boolean, DeliveryError>> {
      log.debug({ deliveryId, status }, 'Updating status if still sending');

      try {
        const result = await db
          .updateTable('notificationdeliveries')
          .set({
            status,
            ...(input?.toEmail !== undefined ? { to_email: input.toEmail } : {}),
            ...(input?.resendEmailId !== undefined ? { resend_email_id: input.resendEmailId } : {}),
            ...(input?.lastError !== undefined ? { last_error: input.lastError } : {}),
            ...(input?.sentAt !== undefined ? { sent_at: input.sentAt } : {}),
          })
          .where('id', '=', deliveryId)
          .where('status', '=', 'sending')
          .executeTakeFirst();

        const updated = result.numUpdatedRows > 0n;
        log.debug({ deliveryId, updated }, 'Update if still sending complete');
        return ok(updated);
      } catch (error) {
        log.error({ error, deliveryId }, 'Failed to update status if still sending');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findStuckSending(
      olderThanMinutes: number
    ): Promise<Result<DeliveryRecord[], DeliveryError>> {
      log.debug({ olderThanMinutes }, 'Finding stuck sending deliveries');

      try {
        // Compute threshold timestamp (parameterized, not sql.raw())
        const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();

        const result = await db
          .selectFrom('notificationdeliveries')
          .selectAll()
          .where('status', '=', 'sending')
          .where(sql<boolean>`last_attempt_at < ${threshold}::timestamptz`)
          .orderBy('last_attempt_at', 'asc')
          .execute();

        log.info({ count: result.length }, 'Found stuck sending deliveries');
        return ok(result.map((row) => mapRow(row as unknown as Record<string, unknown>)));
      } catch (error) {
        log.error({ error }, 'Failed to find stuck sending deliveries');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async existsByDeliveryKey(deliveryKey: string): Promise<Result<boolean, DeliveryError>> {
      try {
        const result = await db
          .selectFrom('notificationdeliveries')
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
