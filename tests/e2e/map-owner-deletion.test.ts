import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import pinoLogger from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { acquireUserDataOwnerLock } from '@/infra/database/user/advisory-locks.js';
import { assertUserDataOwnerCanWrite } from '@/infra/database/user/owner-write-guard.js';
import { makeAdvancedMapAnalyticsRepo } from '@/modules/advanced-map-analytics/index.js';
import { makeAdvancedMapDatasetsRepo } from '@/modules/advanced-map-datasets/index.js';
import { makeUserDataAnonymizer } from '@/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.js';

import type { UserDatabase } from '@/infra/database/user/types.js';

const schema = `map_owner_${randomUUID().replaceAll('-', '')}`;
const logger = pinoLogger({ level: 'silent' });
let db: Kysely<UserDatabase>;
let admin: pg.Client;
let ready = false;

beforeAll(async () => {
  const connectionString = process.env['E2E_BUDGET_PG_URL'];
  if (connectionString === undefined) {
    if (process.env['TEST_E2E_REQUIRED'] === '1') throw new Error('Disposable PostgreSQL required');
    console.warn('Map deletion race tests skipped: no disposable PostgreSQL URL');
    return;
  }
  const target = new URL(connectionString);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    !target.pathname.startsWith('/server_')
  )
    throw new Error('Map deletion tests require a loopback server_* disposable database');
  admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  // This unique, proven empty schema is the only target of the full bootstrap DDL.
  await admin.query(readFileSync('src/infra/database/user/schema.sql', 'utf8'));
  db = new Kysely<UserDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
        max: 5,
        options: `-c search_path=${schema}`,
        application_name: schema,
        statement_timeout: 10000,
      }),
    }),
  });
  ready = true;
});

afterAll(async () => {
  await db?.destroy();
  if (admin !== undefined) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

const mapInput = (userId: string) => ({
  mapId: randomUUID(),
  userId,
  title: 'Private fixture',
  description: null,
  visibility: 'private' as const,
  publicId: null,
});
const datasetInput = (userId: string) => ({
  id: randomUUID(),
  publicId: randomUUID(),
  userId,
  title: 'Private dataset',
  description: null,
  markdown: null,
  unit: 'RON',
  visibility: 'private' as const,
  rows: [{ sirutaCode: '54975', valueNumber: '1.23', valueJson: null }],
});
const markStarted = async (userId: string) => {
  const hash = createHash('sha256').update(userId).digest('hex');
  await sql`insert into userdataanonymizationaudit (user_id_hash, anonymized_user_id, first_svix_id, latest_svix_id, clerk_event_type, clerk_event_timestamp, summary)
    values (${hash}, ${`deleted-user:${hash}`}, 'fixture', 'fixture', 'user.deleted', 1, '{"status":"started"}'::jsonb)`.execute(
    db
  );
};
const deleteUser = (userId: string) =>
  makeUserDataAnonymizer({ db, logger }).anonymizeDeletedUser({
    userId,
    svixId: randomUUID(),
    eventType: 'user.deleted',
    eventTimestamp: Date.now(),
  });

// These call real repositories directly: stale auth caches or bypassed HTTP hooks cannot admit writes.
describe('saved map deletion transaction boundary', () => {
  it('rejects every owner mutation once deletion starts, including replay', async ({ skip }) => {
    if (!ready) {
      skip();
      return;
    }
    const maps = makeAdvancedMapAnalyticsRepo({ db, logger });
    const datasets = makeAdvancedMapDatasetsRepo({ db, logger });
    const owner = `user_${randomUUID()}`;
    const m = mapInput(owner);
    const d = datasetInput(owner);
    expect((await maps.createMap(m)).isOk()).toBe(true);
    expect((await datasets.createDataset(d)).isOk()).toBe(true);
    await markStarted(owner);
    const results = await Promise.all([
      maps.createMap(mapInput(owner)),
      maps.updateMap({ ...m, allowPublicWrite: true }),
      maps.softDeleteMap(m.mapId, owner, true),
      maps.appendSnapshot({
        mapId: m.mapId,
        userId: owner,
        snapshotId: randomUUID(),
        snapshotTitle: 'Snapshot',
        snapshotDescription: null,
        snapshotDocument: {
          title: 'Snapshot',
          description: null,
          state: {},
          savedAt: new Date().toISOString(),
        },
        nextMapTitle: 'New',
        nextMapDescription: null,
        nextVisibility: 'private',
        nextPublicId: null,
        allowPublicWrite: true,
        snapshotCap: 10,
      }),
      datasets.createDataset(datasetInput(owner)),
      datasets.updateDatasetMetadata({ ...d, datasetId: d.id, allowPublicWrite: true }),
      datasets.replaceDatasetRows({
        datasetId: d.id,
        userId: owner,
        rows: d.rows,
        allowPublicWrite: true,
      }),
      datasets.softDeleteDataset(d.id, owner, true),
    ]);
    for (const result of results)
      expect(result.isErr() && result.error.type).toBe('ForbiddenError');
    expect((await maps.createMap(mapInput(`other_${randomUUID()}`))).isOk()).toBe(true);
    const first = await deleteUser(owner);
    expect(first.isOk()).toBe(true);
    expect((await deleteUser(owner)).isOk()).toBe(true);
    expect((await maps.createMap(mapInput(owner))).isErr()).toBe(true);
    expect(
      (
        await db
          .selectFrom('advancedmapanalyticsmaps')
          .select('id')
          .where('user_id', '=', owner)
          .execute()
      ).length
    ).toBe(0);
    expect(
      (
        await db
          .selectFrom('advancedmapdatasetrows')
          .select('dataset_id')
          .where('dataset_id', '=', d.id)
          .execute()
      ).length
    ).toBe(0);
  });

  it('a writer waiting for the owner lock sees a newly committed tombstone', async ({ skip }) => {
    if (!ready) {
      skip();
      return;
    }
    const owner = `user_${randomUUID()}`;
    const gate = await db.startTransaction().setIsolationLevel('read committed').execute();
    await acquireUserDataOwnerLock(gate, owner);
    const writing = makeAdvancedMapAnalyticsRepo({ db, logger }).createMap(mapInput(owner));
    try {
      await expect
        .poll(
          async () =>
            (
              await sql<{
                n: string;
              }>`select count(*)::text n from pg_stat_activity where application_name=${schema} and wait_event='advisory'`.execute(
                db
              )
            ).rows[0]?.n,
          { timeout: 5000 }
        )
        .toBe('1');
      await markStarted(owner);
    } finally {
      await gate.commit().execute();
    }
    const result = await writing;
    expect(result.isErr() && result.error.type).toBe('ForbiddenError');
  });

  it('deletion waits for an already admitted writer and erases its committed row', async ({
    skip,
  }) => {
    if (!ready) {
      skip();
      return;
    }
    const owner = `user_${randomUUID()}`;
    const writer = await db.startTransaction().setIsolationLevel('read committed').execute();
    await assertUserDataOwnerCanWrite(writer, owner);
    await writer
      .insertInto('advancedmapanalyticsmaps')
      .values({
        id: randomUUID(),
        user_id: owner,
        title: 'Admitted before deletion',
        visibility: 'private',
      } as never)
      .execute();
    const deleting = deleteUser(owner);
    try {
      await expect
        .poll(
          async () =>
            (
              await db
                .selectFrom('userdataanonymizationaudit')
                .select('user_id_hash')
                .where('user_id_hash', '=', createHash('sha256').update(owner).digest('hex'))
                .execute()
            ).length,
          { timeout: 5000 }
        )
        .toBe(1);
      await expect
        .poll(
          async () =>
            (
              await sql<{
                n: string;
              }>`select count(*)::text n from pg_stat_activity where application_name=${schema} and wait_event='advisory'`.execute(
                db
              )
            ).rows[0]?.n,
          { timeout: 5000 }
        )
        .toBe('1');
    } finally {
      await writer.commit().execute();
    }
    expect((await deleting).isOk()).toBe(true);
    expect(
      (
        await db
          .selectFrom('advancedmapanalyticsmaps')
          .select('id')
          .where('user_id', '=', owner)
          .execute()
      ).length
    ).toBe(0);
  });
});
