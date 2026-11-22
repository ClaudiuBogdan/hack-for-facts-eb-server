/**
 * Direct acquisitions release 1 — the core: D6, value fields, invariants,
 * item line values and totals, on the serving contract's example rows.
 */
import { describe, expect, it } from 'vitest';

import {
  DA_NOT_COUNTED_REASONS,
  DA_NOT_COUNTED_REASON_LABELS,
  isNamedSupplier,
  toItem,
  toPurchase,
  toTotals,
  toTotalsGroup,
  type DaPurchaseRecord,
} from '@/modules/procurement/core/da-release.js';

import {
  BAD_CODE_SUPPLIER,
  BUYER,
  BUYER_BAD_CODE,
  COMPANY,
  ITEMS,
  NATURAL_PERSON,
  PURCHASES,
  SOLE_TRADER,
  UNVERIFIED,
} from '../../fixtures/procurement/da-release.js';

const row = (n: number): DaPurchaseRecord => {
  const found = PURCHASES[n - 1];
  if (found === undefined) throw new Error(`no fixture row ${String(n)}`);
  return found;
};

const served = (record: DaPurchaseRecord) => toPurchase(record)._unsafeUnwrap();

describe('D6 supplier rule', () => {
  it('names a supplier only when its code is disclosed', () => {
    expect(isNamedSupplier(COMPANY)).toBe(true);
    for (const party of [SOLE_TRADER, NATURAL_PERSON, UNVERIFIED, BAD_CODE_SUPPLIER])
      expect(isNamedSupplier(party)).toBe(false);
    // Not public (absent from supplier_privacy, or the table is absent): withheld.
    expect(isNamedSupplier({ ...COMPANY, supplierPublic: false })).toBe(false);
    // Defensive: a public code that is missing or not valid is still withheld.
    expect(isNamedSupplier({ ...COMPANY, fiscalCodeStatus: 'checksum_failed' })).toBe(false);
    expect(isNamedSupplier({ ...COMPANY, fiscalCode: null })).toBe(false);
  });

  it('serves a withheld supplier as natural_person with no name, code or id', () => {
    for (const n of [6, 9, 10, 11, 12]) {
      expect(served(row(n)).supplier).toEqual({
        displayKind: 'natural_person',
        partyId: null,
        name: null,
        fiscalCode: null,
      });
    }
    expect(served(row(1)).supplier).toEqual({
      displayKind: 'company',
      partyId: COMPANY.portalPartyId,
      name: COMPANY.name,
      fiscalCode: COMPANY.fiscalCode,
    });
    expect(served(row(13)).supplier).toBeNull();
  });

  it('serves buyers as authorities: name always, code only when valid', () => {
    expect(served(row(1)).buyer).toEqual({
      displayKind: 'authority',
      partyId: BUYER.portalPartyId,
      name: BUYER.name,
      fiscalCode: BUYER.fiscalCode,
    });
    expect(served(row(4)).buyer).toEqual({
      displayKind: 'authority',
      partyId: BUYER_BAD_CODE.portalPartyId,
      name: BUYER_BAD_CODE.name,
      fiscalCode: null,
    });
  });
});

describe('value fields per contract case', () => {
  it('counted as reported', () => {
    const p = served(row(1));
    expect(p).toMatchObject({
      reportedValue: '12500.00',
      counted: true,
      countedValue: '12500.00',
      notCountedReason: null,
      valueCorrected: false,
      correctedValue: null,
      reviewRule: null,
      cpvDivision: '44',
    });
  });

  it('corrected: both values, the rule and its sentence', () => {
    const p = served(row(2));
    expect(p.reportedValue).toBe('3150000.00');
    expect(p.countedValue).toBe('3150.00');
    expect(p.correctedValue).toBe('3150.00');
    expect(p.valueCorrected).toBe(true);
    expect(p.reviewRule?.rule).toBe('quantity_unit_mix');
    expect(p.reviewRule?.effect).toBe('correct');
    expect(p.reviewRule?.descriptionEn).toMatch(/wrong unit or quantity scale/u);
  });

  it('excluded by review: reason with labels, rule with sentence, no counted value', () => {
    const p = served(row(3));
    expect(p.counted).toBe(false);
    expect(p.countedValue).toBeNull();
    expect(p.notCountedReason).toEqual({
      code: 'reviewed_entry_error',
      labelEn: 'Left out after review: see the rule.',
      labelRo: 'Exclusă după verificare: vezi regula.',
    });
    expect(p.reviewRule?.effect).toBe('exclude');
  });

  it('open case, refused, before 2025, no longer listed and symbolic', () => {
    expect(served(row(5))).toMatchObject({ counted: true, reviewRule: null });
    expect(served(row(6))).toMatchObject({
      outcome: 'refused',
      notCountedReason: { code: 'not_accepted' },
    });
    expect(served(row(7)).notCountedReason?.code).toBe('value_not_qualified');
    expect(served(row(8)).listedNow).toBe(false);
    expect(served(row(9))).toMatchObject({ symbolicPrice: true, countedValue: '0.01' });
  });

  it('labels every reason in both languages', () => {
    for (const reason of DA_NOT_COUNTED_REASONS) {
      expect(DA_NOT_COUNTED_REASON_LABELS[reason].en.length).toBeGreaterThan(0);
      expect(DA_NOT_COUNTED_REASON_LABELS[reason].ro.length).toBeGreaterThan(0);
    }
  });
});

describe('row invariants refuse the row', () => {
  const broken: [string, Partial<DaPurchaseRecord>][] = [
    ['counted without a counted value', { counted: true, countedValue: null }],
    [
      'not counted with a counted value',
      { counted: false, countedValue: '1.00', notCountedReason: 'not_accepted' },
    ],
    ['counted with a reason', { notCountedReason: 'not_accepted' }],
    ['not counted without a reason', { counted: false, countedValue: null }],
    ['an unknown reason', { counted: false, countedValue: null, notCountedReason: 'mystery' }],
    ['an unknown outcome', { outcome: 'cancelled' }],
    ['a corrected value without a rule', { valueCorrected: true }],
    ['a rule missing from da_value_rules', { valueReviewRule: 'decimal_shift', rule: null }],
    ['a float-looking value', { reportedValue: '1e5' }],
  ];
  it.each(broken)('%s', (_label, change) => {
    const result = toPurchase({ ...row(1), ...change });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('Database');
  });

  it('refuses a corrected value on a purchase that is not counted', () => {
    const result = toPurchase({ ...row(3), valueCorrected: true });
    expect(result.isErr()).toBe(true);
  });
});

describe('items and totals', () => {
  it('passes the SQL line value through unrounded and refuses one that is not decimal text', () => {
    const lines = ITEMS[row(2).purchaseId] ?? [];
    expect(lines.map((item) => toItem(item)._unsafeUnwrap().reportedLineValue)).toEqual([
      '3150000.00',
      '2736.000',
    ]);
    const line = lines[0];
    if (line === undefined) throw new Error('no line');
    const wide = '99999999999999999999.9999';
    expect(toItem({ ...line, reportedLineValue: wide })._unsafeUnwrap().reportedLineValue).toBe(
      wide
    );
    expect(
      toItem({ ...line, reportedLineValue: null })._unsafeUnwrap().reportedLineValue
    ).toBeNull();
    expect(toItem({ ...line, reportedLineValue: '1e21' }).isErr()).toBe(true);
  });

  it('keeps a null counted value only when nothing is counted', () => {
    expect(
      toTotals({
        countedValue: null,
        countedCount: '0',
        symbolicPriceCount: '0',
        purchaseCount: '4',
      }).isOk()
    ).toBe(true);
    expect(
      toTotals({
        countedValue: null,
        countedCount: '2',
        symbolicPriceCount: '0',
        purchaseCount: '4',
      }).isErr()
    ).toBe(true);
    expect(
      toTotals({
        countedValue: '1.5',
        countedCount: 'x',
        symbolicPriceCount: '0',
        purchaseCount: '4',
      }).isErr()
    ).toBe(true);
  });

  it('re-applies D6 to a supplier group the reader marked as named', () => {
    const measures = {
      countedValue: '450.00',
      countedCount: '1',
      symbolicPriceCount: '0',
      purchaseCount: '1',
    };
    const group = toTotalsGroup(
      { ...measures, key: null, supplierBucket: 'named', party: SOLE_TRADER },
      'supplier'
    )._unsafeUnwrap();
    expect(group.party).toEqual({
      displayKind: 'natural_person',
      partyId: null,
      name: null,
      fiscalCode: null,
    });
    expect(group.key).toBe('natural_person');
    const none = toTotalsGroup(
      { ...measures, key: null, supplierBucket: 'none', party: null },
      'supplier'
    )._unsafeUnwrap();
    expect(none).toMatchObject({ noSupplier: true, party: null });
  });
});
