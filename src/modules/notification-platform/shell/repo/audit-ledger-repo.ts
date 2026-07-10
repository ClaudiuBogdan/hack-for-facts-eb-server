import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  decodeTimestampCursor,
  encodeTimestampCursor,
  mapAuditEntry,
  toDatabaseError,
} from './repo-helpers.js';
import { createValidationError } from '../../core/shared/errors.js';

import type { AuditLedgerPort } from '../../core/audit/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';

export class KyselyAuditLedgerRepo implements AuditLedgerPort {
  public constructor(private readonly db: UserDbClient) {}

  public async append(entry: Parameters<AuditLedgerPort['append']>[0]) {
    try {
      await this.db
        .insertInto('notification_audit_log')
        .values({
          occurred_at: entry.occurredAt,
          action: entry.action,
          actor: entry.actor,
          user_id: entry.userId ?? null,
          event_id: entry.eventId ?? null,
          logical_notification_id: entry.logicalNotificationId ?? null,
          delivery_id: entry.deliveryId ?? null,
          batch_id: entry.batchId ?? null,
          subscription_id: entry.subscriptionId ?? null,
          reason: entry.reason ?? null,
          details: entry.details ?? {},
        })
        .execute();
      return ok(undefined);
    } catch (error) {
      return err(toDatabaseError('Append notification audit entry', error));
    }
  }

  public async listByEntity(input: Parameters<AuditLedgerPort['listByEntity']>[0]) {
    const cursor = input.cursor === null ? null : decodeTimestampCursor(input.cursor);
    if (input.cursor !== null && cursor === null) {
      return err(createValidationError('Invalid notification audit cursor', 'cursor'));
    }

    try {
      const rows = await this.db
        .selectFrom('notification_audit_log')
        .selectAll()
        .$if(input.eventId !== undefined, (builder) =>
          builder.where('event_id', '=', input.eventId ?? '')
        )
        .$if(input.deliveryId !== undefined, (builder) =>
          builder.where('delivery_id', '=', input.deliveryId ?? '')
        )
        .$if(input.userId !== undefined, (builder) =>
          builder.where('user_id', '=', input.userId ?? '')
        )
        .$if(cursor !== null, (builder) =>
          builder.where(
            sql<boolean>`(occurred_at, id) < (${cursor?.date ?? new Date(0)}, ${cursor?.id ?? '0'}::bigint)`
          )
        )
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(input.limit + 1)
        .execute();

      const hasNext = rows.length > input.limit;
      if (hasNext) {
        rows.pop();
      }
      const items = rows.map((row) => mapAuditEntry(row as unknown as Record<string, unknown>));
      const last = items.at(-1);
      return ok({
        items,
        nextCursor:
          hasNext && last !== undefined ? encodeTimestampCursor(last.occurredAt, last.id) : null,
      });
    } catch (error) {
      return err(toDatabaseError('List notification audit entries by entity', error));
    }
  }
}

export const makeAuditLedgerRepo = (db: UserDbClient): AuditLedgerPort =>
  new KyselyAuditLedgerRepo(db);
