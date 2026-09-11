/* eslint-disable @typescript-eslint/no-deprecated -- the YAML factor source is the retained Phase A parity baseline (review N/P5) */
/**
 * Phase A real-SQL proof on a dedicated empty PostgreSQL database: the
 * scrapper's actual migration DDL (digest-pinned, read from the sibling
 * checkout or `SCRAPPER_REPO_ROOT`) and the factor reader's generated SQL.
 * The database is either an external disposable one (`E2E_FACTOR_PG_URL`,
 * localhost and named `budget_phase_a`) or, when a container runtime is
 * reachable, a Testcontainers Postgres the suite starts and stops itself
 * (`disposable-postgres.ts`, codebase plan §WP3). Without either the suite
 * SKIPS, or fails when `TEST_E2E_REQUIRED=1`. The e2e suites are not part of
 * the dev-branch CI.
 *
 * The sibling checkout is used only when its dependencies are installed (the
 * migrations resolve `kysely` from the scrapper's own node_modules, a second
 * instance the raw `sql` tags accept by shape). A dirty scrapper working tree
 * on one of the three pinned files fails this suite on purpose: the proof is
 * over the reviewed DDL bytes, not whatever is on disk.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startDisposablePostgres, teardownDisposablePostgres } from './disposable-postgres.js';
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

// Resolved from this file, not the cwd, so a run from a subdirectory finds the same checkout.
const SIBLING_SCRAPPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../hack-for-facts-eb-scrapper'
);
const scrapper =
  process.env['SCRAPPER_REPO_ROOT'] ??
  (existsSync(path.join(SIBLING_SCRAPPER, 'node_modules/kysely')) ? SIBLING_SCRAPPER : undefined);
// Opt-in uses a dedicated fixture, never the application/production connection.
const required = process.env['TEST_E2E_REQUIRED'] === '1';
let db: Kysely<ProdDatabase>;
let container: Awaited<ReturnType<typeof startDisposablePostgres>>;
let ready = false;

/** An external URL is guarded; a container the suite starts is disposable by construction. */
const resolveConnection = async (): Promise<string | undefined> => {
  const external = process.env['E2E_FACTOR_PG_URL'];
  if (external !== undefined && external !== '') {
    const endpoint = new URL(external);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
      !endpoint.pathname.startsWith('/budget_phase_a')
    ) {
      throw new Error('E2E_FACTOR_PG_URL must name a localhost budget_phase_a disposable database');
    }
    return external;
  }
  container = await startDisposablePostgres('budget_phase_a');
  return container?.getConnectionUri();
};

describe('versioned factor reader — real migration DDL', () => {
  beforeAll(async () => {
    const url = scrapper === undefined ? undefined : await resolveConnection();
    if (url === undefined || scrapper === undefined) {
      if (required) throw new Error('Required: a disposable PostgreSQL and SCRAPPER_REPO_ROOT');
      console.warn(
        'Factor SQL proof skipped: no disposable PostgreSQL, container runtime or scrapper checkout'
      );
      return;
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
    ready = true;
  }, 180_000);
  afterAll(async () => {
    await teardownDisposablePostgres(container, () => db?.destroy());
  });

  it('keeps candidates internal, retries after promotion and admits previously promoted sets', async ({
    skip,
  }) => {
    if (!ready) {
      skip();
      return;
    }
    const internal = makeFactorSetReader(db);
    const admitted = makeFactorSetReader(db, { requirePromotion: true });
    expect((await internal.load('1')).isOk()).toBe(true);
    expect((await admitted.load('1')).isErr()).toBe(true);
    const run = await sql<{
      run_id: string;
    }>`insert into etl.load_runs (source_id, target_table, status) values ('economics-factors', 'core.factor_sets', 'succeeded') returning run_id::text`.execute(
      db
    );
    await sql`update core.factor_sets set promoted_at = now(), promoted_run_id = ${run.rows[0]!.run_id}::bigint, is_current = true where factor_set_id = 1`.execute(
      db
    );
    expect((await admitted.load('1')).isOk()).toBe(true);
    await sql`update core.factor_sets set demoted_at = now(), is_current = false where factor_set_id = 1`.execute(
      db
    );
    expect((await makeFactorSetReader(db, { requirePromotion: true }).load('1')).isOk()).toBe(true);
    // Restore the fixture's internal, never-promoted state for legacy parity.
    await sql`update core.factor_sets set promoted_at = null, promoted_run_id = null, demoted_at = null where factor_set_id = 1`.execute(
      db
    );
  });

  it('reads all 228 exact rows through the actual generated SQL with current absent', async ({
    skip,
  }) => {
    if (!ready) {
      skip();
      return;
    }
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
