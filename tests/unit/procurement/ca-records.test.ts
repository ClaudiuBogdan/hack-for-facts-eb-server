import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { validateCaWindow } from '@/modules/procurement/core/ca-records-usecases.js';
import {
  CA_FLOOR_DAY,
  parseCaRecordId,
  toCaBuyer,
  toCaRecord,
  toCaWinner,
  type CaRecordRow,
  type CaWinnerRow,
} from '@/modules/procurement/core/ca-records.js';
import {
  buyerCountsSql,
  buyerKeysSql,
  recordRowsSql,
} from '@/modules/procurement/shell/repo/ca-records-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

const KEY = { sourceName: 'seap', matchId: 'ca:1001:1' };
const PLACE = { countyCode: null, siruta: null, region: null };

const winner = (
  patch: Partial<Omit<CaWinnerRow, 'naming'>> & { naming?: CaWinnerRow['naming'] | null }
): CaWinnerRow => {
  const { naming, ...rest } = patch;
  const base = { ...KEY, winnerOrder: 1, fiscalCode: '14399840', supplierDisclosed: true, ...rest };
  if (naming === null) return base;
  return { ...base, naming: naming ?? { kind: 'company', name: 'ALFA SRL', source: 'view' } };
};

const row = (patch: Partial<CaRecordRow> = {}): CaRecordRow => ({
  ...KEY,
  contractKind: 'ordinary',
  valueKind: 'awarded',
  additive: true,
  status: 'awarded',
  caHeadStatus: 'confirmed',
  amountLei: '10.00',
  nativeAmount: '10.00',
  currency: 'RON',
  fxSource: 'native_ron',
  vatBasis: 'unknown',
  amountOrigin: 'contract_view',
  flags: [],
  changeLei: null,
  changePublicationDay: null,
  awardDay: '2024-01-02',
  publicationDay: '2024-01-03',
  buyerCode: '4267117',
  buyerCountyCode: 'CJ',
  buyerSiruta: '54975',
  buyerRegion: null,
  buyerPerson: false,
  buyerNameMasked: null,
  cpvCode: '45000000-7',
  cpvDivision: '45',
  cpvGroup: '450',
  cpvClass: '4500',
  procedureId: 'P1',
  noticeNo: 'CAN1',
  title: 'Lucrari',
  sourceUrl: 'https://example/1',
  winnerCount: 1,
  lotCount: 0,
  ...patch,
});

describe('contract-award winners', () => {
  it('shows a gate code with its naming', () => {
    expect(toCaWinner(winner({}))).toEqual({
      order: 1,
      displayKind: 'company',
      fiscalCode: '14399840',
      name: 'ALFA SRL',
      disclosed: true,
    });
  });

  it('shows a code outside the gate only by code or masked, never a registry name', () => {
    expect(toCaWinner(winner({ supplierDisclosed: false }))).toMatchObject({
      displayKind: 'code_only',
      name: null,
      disclosed: false,
    });
    expect(
      toCaWinner(
        winner({
          supplierDisclosed: false,
          naming: { kind: 'person_masked', name: 'Io** Po****', source: 'view' },
        })
      )
    ).toMatchObject({ displayKind: 'person_masked', name: 'Io** Po****', fiscalCode: '14399840' });
  });

  it('withholds a code the names view hides, has no row for, or was not read through', () => {
    for (const naming of [
      { kind: 'hidden', name: null, source: 'view' },
      { kind: 'code_only', name: null, source: 'none' },
      { kind: 'company', name: 'ALFA SRL' },
      null,
    ] as const) {
      const served = toCaWinner(winner({ naming }));
      expect(served).toMatchObject({ displayKind: 'withheld', fiscalCode: null, name: null });
    }
    expect(toCaWinner(winner({ supplierDisclosed: null }))).toMatchObject({
      displayKind: 'withheld',
      fiscalCode: null,
    });
  });

  it('screens a name for personal codes', () => {
    expect(
      toCaWinner(winner({ naming: { kind: 'company', name: 'X 1234567890123', source: 'view' } }))
        .name
    ).toBeNull();
    expect(
      toCaWinner(winner({ naming: { kind: 'company', name: 'X 123 4567 8901', source: 'view' } }))
        .name
    ).toBeNull();
  });

  it('serves a winner with no usable code as unidentified', () => {
    expect(toCaWinner(winner({ fiscalCode: null, naming: null }))).toMatchObject({
      displayKind: 'unidentified',
      fiscalCode: null,
    });
  });
});

describe('contract-award buyers', () => {
  it('names an authority by its registry name and a person only by its masked name', () => {
    expect(
      toCaBuyer({ code: '1', person: false, maskedName: null, registryName: 'PRIMARIA X' }, PLACE)
    ).toMatchObject({ displayKind: 'authority', name: 'PRIMARIA X' });
    expect(
      toCaBuyer(
        { code: '1', person: true, maskedName: 'Po****u', registryName: 'POPESCU PFA' },
        PLACE
      )
    ).toMatchObject({ displayKind: 'person_masked', name: 'Po****u' });
    expect(
      toCaBuyer({ code: '1', person: null, maskedName: 'x', registryName: 'POPESCU' }, PLACE)
    ).toMatchObject({ displayKind: 'unknown', name: null });
  });

  it('decides a record’s buyer by the row’s own person flag', () => {
    const record = toCaRecord(
      row({ buyerPerson: true, buyerNameMasked: 'Po****u' }),
      { code: '4267117', person: false, maskedName: null, registryName: 'POPESCU PFA' },
      [winner({})]
    )._unsafeUnwrap();
    expect(record.buyer).toMatchObject({ displayKind: 'person_masked', name: 'Po****u' });
  });
});

describe('contract-award records', () => {
  it('refuses a row that breaks the serving contract', () => {
    const cases: Partial<CaRecordRow>[] = [
      { valueKind: 'modification_change' },
      { status: 'superseded' },
      { status: 'identity_review', additive: true },
      { amountLei: '1.234' },
      { awardDay: '24-01-02' },
      { flags: ['secret'] },
      { winnerCount: 2 },
    ];
    for (const patch of cases)
      expect(toCaRecord(row(patch), null, [winner({})]).isErr(), JSON.stringify(patch)).toBe(true);
  });

  it('withholds a title the free-text rule hits', () => {
    expect(
      toCaRecord(row({ title: 'Contact ion@example.ro' }), null, [winner({})])._unsafeUnwrap().title
    ).toBeNull();
  });
});

describe('record ids and windows', () => {
  it('parses only the record id shape', () => {
    expect(parseCaRecordId('seap:ca:1001:7')).toEqual({
      sourceName: 'seap',
      matchId: 'ca:1001:7',
      publicationId: '1001',
      contractId: '7',
    });
    for (const id of [
      'seap:1001:7',
      'seap:ca:1001',
      'seap:ca:1:2:3',
      'Seap:ca:1:2',
      "seap:ca:1' --:2",
    ])
      expect(parseCaRecordId(id)).toBeNull();
  });

  it('raises the window to the floor and checks its days', () => {
    expect(validateCaWindow(undefined, undefined)._unsafeUnwrap()).toEqual({
      from: CA_FLOOR_DAY,
      to: null,
    });
    expect(validateCaWindow('2019-01-01', '2022-12-31')._unsafeUnwrap()).toEqual({
      from: CA_FLOOR_DAY,
      to: '2022-12-31',
    });
    expect(validateCaWindow('2023-02-30', null).isErr()).toBe(true);
    expect(validateCaWindow('2024-01-02', '2024-01-01').isErr()).toBe(true);
  });
});

describe('identifiers a record may not serve', () => {
  it('serves no buyer whose code lacks an organization code’s shape', () => {
    const record = toCaRecord(row({ buyerCode: '1960101123456' }), null, [
      winner({}),
    ])._unsafeUnwrap();
    expect(record.buyer).toBeNull();
    expect(JSON.stringify(record)).not.toContain('1960101123456');
  });

  it('serves a notice number and a procedure id only in the portal’s formats', () => {
    const served = toCaRecord(row({ noticeNo: 'CAN1234567', procedureId: '123456789' }), null, [
      winner({}),
    ])._unsafeUnwrap();
    expect([served.noticeNo, served.procedureId]).toEqual(['CAN1234567', '123456789']);
    // A digits-only notice number is a portal format too.
    expect(
      toCaRecord(row({ noticeNo: '1234567' }), null, [winner({})])._unsafeUnwrap().noticeNo
    ).toBe('1234567');
    for (const [noticeNo, procedureId] of [
      ['ION POPESCU', '196.01.01.12345'],
      ['can1234567', ''],
      ['12345678901', '1234567890A'],
      ['CAN 1234567', '1960101 123456'],
      ['CAN12345678901', '12345678901'],
    ] as const) {
      const record = toCaRecord(row({ noticeNo, procedureId }), null, [winner({})])._unsafeUnwrap();
      expect([record.noticeNo, record.procedureId]).toEqual([null, null]);
    }
  });

  it('withholds a notice number or procedure id with a personal-code run', () => {
    const record = toCaRecord(
      row({ noticeNo: 'CAN 1960101123456', procedureId: '19601011234567' }),
      null,
      [winner({})]
    )._unsafeUnwrap();
    expect(record.noticeNo).toBeNull();
    expect(record.procedureId).toBeNull();
  });

  it('serves a winner code without an organization code’s shape as unidentified', () => {
    expect(toCaWinner(winner({ fiscalCode: '1960101123456' }))).toMatchObject({
      displayKind: 'unidentified',
      fiscalCode: null,
      name: null,
    });
  });

  it('refuses a year PostgreSQL cannot hold', () => {
    expect(validateCaWindow(null, '0000-01-01').isErr()).toBe(true);
    // Any other early year is clamped to the floor.
    expect(validateCaWindow('1899-12-31', null)._unsafeUnwrap().from).toBe(CA_FLOOR_DAY);
  });
});

describe('the keys and counts statements (reader rule 1)', () => {
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const COMPUTED = [
    'winner_count',
    'lot_count',
    'flags',
    'buyer_person',
    'buyer_name_masked',
    'change_lei',
    'change_publication_day',
    'record_id',
  ];

  it('name no computed column, for every sort', () => {
    const statements = [
      ...(['awardDayDesc', 'awardDayAsc', 'amountDesc'] as const).map((sort) =>
        buyerKeysSql({
          buyerCode: '4267117',
          window: { from: '2021-01-01', to: '2024-12-31' },
          sort,
          offset: 0,
          limit: 20,
        })
      ),
      buyerCountsSql('4267117', { from: '2021-01-01', to: null }),
    ];
    for (const statement of statements) {
      const text = statement.compile(db).sql;
      for (const column of COMPUTED) expect(text).not.toMatch(new RegExp(`\\b${column}\\b`, 'u'));
      expect(text).not.toMatch(/\bin\s*\(\s*select/iu);
    }
  });

  it('name only plain columns (an allowlist)', () => {
    const PLAIN = new Set([
      'source_name',
      'match_id',
      'buyer_code',
      'award_day',
      'amount_lei',
      'status',
    ]);
    const statements = [
      ...(['awardDayDesc', 'awardDayAsc', 'amountDesc'] as const).map((sort) =>
        buyerKeysSql({
          buyerCode: '4267117',
          window: { from: '2021-01-01', to: null },
          sort,
          offset: 0,
          limit: 20,
        })
      ),
      buyerCountsSql('4267117', { from: '2021-01-01', to: '2024-12-31' }),
    ];
    for (const statement of statements) {
      const columns = [...statement.compile(db).sql.matchAll(/\br\.([a-z_]+)/gu)].map((m) => m[1]);
      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) expect(PLAIN.has(column ?? ''), column).toBe(true);
    }
  });

  it('reads rows by source and match_id = any', () => {
    const text = recordRowsSql('seap', ['ca:1:1']).compile(db).sql;
    expect(text).toMatch(/r\.source_name = \$1 and r\.match_id = any\(\$2::text\[\]\)/u);
    expect(text).not.toMatch(/\*/u);
  });
});
