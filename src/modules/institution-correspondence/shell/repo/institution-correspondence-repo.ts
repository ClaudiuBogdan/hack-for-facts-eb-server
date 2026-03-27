import { Value } from '@sinclair/typebox/value';
import { sql } from 'kysely';
import { err, ok } from 'neverthrow';

import { deserialize } from '@/infra/cache/serialization.js';

import {
  createConflictError,
  createDatabaseError,
  createNotFoundError,
} from '../../core/errors.js';
import {
  CorrespondenceThreadRecordSchema,
  REVIEWABLE_PHASE,
  type CorrespondenceThreadRecord,
  type PendingReplyPage,
  type ThreadRecord,
} from '../../core/types.js';

import type {
  AppendCorrespondenceEntryInput,
  InstitutionCorrespondenceRepository,
  LockedThreadMutation,
} from '../../core/ports.js';
import type { UserDbClient } from '@/infra/database/client.js';
import type { Logger } from 'pino';

export interface InstitutionCorrespondenceRepoConfig {
  db: UserDbClient;
  logger: Logger;
}

const toDate = (value: unknown): Date => {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string') {
    return new Date(value);
  }

  if (typeof value === 'object' && value !== null && 'toISOString' in value) {
    return new Date((value as { toISOString: () => string }).toISOString());
  }

  throw new Error(`Unexpected date value in correspondence repo: ${String(value)}`);
};

const toJsonObject = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    const parsed = deserialize(value);
    return parsed.ok && typeof parsed.value === 'object' && parsed.value !== null
      ? (parsed.value as Record<string, unknown>)
      : {};
  }

  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
};

const parseThreadRecord = (value: unknown): CorrespondenceThreadRecord => {
  const record = toJsonObject(value);
  if (!Value.Check(CorrespondenceThreadRecordSchema, record)) {
    const errors = [...Value.Errors(CorrespondenceThreadRecordSchema, record)]
      .map((error) => `${error.path}: ${error.message}`)
      .join(', ');
    throw new Error(`Invalid correspondence thread record: ${errors}`);
  }

  return record;
};

const mapThreadRow = (row: Record<string, unknown>): ThreadRecord => {
  const record = parseThreadRecord(row['record']);

  return {
    id: row['id'] as string,
    entityCui: row['entity_cui'] as string,
    campaignKey: (row['campaign_key'] as string | null) ?? record.campaignKey,
    threadKey: row['thread_key'] as string,
    phase: row['phase'] as ThreadRecord['phase'],
    lastEmailAt: row['last_email_at'] !== null ? toDate(row['last_email_at']) : null,
    lastReplyAt: row['last_reply_at'] !== null ? toDate(row['last_reply_at']) : null,
    nextActionAt: row['next_action_at'] !== null ? toDate(row['next_action_at']) : null,
    closedAt: row['closed_at'] !== null ? toDate(row['closed_at']) : null,
    record,
    createdAt: toDate(row['created_at']),
    updatedAt: toDate(row['updated_at']),
  };
};

const getLatestInboundReply = (thread: ThreadRecord) =>
  [...thread.record.correspondence]
    .filter((entry) => entry.direction === 'inbound')
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0] ?? null;

export const makeInstitutionCorrespondenceRepo = (
  config: InstitutionCorrespondenceRepoConfig
): InstitutionCorrespondenceRepository => {
  const { db, logger } = config;
  const log = logger.child({ repo: 'InstitutionCorrespondenceRepo' });

  return {
    async createThread(input) {
      try {
        const result = await db
          .insertInto('institutionemailthreads')
          .values({
            entity_cui: input.entityCui,
            campaign_key: input.campaignKey,
            thread_key: input.threadKey,
            phase: input.phase,
            last_email_at: input.lastEmailAt ?? null,
            last_reply_at: input.lastReplyAt ?? null,
            next_action_at: input.nextActionAt ?? null,
            closed_at: input.closedAt ?? null,
            record: input.record,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        return ok(mapThreadRow(result as Record<string, unknown>));
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.includes('unique constraint') || error.message.includes('duplicate key'))
        ) {
          return err(createConflictError('A correspondence thread already exists for this key.'));
        }

        log.error({ error, input }, 'Failed to create correspondence thread');
        return err(createDatabaseError('Failed to create correspondence thread', error));
      }
    },

    async findThreadById(id) {
      try {
        const result = await db
          .selectFrom('institutionemailthreads')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();

        return ok(result !== undefined ? mapThreadRow(result as Record<string, unknown>) : null);
      } catch (error) {
        log.error({ error, id }, 'Failed to load correspondence thread by ID');
        return err(createDatabaseError('Failed to load correspondence thread by ID', error));
      }
    },

    async findThreadByKey(threadKey) {
      try {
        const result = await db
          .selectFrom('institutionemailthreads')
          .selectAll()
          .where('thread_key', '=', threadKey)
          .executeTakeFirst();

        return ok(result !== undefined ? mapThreadRow(result as Record<string, unknown>) : null);
      } catch (error) {
        log.error({ error, threadKey }, 'Failed to load correspondence thread by key');
        return err(createDatabaseError('Failed to load correspondence thread by key', error));
      }
    },

    async findPlatformSendThreadByEntity(input) {
      try {
        const result = await db
          .selectFrom('institutionemailthreads')
          .selectAll()
          .where('entity_cui', '=', input.entityCui)
          .where('phase', '!=', 'failed')
          .where(sql<boolean>`record->>'campaign' = ${input.campaign}`)
          .where(sql<boolean>`record->>'submissionPath' = ${'platform_send'}`)
          .orderBy('created_at', 'desc')
          .executeTakeFirst();

        return ok(result !== undefined ? mapThreadRow(result as Record<string, unknown>) : null);
      } catch (error) {
        log.error({ error, input }, 'Failed to load platform-send correspondence thread by entity');
        return err(
          createDatabaseError('Failed to load platform-send correspondence thread by entity', error)
        );
      }
    },

    async updateThread(threadId, input) {
      try {
        const updateSet: Record<string, unknown> = {};
        if (input.phase !== undefined) updateSet['phase'] = input.phase;
        if (input.lastEmailAt !== undefined) updateSet['last_email_at'] = input.lastEmailAt;
        if (input.lastReplyAt !== undefined) updateSet['last_reply_at'] = input.lastReplyAt;
        if (input.nextActionAt !== undefined) updateSet['next_action_at'] = input.nextActionAt;
        if (input.closedAt !== undefined) updateSet['closed_at'] = input.closedAt;
        if (input.record !== undefined) updateSet['record'] = input.record;
        updateSet['updated_at'] = new Date();

        const result = await db
          .updateTable('institutionemailthreads')
          .set(updateSet)
          .where('id', '=', threadId)
          .returningAll()
          .executeTakeFirst();

        if (result === undefined) {
          return err(createNotFoundError(`Thread "${threadId}" was not found.`));
        }

        return ok(mapThreadRow(result as Record<string, unknown>));
      } catch (error) {
        log.error({ error, threadId, input }, 'Failed to update correspondence thread');
        return err(createDatabaseError('Failed to update correspondence thread', error));
      }
    },

    async appendCorrespondenceEntry(input: AppendCorrespondenceEntryInput) {
      try {
        return await db.transaction().execute(async (trx) => {
          const current = await trx
            .selectFrom('institutionemailthreads')
            .selectAll()
            .where('id', '=', input.threadId)
            .forUpdate()
            .executeTakeFirst();

          if (current === undefined) {
            return err(createNotFoundError(`Thread "${input.threadId}" was not found.`));
          }

          const thread = mapThreadRow(current as Record<string, unknown>);
          const duplicate =
            (input.entry.resendEmailId !== null &&
              thread.record.correspondence.some(
                (entry) => entry.resendEmailId === input.entry.resendEmailId
              )) ||
            thread.record.correspondence.some((entry) => entry.id === input.entry.id);

          if (duplicate) {
            return ok(thread);
          }

          const nextRecord: CorrespondenceThreadRecord = {
            ...thread.record,
            correspondence: [...thread.record.correspondence, input.entry],
          };

          const updated = await trx
            .updateTable('institutionemailthreads')
            .set({
              phase: input.phase ?? thread.phase,
              last_email_at:
                input.lastEmailAt !== undefined ? input.lastEmailAt : thread.lastEmailAt,
              last_reply_at:
                input.lastReplyAt !== undefined ? input.lastReplyAt : thread.lastReplyAt,
              next_action_at:
                input.nextActionAt !== undefined ? input.nextActionAt : thread.nextActionAt,
              closed_at: input.closedAt !== undefined ? input.closedAt : thread.closedAt,
              record: nextRecord,
              updated_at: sql`now()`,
            })
            .where('id', '=', input.threadId)
            .returningAll()
            .executeTakeFirstOrThrow();

          return ok(mapThreadRow(updated as Record<string, unknown>));
        });
      } catch (error) {
        log.error({ error, input }, 'Failed to append correspondence entry');
        return err(createDatabaseError('Failed to append correspondence entry', error));
      }
    },

    async mutateThread(threadId, mutator) {
      try {
        return await db.transaction().execute(async (trx) => {
          const current = await trx
            .selectFrom('institutionemailthreads')
            .selectAll()
            .where('id', '=', threadId)
            .forUpdate()
            .executeTakeFirst();

          if (current === undefined) {
            return err(createNotFoundError(`Thread "${threadId}" was not found.`));
          }

          const thread = mapThreadRow(current as Record<string, unknown>);
          const nextStateResult = mutator(thread);
          if (nextStateResult.isErr()) {
            return err(nextStateResult.error);
          }
          const nextState: LockedThreadMutation = nextStateResult.value;

          const updated = await trx
            .updateTable('institutionemailthreads')
            .set({
              ...(nextState.phase !== undefined ? { phase: nextState.phase } : {}),
              ...(nextState.lastEmailAt !== undefined
                ? { last_email_at: nextState.lastEmailAt }
                : {}),
              ...(nextState.lastReplyAt !== undefined
                ? { last_reply_at: nextState.lastReplyAt }
                : {}),
              ...(nextState.nextActionAt !== undefined
                ? { next_action_at: nextState.nextActionAt }
                : {}),
              ...(nextState.closedAt !== undefined ? { closed_at: nextState.closedAt } : {}),
              record: nextState.record,
              updated_at: sql`now()`,
            })
            .where('id', '=', threadId)
            .returningAll()
            .executeTakeFirstOrThrow();

          return ok(mapThreadRow(updated as Record<string, unknown>));
        });
      } catch (error) {
        log.error({ error, threadId }, 'Failed to mutate correspondence thread');
        return err(createDatabaseError('Failed to mutate correspondence thread', error));
      }
    },

    async attachMessageIdToCorrespondenceByResendEmail(threadKey, resendEmailId, messageId) {
      try {
        return await db.transaction().execute(async (trx) => {
          const current = await trx
            .selectFrom('institutionemailthreads')
            .selectAll()
            .where('thread_key', '=', threadKey)
            .forUpdate()
            .executeTakeFirst();

          if (current === undefined) {
            return ok(null);
          }

          const thread = mapThreadRow(current as Record<string, unknown>);
          const targetIndex = thread.record.correspondence.findIndex(
            (entry) => entry.resendEmailId === resendEmailId
          );
          if (targetIndex === -1) {
            return ok(thread);
          }

          const existing = thread.record.correspondence[targetIndex];
          if (existing === undefined) {
            return ok(thread);
          }
          if (existing.messageId === messageId) {
            return ok(thread);
          }

          const nextCorrespondence = [...thread.record.correspondence];
          nextCorrespondence[targetIndex] = {
            ...existing,
            messageId,
          };

          const nextRecord: CorrespondenceThreadRecord = {
            ...thread.record,
            correspondence: nextCorrespondence,
          };

          const updated = await trx
            .updateTable('institutionemailthreads')
            .set({
              record: nextRecord,
              updated_at: sql`now()`,
            })
            .where('thread_key', '=', threadKey)
            .returningAll()
            .executeTakeFirstOrThrow();

          return ok(mapThreadRow(updated as Record<string, unknown>));
        });
      } catch (error) {
        log.error(
          { error, threadKey, resendEmailId },
          'Failed to attach message id to correspondence'
        );
        return err(createDatabaseError('Failed to attach message id to correspondence', error));
      }
    },

    async listPendingReplies(input) {
      try {
        const rows = await db
          .selectFrom('institutionemailthreads')
          .selectAll()
          .where('phase', '=', REVIEWABLE_PHASE)
          .orderBy('last_reply_at', 'desc')
          .limit(input.limit + 1)
          .offset(input.offset)
          .execute();

        const mapped = rows
          .map((row) => mapThreadRow(row as Record<string, unknown>))
          .map((thread) => {
            const reply = getLatestInboundReply(thread);
            return reply !== null ? { thread, reply } : null;
          })
          .filter((item): item is NonNullable<typeof item> => item !== null);

        return ok({
          items: mapped.slice(0, input.limit),
          hasMore: mapped.length > input.limit,
          limit: input.limit,
          offset: input.offset,
        } satisfies PendingReplyPage);
      } catch (error) {
        log.error({ error, input }, 'Failed to list pending correspondence replies');
        return err(createDatabaseError('Failed to list pending correspondence replies', error));
      }
    },
  };
};
