import { randomUUID } from 'node:crypto';

import { makeExecutableSchema } from '@graphql-tools/schema';
// eslint-disable-next-line import-x/no-unresolved -- Runtime is supplied by the test-only @pe-data alias.
import { startPgFixture, type PgFixture } from '@pe-data/extraction-kit/testing/pg-fixture.js';
// eslint-disable-next-line import-x/no-unresolved -- Runtime is supplied by the test-only @pe-data alias.
import { up as v2Schema } from '@pe-data/prod-migrations/20260629T160000__public_enterprises_v2_schema.js';
// eslint-disable-next-line import-x/no-unresolved -- Runtime is supplied by the test-only @pe-data alias.
import { up as cutover } from '@pe-data/prod-migrations/20260630T120000__public_enterprises_cutover.js';
// eslint-disable-next-line import-x/no-unresolved -- Runtime is supplied by the test-only @pe-data alias.
import { up as readViews } from '@pe-data/prod-migrations/20261006T180000__public_enterprises_public_read_views.js';
import { graphql } from 'graphql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { ok, type Result } from 'neverthrow';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getPublicEnterpriseProfile,
  listPublicEnterpriseIndicators,
  listPublicEnterprises,
  listPublicEnterpriseSources,
  type PublicEnterpriseDeps,
} from '@/modules/public-enterprises/core/usecases.js';
import { makePublicEnterprisesModule } from '@/modules/public-enterprises/index.js';
import { makePublicEnterpriseRepo } from '@/modules/public-enterprises/shell/repo/public-enterprise-repo.js';

import type { Organization, ProdDatabase } from '@/modules/shared/index.js';

/**
 * The public-enterprise module over the REAL scraper DDL: the canonical schema
 * (20260629T160000 + the 20260630T120000 cutover; it has no cross-schema
 * foreign key) and the R5 public read views (20261006T180000), applied to a
 * disposable database by the scraper's own PG fixture. Literal reviewed rows;
 * the repository connects separately with a reader that can only read the five
 * views. Kernel identity is an in-memory fake (only 10020943 is named).
 */

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw new Error(JSON.stringify(result.error));
  return result.value;
};
const h = (n: number): string => n.toString(16).padStart(64, '0');

const SEED = `
  insert into public_enterprises.source_snapshots
    (snapshot_id, source_family, source_scope, raw_snapshot_id, source_url, content_sha256, row_count,
     observed_at, source_last_modified_at, status, is_current, privacy_class, metadata, loaded_at, accepted_at) values
    ('amepip-0', 'amepip', '', 'raw-a0', 'https://data.gov.ro/amepip-0.xlsx', '${h(1)}', 2,
     '2025-12-01T00:00:00Z', '2025-11-30T00:00:00Z', 'accepted', false, 'public', '{}', '2025-12-02T00:00:00Z', '2025-12-02T00:00:00Z'),
    ('amepip-1', 'amepip', '', 'raw-a1', 'https://data.gov.ro/amepip-1.xlsx', '${h(2)}', 3,
     '2026-09-01T00:00:00Z', '2026-08-31T00:00:00Z', 'accepted', true, 'public', '{"workbookBytes": 100}', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00.123456Z'),
    ('s1001-1', 's1001', '', 'raw-s1', 'https://mfinante.gov.ro/s1001-1.pdf', '${h(3)}', 2,
     '2026-06-23T00:00:00Z', null, 'accepted', false, 'public', '{"rawStatus": "parsed"}', '2026-06-24T00:00:00Z', '2026-06-24T00:00:00Z'),
    ('s1001-2', 's1001', '', 'raw-s2', 'https://mfinante.gov.ro/s1001-2.pdf', '${h(4)}', 1,
     '2026-08-26T00:00:00Z', null, 'accepted', true, 'public', '{"rawStatus": "partial"}', '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z');

  insert into public_enterprises.source_evidence
    (source_evidence_key, snapshot_id, source_family, source_table, source_record_key, source_url, object_key, privacy_class) values
    ('ev:a0:44444440', 'amepip-0', 'amepip_company_year', 'amepip_company_years', 'amepip-0:44444440:2022', 'https://data.gov.ro/amepip-0.xlsx#44444440', null, 'public'),
    ('ev:a0:10020943', 'amepip-0', 'amepip_company_year', 'amepip_company_years', 'amepip-0:10020943:2022', 'https://data.gov.ro/amepip-0.xlsx#10020943', null, 'public'),
    ('ev:a0:dict:MS', 'amepip-0', 'amepip_kpi_dictionary', 'amepip_kpi_dictionary', 'amepip-0:MS', 'https://data.gov.ro/amepip-0.xlsx#dict-MS', null, 'public'),
    ('ev:a0:v:ms2018', 'amepip-0', 'amepip_indicator_value', 'amepip_indicator_values', 'amepip-0:10020943|2018|MS', 'https://data.gov.ro/amepip-0.xlsx#v0', null, 'public'),
    ('ev:a1:10020943', 'amepip-1', 'amepip_company_year', 'amepip_company_years', 'amepip-1:10020943:2023', 'https://data.gov.ro/amepip-1.xlsx#10020943', null, 'public'),
    ('ev:a1:1973096', 'amepip-1', 'amepip_company_year', 'amepip_company_years', 'amepip-1:1973096:2023', 'https://data.gov.ro/amepip-1.xlsx#1973096', null, 'public'),
    ('ev:a1:25252500', 'amepip-1', 'amepip_form_group', 'amepip_form_groups', 'amepip-1:25252500:2023:v1', 'https://data.gov.ro/amepip-1.xlsx#25252500', null, 'public'),
    ('ev:a1:dict:MS', 'amepip-1', 'amepip_kpi_dictionary', 'amepip_kpi_dictionary', 'amepip-1:MS', 'https://data.gov.ro/amepip-1.xlsx#dict-MS', null, 'public'),
    ('ev:a1:dict:ROA', 'amepip-1', 'amepip_kpi_dictionary', 'amepip_kpi_dictionary', 'amepip-1:ROA', 'https://data.gov.ro/amepip-1.xlsx#dict-ROA', null, 'public'),
    ('ev:a1:dict:NOTE', 'amepip-1', 'amepip_kpi_dictionary', 'amepip_kpi_dictionary', 'amepip-1:NOTE', 'https://data.gov.ro/amepip-1.xlsx#dict-NOTE', null, 'public'),
    ('ev:a1:v:1', 'amepip-1', 'amepip_indicator_value', 'amepip_indicator_values', 'amepip-1:v1', 'https://data.gov.ro/amepip-1.xlsx#v1', null, 'public'),
    ('ev:a1:v:2', 'amepip-1', 'amepip_indicator_value', 'amepip_indicator_values', 'amepip-1:v2', null, 'raw/amepip/1', 'public'),
    ('ev:a1:v:3', 'amepip-1', 'amepip_indicator_value', 'amepip_indicator_values', 'amepip-1:v3', 'https://data.gov.ro/amepip-1.xlsx#v3', null, 'public'),
    ('ev:a1:v:4', 'amepip-1', 'amepip_indicator_value', 'amepip_indicator_values', 'amepip-1:v4', 'https://data.gov.ro/amepip-1.xlsx#v4', null, 'public'),
    ('ev:a1:v:5', 'amepip-1', 'amepip_indicator_value', 'amepip_indicator_values', 'amepip-1:v5', 'https://data.gov.ro/amepip-1.xlsx#v5', null, 'public'),
    ('ev:a1:v:6', 'amepip-1', 'amepip_indicator_value', 'amepip_indicator_values', 'amepip-1:v6', 'https://data.gov.ro/amepip-1.xlsx#v6', null, 'public'),
    ('ev:a1:v:7', 'amepip-1', 'amepip_indicator_value', 'amepip_indicator_values', 'amepip-1:v7', 'https://data.gov.ro/amepip-1.xlsx#v7', null, 'public'),
    ('ev:s1:10300854', 's1001-1', 's1001', 's1001_rows', 's1001-1:10300854', 'https://mfinante.gov.ro/s1001-1.pdf#10300854', null, 'public'),
    ('ev:s1:360557', 's1001-1', 's1001', 's1001_rows', 's1001-1:360557', 'https://mfinante.gov.ro/s1001-1.pdf#360557', null, 'public'),
    ('ev:s2:10300854', 's1001-2', 's1001', 's1001_rows', 's1001-2:10300854', 'https://mfinante.gov.ro/s1001-2.pdf#10300854', null, 'public'),
    ('ev:s2:edge:10300854', 's1001-2', 's1001', 's1001_rows', 's1001-2:edge:10300854', 'https://mfinante.gov.ro/s1001-2.pdf#edge', null, 'public');

  insert into public_enterprises.enterprises
    (cui, organization_cui, universe_sources, current_status, primary_source_evidence_key, privacy_class) values
    ('10020943', '10020943', array['amepip_company_year'], 'active', 'ev:a1:10020943', 'public'),
    ('1973096', '1973096', array['amepip_company_year'], 'active', 'ev:a1:1973096', 'public'),
    ('25252500', '25252500', array['amepip_form_group'], 'unknown', 'ev:a1:25252500', 'public'),
    ('10300854', '10300854', array['s1001'], 'active', 'ev:s1:10300854', 'public'),
    ('360557', '360557', array['s1001'], 'active', 'ev:s1:360557', 'public'),
    ('44444440', '44444440', array['amepip_company_year'], 'active', 'ev:a0:44444440', 'public');

  insert into public_enterprises.enterprise_registry_observations
    (registry_observation_key, snapshot_id, source_family, source_record_key, cui, raw_cui, cui_checksum_status,
     publish_status, observed_name, observed_year, status_raw, status_normalized, raw_subordination,
     derived_authority_level, source_evidence_key, privacy_class) values
    ('amepip-0|amepip_company_year|44444440:2022', 'amepip-0', 'amepip_company_year', '44444440:2022', '44444440', '44444440', 'valid',
     'publishable', 'Old Only SA', 2022, 'functiune', 'active', null, null, 'ev:a0:44444440', 'public'),
    ('amepip-0|amepip_company_year|10020943:2022', 'amepip-0', 'amepip_company_year', '10020943:2022', '10020943', '10020943', 'valid',
     'publishable', 'Hidroelectrica SA', 2022, 'functiune', 'active', null, null, 'ev:a0:10020943', 'public'),
    ('amepip-1|amepip_company_year|10020943:2023', 'amepip-1', 'amepip_company_year', '10020943:2023', '10020943', '10020943', 'valid',
     'publishable', 'Hidroelectrica SA', 2023, 'functiune', 'active', null, null, 'ev:a1:10020943', 'public'),
    ('amepip-1|amepip_company_year|1973096:2023', 'amepip-1', 'amepip_company_year', '1973096:2023', '1973096', '1973096', 'valid',
     'publishable', 'Antibiotice SA', 2023, 'functiune', 'active', null, null, 'ev:a1:1973096', 'public'),
    ('amepip-1|amepip_form_group|25252500:2023:v1', 'amepip-1', 'amepip_form_group', '25252500:2023:v1', '25252500', '25252500', 'valid',
     'publishable', 'Forma Only SA', 2023, null, null, null, null, 'ev:a1:25252500', 'public'),
    ('s1001-1|s1001|10300854', 's1001-1', 's1001', '10300854', '10300854', '10300854', 'valid',
     'publishable', 'RA Aeroportul Craiova', null, 'ACTIV', 'active', 'central', 'central', 'ev:s1:10300854', 'public'),
    ('s1001-1|s1001|360557', 's1001-1', 's1001', '360557', '360557', '360557', 'valid',
     'publishable', 'Eurotest SA', null, 'ACTIV', 'active', 'central', 'central', 'ev:s1:360557', 'public'),
    ('s1001-2|s1001|10300854', 's1001-2', 's1001', '10300854', '10300854', '10300854', 'valid',
     'publishable', 'RA Aeroportul Craiova', null, 'ACTIV', 'active', 'central', 'central', 'ev:s2:10300854', 'public');

  insert into public_enterprises.controlling_authority_edges
    (control_edge_key, snapshot_id, source_family, source_record_key, enterprise_cui, authority_cui, authority_name,
     raw_subordination, authority_level, authority_level_method, apt_type_id, enterprise_status_raw,
     effective_from, effective_to, is_current, confidence, source_url, source_evidence_key, privacy_class) values
    ('s1001-2|s1001|10300854', 's1001-2', 's1001', '10300854', '10300854', '4305849', 'Ministerul Energiei',
     'central', 'central', 's1001_subordination', null, 'ACTIV', '2026-08-26', null, true, 1,
     'https://mfinante.gov.ro/s1001-2.pdf#p3', 'ev:s2:edge:10300854', 'public');

  insert into public_enterprises.amepip_kpi_dictionary
    (snapshot_id, indicator_key, kpi_code, kpi_id, indicator_name, source_sheet, source_header, source_header_hash,
     kpi_family, measure_unit, value_type, is_absolute_financial, source_evidence_key, privacy_class) values
    ('amepip-0', 'MS', 'MS', 'kpi-ms', 'Marja neta', 'Indicatori calculati', 'MS', '${h(11)}', 'financial_ratio', '%', null, false, 'ev:a0:dict:MS', 'public'),
    ('amepip-1', 'MS', 'MS', 'kpi-ms', 'Marja neta', 'Indicatori calculati', 'MS', '${h(11)}', 'financial_ratio', '%', null, false, 'ev:a1:dict:MS', 'public'),
    ('amepip-1', 'ROA', 'ROA', 'kpi-roa', 'Rentabilitatea activelor', 'Indicatori calculati', 'ROA', '${h(12)}', 'financial_ratio', '%', null, false, 'ev:a1:dict:ROA', 'public'),
    ('amepip-1', 'NOTE', null, null, 'Observatii', 'Indicatori formular', 'Observatii', '${h(13)}', null, null, null, false, 'ev:a1:dict:NOTE', 'public');

  insert into public_enterprises.amepip_indicator_values
    (snapshot_id, enterprise_cui, year, source_sheet, version, indicator_key, kpi_code, raw_value, numeric_value,
     boolean_value, text_value, value_kind, source_row_number, source_row_hash, source_evidence_key, privacy_class) values
    ('amepip-0', '10020943', 2018, 'Indicatori calculati', '', 'MS', 'MS', '0.0390', 0.0390, null, null, 'number', 7, '${h(20)}', 'ev:a0:v:ms2018', 'public'),
    ('amepip-1', '10020943', 2019, 'Indicatori calculati', '', 'MS', 'MS', '0.0425', 0.0425, null, null, 'number', 8, '${h(21)}', 'ev:a1:v:1', 'public'),
    ('amepip-1', '10020943', 2019, 'Indicatori calculati', '', 'ROA', 'ROA', '12.50', 12.50, null, null, 'number', 9, '${h(22)}', 'ev:a1:v:2', 'public'),
    ('amepip-1', '10020943', 2019, 'Indicatori formular', '', 'NOTE', null, 'in curs de numire', null, null, null, 'text', 10, '${h(23)}', 'ev:a1:v:3', 'public'),
    ('amepip-1', '10020943', 2019, 'Indicatori formular', 'v2', 'NOTE', null, '', null, null, null, 'empty', 11, '${h(24)}', 'ev:a1:v:4', 'public'),
    ('amepip-1', '10020943', 2020, 'Indicatori calculati', '', 'MS', 'MS', '0.0390', 0.0390, null, null, 'number', 12, '${h(25)}', 'ev:a1:v:5', 'public'),
    ('amepip-1', '10020943', 2020, 'Indicatori formular', '', 'NOTE', null, null, null, null, null, 'empty', 13, '${h(26)}', 'ev:a1:v:6', 'public'),
    ('amepip-1', '10020943', 2021, 'Indicatori formular', '', 'NOTE', null, 'DA', null, true, null, 'boolean', 14, '${h(27)}', 'ev:a1:v:7', 'public');
`;

/** The seven current amepip-1 cells of 10020943 in (year, sheet, version, key) order. */
const ORDERED_CELLS = [
  'amepip-1|10020943|2019|Indicatori calculati||MS',
  'amepip-1|10020943|2019|Indicatori calculati||ROA',
  'amepip-1|10020943|2019|Indicatori formular||NOTE',
  'amepip-1|10020943|2019|Indicatori formular|v2|NOTE',
  'amepip-1|10020943|2020|Indicatori calculati||MS',
  'amepip-1|10020943|2020|Indicatori formular||NOTE',
  'amepip-1|10020943|2021|Indicatori formular||NOTE',
];

const organization = (cui: string): Organization => ({
  orgId: '42',
  cui,
  registrationNumber: null,
  kind: 'public_entity',
  name: 'HIDROELECTRICA SA',
  normalizedName: null,
  countyName: null,
  localityName: null,
  sirutaCode: null,
  firstSeenSource: 'test',
  attrs: {},
});
const identityRepo: PublicEnterpriseDeps['identityRepo'] = {
  findManyByCui: (cuis) =>
    Promise.resolve(
      ok(new Map(cuis.filter((c) => c === '10020943').map((c) => [c, organization(c)])))
    ),
  searchByName: () =>
    Promise.resolve(
      ok([
        {
          orgId: '42',
          cui: '10020943',
          name: 'HIDROELECTRICA SA',
          normalizedName: null,
          countyName: null,
          kind: 'public_entity',
        },
      ])
    ),
};

describe('public-enterprise module over the real R5 DDL and a view-only reader', () => {
  let fixture: PgFixture | undefined;
  let db: Kysely<ProdDatabase> | undefined;
  let deps: PublicEnterpriseDeps;
  const reader = 'pe_contract_' + randomUUID().replaceAll('-', '');
  let readerCreated = false;

  const admin = (text: string) => fixture!.pool.query(text);
  const restricted = async (table: string, where: string, run: () => Promise<void>) => {
    await admin(
      `update public_enterprises.${table} set privacy_class = 'restricted' where ${where}`
    );
    try {
      await run();
    } finally {
      await admin(`update public_enterprises.${table} set privacy_class = 'public' where ${where}`);
    }
  };

  beforeAll(async () => {
    fixture = await startPgFixture();
    await v2Schema(fixture.db);
    await cutover(fixture.db);
    await readViews(fixture.db);
    await admin(SEED);
    await admin(`create role ${reader} nologin;
      grant usage on schema public_enterprises to ${reader};
      grant select on public_enterprises.public_source_snapshots,
        public_enterprises.public_registry_observations, public_enterprises.public_authority_edges,
        public_enterprises.public_enterprise_memberships, public_enterprises.public_amepip_indicators
        to ${reader}`);
    readerCreated = true;
    const pool = new pg.Pool({
      connectionString: fixture.connectionString,
      max: 2,
      options: `-c role=${reader}`,
    });
    db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });
    deps = { repo: makePublicEnterpriseRepo(db, true), identityRepo };
  }, 180000);

  afterAll(async () => {
    await db?.destroy();
    await fixture?.stop();
    // Roles are cluster-wide; remove only this suite's role after its database is dropped.
    const cluster = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
    try {
      if (readerCreated) await cluster.query(`drop role ${reader}`);
    } finally {
      await cluster.end();
    }
  });

  it('the reader reads the five views and nothing else', async () => {
    await expect(
      db!.selectFrom('public_enterprises.public_source_snapshots').selectAll().execute()
    ).resolves.toHaveLength(2);
    await expect(
      sql.raw('select cui from public_enterprises.enterprises').execute(db!)
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql.raw('select 1 from public_enterprises.current_enterprises').execute(db!)
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('serves source availability per lane: loaded, partial and not loaded', async () => {
    expect(unwrap(await listPublicEnterpriseSources(deps))).toEqual([
      {
        family: 'amepip',
        scope: '',
        laneStatus: 'available',
        snapshotId: 'amepip-1',
        rawStatus: null,
        sourceUrl: 'https://data.gov.ro/amepip-1.xlsx',
        contentSha256: h(2),
        observedAt: '2026-09-01T00:00:00.000000Z',
        sourceLastModifiedAt: '2026-08-31T00:00:00.000000Z',
        acceptedAt: '2026-09-02T00:00:00.123456Z',
        loadedAt: '2026-09-02T00:00:00.000000Z',
      },
      expect.objectContaining({ family: 's1001', laneStatus: 'partial', rawStatus: 'partial' }),
      {
        family: 'json_apt',
        scope: null,
        laneStatus: 'unavailable',
        snapshotId: null,
        rawStatus: null,
        sourceUrl: null,
        contentSha256: null,
        observedAt: null,
        sourceLastModifiedAt: null,
        acceptedAt: null,
        loadedAt: null,
      },
    ]);
  });

  it('serves a current profile with its literal cells, and a historical anchor', async () => {
    const profile = unwrap(await getPublicEnterpriseProfile(deps, '10020943'));
    expect(profile).toMatchObject({
      cui: '10020943',
      organization: { name: 'HIDROELECTRICA SA' },
      isCurrentMember: true,
      currentFamilies: ['amepip_company_year'],
      registryObservations: [
        {
          id: 'amepip-1|amepip_company_year|10020943:2023',
          observedName: 'Hidroelectrica SA',
          sourceUrl: 'https://data.gov.ro/amepip-1.xlsx#10020943',
        },
      ],
      authorityEdges: [],
    });
    const cells = unwrap(
      await listPublicEnterpriseIndicators(deps, { cui: '10020943', filter: {}, first: 100 })
    );
    expect(cells.snapshotId).toBe('amepip-1');
    expect(cells.items.map((c) => c.id)).toEqual(ORDERED_CELLS);
    expect(cells.items[0]).toMatchObject({
      numericValue: '0.0425',
      rawValue: '0.0425',
      measureUnit: '%',
      indicatorName: 'Marja neta',
      valueKind: 'number',
      textValue: null,
      sourceUrl: 'https://data.gov.ro/amepip-1.xlsx#v1',
    });
    // Exact scale kept; an evidence without a URL falls back to the snapshot URL.
    expect(cells.items[1]).toMatchObject({
      numericValue: '12.50',
      sourceUrl: 'https://data.gov.ro/amepip-1.xlsx',
    });
    expect(
      cells.items
        .slice(2)
        .map((c) => [c.valueKind, c.rawValue, c.numericValue, c.booleanValue, c.textValue])
    ).toEqual([
      ['text', 'in curs de numire', null, null, null],
      ['empty', '', null, null, null],
      ['number', '0.0390', '0.0390', null, null],
      ['empty', null, null, null, null],
      ['boolean', 'DA', null, true, null],
    ]);

    expect(unwrap(await getPublicEnterpriseProfile(deps, '44444440'))).toMatchObject({
      cui: '44444440',
      organization: null,
      isCurrentMember: false,
      currentFamilies: [],
      registryObservations: [],
    });
    expect(unwrap(await getPublicEnterpriseProfile(deps, '777'))).toBeNull();
    const s1001 = unwrap(await getPublicEnterpriseProfile(deps, '10300854'));
    expect(s1001?.authorityEdges).toEqual([
      expect.objectContaining({
        id: 's1001-2|s1001|10300854',
        authorityName: 'Ministerul Energiei',
        authorityLevel: 'central',
        effectiveFrom: '2026-08-26',
        sourceUrl: 'https://mfinante.gov.ro/s1001-2.pdf#p3',
      }),
    ]);
  });

  it('pages the list in CUI order without overlap or gap; currentOnly=false adds history; no record is dropped for a missing identity', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const result = unwrap(
        await listPublicEnterprises(deps, {
          filter: { currentOnly: { eq: false } },
          page,
          pageSize: 2,
        })
      );
      expect(result.total).toBe(6);
      seen.push(...result.items.map((i) => i.cui));
      expect(
        result.items.filter((i) => i.cui !== '10020943').every((i) => i.organization === null)
      ).toBe(true);
    }
    expect(seen).toEqual(['360557', '1973096', '10020943', '10300854', '25252500', '44444440']);
    const current = unwrap(
      await listPublicEnterprises(deps, { filter: {}, page: 1, pageSize: 100 })
    );
    expect(current.items.map((i) => [i.cui, i.isCurrentMember])).toEqual([
      ['1973096', true],
      ['10020943', true],
      ['10300854', true],
      ['25252500', true],
    ]);
    const byAuthority = unwrap(
      await listPublicEnterprises(deps, {
        filter: { authorityCuis: { in: ['4305849'] }, authorityLevels: { in: ['central'] } },
        page: 1,
        pageSize: 100,
      })
    );
    expect(byAuthority.items.map((i) => i.cui)).toEqual(['10300854']);
  });

  it('pages indicators across year, sheet, version and key; a changed filter or AMEPIP snapshot rejects the cursor', async () => {
    const seen: string[] = [];
    let after: string | undefined;
    let first: string | undefined;
    do {
      const page = unwrap(
        await listPublicEnterpriseIndicators(deps, {
          cui: '10020943',
          filter: {},
          first: 2,
          ...(after === undefined ? {} : { after }),
        })
      );
      seen.push(...page.items.map((c) => c.id));
      after = page.next ?? undefined;
      first ??= after;
    } while (after !== undefined);
    expect(seen).toEqual(ORDERED_CELLS);
    const changedFilter = await listPublicEnterpriseIndicators(deps, {
      cui: '10020943',
      filter: { years: { in: [2019] } },
      first: 2,
      after: first!,
    });
    expect(changedFilter._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      message: 'cursor/filter mismatch; restart pagination',
    });
    const otherCui = await listPublicEnterpriseIndicators(deps, {
      cui: '1973096',
      filter: {},
      first: 2,
      after: first!,
    });
    expect(otherCui._unsafeUnwrapErr().type).toBe('InvalidInput');
    await admin(`update public_enterprises.source_snapshots set is_current = false where snapshot_id = 'amepip-1';
      update public_enterprises.source_snapshots set is_current = true where snapshot_id = 'amepip-0'`);
    try {
      const stale = await listPublicEnterpriseIndicators(deps, {
        cui: '10020943',
        filter: {},
        first: 2,
        after: first!,
      });
      expect(stale._unsafeUnwrapErr().type).toBe('InvalidInput');
      const older = unwrap(
        await listPublicEnterpriseIndicators(deps, { cui: '10020943', filter: {}, first: 100 })
      );
      expect(older.items.map((c) => [c.id, c.numericValue])).toEqual([
        ['amepip-0|10020943|2018|Indicatori calculati||MS', '0.0390'],
      ]);
      expect(unwrap(await getPublicEnterpriseProfile(deps, '44444440'))?.isCurrentMember).toBe(
        true
      );
    } finally {
      await admin(`update public_enterprises.source_snapshots set is_current = false where snapshot_id = 'amepip-0';
        update public_enterprises.source_snapshots set is_current = true where snapshot_id = 'amepip-1'`);
    }
  });

  it('withholds rows whose anchor, fact, evidence, dictionary or snapshot is not public', async () => {
    await restricted('enterprises', `cui = '10300854'`, async () => {
      expect(unwrap(await getPublicEnterpriseProfile(deps, '10300854'))).toBeNull();
      const list = unwrap(
        await listPublicEnterprises(deps, { filter: {}, page: 1, pageSize: 100 })
      );
      expect(list.items.map((i) => i.cui)).not.toContain('10300854');
    });
    await restricted(
      'enterprise_registry_observations',
      `registry_observation_key = 's1001-2|s1001|10300854'`,
      async () => {
        expect(unwrap(await getPublicEnterpriseProfile(deps, '10300854'))).toMatchObject({
          isCurrentMember: false,
          currentFamilies: [],
          registryObservations: [],
        });
      }
    );
    await restricted('source_evidence', `source_evidence_key = 'ev:a1:v:2'`, async () => {
      const cells = unwrap(
        await listPublicEnterpriseIndicators(deps, { cui: '10020943', filter: {}, first: 100 })
      );
      expect(cells.items.map((c) => c.id)).toEqual(
        ORDERED_CELLS.filter((id) => !id.endsWith('ROA'))
      );
    });
    await restricted(
      'amepip_kpi_dictionary',
      `snapshot_id = 'amepip-1' and indicator_key = 'NOTE'`,
      async () => {
        const cells = unwrap(
          await listPublicEnterpriseIndicators(deps, { cui: '10020943', filter: {}, first: 100 })
        );
        expect(cells.items.map((c) => c.indicatorKey)).toEqual(['MS', 'ROA', 'MS']);
      }
    );
    await restricted('source_snapshots', `snapshot_id = 's1001-2'`, async () => {
      const sources = unwrap(await listPublicEnterpriseSources(deps));
      expect(sources.map((s) => [s.family, s.laneStatus])).toEqual([
        ['amepip', 'available'],
        ['s1001', 'unavailable'],
        ['json_apt', 'unavailable'],
      ]);
      expect(unwrap(await getPublicEnterpriseProfile(deps, '10300854'))?.authorityEdges).toEqual(
        []
      );
    });
    // Restored: the baseline is back.
    expect(unwrap(await getPublicEnterpriseProfile(deps, '10300854'))?.isCurrentMember).toBe(true);
  });

  it('serves the same data through the composed GraphQL slice and the MCP tools', async () => {
    const module = makePublicEnterprisesModule({ db: db!, identityRepo, enabled: true });
    const schema = makeExecutableSchema({
      typeDefs:
        'scalar Date\nscalar DateTime\nscalar CUI\nscalar BigInt\nscalar JSON\n' +
        'type PageInfo { hasNextPage: Boolean! endCursor: String }\n' +
        'type Organization { orgId: BigInt! cui: CUI name: String! }\n' +
        'type Query { ping: String }\n' +
        module.graphqlSlice.typeDefs,
      resolvers: module.graphqlResolvers,
    });
    const result = await graphql({
      schema,
      source: `{
        publicEnterprise(cui: "10020943") {
          cui isCurrentMember currentFamilies organization { name }
          indicators(filter: { years: { in: [2019] } }, first: 10) {
            snapshotId edges { node { id numericValue measureUnit rawValue valueKind } }
          }
        }
        publicEnterprises(filter: { currentOnly: { eq: false } }, page: 1, pageSize: 100) { total items { cui } }
      }`,
    });
    expect(result.errors).toBeUndefined();
    const tool = (name: string) => module.mcpTools.find((t) => t.name === name)!;
    const mcpCells = await tool('list_public_enterprise_indicators').handler({
      cui: '10020943',
      filter: { years: { in: [2019] } },
      first: 10,
    });
    const data = result.data as {
      publicEnterprise: { indicators: { edges: { node: Record<string, unknown> }[] } };
      publicEnterprises: { total: number; items: { cui: string }[] };
    };
    expect(data.publicEnterprise.indicators.edges.map((e) => e.node)).toEqual(
      (mcpCells.items as Record<string, unknown>[]).map((c) => ({
        id: c['id'],
        numericValue: c['numericValue'],
        measureUnit: c['measureUnit'],
        rawValue: c['rawValue'],
        valueKind: c['valueKind'],
      }))
    );
    const mcpSearch = await tool('search_public_enterprises').handler({
      filter: { currentOnly: { eq: false } },
      pageSize: 100,
    });
    expect((mcpSearch.items as { cui: string }[]).map((i) => i.cui)).toEqual(
      data.publicEnterprises.items.map((i) => i.cui)
    );
    expect(mcpSearch.meta).toMatchObject({ total: data.publicEnterprises.total });
    const byName = await tool('search_public_enterprises').handler({ q: 'Hidroelectrica' });
    expect((byName.items as { cui: string }[]).map((i) => i.cui)).toEqual(['10020943']);
  });
});
