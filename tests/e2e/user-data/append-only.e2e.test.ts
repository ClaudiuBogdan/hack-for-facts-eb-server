import { sql } from 'kysely';
import { beforeEach, expect, it } from 'vitest';

import { makeUserDataMutationRepo } from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';

import { truncateUserDataTables } from './contract-db.js';
import { makePlannedMutation } from '../../fixtures/user-data/index.js';
import { setupTestDatabase } from '../../infra/test-db.js';
import { expectOk, makeTestClock } from '../../support/index.js';

beforeEach(async () => {
  const { userDb } = await setupTestDatabase();
  await truncateUserDataTables(userDb);
  const repo = makeUserDataMutationRepo({
    db: userDb,
    clock: makeTestClock(new Date('2026-07-11T10:00:00.000Z')),
  });
  expect(expectOk(await repo.commit(makePlannedMutation())).kind).toBe('committed');
});

it('row 17: event UPDATE requires the maintenance GUC and a redaction marker', async () => {
  const { userDb } = await setupTestDatabase();
  await expect(
    sql`UPDATE user_data_events SET payload = '{}'::jsonb`.execute(userDb)
  ).rejects.toThrow(/maintenance path/);

  await expect(
    userDb.transaction().execute(async (trx) => {
      await sql`SET LOCAL app.user_data_maintenance = 'on'`.execute(trx);
      await sql`UPDATE user_data_events SET payload = '{}'::jsonb`.execute(trx);
    })
  ).rejects.toThrow(/must record privacy redaction/);

  const redactedAt = new Date('2026-07-11T11:00:00.000Z');
  await userDb.transaction().execute(async (trx) => {
    await sql`SET LOCAL app.user_data_maintenance = 'on'`.execute(trx);
    await sql`
      UPDATE user_data_events
      SET owner_id = 'anonymous-owner',
          payload = '{}'::jsonb,
          annotations = '{}'::jsonb,
          privacy_redacted_at = ${redactedAt}
    `.execute(trx);
  });
  const row = await userDb
    .selectFrom('user_data_events')
    .select(['owner_id', 'payload', 'annotations', 'privacy_redacted_at'])
    .executeTakeFirstOrThrow();
  expect(row).toMatchObject({ owner_id: 'anonymous-owner', payload: {}, annotations: {} });
  expect(row.privacy_redacted_at).toEqual(redactedAt);
});

it('row 17: maintenance redaction cannot change immutable columns', async () => {
  const { userDb } = await setupTestDatabase();
  await expect(
    userDb.transaction().execute(async (trx) => {
      await sql`SET LOCAL app.user_data_maintenance = 'on'`.execute(trx);
      await sql`
        UPDATE user_data_events
        SET privacy_redacted_at = ${new Date('2026-07-11T11:00:00.000Z')},
            revision = revision + 1
      `.execute(trx);
    })
  ).rejects.toThrow(/immutable columns/);
});

it('row 17: DELETE is rejected with and without the maintenance GUC', async () => {
  const { userDb } = await setupTestDatabase();
  await expect(sql`DELETE FROM user_data_events`.execute(userDb)).rejects.toThrow(/append-only/);
  await expect(
    userDb.transaction().execute(async (trx) => {
      await sql`SET LOCAL app.user_data_maintenance = 'on'`.execute(trx);
      await sql`DELETE FROM user_data_events`.execute(trx);
    })
  ).rejects.toThrow(/append-only/);
});
