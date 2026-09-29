import { randomUUID } from 'node:crypto';

// eslint-disable-next-line import-x/no-unresolved -- The dedicated Vitest config resolves this to NGO_DATA_REPO.
import { startNgoKeyedFixture, type PgFixture } from '@ngo-data/rnong-keyed-reads.fixture.js';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeNgoOrganizationRepo } from '@/modules/ngos/shell/repo/organization-repo.js';

import type { NgoOrganizationRepository } from '@/modules/ngos/core/organization.js';
import type { ProdDatabase } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
};

// This fixture applies the real scraper migrations to its own disposable database.
// The repository connects separately with only the deployed reader permissions.
describe('NGO repository with real DDL and a minimal reader', () => {
  let fixture: PgFixture | undefined;
  let client: pg.PoolClient;
  let db: Kysely<ProdDatabase> | undefined;
  let repo: NgoOrganizationRepository;
  const cui = '30339344';
  const reader = 'ngo_contract_' + randomUUID().replaceAll('-', '');
  let readerCreated = false;
  beforeAll(async () => {
    ({ fixture, client } = await startNgoKeyedFixture());
    await client.query(`create role ${reader} nologin;
      grant usage on schema ngo to ${reader};
      grant select on ngo.rnong_public_records, ngo.rnong_public_snapshots to ${reader};
      grant execute on function ngo.public_organization_profile(text),
        ngo.public_financial_statements(text,integer[]) to ${reader}`);
    readerCreated = true;
    const pool = new pg.Pool({
      connectionString: fixture.connectionString,
      max: 2,
      options: `-c role=${reader}`,
    });
    db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });
    repo = makeNgoOrganizationRepo(db, true);
  }, 180000);
  afterAll(async () => {
    await db?.destroy();
    client?.release();
    await fixture?.stop();
    // Roles are cluster-wide; remove only this suite's role after its database is dropped.
    const admin = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
    try {
      if (readerCreated) await admin.query(`drop role ${reader}`);
    } finally {
      await admin.end();
    }
  });
  it('reads an admitted profile and every registry observation', async () => {
    const result = await repo.profile(cui);
    expect(result.isOk(), result.isErr() ? result.error.message : '').toBe(true);
    expect(unwrap(result)).toMatchObject({
      cui,
      identity: { cui, method: 'registry_cui' },
      observationCount: 2,
      purpose: { availability: 'not_released' },
      fiscal: { availability: 'available' },
      financials: { availability: 'not_loaded' },
    });
    expect(unwrap(result)?.registryRecords).toHaveLength(2);
    const missing = await repo.profile('9999999999');
    expect(missing.isOk()).toBe(true);
    expect(unwrap(missing)).toBeNull();
  });
  it('preserves exact values, dictionary labels, blank cells and year filters', async () => {
    const definitions = Array.from({ length: 46 }, (_, i) => ({
      code: `I${String(i + 1)}`,
      name: `Source label ${String(i + 1)}`,
      normalizedName: `label_${String(i + 1)}`,
    }));
    await client.query(
      `insert into ngo.mfp_financial_resources(resource_id,fiscal_year,source_url,source_sha256,
      object_bucket,object_key,object_version_id,captured_at,dictionary_resource_id,dictionary_url,dictionary_sha256,
      dictionary_object_key,dictionary_object_version_id,statement_profile_hash,indicator_definitions,mapping_version)
      values('repo_fixture',2025,'https://data.gov.ro/data',repeat('a',64),'private','key','version','2026-09-25T10:00:00Z',
      'dict','https://data.gov.ro/dict',repeat('b',64),'dict','version',repeat('c',64),$1::jsonb,'ngo-mfp-observations-v1')`,
      [JSON.stringify(definitions)]
    );
    await client.query(
      `insert into ngo.mfp_financial_statements values('repo_fixture',2025,2,$1,repeat('d',64),
      '{"I1":"9007199254740993","I2":"0","I3":"-0"}')`,
      [cui]
    );
    const result = await repo.financialStatements(cui, [2025]);
    expect(result.isOk(), result.isErr() ? result.error.message : '').toBe(true);
    expect(unwrap(result)).toHaveLength(1);
    expect(unwrap(result)[0]?.indicators.slice(0, 4)).toEqual([
      { code: 'I1', label: 'Source label 1', value: '9007199254740993' },
      { code: 'I2', label: 'Source label 2', value: '0' },
      { code: 'I3', label: 'Source label 3', value: '-0' },
      { code: 'I4', label: 'Source label 4', value: null },
    ]);
    const other = await repo.financialStatements(cui, [2024]);
    expect(other.isOk()).toBe(true);
    expect(unwrap(other)).toEqual([]);
    expect(JSON.stringify(unwrap(result))).not.toMatch(/object_key|object_bucket|source_sha256/);
  });
  it('withholds profiles and statements immediately after a privacy change', async () => {
    await client.query(
      "update core.organizations set privacy_class='restricted' where cui='30339344'"
    );
    try {
      const profile = await repo.profile(cui);
      expect(profile.isOk()).toBe(true);
      expect(unwrap(profile)).toBeNull();
      const statements = await repo.financialStatements(cui, null);
      expect(statements.isOk()).toBe(true);
      expect(unwrap(statements)).toEqual([]);
    } finally {
      await client.query(
        "update core.organizations set privacy_class='public' where cui='30339344'"
      );
    }
  });
  it('denies private tables and the internal helper to the reader', async () => {
    const pool = new pg.Pool({
      connectionString: fixture!.connectionString,
      options: `-c role=${reader}`,
    });
    try {
      for (const statement of [
        'select * from ngo.anaf_registered_offices',
        'select * from ngo.legal_registry_records',
        "select * from ngo.rnong_organizations_for_cui('30339344')",
      ])
        await expect(pool.query(statement)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await pool.end();
    }
  });
});
