import { readFileSync } from 'node:fs';

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeLegacyMapTerritoryLookup } from '@/modules/advanced-map-analytics/index.js';

import { dockerAvailable } from './setup.js';
import { setupTestDatabase } from '../infra/test-db.js';

import type { BudgetDatabase, BudgetDbClient } from '@/infra/database/client.js';

let db: BudgetDbClient | undefined;
let ownsClient = false;
const required = process.env['TEST_E2E_REQUIRED'] === '1' || process.env['CI'] === 'true';

beforeAll(async () => {
  const external = process.env['E2E_BUDGET_PG_URL'];
  if (external !== undefined && external !== '') {
    const target = new URL(external);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
      !target.pathname.startsWith('/server_')
    ) {
      throw new Error('Map territory tests require a loopback server_* test database');
    }
    db = new Kysely<BudgetDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          connectionString: external,
          max: 1,
          connectionTimeoutMillis: 5000,
        }),
      }),
    });
    ownsClient = true;
  } else if (dockerAvailable) {
    db = (await setupTestDatabase()).budgetDb;
  } else if (required) {
    throw new Error('Required map territory PostgreSQL test has no disposable database');
  } else {
    console.warn('Map territory PostgreSQL test skipped: no disposable database');
  }
});

afterAll(async () => {
  if (ownsClient) await db?.destroy();
});

describe('legacy map territory lookup against actual DDL', () => {
  it('preserves the accepted keys and ordering, including sector and city exclusions', async ({
    skip,
  }) => {
    if (db === undefined) {
      skip();
      return;
    }
    const schema = readFileSync('src/infra/database/budget/schema.sql', 'utf8');
    const tableDdl = /CREATE TABLE UATs \([\s\S]*?\n\);/u.exec(schema)?.[0];
    expect(tableDdl).toBeDefined();
    if (tableDdl === undefined) throw new Error('Actual UAT DDL not found');
    // A transaction-local copy shadows public.uats; no permanent serving/test rows are changed.
    await db.transaction().execute(async (tx) => {
      await sql
        .raw(
          tableDdl.replace('CREATE TABLE', 'CREATE TEMP TABLE').replace(/;$/u, ' ON COMMIT DROP;')
        )
        .execute(tx);
      const codes = [
        ['CJ', 'CJ'],
        ['B', 'B'],
        ['179132', 'B'],
        ['179141', 'B'],
        ['179150', 'B'],
        ['179169', 'B'],
        ['179178', 'B'],
        ['179187', 'B'],
        ['179196', 'B'],
        ['54975', 'CJ'],
        ['1001', 'AB'],
        [' 1002 ', 'AB'],
        ['', 'AB'],
      ];
      for (const [code, county] of codes) {
        await sql`insert into uats (uat_key, uat_code, siruta_code, name, county_code, county_name, region)
          values (${code}, ${code}, ${code}, 'fixture', ${county}, 'fixture', 'fixture')`.execute(
          tx
        );
      }
      const result = await makeLegacyMapTerritoryLookup(tx)();
      // Expected identities are declared independently of the query under test.
      expect(result).toEqual([
        '1002',
        '1001',
        '179141',
        '179150',
        '179169',
        '179178',
        '179187',
        '179196',
        '54975',
      ]);
      expect(result).not.toContain('179132');
      expect(result).not.toContain('CJ');
      expect(result).not.toContain('B');
      expect(result).not.toContain('');
    });
  });
});
