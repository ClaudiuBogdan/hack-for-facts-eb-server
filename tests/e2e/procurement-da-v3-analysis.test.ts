/**
 * E2E — the analysis API's direct_acquisition grain answered from
 * procurement_v3 against a REAL Postgres, through the analysis usecases and the
 * routing repo (no ClickHouse configured, so only the DA grain answers):
 * the SQL runs, the counted-value figures, buckets, distincts, concentration
 * and records are right on the contract's example rows, buyer geography joins
 * through public entities to public territories, D6 keys every withheld
 * supplier as one `natural_person` bucket (all of them before supplier_privacy
 * exists), no response carries a withheld supplier's name or code, and a read
 * against a moved publication is refused.
 *
 * Minimal-shape schema from the serving contract (not the data platform's
 * migration, which waits for the owner) plus the three kernel geography tables
 * the join reads. Docker-guarded like the other e2e suites.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import {
  analysisBreakdown,
  analysisConcentration,
  analysisRecords,
  analysisSeries,
  analysisStats,
  type AnalysisDeps,
} from '@/modules/procurement/core/analysis-usecases.js';
import { makeUnconfiguredAnalysisRepo } from '@/modules/procurement/shell/repo/clickhouse-analysis-repo.js';
import { makeDaRoutingAnalysisRepo } from '@/modules/procurement/shell/repo/da-routing-analysis-repo.js';
import {
  DA_V3_VALUE_NOTE,
  makeDaV3AnalysisSource,
} from '@/modules/procurement/shell/repo/da-v3-analysis-source.js';

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
import type { ProdDatabase } from '@/modules/shared/index.js';

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

/** The migration lands supplier_privacy in a new publication (data_as_of moves). */
const publishPrivacy = async (trx: Kysely<ProdDatabase>): Promise<void> => {
  await sql`create table procurement_v3.supplier_privacy (
    fiscal_code_clean text primary key, supplier_kind text, public boolean not null)`.execute(trx);
  for (const [party, isPublic] of [
    [COMPANY, true],
    [SOLE_TRADER, false],
    [NATURAL_PERSON, false],
    [BAD_CODE_SUPPLIER, false],
  ] as const)
    await sql`insert into procurement_v3.supplier_privacy (fiscal_code_clean, public)
      values (${party.fiscalCode}, ${isPublic})`.execute(trx);
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
const WITHHELD_CODES = [SOLE_TRADER, NATURAL_PERSON, UNVERIFIED, BAD_CODE_SUPPLIER].map(
  (party) => party.fiscalCode ?? ''
);

const noLeak = (value: unknown): void => {
  const raw = JSON.stringify(value);
  expect(raw).not.toContain(SECRET);
  for (const code of WITHHELD_CODES) expect(raw).not.toContain(`"${code}"`);
};

describe('before supplier_privacy exists (fails closed)', () => {
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
    // No supplier_privacy yet: everyone is withheld, and the D6 key says so.
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

describe('with supplier_privacy', () => {
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
      supplierName: COMPANY.name,
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
