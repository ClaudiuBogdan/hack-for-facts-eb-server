/** Actual user-schema rollback and borrowed-connection ownership regressions. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { err } from 'neverthrow';
import pg from 'pg';
import pinoLogger from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeLearningProgressRepo } from '@/modules/learning-progress/index.js';
import { makeNotificationsRepo } from '@/modules/notifications/index.js';

import { dockerAvailable } from './setup.js';

import type { UserDatabase } from '@/infra/database/user/types.js';
import type { UpsertInteractiveRecordInput } from '@/modules/learning-progress/core/types.js';

const supplied = process.env['E2E_USER_TRANSACTIONS_PG_URL'];
const logger = pinoLogger({ level: 'silent' });
let db: Kysely<UserDatabase>;
let connectionString: string;
let container: StartedPostgreSqlContainer | undefined;
const input = (userId: string): UpsertInteractiveRecordInput => ({
  userId,
  eventId: randomUUID(),
  clientId: 'transaction-test',
  occurredAt: '2026-09-08T00:00:00.000Z',
  auditEvents: [],
  record: {
    key: 'transaction-fixture',
    interactionId: 'fixture',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    scope: { type: 'entity', entityCui: '12345678' },
    completionRule: { type: 'resolved' },
    phase: 'draft',
    value: null,
    result: null,
    updatedAt: '2026-09-08T00:00:00.000Z',
  },
});
const notification = (userId: string) => ({
  userId,
  notificationType: 'funky:notification:entity_updates' as const,
  entityCui: '12345678',
  config: null,
  hash: randomUUID(),
});
const learningCount = async (userId: string) =>
  (
    await sql<{
      n: string;
    }>`select count(*)::text as n from userinteractions where user_id=${userId}`.execute(db)
  ).rows[0]?.n;

// Explicit environment override is a disposable, task-owned DB only. Never real user data.
describe.skipIf(supplied === undefined && !dockerAvailable)('user transaction ownership', () => {
  beforeAll(async () => {
    if (supplied !== undefined) {
      const url = new URL(supplied);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !/^\/user_transactions_[a-z0-9_]+$/u.test(url.pathname)
      )
        throw new Error('Refusing non-fixture user database');
      connectionString = supplied;
    } else {
      container = await new PostgreSqlContainer('postgres:18-alpine').start();
      connectionString = container.getConnectionUri();
    }
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query('drop schema public cascade; create schema public');
      await client.query(readFileSync('src/infra/database/user/schema.sql', 'utf8'));
    } finally {
      await client.end();
    }
    db = new Kysely<UserDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }),
    });
  }, 120000);
  afterAll(async () => {
    if (db !== undefined) await db.destroy();
    await container?.stop();
  });

  it('rolls back an owned learning write and returns the original business error', async () => {
    const userId = randomUUID();
    const failure = { kind: 'business-rejection' };
    const repo = makeLearningProgressRepo({ db, logger });
    const result = await repo.withTransaction(async (transactional) => {
      expect((await transactional.upsertInteractiveRecord(input(userId))).isOk()).toBe(true);
      return err(failure);
    });
    expect(result._unsafeUnwrapErr()).toBe(failure);
    expect(await learningCount(userId)).toBe('0');
  });
  it('borrows learning transactions without flags, retains row locks and outer rollback', async () => {
    const userId = randomUUID();
    const initial = input(userId);
    await sql`insert into userinteractions(user_id,record_key,record) values(${userId},${initial.record.key},${JSON.stringify(initial.record)}::jsonb)`.execute(
      db
    );
    const outer = new Error('outer rollback');
    await expect(
      db.transaction().execute(async (trx) => {
        const repo = makeLearningProgressRepo({ db: trx, logger });
        expect((await repo.getRecordForUpdate(userId, initial.record.key)).isOk()).toBe(true);
        const concurrent = new pg.Client({ connectionString });
        await concurrent.connect();
        try {
          await concurrent.query('begin');
          await expect(
            concurrent.query('select * from userinteractions where user_id=$1 for update nowait', [
              userId,
            ])
          ).rejects.toMatchObject({ code: '55P03' });
          await concurrent.query('rollback');
        } finally {
          await concurrent.end();
        }
        const changed = {
          ...input(userId),
          record: {
            ...initial.record,
            phase: 'resolved' as const,
            updatedAt: '2026-09-08T01:00:00.000Z',
          },
        };
        expect(
          (await repo.withTransaction((nested) => nested.upsertInteractiveRecord(changed))).isOk()
        ).toBe(true);
        throw outer;
      })
    ).rejects.toBe(outer);
    const row = await db
      .selectFrom('userinteractions')
      .select('record')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.record.phase).toBe('draft');
  });
  it('borrows notification changes and lets the outer owner roll back every statement', async () => {
    const userId = randomUUID();
    const outer = new Error('notification rollback');
    await expect(
      db.transaction().execute(async (trx) => {
        const repo = makeNotificationsRepo({ db: trx, logger });
        expect((await repo.createWithManualOptIn(notification(userId))).isOk()).toBe(true);
        const global = await trx
          .selectFrom('notifications')
          .select('id')
          .where('user_id', '=', userId)
          .where('notification_type', '=', 'funky:notification:global')
          .executeTakeFirstOrThrow();
        expect(
          (await repo.updateCampaignGlobalPreference(global.id, { isActive: false })).isOk()
        ).toBe(true);
        const rows = await trx
          .selectFrom('notifications')
          .select('is_active')
          .where('user_id', '=', userId)
          .execute();
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => !row.is_active)).toBe(true);
        throw outer;
      })
    ).rejects.toBe(outer);
    expect(
      await db.selectFrom('notifications').select('id').where('user_id', '=', userId).execute()
    ).toEqual([]);
  });
  it('rolls back an owned notification insert if a later statement fails, without cache invalidation', async () => {
    const userId = randomUUID();
    let invalidations = 0;
    await sql`create function reject_fixture_global() returns trigger language plpgsql as $$ begin raise exception 'fixture second-statement failure'; end $$;
      create trigger reject_fixture_global before insert on notifications for each row when (new.notification_type='funky:notification:global') execute function reject_fixture_global()`.execute(
      db
    );
    try {
      const repo = makeNotificationsRepo({
        db,
        logger,
        campaignSubscriptionStatsInvalidator: {
          invalidateCampaign: async () => {
            invalidations++;
          },
          invalidateAll: async () => {
            invalidations++;
          },
        },
      });
      expect((await repo.createWithManualOptIn(notification(userId))).isErr()).toBe(true);
      expect(
        await db.selectFrom('notifications').select('id').where('user_id', '=', userId).execute()
      ).toEqual([]);
      expect(invalidations).toBe(0);
    } finally {
      await sql`drop trigger reject_fixture_global on notifications; drop function reject_fixture_global()`.execute(
        db
      );
    }
  });
});
