/**
 * E2E — the analysis API's direct_acquisition grain answered from
 * procurement_v3 against a REAL Postgres, through the analysis usecases and the
 * routing repo (no ClickHouse configured, so only the DA grain answers):
 * the SQL runs, the counted-value figures, buckets, distincts, concentration
 * and records are right on the contract's example rows, buyer geography joins
 * through public entities to public territories, D6 keys every withheld
 * supplier as one `natural_person` bucket (all of them while supplier_disclosure
 * is unreadable, even with a party view that lists every supplier), named
 * suppliers carry their public registry name (party_public_names, by code), no
 * response carries a withheld supplier's name or code, and a read against a
 * moved publication is refused. Parties are read only through the platform's
 * public views (SEC-GRANTS-PROC-2211).
 *
 * Minimal-shape schema from the serving contract (not the data platform's
 * migration, which waits for the owner) plus the three kernel geography tables
 * the join reads. Docker-guarded like the other e2e suites.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Decimal } from 'decimal.js';
import fastifyLib from 'fastify';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import { makeGraphQLPlugin } from '@/infra/graphql/index.js';
import {
  analysisBreakdown,
  analysisConcentration,
  analysisRecords,
  analysisSeries,
  analysisStats,
  type AnalysisDeps,
} from '@/modules/procurement/core/analysis-usecases.js';
import { makeProcurementModule } from '@/modules/procurement/index.js';
import { makeUnconfiguredAnalysisRepo } from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';
import { makeDaRoutingAnalysisRepo } from '@/modules/procurement/shell/repo/da-routing-analysis-repo.js';
import {
  DA_V3_VALUE_NOTE,
  makeDaV3AnalysisSource,
  type DaV3AnalysisSource,
} from '@/modules/procurement/shell/repo/da-v3-analysis-source.js';
import {
  baseTypeDefs,
  mergeGraphqlSlices,
  scalarResolvers,
  type ProdDatabase,
} from '@/modules/shared/index.js';
import { makeSupplierDisclosureRepo } from '@/modules/shared/shell/repo/supplier-disclosure-repo.js';

import { dockerCliUp } from './disposable-postgres.js';
import {
  BAD_CODE_SUPPLIER,
  BUYER,
  COMPANY,
  NATURAL_PERSON,
  PURCHASES,
  SECRET,
  SOLE_TRADER,
  UNVERIFIED,
} from '../fixtures/procurement/da-release.js';

import type { DaPartyRecord } from '@/modules/procurement/core/da-release.js';

let container: StartedPostgreSqlContainer | undefined;
let db: Kysely<ProdDatabase> | undefined;
let dockerAvailable = false;

const it = (name: string, test: () => unknown): void => {
  vitestIt(name, async ({ skip }) => {
    if (!dockerAvailable) skip();
    await test();
  });
};

const SOURCE = 'elicitatie_api_pub';
const AS_OF = '2026-11-18T03:10:00.123456Z';
const AS_OF_2 = '2026-11-19T03:10:00.654321Z';
const micros = (iso: string): string => {
  const [whole, fraction = '0'] = iso.replace('Z', '').split('.');
  return (
    BigInt(Date.parse(`${whole ?? ''}Z`)) * 1000n +
    BigInt(fraction.padEnd(6, '0').slice(0, 6))
  ).toString();
};

const DDL = `
  create schema procurement_v3;
  create table procurement_v3.da_purchases (
    purchase_id text primary key, source_name text not null, native_id text, code text,
    outcome text not null, finalization_day date, reported_value numeric(20,2),
    counted boolean not null, counted_value numeric(20,2), symbolic_price boolean not null default false,
    title text, description text, category_code text, category_as_written text,
    buyer_party_id text, supplier_party_id text
  );
  create table procurement_v3.da_parties (
    source_name text not null, party_kind text not null, portal_party_id text not null,
    fiscal_code_clean text, fiscal_code_status text, name_as_written text,
    primary key (source_name, party_kind, portal_party_id)
  );
  create table procurement_v3.da_release (data_as_of timestamptz not null);
  -- Before the D6 view: a public party view the reader may read, but no
  -- supplier_disclosure, so D6 must withhold every supplier the view lists.
  create view procurement_v3.da_parties_public with (security_barrier = true) as
    select source_name, party_kind, portal_party_id, fiscal_code_clean, fiscal_code_status, name_as_written
    from procurement_v3.da_parties;
  create schema core;
  create table core.public_entities (cui text primary key, territorial_siruta_code text);
  create table core.territories (
    id serial primary key, territorial_siruta_code text, county_code text, region text,
    privacy_class text not null default 'public'
  );
  create schema companies_v2;
  create table companies_v2.registrations (cui text primary key, selected_uat_siruta_code text);
`;

const load = async (trx: Kysely<ProdDatabase>): Promise<void> => {
  await sql.raw(DDL).execute(trx);
  await sql`insert into procurement_v3.da_release values (${AS_OF})`.execute(trx);
  const parties = new Map<string, { kind: string; party: DaPartyRecord }>();
  for (const row of PURCHASES) {
    if (row.buyer !== null)
      parties.set(`b${row.buyer.portalPartyId}`, { kind: 'buyer', party: row.buyer });
    if (row.supplier !== null)
      parties.set(`s${row.supplier.portalPartyId}`, { kind: 'supplier', party: row.supplier });
  }
  for (const { kind, party } of parties.values())
    await sql`insert into procurement_v3.da_parties values (${SOURCE}, ${kind}, ${party.portalPartyId},
      ${party.fiscalCode}, ${party.fiscalCodeStatus}, ${party.name})`.execute(trx);
  for (const row of PURCHASES)
    await sql`insert into procurement_v3.da_purchases values (${row.purchaseId}, ${SOURCE}, ${row.nativeId},
      ${row.code}, ${row.outcome}, ${row.finalizationDay}, ${row.reportedValue}, ${row.counted},
      ${row.countedValue}, ${row.symbolicPrice}, ${row.title}, ${row.description}, ${row.categoryCode},
      ${row.categoryAsWritten}, ${row.buyer?.portalPartyId ?? null}, ${row.supplier?.portalPartyId ?? null})`.execute(
      trx
    );
  // The buyer resolves through its public entity; a restricted territory never answers.
  await sql`insert into core.public_entities values (${BUYER.fiscalCode}, '54975')`.execute(trx);
  await sql`insert into core.territories (territorial_siruta_code, county_code, region)
    values ('54975', 'CJ', 'Nord-Vest')`.execute(trx);
  await sql`insert into core.territories (territorial_siruta_code, county_code, region, privacy_class)
    values ('54975', 'XX', ${`${SECRET} restricted`}, 'restricted')`.execute(trx);
};

/** The registry name the API serves for the public company (never its name as written). */
const COMPANY_REGISTRY_NAME = 'EXEMPLU REGISTRU SA';

/** The API's login under the approved SEC-GRANTS-PROC-2211 v3 grants (DA analysis part). */
const API_LOGIN = 'procurement_api_e2e';
/** The approved column grants; this minimal schema holds a subset, so each is cut to its columns. */
const APPROVED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  da_release: [
    'data_as_of',
    'rows',
    'dated',
    'counted',
    'accepted',
    'with_cpv',
    'with_geo',
    'money',
    'money_dated',
    'money_geo',
    'free_text_rule',
    'registry_as_of',
  ],
  da_purchases: [
    'purchase_id',
    'native_id',
    'code',
    'source_name',
    'source_url',
    'outcome',
    'state_label',
    'publication_day',
    'finalization_day',
    'ca_decision_at',
    'supplier_decision_at',
    'reported_value',
    'counted',
    'counted_value',
    'not_counted_reason',
    'value_corrected',
    'value_review_rule',
    'symbolic_price',
    'title_shown',
    'title_public',
    'description_public',
    'category_code',
    'category_as_written',
    'acquisition_type_label',
    'listed_now',
    'buyer_party_id',
    'supplier_party_id',
  ],
};
const APPROVED_TABLES = [
  'da_buyer_geography',
  'da_rollup_county_month',
  'da_rollup_cpv_month',
  'da_rollup_authority_month',
  'da_rollup_county_cpv_month',
  'da_rollup_supplier_month',
  'da_rollup_supplier_cpv_month',
  'da_rollup_authority_supplier_month',
  'da_rollup_distinct',
  'supplier_disclosure',
  'da_parties_public',
  'party_public_names',
];

const columnsOf = async (trx: Kysely<ProdDatabase>): Promise<Map<string, Set<string>>> => {
  const rows = await sql<{ table_name: string; column_name: string }>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'procurement_v3'`.execute(trx);
  const out = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    const set = out.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    out.set(row.table_name, set);
  }
  return out;
};

const approvedAnalysisGrants = (columns: Map<string, Set<string>>): string => {
  const columnGrants = Object.entries(APPROVED_COLUMNS).map(([table, approved]) => {
    const present = approved.filter((column) => columns.get(table)?.has(column) === true);
    return present.length === 0
      ? ''
      : `grant select (${present.join(', ')}) on procurement_v3.${table} to procurement_api_read;`;
  });
  // Idempotent, and cut to the relations that exist, so any test in this file can call it.
  const tables = APPROVED_TABLES.filter((table) => columns.has(table));
  return `
    do $$ begin
      if not exists (select from pg_roles where rolname = 'procurement_api_read') then
        create role procurement_api_read nologin;
      end if;
      if not exists (select from pg_roles where rolname = '${API_LOGIN}') then
        create role ${API_LOGIN} login password '${API_LOGIN}' in role procurement_api_read;
      end if;
    end $$;
    grant usage on schema procurement_v3 to procurement_api_read;
    ${columnGrants.join('\n')}
    ${tables.length === 0 ? '' : `grant select on ${tables.map((t) => `procurement_v3.${t}`).join(', ')} to procurement_api_read;`}`;
};

/**
 * The migration lands the D6 classification and the platform's public views in
 * a new publication (data_as_of moves). The supplier id is the opaque key the
 * rollups carry instead of a code (stable, never reused).
 */
const publishPrivacy = async (trx: Kysely<ProdDatabase>): Promise<void> => {
  await sql`create table procurement_v3.supplier_privacy (
    fiscal_code_clean text primary key, supplier_kind text, public boolean not null,
    supplier_id bigint generated always as identity)`.execute(trx);
  for (const [party, isPublic, kind] of [
    [COMPANY, true, 'company'],
    [SOLE_TRADER, false, 'sole_trader'],
    [NATURAL_PERSON, false, 'natural_person'],
    [BAD_CODE_SUPPLIER, false, 'unverified'],
  ] as const)
    await sql`insert into procurement_v3.supplier_privacy (fiscal_code_clean, public, supplier_kind)
      values (${party.fiscalCode}, ${isPublic}, ${kind})`.execute(trx);
  await sql`create view procurement_v3.supplier_disclosure with (security_barrier = true) as
    select fiscal_code_clean, supplier_id from procurement_v3.supplier_privacy
    where public and supplier_kind = 'company'`.execute(trx);
  await sql`create or replace view procurement_v3.da_parties_public with (security_barrier = true) as
    select source_name, party_kind, portal_party_id, fiscal_code_clean, fiscal_code_status,
           case when party_kind = 'buyer' then name_as_written end as name_as_written
    from procurement_v3.da_parties
    where party_kind = 'buyer'
       or fiscal_code_clean in (select fiscal_code_clean from procurement_v3.supplier_disclosure)`.execute(
    trx
  );
  await sql`create table procurement_v3.party_public_names (
    fiscal_code_clean text primary key, registry_name text,
    buyer_name_public boolean, supplier_name_public boolean)`.execute(trx);
  await sql`insert into procurement_v3.party_public_names values
    (${COMPANY.fiscalCode}, ${COMPANY_REGISTRY_NAME}, true, true),
    (${SOLE_TRADER.fiscalCode}, ${`${SECRET} REGISTRY PFA`}, false, false)`.execute(trx);
  await sql`update procurement_v3.da_release set data_as_of = ${AS_OF_2}`.execute(trx);
};

let deps: AnalysisDeps;

beforeAll(async () => {
  if (!dockerCliUp()) return;
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('da_v3').start();
  } catch (error) {
    console.warn(
      `Testcontainers runtime unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  dockerAvailable = true;
  db = new Kysely<ProdDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 }),
    }),
  });
  await load(db);
  deps = {
    analysisRepo: makeDaRoutingAnalysisRepo(
      makeUnconfiguredAnalysisRepo(),
      makeDaV3AnalysisSource(db)
    ),
  };
});

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

const DA = { grain: 'direct_acquisition' } as const;
type DaV3Names = DaV3AnalysisSource['namesOf'];
const WITHHELD_CODES = [SOLE_TRADER, NATURAL_PERSON, UNVERIFIED, BAD_CODE_SUPPLIER].map(
  (party) => party.fiscalCode ?? ''
);

const noLeak = (value: unknown): void => {
  const raw = JSON.stringify(value);
  expect(raw).not.toContain(SECRET);
  for (const code of WITHHELD_CODES) expect(raw).not.toContain(`"${code}"`);
};

describe('before supplier_disclosure exists (fails closed)', () => {
  it('serves the counted value, measures its own verdict and withholds every supplier', async () => {
    const stats = (await analysisStats(deps, { scope: DA }))._unsafeUnwrap().blocks[0];
    expect(stats).toMatchObject({
      recordCount: String(PURCHASES.length),
      withValueCount: '9',
      valueAwardedSum: '188822600.01',
      minMonth: '2021-11',
      maxMonth: '2026-11',
    });
    expect(stats?.meta.buildId).toBe(micros(AS_OF));
    expect(stats?.meta.caveats).toContain(DA_V3_VALUE_NOTE);
    expect(stats?.meta.valueBasis).toBe('counted');
    // No supplier_disclosure yet: everyone is withheld, and the D6 key says so.
    expect(stats?.meta.disclosureKey).toBe('unavailable');

    const bySupplier = (
      await analysisBreakdown(deps, { scope: DA, dimension: 'supplier', topN: 10 })
    )._unsafeUnwrap()[0];
    const top = bySupplier?.buckets.filter((bucket) => bucket.kind === 'top') ?? [];
    expect(top.map((bucket) => bucket.key)).toEqual(['natural_person']);
    expect(top[0]?.recordCount).toBe(String(PURCHASES.length - 1));
    noLeak(bySupplier);
    expect(JSON.stringify(bySupplier)).not.toContain(`"${COMPANY.fiscalCode ?? ''}"`);
  });
});

describe('with supplier_disclosure and the public party views', () => {
  it('buckets suppliers by the public set, reconciles to the totals and leaks nothing', async () => {
    if (db === undefined) throw new Error('no database');
    await publishPrivacy(db);
    const breakdown = (
      await analysisBreakdown(deps, { scope: DA, dimension: 'supplier', topN: 10 })
    )._unsafeUnwrap()[0];
    expect(breakdown?.meta.buildId).toBe(micros(AS_OF_2));
    expect(
      breakdown?.buckets.map((bucket) => [
        bucket.kind,
        bucket.key,
        bucket.recordCount,
        bucket.valueSum,
      ])
    ).toEqual([
      ['top', COMPANY.fiscalCode, '7', '188820850.00'],
      ['top', 'natural_person', '5', '1650.01'],
      ['other', null, '0', null],
      ['unknown', null, '1', '100.00'],
    ]);
    noLeak(breakdown);
  });

  it('places buyers through public entities and public territories only', async () => {
    const byCounty = (
      await analysisBreakdown(deps, { scope: DA, dimension: 'buyerCounty', topN: 10 })
    )._unsafeUnwrap()[0];
    expect(
      byCounty?.buckets.map((bucket) => [bucket.kind, bucket.key, bucket.recordCount])
    ).toEqual([
      ['top', 'CJ', String(PURCHASES.length - 1)],
      ['other', null, '0'],
      ['unknown', null, '1'],
    ]);
    noLeak(byCounty);
    const cj = (await analysisStats(deps, { scope: { ...DA, buyerCounty: 'CJ' } }))._unsafeUnwrap()
      .blocks[0];
    expect(cj?.recordCount).toBe(String(PURCHASES.length - 1));
  });

  it('counts the withheld suppliers as one in distincts and concentration', async () => {
    const distinct = (
      await analysisSeries(deps, { scope: DA, measure: 'distinctSuppliers', bucket: 'year' })
    )._unsafeUnwrap()[0];
    expect(distinct?.points.map((point) => [point.bucket, point.value])).toEqual([
      ['2021', '1'],
      ['2025', '2'],
      ['2026', '1'],
    ]);
    const concentration = (
      await analysisConcentration(deps, { scope: DA, basis: 'value' })
    )._unsafeUnwrap()[0];
    expect(concentration?.supplierCount).toBe(2);
    noLeak(concentration);
  });

  it('lists records by counted value with the D6 shape and the CPV label in the title’s place', async () => {
    const records = (
      await analysisRecords(deps, {
        scope: { ...DA, year: 2025 },
        sort: 'value_desc',
        pageSize: 100,
      })
    )._unsafeUnwrap();
    expect(records.items[0]).toMatchObject({
      id: PURCHASES[4]?.purchaseId,
      valueRon: '188800000.00',
      title: null,
      supplierName: COMPANY_REGISTRY_NAME,
      supplierDisplayKind: 'company',
      cpvLabel: 'Materiale de constructii',
    });
    const withheld = records.items.find((row) => row.id === PURCHASES[9]?.purchaseId);
    expect(withheld).toMatchObject({
      supplierCui: null,
      supplierName: null,
      supplierDisplayKind: 'natural_person',
    });
    expect(
      records.items.find((row) => row.id === PURCHASES[12]?.purchaseId)?.supplierDisplayKind
    ).toBeNull();
    noLeak(records);
    expect(JSON.stringify(records)).not.toContain(COMPANY.name ?? '~');
  });

  it('matches a supplier scope only for a public supplier', async () => {
    const pfa = (
      await analysisStats(deps, { scope: { ...DA, supplierCui: SOLE_TRADER.fiscalCode ?? '' } })
    )._unsafeUnwrap();
    expect(pfa.blocks[0]?.recordCount).toBe('0');
    const company = (
      await analysisStats(deps, { scope: { ...DA, supplierCui: COMPANY.fiscalCode ?? '' } })
    )._unsafeUnwrap();
    expect(company.blocks[0]?.recordCount).toBe('7');
    // A legacy or client code keeping leading zeros matches the platform's code.
    const zeros = (
      await analysisStats(deps, { scope: { ...DA, supplierCui: `00${COMPANY.fiscalCode ?? ''}` } })
    )._unsafeUnwrap();
    expect(zeros.blocks[0]?.recordCount).toBe('7');
  });

  it('refuses a read against a moved publication', async () => {
    if (db === undefined) throw new Error('no database');
    const source = makeDaV3AnalysisSource(db);
    const gen = (await source.generation())._unsafeUnwrap();
    if (gen === null) throw new Error('no generation');
    await sql`update procurement_v3.da_release set data_as_of = now()`.execute(db);
    const moved = await source.statsFor(DA, { ...DA, authorityCui: BUYER.fiscalCode ?? '' }, gen);
    expect(moved._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
  });
});

/**
 * The publish-time rollups answer exactly as the live rows do. A reference
 * build (the data platform's rules, agreed 18 Nov) runs over a varied seed; a
 * battery of reads runs live first, then over the rollups through a fresh
 * source, and every answer must be identical.
 *
 * Sequential, like the whole file: these tests build on the publication, the
 * public views (earlier describes), the seed, the rollups and the approved-grant
 * login the parity test creates. Run the file, not a single test.
 */
describe('rollups answer exactly as the live rows', () => {
  const ROLLUP_BASE = `
    create table procurement_v3.f_rollup_base as
    select case when b.fiscal_code_status = 'valid' then b.fiscal_code_clean end as authority_cui,
           case when p.supplier_party_id is null then null
                when sv.supplier_id is not null and s.fiscal_code_status = 'valid' and s.fiscal_code_clean is not null
                  then sv.supplier_id
                else 0 end as supplier_ref,
           case when p.category_code ~ '^[0-9]{2}' then left(p.category_code, 8) end as cpv8,
           t.county_code, t.region,
           date_trunc('month', p.finalization_day)::date as month,
           p.counted, p.counted_value, p.symbolic_price
    from procurement_v3.da_purchases p
    left join procurement_v3.da_parties b
      on b.source_name = p.source_name and b.party_kind = 'buyer' and b.portal_party_id = p.buyer_party_id
    left join procurement_v3.da_parties s
      on s.source_name = p.source_name and s.party_kind = 'supplier' and s.portal_party_id = p.supplier_party_id
    left join procurement_v3.supplier_disclosure sv on sv.fiscal_code_clean = s.fiscal_code_clean
    left join core.public_entities pe
      on pe.cui = b.fiscal_code_clean and b.fiscal_code_status = 'valid'
    left join companies_v2.registrations areg
      on areg.cui = b.fiscal_code_clean and b.fiscal_code_status = 'valid'
     and pe.territorial_siruta_code is null
    left join core.territories t
      on t.territorial_siruta_code = coalesce(pe.territorial_siruta_code, areg.selected_uat_siruta_code)
     and t.privacy_class = 'public'`;
  const MEASURES = `count(*) as purchases, count(*) filter (where counted) as counted_purchases,
    coalesce(sum(counted_value) filter (where counted), 0)::numeric(20,2) as counted_value,
    count(*) filter (where symbolic_price) as symbolic_purchases`;
  const TABLES: readonly (readonly [string, string])[] = [
    ['da_rollup_authority_month', 'authority_cui'],
    ['da_rollup_supplier_month', 'supplier_ref'],
    ['da_rollup_cpv_month', 'cpv8'],
    ['da_rollup_county_month', 'county_code, region'],
    ['da_rollup_authority_supplier_month', 'authority_cui, supplier_ref, county_code, region'],
    ['da_rollup_supplier_cpv_month', 'supplier_ref, cpv8'],
    ['da_rollup_county_cpv_month', 'county_code, region, cpv8'],
  ];

  const seed = async (trx: Kysely<ProdDatabase>): Promise<void> => {
    for (const [id, code, status] of [
      ['rb1', '1000001', 'valid'],
      ['rb2', '1000002', 'valid'],
      ['rb3', '1000003', 'valid'],
      ['rb4', '1000004', 'invalid'],
      ['rb5', '1000005', 'valid'],
    ] as const)
      await sql`insert into procurement_v3.da_parties values (${SOURCE}, 'buyer', ${id}, ${code}, ${status}, 'B')`.execute(
        trx
      );
    await sql`insert into procurement_v3.da_parties values (${SOURCE}, 'supplier', 'rc2', '2000002', 'valid', 'C2')`.execute(
      trx
    );
    await sql`insert into procurement_v3.supplier_privacy (fiscal_code_clean, public, supplier_kind)
      values ('2000002', true, 'company')`.execute(trx);
    await sql`insert into core.public_entities values ('1000001', '777')`.execute(trx);
    await sql`insert into companies_v2.registrations values ('1000002', '777')`.execute(trx);
    await sql`insert into core.territories (territorial_siruta_code, county_code, region)
      values ('777', 'AB', 'Centru')`.execute(trx);
    // A public territory with no county: geography resolves, the county bucket is unknown.
    await sql`insert into core.public_entities values ('1000005', '888')`.execute(trx);
    await sql`insert into core.territories (territorial_siruta_code, county_code, region)
      values ('888', null, null)`.execute(trx);
    await sql`
      insert into procurement_v3.da_purchases
        (purchase_id, source_name, outcome, finalization_day, counted, counted_value, symbolic_price,
         category_code, buyer_party_id, supplier_party_id)
      select 'x' || g, ${SOURCE}, case when g % 7 = 0 then 'refused' else 'accepted' end,
             case when g % 13 = 0 then null else date '2023-01-01' + ((g * 11) % 1095) end,
             g % 5 <> 0, case when g % 5 <> 0 then ((g * 37) % 1000)::numeric + 0.25 end, g % 17 = 0,
             (array['44110000-4', '44111000-1', '45200000-9', '03100000-2', '4', 'X1234', null])[1 + g % 7],
             (array['rb1', 'rb2', 'rb3', 'rb4', 'rb5', ${BUYER.portalPartyId}])[1 + g % 6],
             (array[${COMPANY.portalPartyId}, 'rc2', ${SOLE_TRADER.portalPartyId}, null])[1 + g % 4]
      from generate_series(1, 400) g`.execute(trx);
  };

  const buildRollups = async (trx: Kysely<ProdDatabase>): Promise<void> => {
    await sql.raw(ROLLUP_BASE).execute(trx);
    // The buyer's place, pinned to the publication (GEO_JOIN, one row per valid buyer code).
    await sql
      .raw(
        `create table procurement_v3.da_buyer_geography as
         select distinct on (b.fiscal_code_clean) b.fiscal_code_clean as authority_cui,
                t.territorial_siruta_code, t.county_code, t.region, now() as copied_at
         from procurement_v3.da_parties b
         left join core.public_entities pe on pe.cui = b.fiscal_code_clean
         left join companies_v2.registrations areg
           on areg.cui = b.fiscal_code_clean and pe.territorial_siruta_code is null
         left join core.territories t
           on t.territorial_siruta_code = coalesce(pe.territorial_siruta_code, areg.selected_uat_siruta_code)
          and t.privacy_class = 'public'
         where b.party_kind = 'buyer' and b.fiscal_code_status = 'valid'
         order by b.fiscal_code_clean`
      )
      .execute(trx);
    for (const [table, keys] of TABLES)
      await sql
        .raw(
          `create table procurement_v3.${table} as select ${keys}, month, ${MEASURES}
           from procurement_v3.f_rollup_base group by ${keys}, month`
        )
        .execute(trx);
    await sql
      .raw(
        `create table procurement_v3.da_rollup_distinct as
         select kind as bucket_kind, bucket,
                count(distinct authority_cui) as distinct_authorities,
                count(distinct supplier_ref) filter (where supplier_ref > 0) as distinct_public_suppliers,
                coalesce(bool_or(supplier_ref = 0), false) as has_withheld
         from (select 'month' as kind, month as bucket, authority_cui, supplier_ref
                 from procurement_v3.f_rollup_base where month is not null
               union all
               select 'year', date_trunc('year', month)::date, authority_cui, supplier_ref
                 from procurement_v3.f_rollup_base where month is not null) x
         group by 1, 2`
      )
      .execute(trx);
  };

  const COUNTED_SCOPES: readonly Record<string, unknown>[] = [
    {},
    { year: 2025 },
    { from: '2023-01' },
    { from: '2024-03', to: '2025-06' },
    { authorityCui: '1000001', year: 2024 },
    { supplierCui: COMPANY.fiscalCode, from: '2023-01' },
    { supplierCui: '2000002', year: 2025 },
    { supplierCui: SOLE_TRADER.fiscalCode },
    { buyerCounty: 'AB' },
    { buyerRegion: 'Centru', cpvDivision: '44' },
    { cpvGroup: '441' },
    { authorityCui: '1000002', supplierCui: '2000002' },
    { supplierCui: '2000002', cpvClass: '4411' },
  ];

  /**
   * The battery's requests in order, each flagged when the analysis contract refuses it by design:
   * a distinct count, breakdown or concentration over a key the scope already fixes (a CPV scope
   * fixes its level and every coarser one).
   */
  const batteryRefusals = (): boolean[] => {
    const out: boolean[] = [];
    for (const extra of COUNTED_SCOPES) {
      const authority = 'authorityCui' in extra;
      const supplier = 'supplierCui' in extra;
      // A CPV scope fixes its level and every coarser one.
      const cpvLevels = ['cpvDivision', 'cpvGroup', 'cpvClass', 'cpvCategory'];
      const cpvScope = Math.max(...cpvLevels.map((level, i) => (level in extra ? i : -1)));
      const fixes = (dimension: string): boolean => {
        if (dimension === 'authority') return authority;
        if (dimension === 'supplier') return supplier;
        const level = cpvLevels.indexOf(dimension);
        if (level >= 0) return level <= cpvScope;
        return dimension in extra;
      };
      out.push(false, false, false);
      for (const measure of ['distinctAuthorities', 'distinctSuppliers'] as const)
        for (let bucket = 0; bucket < 3; bucket += 1)
          out.push(measure === 'distinctAuthorities' ? authority : supplier);
      for (const dimension of [
        'authority',
        'supplier',
        'cpvDivision',
        'cpvGroup',
        'cpvClass',
        'cpvCategory',
        'buyerCounty',
        'buyerRegion',
      ])
        for (let rank = 0; rank < 2; rank += 1) out.push(fixes(dimension));
      out.push(supplier, supplier, false);
    }
    return out;
  };

  const battery = async (d: AnalysisDeps): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (const extra of COUNTED_SCOPES) {
      const scope = { ...DA, ...extra };
      out.push(await analysisStats(d, { scope }));
      out.push(await analysisSeries(d, { scope, measure: 'valueAwardedSum', bucket: 'month' }));
      out.push(await analysisSeries(d, { scope, measure: 'recordCount', bucket: 'year' }));
      for (const measure of ['distinctAuthorities', 'distinctSuppliers'] as const)
        for (const bucket of ['month', 'quarter', 'year'] as const)
          out.push(await analysisSeries(d, { scope, measure, bucket }));
      for (const dimension of [
        'authority',
        'supplier',
        'cpvDivision',
        'cpvGroup',
        'cpvClass',
        'cpvCategory',
        'buyerCounty',
        'buyerRegion',
      ] as const)
        for (const rankBy of ['value', 'count'] as const)
          out.push(
            await analysisBreakdown(d, {
              scope,
              dimension,
              // Fewer than the fixture's supplier keys, so the supplier remainder is not empty.
              topN: dimension === 'supplier' ? 2 : 3,
              rankBy,
            })
          );
      for (const basis of ['value', 'count'] as const)
        out.push(await analysisConcentration(d, { scope, basis }));
      out.push(await analysisRecords(d, { scope, sort: 'value_desc', pageSize: 5 }));
    }
    return out;
  };

  it('every stats, series, distinct, breakdown, concentration and records answer is identical', async () => {
    if (db === undefined || container === undefined) throw new Error('no database');
    await sql`update procurement_v3.da_release set data_as_of = ${AS_OF_2}`.execute(db);
    await seed(db);
    const live = await battery({
      analysisRepo: makeDaRoutingAnalysisRepo(
        makeUnconfiguredAnalysisRepo(),
        makeDaV3AnalysisSource(db)
      ),
    });
    await buildRollups(db);
    // The rollup answers are read as the API's login under the approved grants (SEC-GRANTS-PROC-2211):
    // any read of an ungranted relation or column fails the parity below.
    await sql.raw(approvedAnalysisGrants(await columnsOf(db))).execute(db);
    const statements: string[] = [];
    const failedStatements: string[] = [];
    const logged = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          host: container.getHost(),
          port: container.getPort(),
          database: container.getDatabase(),
          user: API_LOGIN,
          password: API_LOGIN,
          max: 2,
        }),
      }),
      log: (event) => {
        if (event.level === 'query') statements.push(event.query.sql);
        else failedStatements.push(event.query.sql);
      },
    });
    try {
      const rolled = await battery({
        analysisRepo: makeDaRoutingAnalysisRepo(
          makeUnconfiguredAnalysisRepo(),
          makeDaV3AnalysisSource(logged)
        ),
      });
      expect(rolled.length).toBe(live.length);
      // Parity of answers, not of failures: every live answer is a real one.
      const failures = (answers: unknown[]) =>
        answers.flatMap((answer, index) => {
          const result = answer as {
            isOk: () => boolean;
            _unsafeUnwrapErr: () => { type: string; message: string };
          };
          return result.isOk()
            ? []
            : [[index, result._unsafeUnwrapErr().type, result._unsafeUnwrapErr().message]];
        });
      // Some scope × shape pairs are refused by design: a distinct count or a breakdown over a key
      // the scope already fixes. Exactly those, and nothing else, may fail.
      const refused = failures(live);
      expect(
        refused.filter(
          ([, type, message]) =>
            type !== 'InvalidInput' ||
            !/requires the measured key \w+ to remain free|is already fixed by the \w+ scope|concentration requires \w+ to remain free/u.test(
              String(message)
            )
        )
      ).toEqual([]);
      // Exactly the requests the contract refuses, by position, and no other.
      const expectedRefused = batteryRefusals().flatMap((isRefused, index) =>
        isRefused ? [index] : []
      );
      expect(batteryRefusals()).toHaveLength(live.length);
      expect(refused.map(([index]) => index)).toEqual(expectedRefused);
      expect(expectedRefused).toHaveLength(61);
      for (let index = 0; index < live.length; index += 1)
        expect({ index, answer: rolled[index] }).toEqual({ index, answer: live[index] });
      // Every rollup and the pinned geography were read, not just present (a rollup the login
      // could not read would fall back to live rows and still match).
      for (const table of [
        ...TABLES.map(([name]) => name),
        'da_rollup_distinct',
        'da_buyer_geography',
      ])
        expect(
          statements.some((text) => text.includes(`"procurement_v3"."${table}"`)),
          table
        ).toBe(true);
      // The kernel's geography moves after the publish: every answer keeps the published
      // place (rollups and live rows both read the pinned table), so nothing changes.
      await sql`update core.territories set county_code = 'QQ' where territorial_siruta_code = '777'`.execute(
        db
      );
      const moved = await battery({
        analysisRepo: makeDaRoutingAnalysisRepo(
          makeUnconfiguredAnalysisRepo(),
          makeDaV3AnalysisSource(logged)
        ),
      });
      for (let index = 0; index < live.length; index += 1)
        expect({ index, answer: moved[index] }).toEqual({ index, answer: live[index] });
      await sql`update core.territories set county_code = 'AB' where territorial_siruta_code = '777'`.execute(
        db
      );
      // A code that flipped to restricted keeps its old rows, zeroed (never deleted): they
      // must never contribute a key, a count or a name, in buckets, distincts or key lists.
      const owner = db;
      const idOf = async (code: string): Promise<string> =>
        (
          await sql<{
            id: string;
          }>`select supplier_id::text as id from procurement_v3.supplier_privacy
            where fiscal_code_clean = ${code}`.execute(owner)
        ).rows[0]?.id ?? '-1';
      const flipped = await idOf(SOLE_TRADER.fiscalCode ?? '');
      const publicRef = await idOf('2000002');
      // Real supplier ids: an unmapped ref would fold into natural_person and prove nothing.
      expect(flipped).toMatch(/^[1-9][0-9]*$/u);
      expect(publicRef).toMatch(/^[1-9][0-9]*$/u);
      expect(flipped).not.toBe(publicRef);
      for (const table of [
        'da_rollup_supplier_month',
        'da_rollup_supplier_cpv_month',
        'da_rollup_authority_supplier_month',
      ])
        await sql`insert into ${sql.table(`procurement_v3.${table}`)}
          (supplier_ref, month, purchases, counted_purchases, counted_value, symbolic_purchases)
          values (${flipped}::bigint, '2025-01-01', 0, 0, 0, 0)`.execute(db);
      // Zeroed rows in a month and under keys nothing else carries must not add a bucket,
      // a month (series points, min/max month) or a key either.
      for (const [table, keys, values] of [
        ['da_rollup_county_month', 'county_code, region', `'ZZ', 'Gone'`],
        ['da_rollup_cpv_month', 'cpv8', `'99999999'`],
        ['da_rollup_authority_month', 'authority_cui', `'9999999'`],
        ['da_rollup_county_cpv_month', 'county_code, region, cpv8', `'ZZ', 'Gone', '99999999'`],
        ['da_rollup_supplier_month', 'supplier_ref', publicRef],
        ['da_rollup_supplier_cpv_month', 'supplier_ref, cpv8', `${publicRef}, '99999999'`],
        [
          'da_rollup_authority_supplier_month',
          'authority_cui, supplier_ref, county_code, region',
          `'9999999', ${publicRef}, 'ZZ', 'Gone'`,
        ],
      ] as const)
        await sql
          .raw(
            `insert into procurement_v3.${table} (${keys}, month, purchases, counted_purchases, counted_value, symbolic_purchases)
             values (${values}, '2030-01-01', 0, 0, 0, 0)`
          )
          .execute(db);
      const zeroed = await battery({
        analysisRepo: makeDaRoutingAnalysisRepo(
          makeUnconfiguredAnalysisRepo(),
          makeDaV3AnalysisSource(logged)
        ),
      });
      for (let index = 0; index < live.length; index += 1)
        expect({ index, answer: zeroed[index] }).toEqual({ index, answer: live[index] });
      // Even a non-zero row under a restricted code (the build STOPs on it) is withheld on read:
      // its 3 purchases and 30 lei land in the one natural_person bucket, under no key of its own.
      const withheldBucket = async () => {
        const answer = await analysisBreakdown(
          {
            analysisRepo: makeDaRoutingAnalysisRepo(
              makeUnconfiguredAnalysisRepo(),
              makeDaV3AnalysisSource(logged)
            ),
          },
          { scope: { ...DA, year: 2025 }, dimension: 'supplier', topN: 10 }
        );
        noLeak(answer);
        const buckets = answer._unsafeUnwrap()[0]?.buckets ?? [];
        const bucket = buckets.find((b) => b.key === 'natural_person');
        return {
          keys: buckets.map((b) => b.key),
          records: BigInt(bucket?.recordCount ?? '-1'),
          value: new Decimal(bucket?.valueSum ?? '0'),
        };
      };
      const before = await withheldBucket();
      await sql`insert into procurement_v3.da_rollup_supplier_month
        (supplier_ref, month, purchases, counted_purchases, counted_value, symbolic_purchases)
        values (${flipped}::bigint, '2025-02-01', 3, 3, 30, 0)`.execute(db);
      const guarded = await withheldBucket();
      expect(before.records).toBeGreaterThan(0n);
      expect(guarded.keys).toEqual(before.keys);
      expect(guarded.records - before.records).toBe(3n);
      expect(guarded.value.minus(before.value).toFixed(2)).toBe('30.00');
      // Without the supplier_disclosure grant the rollups still answer (PROC-C4HN: summed per
      // supplier, nothing joined) and withhold every supplier: the same requests, and only
      // they, are refused, and no answer keys, echoes or names a supplier. Wired as production
      // wires it (D6 enforced), so a supplier scope echoes `withheld`.
      await sql`revoke select on procurement_v3.supplier_disclosure from procurement_api_read`.execute(
        db
      );
      try {
        statements.length = 0;
        failedStatements.length = 0;
        const closed = await battery({
          analysisRepo: makeDaRoutingAnalysisRepo(
            makeUnconfiguredAnalysisRepo(),
            makeDaV3AnalysisSource(logged)
          ),
          supplierDisclosure: makeSupplierDisclosureRepo(logged, true),
        });
        // The same refusals, by position, type and message; no statement failed (a caught error
        // must not stand in for a refusal or an answer).
        expect(failures(closed)).toEqual(refused);
        expect(failedStatements).toEqual([]);
        // The view is only probed for its privilege, never read.
        expect(
          statements.filter(
            (text) =>
              text.includes('supplier_disclosure') &&
              !text.includes('has_table_privilege') &&
              !text.includes('pg_attribute')
          )
        ).toEqual([]);
        // The supplier rollups answered (no fallback to the live rows), and nothing read the view
        // but the privilege probes.
        for (const table of [
          'da_rollup_supplier_month',
          'da_rollup_supplier_cpv_month',
          'da_rollup_authority_supplier_month',
        ])
          expect(
            statements.some((text) => text.includes(`"procurement_v3"."${table}"`)),
            table
          ).toBe(true);
        const supplierCodes = [COMPANY.fiscalCode ?? '', '2000002', ...WITHHELD_CODES].filter(
          (code) => code !== ''
        );
        expect(supplierCodes.length).toBeGreaterThanOrEqual(5);
        for (const answer of closed) {
          noLeak(answer);
          const raw = JSON.stringify(answer);
          // Anywhere, embedded or not (a canonicalScope echo included).
          for (const code of supplierCodes)
            expect(raw).not.toMatch(new RegExp(`(?<![0-9])${code}(?![0-9])`, 'u'));
          expect(raw).not.toContain(COMPANY_REGISTRY_NAME);
        }
      } finally {
        await sql`grant select on procurement_v3.supplier_disclosure to procurement_api_read`.execute(
          db
        );
      }
    } finally {
      await logged.destroy();
    }
  });

  it('pages records by value and by date in exactly the single-ORDER-BY order, across the keyed/unkeyed boundary', async () => {
    if (db === undefined) throw new Error('no database');
    const source = makeDaV3AnalysisSource(db);
    const gen = (await source.generation())._unsafeUnwrap();
    if (gen === null) throw new Error('no generation');
    const undated = await sql<{ n: string }>`select count(*)::text as n
      from procurement_v3.da_purchases where finalization_day is null`.execute(db);
    expect(Number(undated.rows[0]?.n)).toBeGreaterThan(0);
    for (const [sort, direction, key] of [
      ['value_desc', 'desc', 'case when counted then counted_value end'],
      ['value_asc', 'asc', 'case when counted then counted_value end'],
      ['date_desc', 'desc', 'finalization_day'],
      ['date_asc', 'asc', 'finalization_day'],
    ] as const) {
      const expected = (
        await sql<{ id: string }>`select purchase_id as id from procurement_v3.da_purchases
          order by ${sql.raw(key)} ${sql.raw(direction)} nulls last,
                   purchase_id ${sql.raw(direction)}`.execute(db)
      ).rows.map((row) => row.id);
      const pages: string[][] = [];
      for (let offset = 0; offset < expected.length + 7; offset += 7) {
        const page = await source.recordsFor(DA, DA, gen, { sort, offset, limit: 7 });
        pages.push(page._unsafeUnwrap().rows.map((row) => row.id));
      }
      // Page by page: each page is exactly its slice of the one ORDER BY.
      expect({ sort, pages }).toEqual({
        sort,
        pages: pages.map((_, i) => expected.slice(i * 7, (i + 1) * 7)),
      });
    }

    // A geography scope pages over the buyer's pinned place, read as the API's login (the
    // approved grants; the role exists from the parity test above, this file is sequential).
    if (container === undefined) throw new Error('no container');
    const api = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          host: container.getHost(),
          port: container.getPort(),
          database: container.getDatabase(),
          user: API_LOGIN,
          password: API_LOGIN,
          max: 1,
        }),
      }),
    });
    try {
      const geoSource = makeDaV3AnalysisSource(api);
      const geoGen = (await geoSource.generation())._unsafeUnwrap();
      if (geoGen === null) throw new Error('no generation');
      const scope = { ...DA, buyerCounty: 'AB' };
      for (const [sort, direction] of [
        ['date_desc', 'desc'],
        ['date_asc', 'asc'],
      ] as const) {
        const expected = (
          await sql<{ id: string }>`select p.purchase_id as id from procurement_v3.da_purchases p
            join procurement_v3.da_parties b
              on b.source_name = p.source_name and b.party_kind = 'buyer'
             and b.portal_party_id = p.buyer_party_id and b.fiscal_code_status = 'valid'
            join procurement_v3.da_buyer_geography t on t.authority_cui = b.fiscal_code_clean
            where t.county_code = 'AB'
            order by p.finalization_day ${sql.raw(direction)} nulls last,
                     p.purchase_id ${sql.raw(direction)}`.execute(db)
        ).rows.map((row) => row.id);
        expect(expected.length).toBeGreaterThan(14);
        const pages: string[][] = [];
        for (let offset = 0; offset < expected.length + 7; offset += 7) {
          const page = await geoSource.recordsFor(DA, scope, geoGen, { sort, offset, limit: 7 });
          pages.push(page._unsafeUnwrap().rows.map((row) => row.id));
        }
        expect({ sort, pages }).toEqual({
          sort,
          pages: pages.map((_, i) => expected.slice(i * 7, (i + 1) * 7)),
        });
      }
    } finally {
      await api.destroy();
    }
  });

  it('skips a supplier rollup still on the earlier shape and answers the same', async () => {
    if (db === undefined || container === undefined) throw new Error('no database');
    const scope = { ...DA, supplierCui: COMPANY.fiscalCode ?? '', from: '2023-01' };
    const ask = async (source: ReturnType<typeof makeDaV3AnalysisSource>) => {
      const d = {
        analysisRepo: makeDaRoutingAnalysisRepo(makeUnconfiguredAnalysisRepo(), source),
      };
      return [
        await analysisStats(d, { scope }),
        await analysisSeries(d, { scope, measure: 'valueAwardedSum', bucket: 'month' }),
        await analysisBreakdown(d, { scope, dimension: 'cpvDivision', topN: 3, rankBy: 'value' }),
      ];
    };
    const current = await ask(makeDaV3AnalysisSource(db));
    const statements: string[] = [];
    const logged = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 }),
      }),
      log: (event) => {
        if (event.level === 'query') statements.push(event.query.sql);
      },
    });
    await sql`alter table procurement_v3.da_rollup_supplier_month
      rename column supplier_ref to supplier_key`.execute(db);
    try {
      const earlier = await ask(makeDaV3AnalysisSource(logged));
      expect(earlier.every((answer) => answer.isOk())).toBe(true);
      expect(earlier).toEqual(current);
      expect(statements.some((text) => text.includes('da_rollup_supplier_month'))).toBe(false);
    } finally {
      await sql`alter table procurement_v3.da_rollup_supplier_month
        rename column supplier_key to supplier_ref`.execute(db);
      await logged.destroy();
    }
  });

  it('reads the quality verdict from da_release when the platform publishes it, equal to live', async () => {
    if (db === undefined) throw new Error('no database');
    const liveGen = (await makeDaV3AnalysisSource(db).generation())._unsafeUnwrap();
    await sql
      .raw(
        `
      alter table procurement_v3.da_release
        add column rows bigint, add column dated bigint, add column counted bigint,
        add column accepted bigint, add column with_cpv bigint, add column with_geo bigint,
        add column money numeric(20,2), add column money_dated numeric(20,2), add column money_geo numeric(20,2);
      update procurement_v3.da_release r set
        rows = q.rows, dated = q.dated, counted = q.counted, accepted = q.accepted,
        with_cpv = q.with_cpv, with_geo = q.with_geo, money = q.money,
        money_dated = q.money_dated, money_geo = q.money_geo
      from (
        select count(*) as rows,
               count(*) filter (where p.finalization_day is not null) as dated,
               count(*) filter (where p.counted) as counted,
               count(*) filter (where p.outcome = 'accepted') as accepted,
               count(*) filter (where p.category_code ~ '^[0-9]{2}') as with_cpv,
               count(*) filter (where f.territorial_siruta_code is not null) as with_geo,
               coalesce(sum(p.counted_value) filter (where p.counted), 0) as money,
               coalesce(sum(p.counted_value) filter (where p.counted and p.finalization_day is not null), 0) as money_dated,
               coalesce(sum(p.counted_value) filter (where p.counted and f.territorial_siruta_code is not null), 0) as money_geo
        from procurement_v3.da_purchases p
        left join procurement_v3.da_parties b
          on b.source_name = p.source_name and b.party_kind = 'buyer' and b.portal_party_id = p.buyer_party_id
        left join core.public_entities pe on pe.cui = b.fiscal_code_clean and b.fiscal_code_status = 'valid'
        left join companies_v2.registrations areg
          on areg.cui = b.fiscal_code_clean and b.fiscal_code_status = 'valid' and pe.territorial_siruta_code is null
        left join core.territories f
          on f.territorial_siruta_code = coalesce(pe.territorial_siruta_code, areg.selected_uat_siruta_code)
         and f.privacy_class = 'public'
      ) q`
      )
      .execute(db);
    if (container === undefined) throw new Error('no container');
    // The published quality columns are read as the API's login under the approved grants
    // (the da_release grant now covers them: the helper grants every approved column present).
    await sql.raw(approvedAnalysisGrants(await columnsOf(db))).execute(db);
    const statements: string[] = [];
    const logged = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          host: container.getHost(),
          port: container.getPort(),
          database: container.getDatabase(),
          user: API_LOGIN,
          password: API_LOGIN,
          max: 1,
        }),
      }),
      log: (event) => {
        if (event.level === 'query') statements.push(event.query.sql);
      },
    });
    try {
      const published = (await makeDaV3AnalysisSource(logged).generation())._unsafeUnwrap();
      expect(published?.quality).toEqual(liveGen?.quality);
      expect(published?.buildId).toBe(liveGen?.buildId);
      // The published columns answered: the whole-table scan never ran.
      expect(statements.some((text) => text.includes('with per_buyer'))).toBe(false);
      // A partial payload is not a measurement: the reader measures live and agrees.
      await sql`update procurement_v3.da_release set dated = null`.execute(db);
      statements.length = 0;
      const partial = (await makeDaV3AnalysisSource(logged).generation())._unsafeUnwrap();
      expect(partial?.quality).toEqual(liveGen?.quality);
      expect(statements.some((text) => text.includes('with per_buyer'))).toBe(true);
    } finally {
      await logged.destroy();
    }
  });
});

/**
 * PROC-B51G: a DA supplier bucket is named only through the D6 name gate
 * (party_public_names.supplier_name_public), read as the API's login under the approved grants, in
 * the publication the buckets came from. Sequential like the file: it reads the seed and rollups
 * the earlier tests built (run the file, not a single test).
 */
describe('DA supplier bucket names (PROC-B51G)', () => {
  it('names a public company only, fails closed, and never names across a revocation', async () => {
    if (db === undefined || container === undefined) throw new Error('no database');
    await sql.raw(approvedAnalysisGrants(await columnsOf(db))).execute(db);
    // A disclosed code whose registry name exists but is not public.
    const HIDDEN_NAME = 'NUME NEPUBLIC SRL';
    await sql`insert into procurement_v3.party_public_names values
      ('2000002', ${HIDDEN_NAME}, true, false)`.execute(db);
    const api = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          host: container.getHost(),
          port: container.getPort(),
          database: container.getDatabase(),
          user: API_LOGIN,
          password: API_LOGIN,
          max: 1,
        }),
      }),
    });
    // One source for every call: its per-publication cache is warm after the first.
    const source = makeDaV3AnalysisSource(api);
    const ask = (namesOf: DaV3Names = source.namesOf) =>
      analysisBreakdown(
        {
          analysisRepo: makeDaRoutingAnalysisRepo(makeUnconfiguredAnalysisRepo(), source),
          daSupplierNames: { namesOf },
        },
        { scope: DA, dimension: 'supplier', topN: 10 }
      );
    const named = (answer: Awaited<ReturnType<typeof ask>>): Record<string, unknown> =>
      Object.fromEntries(
        (answer._unsafeUnwrap()[0]?.buckets ?? [])
          .filter((bucket) => bucket.kind === 'top')
          .map((bucket): [string, unknown] => [
            bucket.key ?? '',
            [bucket.displayKind, bucket.displayName],
          ])
      );
    const expected = {
      [COMPANY.fiscalCode ?? '']: ['company', COMPANY_REGISTRY_NAME],
      // Disclosed, its name in the registry but not public.
      '2000002': ['company', null],
      natural_person: ['natural_person', null],
    };
    try {
      for (let round = 0; round < 2; round += 1) {
        const answer = await ask();
        noLeak(answer);
        expect(JSON.stringify(answer)).not.toContain(HIDDEN_NAME);
        expect(named(answer)).toEqual(expected);
      }
      // supplier_disclosure revoked between the (cached) bucket read and the name read: refused,
      // retryably, never named under the earlier state.
      const owner = db;
      const revoking: DaV3Names = async (buildId, codes) => {
        await sql`revoke select on procurement_v3.supplier_disclosure from procurement_api_read`.execute(
          owner
        );
        return source.namesOf(buildId, codes);
      };
      try {
        const gap = await ask(revoking);
        expect(gap._unsafeUnwrapErr()).toMatchObject({
          type: 'ServiceUnavailable',
          message: expect.stringContaining('repeat the request') as unknown,
        });
        // Revoked before the read: every supplier withheld, nothing named or asked.
        const closed = await ask();
        expect(named(closed)).toEqual({ natural_person: ['natural_person', null] });
        expect(JSON.stringify(closed)).not.toContain(COMPANY_REGISTRY_NAME);
      } finally {
        await sql`grant select on procurement_v3.supplier_disclosure to procurement_api_read`.execute(
          db
        );
      }
      // A name read for an older publication is refused (a publish between read and name).
      expect(
        (await source.namesOf('1', [COMPANY.fiscalCode ?? '']))._unsafeUnwrapErr()
      ).toMatchObject({ type: 'ServiceUnavailable' });
      // Without the name gate a named answer is refused, never served from another name source.
      await sql`revoke select on procurement_v3.party_public_names from procurement_api_read`.execute(
        db
      );
      try {
        expect((await ask())._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
      } finally {
        await sql`grant select on procurement_v3.party_public_names to procurement_api_read`.execute(
          db
        );
      }
    } finally {
      await sql`delete from procurement_v3.party_public_names where fiscal_code_clean = '2000002'`.execute(
        db
      );
      await api.destroy();
    }
  });

  it('names through the production wiring, on GraphQL and MCP', async () => {
    if (db === undefined || container === undefined) throw new Error('no database');
    await sql.raw(approvedAnalysisGrants(await columnsOf(db))).execute(db);
    const api = new Kysely<ProdDatabase>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          host: container.getHost(),
          port: container.getPort(),
          database: container.getDatabase(),
          user: API_LOGIN,
          password: API_LOGIN,
          max: 2,
        }),
      }),
    });
    const module = makeProcurementModule({
      db: api,
      warmCache: false,
      legacyEnabled: false,
      daV3Enabled: true,
    });
    const { typeDefs } = mergeGraphqlSlices(baseTypeDefs, [module.graphqlSlice]);
    const app = fastifyLib({ logger: false });
    try {
      await app.register(
        makeGraphQLPlugin({
          schema: [typeDefs],
          resolvers: [{ ...scalarResolvers, ...module.graphqlResolvers }],
          isProduction: false,
          enableGraphiQL: false,
        })
      );
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          query:
            '{ procurementBreakdown(scope: { grain: direct_acquisition }, dimension: supplier, topN: 10) { buckets { kind key displayKind displayName } } }',
        }),
      });
      const body: {
        data?: { procurementBreakdown: { buckets: Record<string, unknown>[] }[] };
        errors?: unknown;
      } = res.json();
      expect(body.errors).toBeUndefined();
      const graphNames = (body.data?.procurementBreakdown[0]?.buckets ?? []).filter(
        (bucket) => bucket['kind'] === 'top'
      );
      expect(graphNames).toContainEqual({
        kind: 'top',
        key: COMPANY.fiscalCode,
        displayKind: 'company',
        displayName: COMPANY_REGISTRY_NAME,
      });
      expect(graphNames).toContainEqual({
        kind: 'top',
        key: 'natural_person',
        displayKind: 'natural_person',
        displayName: null,
      });
      const tool = module.mcpTools.find((candidate) => candidate.name === 'aggregate_procurement');
      if (tool === undefined) throw new Error('aggregate_procurement is not registered');
      const output = await tool.handler({
        shape: 'breakdown',
        scope: { grain: 'direct_acquisition' },
        dimension: 'supplier',
        topN: 10,
      });
      const raw = JSON.stringify(output);
      expect(raw).toContain(`"displayName":"${COMPANY_REGISTRY_NAME}"`);
      noLeak(output);
    } finally {
      await app.close();
      await api.destroy();
    }
  });
});
