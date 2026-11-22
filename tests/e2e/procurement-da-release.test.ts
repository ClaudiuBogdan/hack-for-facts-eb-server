/**
 * E2E — direct acquisitions release 1 against a REAL Postgres: the repository's
 * SQL runs (types, casts, grouping, window counts, timestamp text), the D6
 * filter and supplier buckets hold in SQL, and the reader works both before
 * and after `supplier_disclosure` and the pending columns exist.
 *
 * Parties are read only through `da_parties_public`. Before: that view is
 * readable but `supplier_disclosure` is not (here the view is unfiltered, so a
 * reader that trusted it alone would leak): every supplier must be withheld.
 * After: the platform's views (SEC-GRANTS-PROC-2211) and the `*_shown`
 * columns exist, and the reader runs as a login holding EXACTLY the approved
 * grants, so a read of any ungranted column or table fails the test.
 *
 * The schema is a MINIMAL SHAPE built from the serving contract
 * (DIRECT_ACQUISITION_SERVING_CONTRACT.md: column names and types), not the
 * data platform's migration, which waits for the owner. Rows are the
 * contract's example rows (tests/fixtures/procurement/da-release.ts).
 * Docker-guarded like the other e2e suites.
 */

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';

import {
  daPurchaseTotals,
  getDaPurchase,
  listDaPurchases,
  type DaReleaseDeps,
} from '@/modules/procurement/core/da-release-usecases.js';
import { makeDaReleaseRepo } from '@/modules/procurement/shell/repo/da-release-repo.js';

import { dockerCliUp } from './disposable-postgres.js';
import {
  BAD_CODE_SUPPLIER,
  COMPANY,
  ITEMS,
  NATURAL_PERSON,
  PURCHASES,
  SECRET,
  SOLE_TRADER,
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

const DDL = `
  create schema procurement_v3;
  create table procurement_v3.da_purchases (
    purchase_id text primary key,
    source_name text not null,
    native_id text not null,
    code text not null unique,
    source_url text,
    outcome text not null,
    state_label text,
    publication_day date,
    finalization_day date,
    ca_decision_at timestamptz,
    supplier_decision_at timestamptz,
    reported_value numeric(20,2),
    counted boolean not null,
    counted_value numeric(20,2),
    not_counted_reason text,
    value_corrected boolean not null default false,
    value_review_rule text,
    symbolic_price boolean not null default false,
    title text,
    description text,
    category_code text,
    category_as_written text,
    acquisition_type_label text,
    buyer_party_id text,
    supplier_party_id text,
    estimate_reported numeric(20,2),
    value_review_description text
  );
  create table procurement_v3.da_parties (
    source_name text not null,
    party_kind text not null,
    portal_party_id text not null,
    fiscal_code_clean text,
    fiscal_code_status text,
    name_as_written text,
    phone text,
    primary key (source_name, party_kind, portal_party_id)
  );
  create table procurement_v3.da_value_rules (
    rule text primary key,
    effect text not null,
    public_description_en text,
    public_description_ro text
  );
  create table procurement_v3.da_items (
    purchase_id text not null,
    item_index integer not null,
    name text,
    unit text,
    quantity numeric,
    requested_quantity numeric,
    unit_price numeric,
    estimated_price numeric,
    catalogue_price numeric,
    supplier_rejected boolean,
    quantity_correction boolean,
    primary key (purchase_id, item_index)
  );
  create table procurement_v3.da_release (
    data_as_of timestamptz not null,
    rows bigint, dated bigint, counted bigint, accepted bigint, with_cpv bigint, with_geo bigint,
    money numeric, money_dated numeric, money_geo numeric, free_text_rule text,
    registry_as_of timestamptz
  );
  -- Before the D6 view: a public party view the reader may read, but no
  -- supplier_disclosure, so D6 must withhold every supplier the view lists.
  create view procurement_v3.da_parties_public with (security_barrier = true) as
    select source_name, party_kind, portal_party_id, fiscal_code_clean, fiscal_code_status, name_as_written
    from procurement_v3.da_parties;
`;

const parties = (): Map<string, { kind: 'buyer' | 'supplier'; party: DaPartyRecord }> => {
  const out = new Map<string, { kind: 'buyer' | 'supplier'; party: DaPartyRecord }>();
  for (const row of PURCHASES) {
    if (row.buyer !== null)
      out.set(`buyer:${row.buyer.portalPartyId}`, { kind: 'buyer', party: row.buyer });
    if (row.supplier !== null)
      out.set(`supplier:${row.supplier.portalPartyId}`, { kind: 'supplier', party: row.supplier });
  }
  return out;
};

const load = async (trx: Kysely<ProdDatabase>): Promise<void> => {
  await sql.raw(DDL).execute(trx);
  await sql`insert into procurement_v3.da_release (data_as_of) values ('2026-11-18T03:10:00.123456Z')`.execute(
    trx
  );
  for (const { kind, party } of parties().values()) {
    await sql`insert into procurement_v3.da_parties
      (source_name, party_kind, portal_party_id, fiscal_code_clean, fiscal_code_status, name_as_written, phone)
      values (${SOURCE}, ${kind}, ${party.portalPartyId}, ${party.fiscalCode}, ${party.fiscalCodeStatus}, ${party.name}, '0700000000')`.execute(
      trx
    );
    // The same portal id under another source must never join.
    await sql`insert into procurement_v3.da_parties
      (source_name, party_kind, portal_party_id, fiscal_code_clean, fiscal_code_status, name_as_written)
      values ('archive', ${kind}, ${party.portalPartyId}, '1', 'valid', ${`${SECRET} OTHER SOURCE`})`.execute(
      trx
    );
  }
  const rules = new Map(
    PURCHASES.flatMap((row) => (row.rule === null ? [] : [[row.rule.rule, row.rule] as const]))
  );
  for (const rule of rules.values())
    await sql`insert into procurement_v3.da_value_rules values (${rule.rule}, ${rule.effect}, ${rule.descriptionEn}, ${rule.descriptionRo})`.execute(
      trx
    );
  for (const row of PURCHASES) {
    await sql`insert into procurement_v3.da_purchases (
        purchase_id, source_name, native_id, code, source_url, outcome, state_label, publication_day,
        finalization_day, ca_decision_at, supplier_decision_at, reported_value, counted, counted_value,
        not_counted_reason, value_corrected, value_review_rule, symbolic_price, title, description,
        category_code, category_as_written, acquisition_type_label, buyer_party_id, supplier_party_id,
        estimate_reported, value_review_description)
      values (${row.purchaseId}, ${SOURCE}, ${row.nativeId}, ${row.code}, ${row.sourceUrl}, ${row.outcome},
        ${row.stateLabel}, ${row.publicationDay}, ${row.finalizationDay}, ${row.buyerDecisionAt},
        ${row.supplierDecisionAt}, ${row.reportedValue}, ${row.counted}, ${row.countedValue},
        ${row.notCountedReason}, ${row.valueCorrected}, ${row.valueReviewRule}, ${row.symbolicPrice},
        ${row.title}, ${row.description}, ${row.categoryCode}, ${row.categoryAsWritten},
        ${row.acquisitionTypeLabel}, ${row.buyer?.portalPartyId ?? null}, ${row.supplier?.portalPartyId ?? null},
        1, ${`${SECRET} internal note`})`.execute(trx);
  }
  for (const [purchaseId, items] of Object.entries(ITEMS))
    for (const item of items)
      await sql`insert into procurement_v3.da_items values (${purchaseId}, ${item.itemIndex}, ${item.name},
        ${item.unit}, ${item.quantity}, ${item.requestedQuantity}, ${item.unitPrice}, 99, ${item.cataloguePrice},
        ${item.supplierRejected}, ${item.quantityCorrection})`.execute(trx);
  await sql`insert into procurement_v3.da_items (purchase_id, item_index, name, quantity, unit_price)
    values (${PURCHASES[1]?.purchaseId ?? ''}, 2, 'Wide', 9999999999.99, 9999999999.99)`.execute(
    trx
  );
};

/** The registry name the API serves for the public company (never its name as written). */
const COMPANY_REGISTRY_NAME = 'EXEMPLU REGISTRU SA';

/** The API's login under the approved SEC-GRANTS-PROC-2211 v3 grants (DA release part). */
const API_LOGIN = 'procurement_api_e2e';
const APPROVED_GRANTS = `
  create role procurement_api_read nologin;
  grant usage on schema procurement_v3 to procurement_api_read;
  grant select (data_as_of, rows, dated, counted, accepted, with_cpv, with_geo, money, money_dated,
    money_geo, free_text_rule, registry_as_of) on procurement_v3.da_release to procurement_api_read;
  grant select (purchase_id, native_id, code, source_name, source_url, outcome, state_label,
    publication_day, finalization_day, ca_decision_at, supplier_decision_at, reported_value, counted,
    counted_value, not_counted_reason, value_corrected, value_review_rule, symbolic_price, title_shown,
    title_public, description_public, category_code, category_as_written, acquisition_type_label,
    listed_now, buyer_party_id, supplier_party_id) on procurement_v3.da_purchases to procurement_api_read;
  grant select (purchase_id, item_index, item_name_shown, item_name_public, item_unit_shown,
    item_unit_public, quantity, requested_quantity, unit_price, catalogue_price, supplier_rejected,
    quantity_correction, superseded_at) on procurement_v3.da_items to procurement_api_read;
  grant select (rule, effect, public_description_en, public_description_ro)
    on procurement_v3.da_value_rules to procurement_api_read;
  grant select on procurement_v3.supplier_disclosure, procurement_v3.da_parties_public,
    procurement_v3.party_public_names to procurement_api_read;
  create role ${API_LOGIN} login password '${API_LOGIN}' in role procurement_api_read;
`;

/** Add the pending columns and the platform's public views, as the loader and migration will. */
const addPendingColumns = async (trx: Kysely<ProdDatabase>): Promise<void> => {
  await sql`alter table procurement_v3.da_items add column superseded_at timestamptz`.execute(trx);
  // A line the sync no longer sees: kept, never served.
  await sql`insert into procurement_v3.da_items (purchase_id, item_index, name, quantity, unit_price, superseded_at)
    values (${PURCHASES[1]?.purchaseId ?? ''}, 3, ${`${SECRET} superseded line`}, 1, 1, now())`.execute(
    trx
  );
  // The site-wide D6 classification: the company is public, the sole trader and the bad code are
  // not, and UNVERIFIED's code is absent (absent means withheld). The API never reads it.
  await sql`create table procurement_v3.supplier_privacy (
    fiscal_code_clean text primary key, supplier_id bigint not null, supplier_kind text,
    public boolean not null, method text, classified_at timestamptz)`.execute(trx);
  for (const [id, party, isPublic, kind] of [
    [1, COMPANY, true, 'company'],
    [2, SOLE_TRADER, false, 'sole_trader'],
    [3, NATURAL_PERSON, false, 'natural_person'],
    [4, BAD_CODE_SUPPLIER, false, 'unverified'],
  ] as const)
    await sql`insert into procurement_v3.supplier_privacy (fiscal_code_clean, supplier_id, public, supplier_kind)
      values (${party.fiscalCode}, ${id}, ${isPublic}, ${kind})`.execute(trx);
  // The platform's public views (migration 20261121T090060, procurement-prod's final columns).
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
  // Free text through the platform's *_shown columns: only purchase 1's title and line 0's
  // name and unit are public. A shown text whose flag is false is never served either.
  await sql`alter table procurement_v3.da_purchases
    add column title_shown text, add column title_public boolean,
    add column description_shown text, add column description_public boolean`.execute(trx);
  await sql`alter table procurement_v3.da_items
    add column item_name_shown text, add column item_name_public boolean,
    add column item_unit_shown text, add column item_unit_public boolean`.execute(trx);
  await sql`update procurement_v3.da_purchases set title_public = true, title_shown = title,
    description_public = true, description_shown = description
    where purchase_id = ${PURCHASES[0]?.purchaseId ?? ''}`.execute(trx);
  await sql`update procurement_v3.da_purchases set title_public = false,
    title_shown = ${`${SECRET} shown but not public`}
    where purchase_id = ${PURCHASES[2]?.purchaseId ?? ''}`.execute(trx);
  await sql`update procurement_v3.da_items set item_unit_public = true, item_unit_shown = unit,
    item_name_public = true, item_name_shown = name where item_index = 0`.execute(trx);
  await sql`alter table procurement_v3.da_purchases add column listed_now boolean`.execute(trx);
  for (const row of PURCHASES)
    await sql`update procurement_v3.da_purchases set listed_now = ${row.listedNow} where purchase_id = ${row.purchaseId}`.execute(
      trx
    );
  await sql.raw(APPROVED_GRANTS).execute(trx);
};

/** The reader: the owner login before the views, the approved-grant login after. */
let reader: Kysely<ProdDatabase> | undefined;

const deps = (): DaReleaseDeps => {
  const current = reader ?? db;
  if (current === undefined) throw new Error('no database');
  return { repo: makeDaReleaseRepo(current, true) };
};

beforeAll(async () => {
  if (!dockerCliUp()) return;
  try {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('da_release')
      .start();
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
});

afterAll(async () => {
  await reader?.destroy();
  await db?.destroy();
  await container?.stop();
});

const ALL = { page: 1, pageSize: 100 };

/** `forbidden`: text no response may contain in this phase. */
const checkCommon = async (forbidden: readonly string[]) => {
  const list = (await listDaPurchases(deps(), ALL))._unsafeUnwrap();
  expect(list.dataAsOf).toBe('2026-11-18T03:10:00.123456Z');
  expect(list.total).toBe(PURCHASES.length);
  expect(list.items.map((item) => item.finalizationDay)).toEqual(
    [...PURCHASES]
      .map((row) => row.finalizationDay)
      .sort()
      .reverse()
  );
  const raw = JSON.stringify(list);
  for (const text of [
    ...forbidden,
    'OTHER SOURCE',
    'internal note',
    '0700000000',
    'Popescu Ion',
    'Servicii prestate',
  ])
    expect(raw).not.toContain(text);

  const corrected = PURCHASES[1];
  const detail = (await getDaPurchase(deps(), corrected?.purchaseId ?? ''))._unsafeUnwrap();
  expect(detail.purchase).toMatchObject({
    reportedValue: '3150000.00',
    countedValue: '3150.00',
    correctedValue: '3150.00',
    reviewRule: { rule: 'quantity_unit_mix', effect: 'correct' },
    finalizationDay: '2025-03-04',
    buyerDecisionAt: '2025-06-01T08:00:00.000000Z',
  });
  expect(
    detail.items.map((item) => [
      item.itemIndex,
      item.quantity,
      item.unitPrice,
      item.reportedLineValue,
    ])
  ).toEqual([
    [0, '375', '8400.00', '3150000.00'],
    [1, '15.2', '180.00', '2736.000'],
    // Past 20 significant digits: exact in SQL numeric.
    [2, '9999999999.99', '9999999999.99', '99999999999800000000.0001'],
  ]);

  const totals = (await daPurchaseTotals(deps(), ALL))._unsafeUnwrap();
  expect(totals.overall).toEqual({
    countedValue: '188822600.01',
    countedCount: '9',
    symbolicPriceCount: '1',
    purchaseCount: String(PURCHASES.length),
  });

  const months = (await daPurchaseTotals(deps(), { groupBy: 'month', ...ALL }))._unsafeUnwrap();
  expect(months.groups.map((group) => group.key)).toEqual(
    [...new Set(PURCHASES.map((row) => row.finalizationDay?.slice(0, 7)))].sort()
  );
  const july = months.groups.find((group) => group.key === '2025-07');
  expect(july).toMatchObject({ countedValue: '1750.00', countedCount: '4', purchaseCount: '4' });

  const years = (
    await daPurchaseTotals(deps(), { groupBy: 'year', page: 1, pageSize: 2 })
  )._unsafeUnwrap();
  expect(years.groups.map((group) => group.key)).toEqual(['2021', '2025']);
  expect(years.groupCount).toBe(3);
  const past = (
    await daPurchaseTotals(deps(), { groupBy: 'year', page: 9, pageSize: 2 })
  )._unsafeUnwrap();
  expect(past.groups).toEqual([]);
  expect(past.groupCount).toBe(3);

  const byBuyer = (await daPurchaseTotals(deps(), { groupBy: 'buyer', ...ALL }))._unsafeUnwrap();
  expect(byBuyer.groups.map((group) => group.party?.name)).toEqual([
    'COMUNA EXEMPLU',
    'SCOALA GIMNAZIALA EXEMPLU',
  ]);
  expect(byBuyer.groups[1]?.party?.fiscalCode).toBeNull();

  const cpv = (
    await listDaPurchases(deps(), { filter: { cpvDivision: '30' }, ...ALL })
  )._unsafeUnwrap();
  expect(cpv.total).toBe(1);
  const range = (
    await listDaPurchases(deps(), {
      filter: { finalizationFrom: '2025-07-01', finalizationTo: '2025-07-31', counted: true },
      ...ALL,
    })
  )._unsafeUnwrap();
  expect(range.total).toBe(4);
  const byCode = (
    await listDaPurchases(deps(), { filter: { code: PURCHASES[4]?.code ?? '' }, ...ALL })
  )._unsafeUnwrap();
  expect(byCode.items.map((item) => item.purchaseId)).toEqual([PURCHASES[4]?.purchaseId]);
  const refused = (
    await listDaPurchases(deps(), { filter: { outcomes: ['refused'] }, ...ALL })
  )._unsafeUnwrap();
  expect(refused.total).toBe(1);
};

describe('before supplier_disclosure and the pending columns exist', () => {
  it('serves every case and withholds every supplier, companies included (fails closed)', async () => {
    await checkCommon([SECRET, COMPANY.name ?? '~']);
    const list = (await listDaPurchases(deps(), ALL))._unsafeUnwrap();
    expect(list.items.every((item) => item.listedNow === null)).toBe(true);
    // No public flag column yet: every free-text field is withheld.
    expect(
      list.items.every((item) => item.title === null && item.titleWithheld === 'privacy')
    ).toBe(true);
    expect(list.items.every((item) => item.description === null)).toBe(true);
    for (const item of list.items.filter((i) => i.supplier !== null))
      expect(item.supplier).toEqual({
        displayKind: 'natural_person',
        partyId: null,
        name: null,
        fiscalCode: null,
      });
    for (const code of [COMPANY.fiscalCode, SOLE_TRADER.fiscalCode]) {
      const probe = (
        await listDaPurchases(deps(), { filter: { supplierFiscalCode: code ?? '' }, ...ALL })
      )._unsafeUnwrap();
      expect(probe.total).toBe(0);
    }
    const bySupplier = (
      await daPurchaseTotals(deps(), { groupBy: 'supplier', ...ALL })
    )._unsafeUnwrap();
    expect(
      bySupplier.groups.map((g) => [g.party?.displayKind ?? null, g.noSupplier, g.purchaseCount])
    ).toEqual([
      ['natural_person', false, String(PURCHASES.length - 1)],
      [null, true, '1'],
    ]);
  });
});

describe('after the public views and the pending columns exist, under the approved grants', () => {
  it('names only companies, by registry name, and serves listed_now', async () => {
    if (db === undefined || container === undefined) throw new Error('no database');
    await addPendingColumns(db);
    reader = new Kysely<ProdDatabase>({
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
    await checkCommon([SECRET, COMPANY.name ?? '~']);
    const list = (await listDaPurchases(deps(), ALL))._unsafeUnwrap();
    expect(list.items.find((item) => item.purchaseId === PURCHASES[7]?.purchaseId)?.listedNow).toBe(
      false
    );
    const first = list.items.find((item) => item.purchaseId === PURCHASES[0]?.purchaseId);
    // The description is never read, even where the platform marks it public.
    expect(first).toMatchObject({
      title: 'Public title 1',
      titleWithheld: null,
      description: null,
      descriptionWithheld: 'privacy',
    });
    const lines = (await getDaPurchase(deps(), PURCHASES[1]?.purchaseId ?? ''))._unsafeUnwrap()
      .items;
    expect(lines.map((line) => [line.unit, line.unitWithheld])).toEqual([
      ['tona', null],
      [null, 'privacy'],
      [null, 'privacy'],
    ]);
    expect(lines.map((line) => [line.itemIndex, line.name, line.nameWithheld])).toEqual([
      [0, 'Beton refractar', null],
      [1, null, 'privacy'],
      [2, null, 'privacy'],
    ]);
    const named = new Set(
      list.items.flatMap((item) =>
        item.supplier?.name === null || item.supplier === null ? [] : [item.supplier.name]
      )
    );
    expect(named).toEqual(new Set([COMPANY_REGISTRY_NAME]));

    const pfa = (
      await listDaPurchases(deps(), {
        filter: { supplierFiscalCode: SOLE_TRADER.fiscalCode ?? '' },
        ...ALL,
      })
    )._unsafeUnwrap();
    expect(pfa.total).toBe(0);
    const company = (
      await listDaPurchases(deps(), {
        filter: { supplierFiscalCode: COMPANY.fiscalCode ?? '' },
        ...ALL,
      })
    )._unsafeUnwrap();
    expect(company.total).toBe(PURCHASES.filter((row) => row.supplier === COMPANY).length);

    const bySupplier = (
      await daPurchaseTotals(deps(), { groupBy: 'supplier', ...ALL })
    )._unsafeUnwrap();
    expect(bySupplier.groupCount).toBe(3);
    expect(
      bySupplier.groups.map((group) => [
        group.party?.displayKind ?? null,
        group.noSupplier,
        group.purchaseCount,
      ])
    ).toEqual([
      ['company', false, String(PURCHASES.filter((row) => row.supplier === COMPANY).length)],
      ['natural_person', false, '5'],
      [null, true, '1'],
    ]);
    expect(JSON.stringify(bySupplier)).not.toContain(SECRET);
    expect(bySupplier.groups[0]?.party?.name).toBe(COMPANY_REGISTRY_NAME);
  });
});

describe('list orders page exactly as one ORDER BY, across the keyed/unkeyed boundary', () => {
  it('serves every sort in the single-statement order, page by page', async () => {
    if (db === undefined) throw new Error('no database');
    // Undated and uncounted purchases, so every sort crosses its keyed/unkeyed boundary.
    for (const [index, id] of ['u1', 'u2', 'u3'].entries())
      await sql`insert into procurement_v3.da_purchases
          (purchase_id, source_name, native_id, code, outcome, counted, not_counted_reason, buyer_party_id)
        values (${`${'e'.repeat(62)}u${String(index)}`}, ${SOURCE}, ${`undated-${id}`}, ${`DA-U-${id}`},
          'unknown', false, 'detail_unusable', ${PURCHASES[0]?.buyer?.portalPartyId ?? null})`.execute(
        db
      );
    const undated = await sql<{ n: string }>`select count(*)::text as n
      from procurement_v3.da_purchases where finalization_day is null`.execute(db);
    expect(Number(undated.rows[0]?.n)).toBeGreaterThanOrEqual(3);
    for (const [sort, key, direction] of [
      ['finalizationDesc', 'finalization_day', 'desc'],
      ['finalizationAsc', 'finalization_day', 'asc'],
      ['countedValueDesc', 'counted_value', 'desc'],
    ] as const) {
      const expected = (
        await sql<{ id: string }>`select purchase_id as id from procurement_v3.da_purchases
          order by ${sql.raw(key)} ${sql.raw(direction)} nulls last,
                   purchase_id ${sql.raw(direction)}`.execute(db)
      ).rows.map((row) => row.id);
      // Two page sizes, so the boundary falls inside a page and on a page edge.
      for (const pageSize of [2, 4]) {
        const pages: string[][] = [];
        for (let page = 1; (page - 1) * pageSize < expected.length + pageSize; page += 1) {
          const list = (await listDaPurchases(deps(), { sort, page, pageSize }))._unsafeUnwrap();
          pages.push(list.items.map((item) => item.purchaseId));
        }
        // Page by page, not flattened: each page holds exactly its slice of the one ORDER BY.
        const slices = pages.map((_, i) => expected.slice(i * pageSize, (i + 1) * pageSize));
        expect({ sort, pageSize, pages }).toEqual({ sort, pageSize, pages: slices });
      }
    }
  });
});

/**
 * PROC-AP75: whole-table supplier totals from the per-party rollup. Every eligible request (no
 * filter, or a month-aligned finalization range) answers exactly as the purchases did, the rollup
 * is read only while da_release says it was built for this publication, and anything else falls
 * back. Sequential like the file: runs after the API login exists.
 */
describe('supplier totals from the per-party rollup (PROC-AP75)', () => {
  it('answers exactly as the purchases, only while fresh and eligible', async () => {
    if (db === undefined || container === undefined) throw new Error('no database');
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
        statements.push(event.query.sql);
      },
    });
    const ask = (filter: Record<string, string>, page: number, pageSize: number) =>
      daPurchaseTotals(
        { repo: makeDaReleaseRepo(logged, true) },
        {
          groupBy: 'supplier',
          filter,
          page,
          pageSize,
        }
      );
    const ELIGIBLE = [
      {},
      { finalizationFrom: '2025-01-01', finalizationTo: '2025-12-31' },
      { finalizationFrom: '2025-07-01' },
      { finalizationTo: '2025-06-30' },
      // A leap February ends on the 29th.
      { finalizationFrom: '2021-01-01', finalizationTo: '2024-02-29' },
      // A month holding only an emptied bucket: zero counts, no group (never a refused total).
      { finalizationFrom: '2025-08-01', finalizationTo: '2025-08-31' },
      // A month whose one counted value has one decimal (see below): both paths print cents.
      { finalizationFrom: '2026-11-01', finalizationTo: '2026-11-30' },
    ];
    // A day inside a month, or any other filter: the purchases answer.
    const INELIGIBLE = [
      { finalizationFrom: '2025-07-08' },
      { finalizationTo: '2025-07-09' },
      { finalizationTo: '2025-02-27' },
      { finalizationFrom: '2025-01-01', cpvDivision: '44' },
    ];
    const battery = async () => {
      const out: unknown[] = [];
      for (const filter of [...ELIGIBLE, ...INELIGIBLE])
        for (const [page, pageSize] of [
          [1, 100],
          [1, 1],
          [2, 1],
          [3, 1],
          [9, 1],
        ] as const)
          out.push(await ask(filter, page, pageSize));
      return out;
    };
    const read = (text: string) => text.includes('da_rollup_supplier_party_month"');
    try {
      // As on prod, the purchases' counted value is unconstrained numeric (scale <= 2 by a CHECK),
      // so a value the portal gave with one decimal sums with one decimal on the purchases path.
      await sql`alter table procurement_v3.da_purchases alter column counted_value type numeric`.execute(
        db
      );
      await sql`update procurement_v3.da_purchases set counted_value = 5200.0
        where finalization_day = '2026-11-13'`.execute(db);
      const purchases = await battery();
      expect(JSON.stringify(purchases)).toContain('"countedValue":"5200.00"');
      expect(JSON.stringify(purchases)).not.toContain('"countedValue":"5200.0"');
      for (const answer of purchases) expect((answer as { isOk: () => boolean }).isOk()).toBe(true);

      // The platform's rollup and its freshness marker, as 065 and the migration build them.
      await sql`create table procurement_v3.da_rollup_supplier_party_month as
        select source_name, supplier_party_id,
               date_trunc('month', finalization_day)::date as month,
               count(*) as purchases,
               count(*) filter (where counted) as counted_purchases,
               coalesce(sum(counted_value) filter (where counted), 0)::numeric(20, 2) as counted_value,
               count(*) filter (where counted and symbolic_price) as counted_symbolic_purchases
        from procurement_v3.da_purchases group by 1, 2, 3`.execute(db);
      // An emptied bucket keeps its row with zeros, under a party and a month nothing else has.
      await sql`insert into procurement_v3.da_rollup_supplier_party_month
        values ('elicitatie_api_pub', 'emptied-party', '2025-08-01', 0, 0, 0, 0)`.execute(db);
      await sql`alter table procurement_v3.da_release add column supplier_party_rollup_for timestamptz`.execute(
        db
      );
      await sql`update procurement_v3.da_release set supplier_party_rollup_for = data_as_of`.execute(
        db
      );

      // Not granted yet (the PRJ-54YB cutover adds it): the purchases answer, unchanged.
      statements.length = 0;
      expect(await battery()).toEqual(purchases);
      expect(statements.some(read)).toBe(false);

      // The rollup readable but not its freshness marker: still the purchases.
      await sql`grant select on procurement_v3.da_rollup_supplier_party_month to procurement_api_read`.execute(
        db
      );
      statements.length = 0;
      expect(await battery()).toEqual(purchases);
      expect(statements.some(read)).toBe(false);
      await sql`grant select (supplier_party_rollup_for) on procurement_v3.da_release to procurement_api_read`.execute(
        db
      );
      statements.length = 0;
      const rolled = await battery();
      expect(rolled).toEqual(purchases);
      // Every eligible request read the rollup, and never the purchases; no other request did.
      for (const filter of ELIGIBLE) {
        statements.length = 0;
        await ask(filter, 1, 100);
        expect(statements.some(read), JSON.stringify(filter)).toBe(true);
        expect(
          statements.some((text) => text.includes('"procurement_v3"."da_purchases"')),
          JSON.stringify(filter)
        ).toBe(false);
      }
      for (const filter of INELIGIBLE) {
        statements.length = 0;
        await ask(filter, 1, 100);
        expect(statements.some(read), JSON.stringify(filter)).toBe(false);
      }

      // A rollup built for another publication is never read.
      await sql`update procurement_v3.da_release
        set supplier_party_rollup_for = data_as_of - interval '1 day'`.execute(db);
      statements.length = 0;
      expect(await battery()).toEqual(purchases);
      expect(statements.some(read)).toBe(false);
    } finally {
      await logged.destroy();
    }
  });
});
