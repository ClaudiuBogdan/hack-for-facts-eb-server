import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import { type UserDbClient } from '@/infra/database/client.js';
import { acquireUserDataOwnerLock } from '@/infra/database/user/advisory-locks.js';

import { createDatabaseError } from '../../core/errors.js';
import { type UserDataErasurePort } from '../../core/ports.js';
import { type ResolvedRedactors } from '../../core/types.js';

const redactAnnotations = (
  category: string,
  annotations: Record<string, Record<string, unknown>> | null,
  redactors: ResolvedRedactors
): Record<string, Record<string, unknown>> | null => {
  if (annotations === null) return null;
  const namespaceRedactors = redactors.annotationsByCategory[category] ?? {};
  return Object.fromEntries(
    Object.entries(annotations).map(([namespace, annotation]) => [
      namespace,
      namespaceRedactors[namespace]?.(annotation) ?? annotation,
    ])
  );
};

const redactPayload = (
  category: string,
  payload: Record<string, unknown> | null,
  redactors: ResolvedRedactors
): Record<string, unknown> | null => {
  if (payload === null) return null;
  return redactors.payloadByCategory[category]?.(payload) ?? payload;
};

export const makeUserDataErasureRepo = (deps: { db: UserDbClient }): UserDataErasurePort => {
  const { db } = deps;
  return {
    eraseOwner: async (input) => {
      try {
        const counts = await db.transaction().execute(async (trx) => {
          await acquireUserDataOwnerLock(trx, input.ownerId);
          await sql`SET LOCAL app.user_data_maintenance = 'on'`.execute(trx);

          const records = await trx
            .selectFrom('user_data_records')
            .select(['record_id', 'category', 'status', 'payload', 'annotations'])
            .where('owner_id', '=', input.ownerId)
            .execute();
          for (const record of records) {
            const active = record.status === 'active';
            await trx
              .updateTable('user_data_records')
              .set({
                owner_id: input.anonymizedOwnerId,
                payload: active
                  ? redactPayload(record.category, record.payload, input.redactors)
                  : null,
                annotations: active
                  ? redactAnnotations(record.category, record.annotations, input.redactors)
                  : null,
                privacy_redacted_at: input.now,
              })
              .where('record_id', '=', record.record_id)
              .executeTakeFirst();
          }

          const events = await trx
            .selectFrom('user_data_events')
            .select(['event_seq', 'category', 'payload', 'annotations'])
            .where('owner_id', '=', input.ownerId)
            .execute();
          for (const event of events) {
            await trx
              .updateTable('user_data_events')
              .set({
                owner_id: input.anonymizedOwnerId,
                payload: redactPayload(event.category, event.payload, input.redactors),
                annotations: redactAnnotations(event.category, event.annotations, input.redactors),
                client_occurred_at: null,
                source_event_id: null,
                source_occurred_at: null,
                privacy_redacted_at: input.now,
              })
              .where('event_seq', '=', event.event_seq)
              .executeTakeFirst();
          }

          const receiptResult = await trx
            .deleteFrom('user_data_idempotency_receipts')
            .where('requester_id', '=', input.ownerId)
            .executeTakeFirst();
          return {
            records: records.length,
            events: events.length,
            receipts: Number(receiptResult.numDeletedRows),
          };
        });
        return ok(counts);
      } catch {
        return err(createDatabaseError('Failed to erase user-data owner', true));
      }
    },
  };
};
