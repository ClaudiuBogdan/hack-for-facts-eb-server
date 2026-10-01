import { randomUUID } from 'node:crypto';

import { makeExecutableSchema } from '@graphql-tools/schema';
// eslint-disable-next-line import-x/no-unresolved -- Runtime is supplied by the dedicated NGO_DATA_REPO alias.
import { startNgoKeyedFixture, type PgFixture } from '@ngo-data/rnong-keyed-reads.fixture.js';
import { graphql } from 'graphql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeNgosModule } from '@/modules/ngos/index.js';
import { makeNgoOrganizationRepo } from '@/modules/ngos/shell/repo/organization-repo.js';
import { makeNgoRegistryRepo } from '@/modules/ngos/shell/repo/registry-repo.js';

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
    ({ fixture, client } = await startNgoKeyedFixture({ registryReads: true }));
    await client.query(`create role ${reader} nologin;
      grant usage on schema ngo to ${reader};
      grant select on ngo.rnong_public_records, ngo.rnong_public_snapshots to ${reader};
      grant select on ngo.public_section_snapshots, ngo.public_social_services,
        ngo.public_social_service_providers, ngo.public_social_enterprise_certificates,
        ngo.public_employment_accreditations, ngo.rnong_public_purposes to ${reader};
      grant execute on function ngo.public_organization_profile(text),
        ngo.public_financial_statements(text,integer[]),ngo.public_registry_profile(text),ngo.public_registry_record_identities(text,text[]) to ${reader}`);
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
      purpose: { availability: 'available', text: 'Activități sportive.' },
      fiscal: { availability: 'available' },
      financials: { availability: 'not_loaded' },
    });
    expect(unwrap(result)?.registryRecords).toHaveLength(2);
    const missing = await repo.profile('9999999999');
    expect(missing.isOk()).toBe(true);
    expect(unwrap(missing)).toBeNull();
  });
  it('serves registry-only purpose and nullable enrichment through the composed GraphQL and MCP module', async () => {
    const module = makeNgosModule({ db: db!, enabled: true });
    const schema = makeExecutableSchema({
      typeDefs:
        'scalar Date\nscalar DateTime\nscalar CUI\ntype PageInfo { hasNextPage:Boolean! endCursor:String }\ntype Query {ping:String}\n' +
        module.graphqlSlice.typeDefs,
      resolvers: module.graphqlResolvers,
    });
    const result = await graphql({
      schema,
      source: `{ngoRegistryProfile(registryNumber:"2/A/2020"){status profiles{cui identity{cui method} registryNumber observationCount conflicts purpose{availability text} financials{availability fiscalYears statements{fiscalYear}} fiscal{availability data{vatPayer}} socialServices{availability snapshot{id} data{county}}}}}`,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data?.['ngoRegistryProfile']).toMatchObject({
      status: 'resolved',
      profiles: [
        {
          cui: null,
          identity: null,
          observationCount: 2,
          conflicts: ['court'],
          purpose: { availability: 'available', text: null },
          financials: { availability: 'not_loaded', fiscalYears: [], statements: [] },
          socialServices: { availability: 'not_loaded', snapshot: null, data: null },
        },
      ],
    });
    const admitted = await graphql({
      schema,
      source: `{ngoRegistryProfile(registryNumber:"1/A/2020"){profiles{cui purpose{availability text} financials{availability statements{fiscalYear}}}}}`,
    });
    expect(admitted.errors).toBeUndefined();
    expect(admitted.data?.['ngoRegistryProfile']).toMatchObject({
      profiles: [{ cui, purpose: { availability: 'available', text: 'Activități sportive.' } }],
    });
    const registryOnly = unwrap(await repo.registryProfile('2/A/2020'));
    expect(
      registryOnly?.profiles[0]?.registryRecords.every(
        (r) => r.organizationCui === null && r.organizationIdentityMethod === null
      )
    ).toBe(true);
    const tool = module.mcpTools.find((t) => t.name === 'get_ngo_registry_profile')!;
    expect(await tool.handler({ registryNumber: '2/A/2020' })).toMatchObject({
      ok: true,
      item: { status: 'resolved', profiles: [{ cui: null }] },
    });
    expect(await tool.handler({ registryNumber: 'unknown' })).toMatchObject({
      ok: true,
      item: null,
    });
  });
  it('adds admitted identities to current registry records without replacing source/direct CUI fields', async () => {
    const records = unwrap(await makeNgoRegistryRepo(db!, true).list({ filter: {}, first: 100 }));
    expect(records.items[0]).toMatchObject({
      sourceCui: cui,
      linkedOrganizationCui: cui,
      organizationCui: cui,
      organizationIdentityMethod: 'registry_cui',
    });
    expect(records.items.find((r) => r.registryNumber === '2/A/2020')).toMatchObject({
      organizationCui: null,
      organizationIdentityMethod: null,
    });
  });
  it('withholds a purpose the organization observations disagree on', async () => {
    const second =
      '(select legal_record_id from ngo.legal_registry_records where source_row_number=2)';
    await client.query(
      `update ngo.rnong_purposes set purpose='Alt scop.' where legal_record_id=${second}`
    );
    try {
      const profile = unwrap(await repo.profile(cui));
      expect(profile?.purpose).toMatchObject({ availability: 'not_released', text: null });
      expect(profile?.conflicts).toContain('purpose');
    } finally {
      await client.query(
        `update ngo.rnong_purposes set purpose='Activități sportive.' where legal_record_id=${second}`
      );
    }
  });
  it('reads current source lists by CUI, county-only for protective services, without places', async () => {
    const profile = unwrap(await repo.profile(cui));
    expect(profile?.socialServices).toMatchObject({
      availability: 'available',
      snapshot: { sourceUrl: 'https://mmuncii.ro/licente.xml', sourceDeclaredDate: null },
    });
    // Stale, other-scope and restricted rows are absent. Protective services keep their category
    // and county only; unreviewed or missing labels are withheld with the place.
    expect(
      profile?.socialServices.data?.map(({ serviceType, serviceName, locality, countyOnly }) => ({
        serviceType: serviceType?.slice(0, 20) ?? null,
        serviceName,
        locality,
        countyOnly,
      }))
    ).toEqual([
      { serviceType: '5.Centre rezidenţial', serviceName: null, locality: null, countyOnly: true },
      {
        serviceType: 'Centre de zi  pentru',
        serviceName: 'Centrul de zi Floresti',
        locality: 'FLORESTI',
        countyOnly: false,
      },
      { serviceType: 'Centre rezidenţiale ', serviceName: null, locality: null, countyOnly: true },
      { serviceType: null, serviceName: null, locality: null, countyOnly: true },
      { serviceType: null, serviceName: null, locality: null, countyOnly: true },
    ]);
    expect(profile?.socialServiceAccreditations.data).toEqual([
      { certificateNumber: 'AF/000044', decisionNumber: '486' },
    ]);
    expect(profile?.socialEnterpriseCertificates).toMatchObject({
      snapshot: { sourceDeclaredDate: '2026-05-15' },
      data: [
        {
          certificateNumber: 'CJ/0001',
          certificateDate: '2021-05-04',
          validUntil: '2026-05-04',
          status: 'ACTIV',
        },
      ],
    });
    expect(profile?.employmentServiceAccreditations.data).toEqual([
      { certificateNumber: 'Seria A nr. 0001', issuedOn: '2019-03-01' },
    ]);
    expect(JSON.stringify(profile)).not.toMatch(
      /Exemplu 1|54975|Adapost|Casa de tip|Turda|Turzii|BISTRITA|alt scope|Art\. 29|Notificare|Privat/
    );

    await client.query(
      "update ngo.source_snapshots set is_current=false where source_id='anofm_rueis'"
    );
    try {
      const withoutRueis = unwrap(await repo.profile(cui));
      expect(withoutRueis?.socialEnterpriseCertificates).toEqual({
        availability: 'not_loaded',
        snapshot: null,
        data: null,
      });
    } finally {
      await client.query(
        "update ngo.source_snapshots set is_current=true where source_id='anofm_rueis'"
      );
    }
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
        'select * from ngo.social_services',
        'select * from ngo.social_service_providers',
        'select * from ngo.sector_memberships',
        'select * from ngo.accreditations',
        'select * from ngo.source_snapshots',
        'select * from ngo.rnong_purposes',
      ])
        await expect(pool.query(statement)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await pool.end();
    }
  });
});
