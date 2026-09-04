/** Phase A real-SQL proof on a dedicated empty PostgreSQL database. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  makeDatasetFactorSource,
  FACTOR_DATASET_IDS,
} from '../../src/modules/budget/shell/factors/dataset-factor-source.js';
import { makeFactorSetSource } from '../../src/modules/budget/shell/factors/factor-set-source.js';
import { createDatasetRepo } from '../../src/modules/datasets/index.js';
import { makeFactorSetReader } from '../../src/modules/normalization/index.js';
import fixture from '../unit/normalization/fixtures/factor-set-1.json' with { type: 'json' };

import type { FactorKind } from '../../src/modules/budget/core/legacy-analytics/ports.js';
import type { ProdDatabase } from '../../src/modules/shared/index.js';

const url = process.env['E2E_FACTOR_PG_URL'];
const scrapper = process.env['SCRAPPER_REPO_ROOT'];
// Opt-in uses a dedicated fixture, never the application/production connection.
const required = process.env['TEST_E2E_REQUIRED'] === '1';
const suite = required || (url !== undefined && scrapper !== undefined) ? describe : describe.skip;
let db: Kysely<ProdDatabase>;

suite('versioned factor reader — real migration DDL', () => {
  beforeAll(async () => {
    if (url === undefined || scrapper === undefined)
      throw new Error('Required: E2E_FACTOR_PG_URL and SCRAPPER_REPO_ROOT');
    const endpoint = new URL(url);
    if (
      !['127.0.0.1', 'localhost'].includes(endpoint.hostname) ||
      !endpoint.pathname.startsWith('/budget_phase_a')
    ) {
      throw new Error('E2E_FACTOR_PG_URL must name a localhost budget_phase_a disposable database');
    }
    db = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 2 }) }),
    });
    const existing = await sql<{
      n: string;
    }>`select count(*)::text as n from information_schema.tables where table_schema not in ('pg_catalog','information_schema')`.execute(
      db
    );
    if (existing.rows[0]?.n !== '0')
      throw new Error('Factor SQL proof requires an empty disposable database');
    // Actual D2 DDL and the migrations owning its ETL dependencies. No stubs.
    const migrations = [
      [
        '20260611T220000__companies_domain',
        '0c84c277726d05d3ed8f0b959cd0c023e86f01b3d7bd3dbcf278223098022f97',
      ],
      [
        '20260707T120000__etl_sync_policy',
        '28a2f2f4c0e7d0365bd8a79cf7cbcc5f5f55702739d6f49fe20876f65e4be5e9',
      ],
      [
        '20260902T101000__core_normalization_factors',
        '0ef0bad8aef6951b644a936a73239a952876ceebc43b8f83277fe3559b9e924d',
      ],
    ] as const;
    for (const [name, digest] of migrations) {
      const file = path.join(scrapper, 'src/db/prod-migrations', name + '.ts');
      expect(
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex')
      ).toBe(digest);
      const migration = (await import(pathToFileURL(file).href)) as {
        up: (db: Kysely<ProdDatabase>) => Promise<void>;
      };
      await migration.up(db);
    }
    await sql`insert into core.factor_sets (source_manifest_digest, source_manifest) values (${fixture.digest}, '{}'::jsonb)`.execute(
      db
    );
    const values = fixture.rows.map(
      (row) =>
        sql`(1, ${row.kind}, ${row.frequency}, ${row.periodKey}, ${row.value}::numeric, 'fixture', 'observed', 'set-1 snapshot', 'https://insse.ro/', 'set-1 snapshot')`
    );
    await sql`insert into core.normalization_factors (factor_set_id,factor_kind,frequency,period_key,value,unit,derivation,source,source_url,source_dataset) values ${sql.join(values)}`.execute(
      db
    );
  }, 120_000);
  afterAll(async () => {
    await db?.destroy();
  });

  it('reads all 228 exact rows through the actual generated SQL with current absent', async () => {
    const reader = makeFactorSetReader(db);
    expect((await reader.current())._unsafeUnwrap()).toBeNull();
    const loaded = (await reader.load('1'))._unsafeUnwrap();
    expect(loaded.rows).toHaveLength(228);
    expect(loaded.manifestDigest).toBe(fixture.digest);
    const actual = makeFactorSetSource(reader, '1', fixture.digest);
    const baseline = makeDatasetFactorSource(createDatasetRepo({ rootDir: './datasets/yaml' }));
    for (const kind of Object.keys(FACTOR_DATASET_IDS) as FactorKind[]) {
      const rows = (await actual.yearly(kind))._unsafeUnwrap()!;
      const expected = (await baseline.yearly(kind))._unsafeUnwrap()!;
      expect(rows.size).toBe(expected.size);
      for (const [year, value] of expected) expect(rows.get(year)?.equals(value)).toBe(true);
    }
    expect((await reader.load('2'))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
  });
});
