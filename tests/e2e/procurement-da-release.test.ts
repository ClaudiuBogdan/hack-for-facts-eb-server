/**
 * E2E — direct acquisitions release 1 against a REAL Postgres: the repository's
 * SQL runs (types, casts, grouping, window counts, timestamp text), the D6
 * filter and supplier buckets hold in SQL, and the reader works both before
 * and after the pending `supplier_kind` / `listed_now` columns exist.
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
  create table procurement_v3.da_release (data_as_of timestamptz not null);
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
  await sql`insert into procurement_v3.da_release values ('2026-11-18T03:10:00Z')`.execute(trx);
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
};

/** Add the pending columns, as the loader change will. */
const addPendingColumns = async (trx: Kysely<ProdDatabase>): Promise<void> => {
  await sql`alter table procurement_v3.da_parties add column supplier_kind text`.execute(trx);
  await sql`alter table procurement_v3.da_purchases add column listed_now boolean`.execute(trx);
  for (const { kind, party } of parties().values())
    if (kind === 'supplier')
      await sql`update procurement_v3.da_parties set supplier_kind = ${party.supplierKind}
        where source_name = ${SOURCE} and party_kind = 'supplier' and portal_party_id = ${party.portalPartyId}`.execute(
        trx
      );
  for (const row of PURCHASES)
    await sql`update procurement_v3.da_purchases set listed_now = ${row.listedNow} where purchase_id = ${row.purchaseId}`.execute(
      trx
    );
};

const deps = (): DaReleaseDeps => {
  if (db === undefined) throw new Error('no database');
  return { repo: makeDaReleaseRepo(db, true) };
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
  await db?.destroy();
  await container?.stop();
});

const ALL = { page: 1, pageSize: 100 };

/** `forbidden`: text no response may contain in this phase. */
const checkCommon = async (forbidden: readonly string[]) => {
  const list = (await listDaPurchases(deps(), ALL))._unsafeUnwrap();
  expect(list.dataAsOf).toBe('2026-11-18T03:10:00Z');
  expect(list.total).toBe(PURCHASES.length);
  expect(list.items.map((item) => item.finalizationDay)).toEqual(
    [...PURCHASES]
      .map((row) => row.finalizationDay)
      .sort()
      .reverse()
  );
  const raw = JSON.stringify(list);
  for (const text of [...forbidden, 'OTHER SOURCE', 'internal note', '0700000000'])
    expect(raw).not.toContain(text);

  const corrected = PURCHASES[1];
  const detail = (await getDaPurchase(deps(), corrected?.purchaseId ?? ''))._unsafeUnwrap();
  expect(detail.purchase).toMatchObject({
    reportedValue: '3150000.00',
    countedValue: '3150.00',
    correctedValue: '3150.00',
    reviewRule: { rule: 'quantity_unit_mix', effect: 'correct' },
    finalizationDay: '2025-03-04',
    buyerDecisionAt: '2025-06-01T08:00:00Z',
  });
  expect(
    detail.items.map((item) => [
      item.itemIndex,
      item.quantity,
      item.unitPrice,
      item.reportedLineValue,
    ])
  ).toEqual([
    [0, '375', '8400.00', '3150000'],
    [1, '15.2', '180.00', '2736'],
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

describe('before supplier_kind and listed_now exist', () => {
  it('serves every case, withholds suppliers without a valid code, and names no pending column', async () => {
    // Before supplier_kind, a valid code is named (the contract's interim rule), so only
    // the suppliers without a valid code must stay hidden.
    await checkCommon([NATURAL_PERSON.name ?? '~', BAD_CODE_SUPPLIER.name ?? '~']);
    const list = (await listDaPurchases(deps(), ALL))._unsafeUnwrap();
    expect(list.items.every((item) => item.listedNow === null)).toBe(true);
    const natural = list.items.find((item) => item.purchaseId === PURCHASES[9]?.purchaseId);
    expect(natural?.supplier).toEqual({
      displayKind: 'natural_person',
      partyId: null,
      name: null,
      fiscalCode: null,
    });
    // Fallback: a valid code is named until supplier_kind exists (the contract's interim rule).
    const pfa = (
      await listDaPurchases(deps(), {
        filter: { supplierFiscalCode: SOLE_TRADER.fiscalCode ?? '' },
        ...ALL,
      })
    )._unsafeUnwrap();
    expect(pfa.total).toBe(2);
    const bySupplier = (
      await daPurchaseTotals(deps(), { groupBy: 'supplier', ...ALL })
    )._unsafeUnwrap();
    const withheld = bySupplier.groups.filter(
      (group) => group.party?.displayKind === 'natural_person'
    );
    expect(withheld).toHaveLength(1);
    expect(withheld[0]).toMatchObject({
      key: null,
      countedValue: '1200.00',
      countedCount: '2',
      purchaseCount: '2',
    });
    expect(JSON.stringify(bySupplier)).not.toContain(NATURAL_PERSON.name ?? '~');
  });
});

describe('after supplier_kind and listed_now exist', () => {
  it('names only companies and serves listed_now', async () => {
    if (db === undefined) throw new Error('no database');
    await addPendingColumns(db);
    await checkCommon([SECRET]);
    const list = (await listDaPurchases(deps(), ALL))._unsafeUnwrap();
    expect(list.items.find((item) => item.purchaseId === PURCHASES[7]?.purchaseId)?.listedNow).toBe(
      false
    );
    const named = new Set(
      list.items.flatMap((item) =>
        item.supplier?.name === null || item.supplier === null ? [] : [item.supplier.name]
      )
    );
    expect(named).toEqual(new Set([COMPANY.name]));

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
  });
});
