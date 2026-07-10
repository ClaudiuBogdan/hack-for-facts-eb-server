import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import { mapDigestBatch, mapLogicalNotification, toDatabaseError } from './repo-helpers.js';
import { createNotFoundError } from '../../core/shared/errors.js';

import type { DigestBatchRepo } from '../../core/digest/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';

export class KyselyDigestBatchRepo implements DigestBatchRepo {
  public constructor(private readonly db: UserDbClient) {}

  public async findById(id: string) {
    try {
      const row = await this.db
        .selectFrom('notification_digest_batches')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return ok(
        row === undefined ? null : mapDigestBatch(row as unknown as Record<string, unknown>)
      );
    } catch (error) {
      return err(toDatabaseError('Find notification digest batch by id', error));
    }
  }

  public async findOrCreateOpen(input: Parameters<DigestBatchRepo['findOrCreateOpen']>[0]) {
    try {
      const inserted = await this.db
        .insertInto('notification_digest_batches')
        .values({
          id: input.id,
          user_id: input.userId,
          channel: input.channel,
          cadence: input.cadence,
          window_start_utc: input.window.windowStartUtc,
          window_end_utc: input.window.windowEndUtc,
          dispatch_at_utc: input.window.dispatchAtUtc,
          status: 'open',
          rendered_item_ids: null,
          overflow_count: null,
          delivery_id: null,
          claim_token: null,
          claim_expires_at: null,
          created_at: input.now,
          updated_at: input.now,
        })
        .onConflict((conflict) =>
          conflict.columns(['user_id', 'channel', 'cadence', 'window_start_utc']).doNothing()
        )
        .returningAll()
        .executeTakeFirst();

      if (inserted !== undefined) {
        return ok(mapDigestBatch(inserted as unknown as Record<string, unknown>));
      }

      const existing = await this.db
        .selectFrom('notification_digest_batches')
        .selectAll()
        .where('user_id', '=', input.userId)
        .where('channel', '=', input.channel)
        .where('cadence', '=', input.cadence)
        .where('window_start_utc', '=', input.window.windowStartUtc)
        .executeTakeFirst();
      if (existing === undefined) {
        return err(
          toDatabaseError('Find digest batch after idempotency conflict', new Error('row missing'))
        );
      }
      return ok(mapDigestBatch(existing as unknown as Record<string, unknown>));
    } catch (error) {
      return err(toDatabaseError('Find or create open notification digest batch', error));
    }
  }

  public async addMemberIdempotent(input: Parameters<DigestBatchRepo['addMemberIdempotent']>[0]) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const batch = await transaction
          .selectFrom('notification_digest_batches')
          .select(['id', 'status'])
          .where('id', '=', input.batchId)
          .forUpdate()
          .executeTakeFirst();
        if (batch === undefined) {
          return err(createNotFoundError('digest batch', input.batchId));
        }
        if (batch.status !== 'open') {
          return ok<'added' | 'duplicate' | 'rejected'>('rejected');
        }
        const inserted = await transaction
          .insertInto('notification_digest_members')
          .values({
            batch_id: input.batchId,
            logical_notification_id: input.logicalNotificationId,
            created_at: input.now,
          })
          .onConflict((conflict) =>
            conflict.columns(['batch_id', 'logical_notification_id']).doNothing()
          )
          .returning('batch_id')
          .executeTakeFirst();
        return ok<'added' | 'duplicate' | 'rejected'>(
          inserted === undefined ? 'duplicate' : 'added'
        );
      });
    } catch (error) {
      return err(toDatabaseError('Add notification digest member', error));
    }
  }

  public async claimDue(input: Parameters<DigestBatchRepo['claimDue']>[0]) {
    try {
      const result = await sql<Record<string, unknown>>`
        WITH candidates AS (
          SELECT id
          FROM notification_digest_batches
          WHERE (
              status = 'open'
              OR (status = 'materializing' AND claim_expires_at < ${input.now})
            )
            AND dispatch_at_utc <= ${input.now}
          ORDER BY dispatch_at_utc, id
          FOR UPDATE SKIP LOCKED
          LIMIT ${input.limit}
        )
        UPDATE notification_digest_batches AS batches
        SET status = 'materializing',
            claim_token = ${input.claimToken}::uuid,
            claim_expires_at = ${input.now}::timestamptz + (${input.leaseSeconds} * interval '1 second'),
            updated_at = ${input.now}
        FROM candidates
        WHERE batches.id = candidates.id
        RETURNING batches.*
      `.execute(this.db);
      return ok(result.rows.map(mapDigestBatch));
    } catch (error) {
      return err(toDatabaseError('Claim due notification digest batches', error));
    }
  }

  public async listMembersNewestFirst(
    input: Parameters<DigestBatchRepo['listMembersNewestFirst']>[0]
  ) {
    try {
      const [rows, count] = await Promise.all([
        this.db
          .selectFrom('notification_digest_members as members')
          .innerJoin(
            'logical_notifications as logical',
            'logical.id',
            'members.logical_notification_id'
          )
          .selectAll('logical')
          .where('members.batch_id', '=', input.batchId)
          .orderBy('logical.created_at', 'desc')
          .orderBy('logical.id', 'desc')
          .limit(input.limit)
          .execute(),
        this.db
          .selectFrom('notification_digest_members')
          .select(sql<string>`count(*)`.as('count'))
          .where('batch_id', '=', input.batchId)
          .executeTakeFirstOrThrow(),
      ]);
      return ok({
        items: rows.map((row) => mapLogicalNotification(row as unknown as Record<string, unknown>)),
        totalCount: Number(count.count),
      });
    } catch (error) {
      return err(toDatabaseError('List notification digest members', error));
    }
  }

  public async markRendered(input: Parameters<DigestBatchRepo['markRendered']>[0]) {
    try {
      const result = await this.db
        .updateTable('notification_digest_batches')
        .set({
          status: 'rendered',
          rendered_item_ids: input.renderedItemIds,
          overflow_count: input.overflowCount,
          delivery_id: input.deliveryId,
          claim_token: null,
          claim_expires_at: null,
          updated_at: input.now,
        })
        .where('id', '=', input.batchId)
        .where('status', '=', 'materializing')
        .where('claim_token', '=', input.expectedClaimToken)
        .executeTakeFirst();
      return ok(result.numUpdatedRows > 0n);
    } catch (error) {
      return err(toDatabaseError('Mark notification digest batch rendered', error));
    }
  }

  public async cancelWholeBatch(input: Parameters<DigestBatchRepo['cancelWholeBatch']>[0]) {
    try {
      return await this.db.transaction().execute(async (transaction) => {
        const batch = await transaction
          .selectFrom('notification_digest_batches')
          .select(['id', 'status', 'delivery_id'])
          .where('id', '=', input.batchId)
          .forUpdate()
          .executeTakeFirst();
        if (batch === undefined || batch.status === 'cancelled') {
          return ok(false);
        }
        await transaction
          .updateTable('notification_digest_batches')
          .set({
            status: 'cancelled',
            claim_token: null,
            claim_expires_at: null,
            updated_at: input.now,
          })
          .where('id', '=', batch.id)
          .execute();
        if (batch.delivery_id !== null) {
          await transaction
            .updateTable('notification_deliveries')
            .set({
              status: 'cancelled',
              last_error_code: input.reason,
              last_error_message: input.reason,
              terminal_at: input.now,
              claim_token: null,
              claim_expires_at: null,
              updated_at: input.now,
            })
            .where('id', '=', batch.delivery_id)
            .where('status', 'in', [
              'pending_render',
              'scheduled',
              'ready',
              'sending',
              'retry_wait',
              'accepted',
            ])
            .execute();
        }
        return ok(true);
      });
    } catch (error) {
      return err(toDatabaseError('Cancel whole notification digest batch', error));
    }
  }
}

export const makeDigestBatchRepo = (db: UserDbClient): DigestBatchRepo =>
  new KyselyDigestBatchRepo(db);
