import { execSync } from 'node:child_process';

import { sql } from 'kysely';

import { type UserDbClient } from '@/infra/database/client.js';

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
