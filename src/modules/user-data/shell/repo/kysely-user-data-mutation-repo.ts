import { sql, type Transaction } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { type Clock } from '@/common/ports/clock.js';
import { type UserDbClient } from '@/infra/database/client.js';
import { acquireUserDataOwnerLock } from '@/infra/database/user/advisory-locks.js';
import { type UserDatabase } from '@/infra/database/user/types.js';

import { type UserDataError } from '../../core/errors.js';
import {
  type MutationOutcome,
  type MutationResultData,
  type UserDataMutationPort,
} from '../../core/ports.js';
import {
  type ActorContext,
  type CurrentRecord,
  type PlannedMutation,
  type ReceiptClaim,
  type UserDataEvent,
} from '../../core/types.js';

type CommitPhase = 'receiptCheck' | 'rowLock' | 'quota' | 'snapshot' | 'event' | 'receipt';

export interface UserDataCommitTestHooks {
  beforePhase?(phase: CommitPhase): Promise<void>;
}

interface ReceiptRow {
  requester_id: string;
  idempotency_key_hash: string;
  canonical_request_hash: string;
  event_id: string;
  event_seq: string;
  created_at: Date;
  expires_at: Date;
}

type UserDataTransaction = Transaction<UserDatabase>;
type OutsideDecision =
  | { kind: 'snapshotConflict'; plan: PlannedMutation }
  | { kind: 'receiptConflict'; claim: ReceiptClaim };

class ControlledRollback extends Error {
  public constructor(public readonly decision: OutsideDecision) {
    super('Controlled user-data transaction rollback');
  }
}

/** Carries a typed UserDataError across a transaction abort (throwing plain objects is banned). */
export class UserDataErrorSignal extends Error {
  public constructor(public readonly userDataError: UserDataError) {
    super(`User-data error signal: ${userDataError.type}`);
  }
}

const databaseError = (message: string): UserDataError => ({
  type: 'DatabaseError',
  message,
  retryable: true,
});

export const mapUserDataRecordRow = (row: {
  record_id: string;
  owner_id: string;
  category: string;
  logical_key: string;
  target_type: string | null;
  target_id: string | null;
  schema_version: number;
  schema_hash: string;
  revision: string;
  status: 'active' | 'deleted';
  payload: Record<string, unknown> | null;
  annotations: Record<string, Record<string, unknown>> | null;
  last_event_seq: string;
  last_event_id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  privacy_redacted_at: Date | null;
}): CurrentRecord => ({
  recordId: row.record_id,
  identity: {
    ownerId: row.owner_id,
    category: row.category,
    logicalKey: row.logical_key,
  },
  target:
    row.target_type === null || row.target_id === null
      ? null
      : { targetType: row.target_type, targetId: row.target_id },
  schemaVersion: row.schema_version,
  schemaHash: row.schema_hash,
  revision: Number(row.revision),
  status: row.status,
  payload: row.payload,
  annotations: row.annotations,
  lastEventSeq: row.last_event_seq,
  lastEventId: row.last_event_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  privacyRedactedAt: row.privacy_redacted_at,
});

const mapActor = (row: {
  actor_type: 'owner' | 'system' | 'admin';
  actor_id: string | null;
  actor_reason: string | null;
}): ActorContext => {
  if (row.actor_type === 'owner') return { type: 'owner' };
  if (row.actor_type === 'system') return { type: 'system', source: row.actor_id ?? 'unknown' };
  return { type: 'admin', actorId: row.actor_id ?? '', reason: row.actor_reason ?? '' };
};

export const mapUserDataEventRow = (row: {
  event_seq: string;
  event_id: string;
  record_id: string;
  owner_id: string;
  category: string;
  logical_key: string;
  target_type: string | null;
  target_id: string | null;
  revision: string;
  operation: UserDataEvent['operation'];
  scope: UserDataEvent['scope'];
  annotation_namespace: string | null;
  schema_version: number;
  schema_hash: string;
  payload: Record<string, unknown> | null;
  annotations: Record<string, Record<string, unknown>> | null;
  actor_type: 'owner' | 'system' | 'admin';
  actor_id: string | null;
  actor_reason: string | null;
  provenance: UserDataEvent['provenance'];
  integrity: UserDataEvent['integrity'];
  recorded_at: Date;
  client_occurred_at: Date | null;
  privacy_redacted_at: Date | null;
}): UserDataEvent => ({
  eventSeq: row.event_seq,
  eventId: row.event_id,
  recordId: row.record_id,
  identity: {
    ownerId: row.owner_id,
    category: row.category,
    logicalKey: row.logical_key,
  },
  target:
    row.target_type === null || row.target_id === null
      ? null
      : { targetType: row.target_type, targetId: row.target_id },
  revision: Number(row.revision),
  operation: row.operation,
  scope: row.scope,
  annotationNamespace: row.annotation_namespace,
  schemaVersion: row.schema_version,
  schemaHash: row.schema_hash,
  payload: row.payload,
  annotations: row.annotations,
  actor: mapActor(row),
  provenance: row.provenance,
  integrity: row.integrity,
  recordedAt: row.recorded_at,
  clientOccurredAt: row.client_occurred_at,
  privacyRedactedAt: row.privacy_redacted_at,
});

const selectRecordByIdentity = async (
  db: UserDbClient | UserDataTransaction,
  identity: PlannedMutation['identity'],
  forUpdate: boolean
): Promise<CurrentRecord | null> => {
  let query = db
    .selectFrom('user_data_records')
    .selectAll()
    .where('owner_id', '=', identity.ownerId)
    .where('category', '=', identity.category)
    .where('logical_key', '=', identity.logicalKey);
  if (forUpdate) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  return row === undefined ? null : mapUserDataRecordRow(row);
};

const selectReceipt = async (
  db: UserDbClient | UserDataTransaction,
  claim: ReceiptClaim
): Promise<ReceiptRow | null> => {
  const row = await db
    .selectFrom('user_data_idempotency_receipts')
    .selectAll()
    .where('requester_id', '=', claim.requesterId)
    .where('idempotency_key_hash', '=', claim.idempotencyKeyHash)
    .executeTakeFirst();
  return row ?? null;
};

const buildResultFromEvent = async (
  db: UserDbClient | UserDataTransaction,
  eventId: string
): Promise<MutationResultData> => {
  const row = await db
    .selectFrom('user_data_events as event')
    .innerJoin('user_data_records as record', 'record.record_id', 'event.record_id')
    .select([
      'event.event_seq',
      'event.event_id',
      'event.record_id',
      'event.owner_id',
      'event.category',
      'event.logical_key',
      'event.target_type',
      'event.target_id',
      'event.revision',
      'event.operation',
      'event.scope',
      'event.annotation_namespace',
      'event.schema_version',
      'event.schema_hash',
      'event.payload',
      'event.annotations',
      'event.actor_type',
      'event.actor_id',
      'event.actor_reason',
      'event.provenance',
      'event.integrity',
      'event.recorded_at',
      'event.client_occurred_at',
      'event.privacy_redacted_at',
      'record.created_at',
    ])
    .where('event.event_id', '=', eventId)
    .executeTakeFirstOrThrow();
  const event = mapUserDataEventRow(row);
  const deleted = event.operation === 'delete';
  return {
    record: {
      recordId: event.recordId,
      identity: event.identity,
      target: event.target,
      schemaVersion: event.schemaVersion,
      schemaHash: event.schemaHash,
      revision: event.revision,
      status: deleted ? 'deleted' : 'active',
      payload: event.payload,
      annotations: event.annotations,
      lastEventSeq: event.eventSeq,
      lastEventId: event.eventId,
      createdAt: row.created_at,
      updatedAt: event.recordedAt,
      deletedAt: deleted ? event.recordedAt : null,
      privacyRedactedAt: event.privacyRedactedAt,
    },
    eventId: event.eventId,
    eventSeq: event.eventSeq,
    recordedAt: event.recordedAt,
  };
};

const actorColumns = (
  actor: ActorContext
): { actorId: string | null; actorReason: string | null } => {
  if (actor.type === 'owner') return { actorId: null, actorReason: null };
  if (actor.type === 'system') return { actorId: actor.source, actorReason: null };
  return { actorId: actor.actorId, actorReason: actor.reason };
};

const before = async (hooks: UserDataCommitTestHooks | undefined, phase: CommitPhase) => {
  await hooks?.beforePhase?.(phase);
};

export const makeUserDataMutationRepo = (deps: {
  db: UserDbClient;
  clock: Clock;
  /** Tests only; never wired in build-app. */
  testHooks?: UserDataCommitTestHooks;
}): UserDataMutationPort => {
  const { db, clock, testHooks } = deps;

  const decideReceipt = async (
    connection: UserDbClient | UserDataTransaction,
    claim: ReceiptClaim,
    now: Date
  ): Promise<MutationOutcome | null> => {
    const receipt = await selectReceipt(connection, claim);
    if (receipt === null || receipt.expires_at.getTime() <= now.getTime()) return null;
    if (receipt.canonical_request_hash !== claim.canonicalRequestHash)
      return { kind: 'idempotencyConflict' };
    return { kind: 'replayed', result: await buildResultFromEvent(connection, receipt.event_id) };
  };

  const outsideDecision = async (decision: OutsideDecision): Promise<MutationOutcome> => {
    if (decision.kind === 'snapshotConflict') {
      const current = await selectRecordByIdentity(db, decision.plan.identity, false);
      if (current === null) throw new Error('CAS row disappeared after concurrent write');
      return { kind: 'revisionConflict', current };
    }
    const receiptOutcome = await decideReceipt(db, decision.claim, clock.now());
    if (receiptOutcome === null) throw new Error('Receipt disappeared after concurrent write');
    return receiptOutcome;
  };

  return {
    getForMutation: async (identity) => {
      try {
        return ok(await selectRecordByIdentity(db, identity, false));
      } catch {
        return err(databaseError('Failed to load user-data record'));
      }
    },

    probeReceipt: async (claim) => {
      try {
        const receipt = await selectReceipt(db, claim);
        if (receipt === null || receipt.expires_at.getTime() <= clock.now().getTime())
          return ok('absent');
        return ok(
          receipt.canonical_request_hash === claim.canonicalRequestHash ? 'match' : 'mismatch'
        );
      } catch {
        return err(databaseError('Failed to probe user-data receipt'));
      }
    },

    deleteExpiredReceipts: async (now) => {
      try {
        const result = await db
          .deleteFrom('user_data_idempotency_receipts')
          .where('expires_at', '<=', now)
          .executeTakeFirst();
        return ok(Number(result.numDeletedRows));
      } catch {
        return err(databaseError('Failed to delete expired user-data receipts'));
      }
    },

    commit: async (plan): Promise<Result<MutationOutcome, UserDataError>> => {
      try {
        const outcome = await db.transaction().execute(async (trx) => {
          await acquireUserDataOwnerLock(trx, plan.identity.ownerId);

          await before(testHooks, 'receiptCheck');
          const now = clock.now();
          const receiptOutcome = await decideReceipt(trx, plan.receipt, now);
          if (receiptOutcome !== null) return receiptOutcome;

          await before(testHooks, 'rowLock');
          const current = await selectRecordByIdentity(trx, plan.identity, true);
          if (plan.expectedRevision === 0 && current !== null)
            return { kind: 'revisionConflict', current } satisfies MutationOutcome;
          if (plan.expectedRevision !== 0 && current === null)
            throw new UserDataErrorSignal(databaseError('CAS row disappeared'));
          if (current !== null && current.revision !== plan.expectedRevision)
            return { kind: 'revisionConflict', current } satisfies MutationOutcome;

          await before(testHooks, 'quota');
          if (plan.operation === 'create' && plan.quota !== null) {
            const countRow = await trx
              .selectFrom('user_data_records')
              .select(({ fn }) => fn.countAll<string>().as('count'))
              .where('owner_id', '=', plan.identity.ownerId)
              .where('category', '=', plan.identity.category)
              .where('status', '=', 'active')
              .executeTakeFirstOrThrow();
            if (BigInt(countRow.count) >= BigInt(plan.quota.maxRecordsInCategory))
              return {
                kind: 'quotaExceeded',
                limit: plan.quota.maxRecordsInCategory,
              } satisfies MutationOutcome;
          }

          const sequenceResult = await sql<{ event_seq: string }>`
            select nextval('user_data_event_seq')::text as event_seq
          `.execute(trx);
          const eventSeq = sequenceResult.rows[0]?.event_seq;
          if (eventSeq === undefined) throw new Error('Sequence did not return a value');
          const recordedAt = clock.now();
          const deletedAt = plan.afterImage.status === 'deleted' ? recordedAt : null;

          await before(testHooks, 'snapshot');
          if (plan.expectedRevision === 0) {
            const inserted = await trx
              .insertInto('user_data_records')
              .values({
                record_id: plan.recordId,
                owner_id: plan.identity.ownerId,
                category: plan.identity.category,
                logical_key: plan.identity.logicalKey,
                target_type: plan.target?.targetType ?? null,
                target_id: plan.target?.targetId ?? null,
                schema_version: plan.afterImage.schemaVersion,
                schema_hash: plan.afterImage.schemaHash,
                revision: plan.nextRevision,
                status: plan.afterImage.status,
                payload: plan.afterImage.payload,
                annotations: plan.afterImage.annotations,
                last_event_seq: eventSeq,
                last_event_id: plan.eventId,
                created_at: recordedAt,
                updated_at: recordedAt,
                deleted_at: deletedAt,
                privacy_redacted_at: null,
              })
              .onConflict((conflict) =>
                conflict.columns(['owner_id', 'category', 'logical_key']).doNothing()
              )
              .returning('record_id')
              .executeTakeFirst();
            if (inserted === undefined)
              throw new ControlledRollback({ kind: 'snapshotConflict', plan });
          } else {
            const updated = await trx
              .updateTable('user_data_records')
              .set({
                schema_version: plan.afterImage.schemaVersion,
                schema_hash: plan.afterImage.schemaHash,
                revision: plan.nextRevision,
                status: plan.afterImage.status,
                payload: plan.afterImage.payload,
                annotations: plan.afterImage.annotations,
                last_event_seq: eventSeq,
                last_event_id: plan.eventId,
                updated_at: recordedAt,
                deleted_at: deletedAt,
              })
              .where('record_id', '=', plan.recordId)
              .where('revision', '=', String(plan.expectedRevision))
              .returning('record_id')
              .executeTakeFirst();
            if (updated === undefined)
              throw new ControlledRollback({ kind: 'snapshotConflict', plan });
          }

          await before(testHooks, 'event');
          const actor = actorColumns(plan.actor);
          await trx
            .insertInto('user_data_events')
            .values({
              event_seq: eventSeq,
              event_id: plan.eventId,
              record_id: plan.recordId,
              owner_id: plan.identity.ownerId,
              category: plan.identity.category,
              logical_key: plan.identity.logicalKey,
              target_type: plan.target?.targetType ?? null,
              target_id: plan.target?.targetId ?? null,
              revision: plan.nextRevision,
              operation: plan.operation,
              scope: plan.scope,
              annotation_namespace: plan.annotationNamespace,
              schema_version: plan.afterImage.schemaVersion,
              schema_hash: plan.afterImage.schemaHash,
              payload: plan.afterImage.payload,
              annotations: plan.afterImage.annotations,
              actor_type: plan.actor.type,
              actor_id: actor.actorId,
              actor_reason: actor.actorReason,
              provenance: 'live',
              integrity: 'verified',
              recorded_at: recordedAt,
              client_occurred_at: plan.clientOccurredAt,
              source_event_id: null,
              source_occurred_at: null,
              privacy_redacted_at: null,
            })
            .execute();

          await before(testHooks, 'receipt');
          const expiresAt = new Date(recordedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
          const receiptResult = await sql<{ requester_id: string }>`
            insert into user_data_idempotency_receipts (
              requester_id, idempotency_key_hash, canonical_request_hash,
              event_id, event_seq, created_at, expires_at
            ) values (
              ${plan.receipt.requesterId}, ${plan.receipt.idempotencyKeyHash},
              ${plan.receipt.canonicalRequestHash}, ${plan.eventId}::uuid,
              ${eventSeq}::bigint, ${recordedAt}, ${expiresAt}
            )
            on conflict (requester_id, idempotency_key_hash) do update set
              canonical_request_hash = excluded.canonical_request_hash,
              event_id = excluded.event_id,
              event_seq = excluded.event_seq,
              created_at = excluded.created_at,
              expires_at = excluded.expires_at
            where user_data_idempotency_receipts.expires_at <= ${now}
            returning requester_id
          `.execute(trx);
          if (receiptResult.rows[0] === undefined)
            throw new ControlledRollback({ kind: 'receiptConflict', claim: plan.receipt });

          return {
            kind: 'committed',
            result: await buildResultFromEvent(trx, plan.eventId),
          } satisfies MutationOutcome;
        });
        return ok(outcome);
      } catch (error) {
        if (error instanceof ControlledRollback) {
          try {
            return ok(await outsideDecision(error.decision));
          } catch {
            return err(databaseError('Failed to resolve concurrent user-data commit'));
          }
        }
        if (error instanceof UserDataErrorSignal) return err(error.userDataError);
        return err(databaseError('Failed to commit user-data mutation'));
      }
    },
  };
};
