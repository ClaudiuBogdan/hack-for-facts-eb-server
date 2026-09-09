/**
 * `setStatementTimeout` issues `SET LOCAL`, which Postgres discards outside a
 * transaction block (with a WARNING per call). Every legacy repo called it on
 * a plain `Kysely` instance, so 20+ call sites bounded nothing and paid a
 * round trip each. The helper now issues the statement only for a
 * `Transaction`; the pool-level `statement_timeout` bounds the rest.
 * Compiled through a driver that executes nothing and records statements.
 */

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { setStatementTimeout, withTimeout } from '@/infra/database/query-builders/timeout.js';

const recordingDb = (): { db: Kysely<unknown>; sql: string[] } => {
  const captured: string[] = [];
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') captured.push(event.query.sql);
    },
  });
  return { db, sql: captured };
};

describe('setStatementTimeout', () => {
  it('issues SET LOCAL inside a transaction', async () => {
    const { db, sql } = recordingDb();
    await db.transaction().execute(async (trx) => {
      await setStatementTimeout(trx, 5_000);
    });
    expect(sql).toEqual(['SET LOCAL statement_timeout = 5000']);
  });

  it('issues nothing on a non-transaction instance (SET LOCAL would be discarded)', async () => {
    const { db, sql } = recordingDb();
    await setStatementTimeout(db, 5_000);
    expect(sql).toEqual([]);
  });

  it('still validates the bound before deciding whether to issue anything', async () => {
    const { db } = recordingDb();
    await expect(setStatementTimeout(db, 500)).rejects.toThrow(/at least 1000ms/u);
    await expect(setStatementTimeout(db, 400_000)).rejects.toThrow(/at most 300000ms/u);
    await expect(setStatementTimeout(db, 1.5)).rejects.toThrow(/integer/u);
  });

  it('withTimeout runs the callback either way', async () => {
    const { db, sql } = recordingDb();
    const plain = await withTimeout(db, 5_000, async () => 'plain');
    expect(plain).toBe('plain');
    expect(sql).toEqual([]);
    const inTrx = await db
      .transaction()
      .execute((trx) => withTimeout(trx, 5_000, async () => 'trx'));
    expect(inTrx).toBe('trx');
    expect(sql).toEqual(['SET LOCAL statement_timeout = 5000']);
  });
});
