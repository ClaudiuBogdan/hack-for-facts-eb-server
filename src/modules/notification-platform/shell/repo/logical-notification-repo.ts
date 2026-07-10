import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  decodeTimestampCursor,
  encodeTimestampCursor,
  mapLogicalNotification,
  toDatabaseError,
} from './repo-helpers.js';
import { createValidationError } from '../../core/shared/errors.js';

import type { LogicalNotificationRepo } from '../../core/inbox/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';

export class KyselyLogicalNotificationRepo implements LogicalNotificationRepo {
  public constructor(private readonly db: UserDbClient) {}

  public async insertBatchIdempotent(
    rows: Parameters<LogicalNotificationRepo['insertBatchIdempotent']>[0]
  ) {
    if (rows.length === 0) {
      return ok({ createdIds: [], duplicateCount: 0 });
    }

    try {
      const inserted = await this.db
        .insertInto('logical_notifications')
        .values(
          rows.map((row) => ({
            id: row.id,
            event_id: row.eventId,
            kind_id: row.kindId,
            kind_version: row.kindVersion,
            user_id: row.userId,
            eligibility_reason: row.eligibilityReason,
            locale: row.locale,
            recipient_facts: row.recipientFacts,
            inbox_template_id: row.inboxTemplateId,
            inbox_template_version: row.inboxTemplateVersion,
            inbox_title: row.inboxTitle,
            inbox_body: row.inboxBody,
            inbox_action_url: row.inboxActionUrl,
            inbox_visible: row.inboxVisible,
            read_at: null,
            archived_at: null,
            stream_key: row.streamKey,
            stream_sequence: row.streamSequence,
            created_at: row.createdAt,
            retention_expires_at: row.retentionExpiresAt,
          }))
        )
        .onConflict((conflict) => conflict.columns(['event_id', 'kind_id', 'user_id']).doNothing())
        .returning('id')
        .execute();

      return ok({
        createdIds: inserted.map((row) => row.id),
        duplicateCount: rows.length - inserted.length,
      });
    } catch (error) {
      return err(toDatabaseError('Insert logical notification batch', error));
    }
  }

  public async findByIdForUser(id: string, userId: string) {
    try {
      const row = await this.db
        .selectFrom('logical_notifications')
        .selectAll()
        .where('id', '=', id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return ok(
        row === undefined ? null : mapLogicalNotification(row as unknown as Record<string, unknown>)
      );
    } catch (error) {
      return err(toDatabaseError('Find logical notification for user', error));
    }
  }

  public async findByIds(ids: string[]) {
    if (ids.length === 0) {
      return ok([]);
    }
    try {
      const rows = await this.db
        .selectFrom('logical_notifications')
        .selectAll()
        .where('id', 'in', ids)
        .execute();
      return ok(
        rows.map((row) => mapLogicalNotification(row as unknown as Record<string, unknown>))
      );
    } catch (error) {
      return err(toDatabaseError('Find logical notifications by ids', error));
    }
  }

  public async listForUser(input: Parameters<LogicalNotificationRepo['listForUser']>[0]) {
    const cursor = input.cursor === null ? null : decodeTimestampCursor(input.cursor);
    if (input.cursor !== null && cursor === null) {
      return err(createValidationError('Invalid logical notification cursor', 'cursor'));
    }

    try {
      const rows = await this.db
        .selectFrom('logical_notifications')
        .selectAll()
        .where('user_id', '=', input.userId)
        .where('inbox_visible', '=', true)
        .$if(input.view === 'all', (builder) => builder.where('archived_at', 'is', null))
        .$if(input.view === 'unread', (builder) =>
          builder.where('read_at', 'is', null).where('archived_at', 'is', null)
        )
        .$if(input.view === 'archived', (builder) => builder.where('archived_at', 'is not', null))
        .$if(cursor !== null, (builder) =>
          builder.where(
            sql<boolean>`(created_at, id) < (${cursor?.date ?? new Date(0)}, ${cursor?.id ?? ''}::uuid)`
          )
        )
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(input.limit + 1)
        .execute();

      const hasNext = rows.length > input.limit;
      if (hasNext) {
        rows.pop();
      }
      const items = rows.map((row) =>
        mapLogicalNotification(row as unknown as Record<string, unknown>)
      );
      const last = items.at(-1);
      return ok({
        items,
        nextCursor:
          hasNext && last !== undefined ? encodeTimestampCursor(last.createdAt, last.id) : null,
      });
    } catch (error) {
      return err(toDatabaseError('List logical notifications for user', error));
    }
  }

  public async countUnread(userId: string) {
    try {
      const row = await this.db
        .selectFrom('logical_notifications')
        .select(sql<string>`count(*)`.as('count'))
        .where('user_id', '=', userId)
        .where('read_at', 'is', null)
        .where('archived_at', 'is', null)
        .where('inbox_visible', '=', true)
        .executeTakeFirstOrThrow();
      return ok(Number(row.count));
    } catch (error) {
      return err(toDatabaseError('Count unread logical notifications', error));
    }
  }

  public async setReadState(input: Parameters<LogicalNotificationRepo['setReadState']>[0]) {
    try {
      const result = await this.db
        .updateTable('logical_notifications')
        .set({ read_at: input.readAt })
        .where('id', '=', input.id)
        .where('user_id', '=', input.userId)
        .executeTakeFirst();
      return ok(result.numUpdatedRows > 0n);
    } catch (error) {
      return err(toDatabaseError('Set logical notification read state', error));
    }
  }

  public async markAllRead(input: Parameters<LogicalNotificationRepo['markAllRead']>[0]) {
    try {
      const result = await this.db
        .updateTable('logical_notifications')
        .set({ read_at: input.now })
        .where('user_id', '=', input.userId)
        .where('read_at', 'is', null)
        .where('archived_at', 'is', null)
        .where('inbox_visible', '=', true)
        .executeTakeFirst();
      return ok(Number(result.numUpdatedRows));
    } catch (error) {
      return err(toDatabaseError('Mark all logical notifications read', error));
    }
  }

  public async setArchivedState(input: Parameters<LogicalNotificationRepo['setArchivedState']>[0]) {
    try {
      const result = await this.db
        .updateTable('logical_notifications')
        .set({ archived_at: input.archivedAt })
        .where('id', '=', input.id)
        .where('user_id', '=', input.userId)
        .executeTakeFirst();
      return ok(result.numUpdatedRows > 0n);
    } catch (error) {
      return err(toDatabaseError('Set logical notification archived state', error));
    }
  }

  public async listByEvent(eventId: string) {
    try {
      const rows = await this.db
        .selectFrom('logical_notifications')
        .selectAll()
        .where('event_id', '=', eventId)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute();
      return ok(
        rows.map((row) => mapLogicalNotification(row as unknown as Record<string, unknown>))
      );
    } catch (error) {
      return err(toDatabaseError('List logical notifications by event', error));
    }
  }
}

export const makeLogicalNotificationRepo = (db: UserDbClient): LogicalNotificationRepo =>
  new KyselyLogicalNotificationRepo(db);
