import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import { mapNotificationEvent, toDatabaseError } from './repo-helpers.js';

import type { NotificationEventRepo } from '../../core/events/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';

export class KyselyNotificationEventRepo implements NotificationEventRepo {
  public constructor(private readonly db: UserDbClient) {}

  public async insertOrFind(input: Parameters<NotificationEventRepo['insertOrFind']>[0]) {
    try {
      const inserted = await this.db
        .insertInto('notification_events')
        .values({
          id: input.id,
          source: input.source,
          event_type: input.eventType,
          event_schema_version: input.eventSchemaVersion,
          occurrence_key: input.occurrenceKey,
          occurred_at: input.occurredAt,
          facts: input.facts,
          payload_hash: input.payloadHash,
          correlation_id: input.correlationId ?? null,
          causation_id: input.causationId ?? null,
          stream_key: input.streamKey,
          stream_sequence: input.streamSequence,
          retention_expires_at: input.retentionExpiresAt,
          resolution_cursor: null,
          claim_token: null,
          claim_expires_at: null,
          resolved_at: null,
        })
        .onConflict((conflict) =>
          conflict.columns(['source', 'event_type', 'occurrence_key']).doNothing()
        )
        .returningAll()
        .executeTakeFirst();

      if (inserted !== undefined) {
        return ok({
          event: mapNotificationEvent(inserted as unknown as Record<string, unknown>),
          created: true,
          payloadConflict: false,
        });
      }

      const existing = await this.db
        .selectFrom('notification_events')
        .selectAll()
        .where('source', '=', input.source)
        .where('event_type', '=', input.eventType)
        .where('occurrence_key', '=', input.occurrenceKey)
        .executeTakeFirst();

      if (existing === undefined) {
        return err(
          toDatabaseError(
            'Find notification event after idempotency conflict',
            new Error('row missing')
          )
        );
      }

      return ok({
        event: mapNotificationEvent(existing as unknown as Record<string, unknown>),
        created: false,
        payloadConflict: existing.payload_hash !== input.payloadHash,
      });
    } catch (error) {
      return err(toDatabaseError('Insert or find notification event', error));
    }
  }

  public async findById(eventId: string) {
    try {
      const row = await this.db
        .selectFrom('notification_events')
        .selectAll()
        .where('id', '=', eventId)
        .executeTakeFirst();
      return ok(
        row === undefined ? null : mapNotificationEvent(row as unknown as Record<string, unknown>)
      );
    } catch (error) {
      return err(toDatabaseError('Find notification event by id', error));
    }
  }

  public async claimForResolution(
    input: Parameters<NotificationEventRepo['claimForResolution']>[0]
  ) {
    try {
      const result = await sql<Record<string, unknown>>`
        UPDATE notification_events
        SET status = 'resolving',
            claim_token = ${input.claimToken}::uuid,
            claim_expires_at = ${input.now}::timestamptz + (${input.leaseSeconds} * interval '1 second'),
            updated_at = ${input.now}
        WHERE id = ${input.eventId}::uuid
          AND (
            status = 'pending'
            OR (status = 'resolving' AND claim_expires_at < ${input.now})
          )
        RETURNING *
      `.execute(this.db);
      const row = result.rows[0];
      return ok(row === undefined ? null : mapNotificationEvent(row));
    } catch (error) {
      return err(toDatabaseError('Claim notification event for resolution', error));
    }
  }

  public async saveResolutionCursor(
    input: Parameters<NotificationEventRepo['saveResolutionCursor']>[0]
  ) {
    try {
      const result = await this.db
        .updateTable('notification_events')
        .set({ resolution_cursor: input.cursor, updated_at: new Date() })
        .where('id', '=', input.eventId)
        .where('status', '=', 'resolving')
        .where('claim_token', '=', input.expectedClaimToken)
        .executeTakeFirst();
      return ok(result.numUpdatedRows > 0n);
    } catch (error) {
      return err(toDatabaseError('Save notification event resolution cursor', error));
    }
  }

  public async markResolved(input: Parameters<NotificationEventRepo['markResolved']>[0]) {
    try {
      const result = await this.db
        .updateTable('notification_events')
        .set({
          status: 'resolved',
          resolved_at: input.now,
          claim_token: null,
          claim_expires_at: null,
          updated_at: input.now,
        })
        .where('id', '=', input.eventId)
        .where('status', '=', 'resolving')
        .where('claim_token', '=', input.expectedClaimToken)
        .executeTakeFirst();
      return ok(result.numUpdatedRows > 0n);
    } catch (error) {
      return err(toDatabaseError('Mark notification event resolved', error));
    }
  }

  public async markConflicted(eventId: string) {
    try {
      await this.db
        .updateTable('notification_events')
        .set({
          status: 'conflicted',
          claim_token: null,
          claim_expires_at: null,
          updated_at: new Date(),
        })
        .where('id', '=', eventId)
        .execute();
      return ok(undefined);
    } catch (error) {
      return err(toDatabaseError('Mark notification event conflicted', error));
    }
  }

  public async findUnresolvedOlderThan(
    input: Parameters<NotificationEventRepo['findUnresolvedOlderThan']>[0]
  ) {
    try {
      const rows = await this.db
        .selectFrom('notification_events')
        .selectAll()
        .where('status', 'in', ['pending', 'resolving'])
        .where('created_at', '<', input.olderThan)
        .orderBy('created_at', 'asc')
        .limit(input.limit)
        .execute();
      return ok(rows.map((row) => mapNotificationEvent(row as unknown as Record<string, unknown>)));
    } catch (error) {
      return err(toDatabaseError('Find unresolved notification events', error));
    }
  }
}

export const makeNotificationEventRepo = (db: UserDbClient): NotificationEventRepo =>
  new KyselyNotificationEventRepo(db);
