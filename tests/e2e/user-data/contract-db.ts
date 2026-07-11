import { execSync } from 'node:child_process';

import { sql } from 'kysely';
import { ok } from 'neverthrow';

import { type UserDbClient } from '@/infra/database/client.js';
import { type UserDataReadPort } from '@/modules/user-data/core/ports.js';
import {
  mapUserDataEventRow,
  mapUserDataRecordRow,
} from '@/modules/user-data/shell/repo/kysely-user-data-mutation-repo.js';

export const isDockerAvailable = (): boolean => {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};

export const truncateUserDataTables = async (db: UserDbClient): Promise<void> => {
  await sql`
    TRUNCATE TABLE
      user_data_events,
      user_data_records,
      user_data_idempotency_receipts
    CASCADE
  `.execute(db);
  await sql`ALTER SEQUENCE user_data_event_seq RESTART WITH 1`.execute(db);
};

export const userDataStateCounts = async (
  db: UserDbClient
): Promise<{ records: number; events: number; receipts: number }> => {
  const result = await sql<{ records: string; events: string; receipts: string }>`
    SELECT
      (SELECT COUNT(*)::text FROM user_data_records) AS records,
      (SELECT COUNT(*)::text FROM user_data_events) AS events,
      (SELECT COUNT(*)::text FROM user_data_idempotency_receipts) AS receipts
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) throw new Error('User-data count query returned no row');
  return {
    records: Number(row.records),
    events: Number(row.events),
    receipts: Number(row.receipts),
  };
};

export const makeMutationContractReadHelpers = (
  db: UserDbClient
): Pick<UserDataReadPort, 'findByKey' | 'historyByRecord' | 'syncSince'> => ({
  findByKey: async (ownerId, category, logicalKey) => {
    const row = await db
      .selectFrom('user_data_records')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('category', '=', category)
      .where('logical_key', '=', logicalKey)
      .executeTakeFirst();
    return ok(row === undefined ? null : mapUserDataRecordRow(row));
  },

  historyByRecord: async (ownerId, recordId, page) => {
    let query = db
      .selectFrom('user_data_events')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('record_id', '=', recordId)
      .orderBy('revision', 'desc')
      .limit(page.limit + 1);
    if (page.beforeRevision !== null)
      query = query.where('revision', '<', String(page.beforeRevision));
    const rows = await query.execute();
    const items = rows.slice(0, page.limit).map(mapUserDataEventRow);
    return ok({
      items,
      nextCursor: rows.length > page.limit ? String(items.at(-1)?.revision ?? '') : null,
    });
  },

  syncSince: async (ownerId, cursor, limit) => {
    let query = db
      .selectFrom('user_data_records')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('last_event_seq', '>', cursor.lastSeq)
      .orderBy('last_event_seq', 'asc')
      .limit(limit);
    if (cursor.cycleHighWater !== null)
      query = query.where('last_event_seq', '<=', cursor.cycleHighWater);
    if (cursor.category !== null) query = query.where('category', '=', cursor.category);
    const [rows, highWater] = await Promise.all([
      query.execute(),
      db
        .selectFrom('user_data_records')
        .select(({ fn }) => fn.max<string>('last_event_seq').as('value'))
        .where('owner_id', '=', ownerId)
        .executeTakeFirstOrThrow(),
    ]);
    return ok({
      items: rows.map(mapUserDataRecordRow),
      ownerHighWater: highWater.value ?? '0',
    });
  },
});
