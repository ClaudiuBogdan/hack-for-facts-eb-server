/**
 * The money build's contract-award floor (PROC-ACX6; owner, 25 Nov) read from
 * `procurement_v3.money_generations.ca_award_day_from` on a throwaway
 * PostgreSQL 18, as a login holding only the API's grant on the table. The
 * column is named in SQL only when the catalog says it exists and this login
 * may read it, so a table without it, a login without its grant, a null, a
 * day to_char cannot print, and a dropped column all read as none (the core
 * then serves 2021-01-01): never a refusal. The floor is the asked build's.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { ok } from 'neverthrow';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { makeClickhouseMoneyRepo } from '@/modules/procurement/shell/repo/clickhouse-money-repo.js';

import { dockerCliUp } from './disposable-postgres.js';

import type { ClickhouseReader } from '@/modules/procurement/shell/repo/clickhouse-reader.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

let dockerAvailable = false;
let container: StartedPostgreSqlContainer | undefined;
let owner: Kysely<ProdDatabase> | undefined;
let tableGrant: Kysely<ProdDatabase> | undefined;
let columnGrant: Kysely<ProdDatabase> | undefined;
let floorOnly: Kysely<ProdDatabase> | undefined;

const it = (name: string, test: () => Promise<void>): void => {
  vitestIt(name, async ({ skip }) => {
    if (!dockerAvailable) skip();
    await test();
  });
};

const connect = (uri: string): Kysely<ProdDatabase> =>
  new Kysely<ProdDatabase>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: uri, max: 2 }) }),
  });

const asRole = (role: string): string => {
  const uri = new URL(container?.getConnectionUri() ?? '');
  uri.username = role;
  uri.password = role;
  return uri.toString();
};

/** No ClickHouse read is made for the floor. */
const reader: ClickhouseReader = { query: () => Promise.resolve(ok([] as never)) };

const ownerDb = (): Kysely<ProdDatabase> => {
  if (owner === undefined) throw new Error('no owner connection');
  return owner;
};

beforeAll(async () => {
  if (!dockerCliUp()) return;
  try {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('money_floor')
      .start();
  } catch (error) {
    console.warn(
      `Testcontainers runtime unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  dockerAvailable = true;
  owner = connect(container.getConnectionUri());
  await sql
    .raw(
      `create schema procurement_v3;
      create table procurement_v3.money_generations (build_id bigint primary key, status text not null,
        published_at timestamptz not null);
      insert into procurement_v3.money_generations values (1, 'retired', now() - interval '2 days'),
        (2, 'active', now() - interval '1 day');
      create role money_table login password 'money_table';
      create role money_columns login password 'money_columns';
      create role money_floor_only login password 'money_floor_only';
      grant usage on schema procurement_v3 to money_table, money_columns, money_floor_only;
      grant select on procurement_v3.money_generations to money_table;
      grant select (build_id, status, published_at) on procurement_v3.money_generations to money_columns;`
    )
    .execute(owner);
  tableGrant = connect(asRole('money_table'));
  columnGrant = connect(asRole('money_columns'));
  floorOnly = connect(asRole('money_floor_only'));
}, 240_000);

afterAll(async () => {
  await tableGrant?.destroy();
  await columnGrant?.destroy();
  await floorOnly?.destroy();
  await owner?.destroy();
  await container?.stop();
});

describe('the money build’s contract-award floor', () => {
  const floorOf = async (db: Kysely<ProdDatabase> | undefined, build = '2') => {
    if (db === undefined) throw new Error('no connection');
    const repo = makeClickhouseMoneyRepo({ db, reader });
    return (await repo.caFloor(build))._unsafeUnwrap();
  };
  const setFloor = async (build: number, day: string | null): Promise<void> => {
    await sql`update procurement_v3.money_generations set ca_award_day_from = ${day}::date
      where build_id = ${build}`.execute(ownerDb());
  };

  it('reads none without the column, without its grant, while null, and for a day it cannot print', async () => {
    // No column (every build before the migration). The active build is still read.
    expect(await floorOf(tableGrant)).toBeNull();
    expect(await floorOf(columnGrant)).toBeNull();
    expect(
      (await makeClickhouseMoneyRepo({ db: ownerDb(), reader }).activeBuild())._unsafeUnwrap()
    ).toBe('2');

    await sql`alter table procurement_v3.money_generations add column ca_award_day_from date`.execute(
      ownerDb()
    );
    try {
      // The column, null (build 2 was prepared before it existed).
      expect(await floorOf(tableGrant)).toBeNull();

      // Recorded: a table grant reads it; a per-column grant without it reads none, no error.
      await setFloor(2, '2018-01-01');
      await setFloor(1, '2016-01-01');
      expect(await floorOf(tableGrant)).toBe('2018-01-01');
      expect(await floorOf(columnGrant)).toBeNull();
      // The floor is the asked build's, never another row's.
      expect(await floorOf(tableGrant, '1')).toBe('2016-01-01');
      expect(await floorOf(tableGrant, '99')).toBeNull();
      // Granted per column: read.
      await sql`grant select (ca_award_day_from) on procurement_v3.money_generations to money_columns`.execute(
        ownerDb()
      );
      expect(await floorOf(columnGrant)).toBe('2018-01-01');

      // The catalog says readable but the read itself is refused (here: no grant on build_id, as
      // a revoke between the check and the read would do): none, through the read's own fallback.
      await sql`grant select (ca_award_day_from) on procurement_v3.money_generations to money_floor_only`.execute(
        ownerDb()
      );
      expect(await floorOf(floorOnly)).toBeNull();

      // Days to_char overflows on or prints without their era, and infinity: none.
      for (const day of ['500000-01-01', '2018-01-01 BC', 'infinity']) {
        await setFloor(2, day);
        expect(await floorOf(tableGrant), day).toBeNull();
      }
      await setFloor(2, '2018-01-01');

      // The grant revoked: none again, no error.
      await sql`revoke select (ca_award_day_from) on procurement_v3.money_generations from money_columns`.execute(
        ownerDb()
      );
      expect(await floorOf(columnGrant)).toBeNull();
    } finally {
      await sql`alter table procurement_v3.money_generations drop column if exists ca_award_day_from`.execute(
        ownerDb()
      );
    }
    // A dropped column reads as no column.
    expect(await floorOf(tableGrant)).toBeNull();
  });
});
