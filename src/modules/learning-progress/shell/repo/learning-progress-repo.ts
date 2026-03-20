/**
 * Learning Progress Repository - Kysely Implementation
 *
 * Stores one row per user and per client-controlled record key.
 */

import { sql, type Transaction } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { createDatabaseError, type LearningProgressError } from '../../core/errors.js';

import type { LearningProgressRepository } from '../../core/ports.js';
import type {
  LearningProgressRecordRow,
  StoredInteractiveAuditEvent,
  UpsertInteractiveRecordInput,
  UpsertInteractiveRecordResult,
} from '../../core/types.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type {
  LearningProgressAuditEventRow,
  LearningProgressRecordValueRow,
  UserDatabase,
} from '@/infra/database/user/types.js';
import type { Logger } from 'pino';

export interface LearningProgressRepoOptions {
  db: UserDbConnection;
  logger: Logger;
  transactionScoped?: boolean;
}

const LEARNING_PROGRESS_ROW_COLUMNS = [
  'user_id',
  'record_key',
  'record',
  'audit_events',
  'updated_seq',
  'created_at',
  'updated_at',
] as const;

type UserDbConnection = UserDbClient | Transaction<UserDatabase>;

function sortAuditEvents(
  leftEvent: StoredInteractiveAuditEvent,
  rightEvent: StoredInteractiveAuditEvent
): number {
  const leftSeq = BigInt(leftEvent.seq);
  const rightSeq = BigInt(rightEvent.seq);

  if (leftSeq < rightSeq) return -1;
  if (leftSeq > rightSeq) return 1;

  return leftEvent.id.localeCompare(rightEvent.id);
}

function recordsAreEqual(
  leftRecord: LearningProgressRecordValueRow,
  rightRecord: LearningProgressRecordValueRow
): boolean {
  return JSON.stringify(leftRecord) === JSON.stringify(rightRecord);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function compareTimestamps(leftTimestamp: string, rightTimestamp: string): number {
  const leftValue = Date.parse(leftTimestamp);
  const rightValue = Date.parse(rightTimestamp);

  if (Number.isNaN(leftValue) || Number.isNaN(rightValue)) {
    return leftTimestamp.localeCompare(rightTimestamp);
  }

  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

class LearningProgressTransactionRollbackError extends Error {
  readonly failure: LearningProgressError;

  constructor(failure: LearningProgressError) {
    super('Learning progress transaction rolled back');
    this.failure = failure;
  }
}

class KyselyLearningProgressRepo implements LearningProgressRepository {
  private readonly db: UserDbConnection;
  private readonly log: Logger;
  private readonly transactionScoped: boolean;

  constructor(options: LearningProgressRepoOptions) {
    this.db = options.db;
    this.log = options.logger.child({ module: 'learning-progress-repo' });
    this.transactionScoped = options.transactionScoped ?? false;
  }

  async getRecords(
    userId: string
  ): Promise<Result<readonly LearningProgressRecordRow[], LearningProgressError>> {
    try {
      const rows = await this.db
        .selectFrom('learningprogress')
        .select(LEARNING_PROGRESS_ROW_COLUMNS)
        .where('user_id', '=', userId)
        .orderBy('updated_seq', 'asc')
        .execute();

      return ok(rows.map((row) => this.mapRow(row as unknown as QueryRow)));
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to load learning progress records');
      return err(createDatabaseError('Failed to load learning progress records', error));
    }
  }

  async upsertInteractiveRecord(
    input: UpsertInteractiveRecordInput
  ): Promise<Result<UpsertInteractiveRecordResult, LearningProgressError>> {
    try {
      if (!this.transactionScoped) {
        return await this.withTransaction((transactionalRepo) =>
          transactionalRepo.upsertInteractiveRecord(input)
        );
      }

      return await this.doUpsertInteractiveRecord(input);
    } catch (error) {
      this.log.error(
        { err: error, userId: input.userId, recordKey: input.record.key },
        'Failed to upsert learning progress record'
      );
      return err(createDatabaseError('Failed to upsert learning progress record', error));
    }
  }

  async resetProgress(userId: string): Promise<Result<void, LearningProgressError>> {
    try {
      await this.db.deleteFrom('learningprogress').where('user_id', '=', userId).execute();
      return ok(undefined);
    } catch (error) {
      this.log.error({ err: error, userId }, 'Failed to reset learning progress');
      return err(createDatabaseError('Failed to reset learning progress', error));
    }
  }

  async withTransaction<T>(
    callback: (repo: LearningProgressRepository) => Promise<Result<T, LearningProgressError>>
  ): Promise<Result<T, LearningProgressError>> {
    if (this.transactionScoped) {
      return callback(this);
    }

    try {
      const value = await this.db.transaction().execute(async (transaction) => {
        const transactionalRepo = new KyselyLearningProgressRepo({
          db: transaction,
          logger: this.log,
          transactionScoped: true,
        });
        const result = await callback(transactionalRepo);

        if (result.isErr()) {
          throw new LearningProgressTransactionRollbackError(result.error);
        }

        return result.value;
      });

      return ok(value);
    } catch (error) {
      if (error instanceof LearningProgressTransactionRollbackError) {
        return err(error.failure);
      }

      this.log.error({ err: error }, 'Failed to execute learning progress transaction');
      return err(createDatabaseError('Failed to execute learning progress transaction', error));
    }
  }

  private mapRow(row: QueryRow): LearningProgressRecordRow {
    return {
      userId: row.user_id,
      recordKey: row.record_key,
      record: row.record,
      auditEvents: [...row.audit_events].sort(sortAuditEvents),
      updatedSeq: row.updated_seq,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    };
  }

  private async doUpsertInteractiveRecord(
    input: UpsertInteractiveRecordInput
  ): Promise<Result<UpsertInteractiveRecordResult, LearningProgressError>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existingRow = await this.db
        .selectFrom('learningprogress')
        .select(LEARNING_PROGRESS_ROW_COLUMNS)
        .where('user_id', '=', input.userId)
        .where('record_key', '=', input.record.key)
        .forUpdate()
        .executeTakeFirst();

      if (existingRow === undefined) {
        const updatedSeq = await this.allocateSequence();
        const insertedRow = await this.db
          .insertInto('learningprogress')
          .values({
            user_id: input.userId,
            record_key: input.record.key,
            record: sql`${JSON.stringify(input.record)}::jsonb`,
            audit_events: sql`${JSON.stringify(
              input.auditEvents.map(
                (auditEvent): StoredInteractiveAuditEvent => ({
                  ...auditEvent,
                  seq: updatedSeq,
                  sourceClientEventId: input.eventId,
                  sourceClientId: input.clientId,
                })
              )
            )}::jsonb`,
            updated_seq: sql`${updatedSeq}::bigint`,
            created_at: new Date(input.record.updatedAt),
            updated_at: new Date(input.record.updatedAt),
          } as never)
          .onConflict((conflict) => conflict.columns(['user_id', 'record_key']).doNothing())
          .returning(LEARNING_PROGRESS_ROW_COLUMNS)
          .executeTakeFirst();

        if (insertedRow !== undefined) {
          return ok({
            applied: true,
            row: this.mapRow(insertedRow as unknown as QueryRow),
          });
        }

        continue;
      }

      const existingRecord = this.mapRow(existingRow as unknown as QueryRow);
      const hasDuplicateAuditEvent =
        input.auditEvents.length > 0 &&
        existingRecord.auditEvents.some(
          (auditEvent) => auditEvent.sourceClientEventId === input.eventId
        );
      const hasDuplicateRecordOnlyUpdate =
        input.auditEvents.length === 0 && recordsAreEqual(existingRecord.record, input.record);
      const isIncomingRecordStale =
        compareTimestamps(input.record.updatedAt, existingRecord.record.updatedAt) < 0;
      const hasNewAuditEvents = input.auditEvents.length > 0 && !hasDuplicateAuditEvent;
      const shouldReplaceRecord = !hasDuplicateRecordOnlyUpdate && !isIncomingRecordStale;

      if (hasDuplicateAuditEvent || (!shouldReplaceRecord && !hasNewAuditEvents)) {
        return ok({
          applied: false,
          row: existingRecord,
        });
      }

      const updatedSeq = await this.allocateSequence();
      const nextAuditEvents = [
        ...existingRecord.auditEvents,
        ...input.auditEvents.map(
          (auditEvent): StoredInteractiveAuditEvent => ({
            ...auditEvent,
            seq: updatedSeq,
            sourceClientEventId: input.eventId,
            sourceClientId: input.clientId,
          })
        ),
      ].sort(sortAuditEvents);

      const nextRecord = shouldReplaceRecord ? input.record : existingRecord.record;
      const nextUpdatedAt = shouldReplaceRecord
        ? new Date(input.record.updatedAt)
        : new Date(existingRecord.updatedAt);

      const updatedRow = await this.db
        .updateTable('learningprogress')
        .set({
          record: sql`${JSON.stringify(nextRecord)}::jsonb`,
          audit_events: sql`${JSON.stringify(nextAuditEvents)}::jsonb`,
          updated_seq: sql`${updatedSeq}::bigint`,
          updated_at: nextUpdatedAt,
        } as never)
        .where('user_id', '=', input.userId)
        .where('record_key', '=', input.record.key)
        .returning(LEARNING_PROGRESS_ROW_COLUMNS)
        .executeTakeFirstOrThrow();

      return ok({
        applied: true,
        row: this.mapRow(updatedRow as unknown as QueryRow),
      });
    }

    throw new Error('Failed to upsert learning progress record after concurrent insert retry');
  }

  private async allocateSequence(): Promise<string> {
    const sequenceResult = await sql<{ updated_seq: string }>`
      select nextval('learningprogress_updated_seq')::text as updated_seq
    `.execute(this.db);

    const updatedSeq = sequenceResult.rows[0]?.updated_seq;
    if (updatedSeq === undefined) {
      throw new Error('Failed to allocate learning progress sequence value');
    }

    return updatedSeq;
  }
}

interface QueryRow {
  user_id: string;
  record_key: string;
  record: LearningProgressRecordValueRow;
  audit_events: LearningProgressAuditEventRow[];
  updated_seq: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export const makeLearningProgressRepo = (
  options: LearningProgressRepoOptions
): LearningProgressRepository => {
  return new KyselyLearningProgressRepo(options);
};
