/**
 * Webhook Event Repository Implementation
 *
 * Stores Resend webhook events for idempotent processing.
 */

import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import {
  type DeliveryError,
  createDatabaseError,
  createDuplicateWebhookEventError,
} from '../../core/errors.js';

import type { WebhookEventRepository, InsertWebhookEventInput } from '../../core/ports.js';
import type { StoredWebhookEvent } from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for the webhook event repository.
 */
export interface WebhookEventRepoConfig {
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
 * Maps a database row to StoredWebhookEvent.
 */
const mapRow = (row: Record<string, unknown>): StoredWebhookEvent => ({
  id: row['id'] as string,
  svixId: row['svix_id'] as string,
  eventType: row['event_type'] as string,
  resendEmailId: row['resend_email_id'] as string,
  deliveryId: (row['delivery_id'] as string | null) ?? null,
  payload: (row['payload'] as Record<string, unknown> | null) ?? {},
  processedAt: row['processed_at'] !== null ? toDate(row['processed_at']) : null,
  createdAt: toDate(row['created_at']),
});

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Kysely-based webhook event repository.
 */
export const makeWebhookEventRepo = (config: WebhookEventRepoConfig): WebhookEventRepository => {
  const { db, logger } = config;
  const log = logger.child({ repo: 'WebhookEventRepo' });

  return {
    async insert(
      input: InsertWebhookEventInput
    ): Promise<Result<StoredWebhookEvent, DeliveryError>> {
      log.debug({ svixId: input.svixId, eventType: input.eventType }, 'Inserting webhook event');

      try {
        const result = await db
          .insertInto('resendwebhookevents')
          .values({
            svix_id: input.svixId,
            event_type: input.eventType,
            resend_email_id: input.resendEmailId,
            delivery_id: input.deliveryId ?? null,
            payload: JSON.stringify(input.payload),
          })
          .returningAll()
          .executeTakeFirst();

        if (result === undefined) {
          return err(createDatabaseError('Insert returned no result'));
        }

        log.info({ id: result.id, svixId: input.svixId }, 'Webhook event inserted');
        return ok(mapRow(result as unknown as Record<string, unknown>));
      } catch (error) {
        // Check for unique constraint violation on svix_id
        if (
          error instanceof Error &&
          (error.message.includes('unique constraint') ||
            error.message.includes('duplicate key') ||
            error.message.includes('UNIQUE constraint'))
        ) {
          log.debug({ svixId: input.svixId }, 'Duplicate webhook event (already processed)');
          return err(createDuplicateWebhookEventError(input.svixId));
        }

        log.error({ error, svixId: input.svixId }, 'Failed to insert webhook event');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async markProcessed(svixId: string): Promise<Result<void, DeliveryError>> {
      log.debug({ svixId }, 'Marking webhook event as processed');

      try {
        await db
          .updateTable('resendwebhookevents')
          .set({ processed_at: new Date() })
          .where('svix_id', '=', svixId)
          .execute();

        log.debug({ svixId }, 'Webhook event marked as processed');
        return ok(undefined);
      } catch (error) {
        log.error({ error, svixId }, 'Failed to mark webhook event as processed');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },

    async findUnprocessed(
      olderThanMinutes: number
    ): Promise<Result<StoredWebhookEvent[], DeliveryError>> {
      log.debug({ olderThanMinutes }, 'Finding unprocessed webhook events');

      try {
        // Compute threshold timestamp (parameterized, not sql.raw())
        const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();

        const result = await db
          .selectFrom('resendwebhookevents')
          .selectAll()
          .where('processed_at', 'is', null)
          .where(sql<boolean>`created_at < ${threshold}::timestamptz`)
          .orderBy('created_at', 'asc')
          .execute();

        log.debug({ count: result.length }, 'Found unprocessed webhook events');
        return ok(result.map((row) => mapRow(row as unknown as Record<string, unknown>)));
      } catch (error) {
        log.error({ error }, 'Failed to find unprocessed webhook events');
        return err(createDatabaseError(error instanceof Error ? error.message : 'Unknown error'));
      }
    },
  };
};
