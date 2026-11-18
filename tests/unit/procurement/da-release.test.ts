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

const served = (record: DaPurchaseRecord, kindColumn = true) =>
  toPurchase(record, kindColumn)._unsafeUnwrap();

describe('D6 supplier rule', () => {
  it('names only a company with a valid code once supplier_kind exists', () => {
    expect(isNamedSupplier(COMPANY, true)).toBe(true);
    for (const party of [SOLE_TRADER, NATURAL_PERSON, UNVERIFIED, BAD_CODE_SUPPLIER])
      expect(isNamedSupplier(party, true)).toBe(false);
    // A null kind with the column present is withheld, even with a valid code.
    expect(isNamedSupplier({ ...COMPANY, supplierKind: null }, true)).toBe(false);
    // "company" with a code that is not valid is withheld.
    expect(isNamedSupplier({ ...COMPANY, fiscalCodeStatus: 'checksum_failed' }, true)).toBe(false);
    expect(isNamedSupplier({ ...COMPANY, fiscalCode: null }, true)).toBe(false);
  });

  it('falls back to a valid fiscal code before supplier_kind exists', () => {
    const noKind = { supplierKind: null };
    expect(isNamedSupplier({ ...COMPANY, ...noKind }, false)).toBe(true);
    expect(isNamedSupplier({ ...SOLE_TRADER, ...noKind }, false)).toBe(true);
    expect(isNamedSupplier({ ...NATURAL_PERSON, ...noKind }, false)).toBe(false);
    expect(isNamedSupplier({ ...BAD_CODE_SUPPLIER, ...noKind }, false)).toBe(false);
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
    const result = toPurchase({ ...row(1), ...change }, true);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('Database');
  });

  it('refuses a corrected value on a purchase that is not counted', () => {
    const result = toPurchase({ ...row(3), valueCorrected: true }, true);
    expect(result.isErr()).toBe(true);
  });
});

describe('items and totals', () => {
  it('computes the reported line value exactly and never rounds it', () => {
    const items = (ITEMS[row(2).purchaseId] ?? []).map((item) => toItem(item)._unsafeUnwrap());
    expect(items.map((item) => item.reportedLineValue)).toEqual(['3150000', '2736']);
    expect(
      toItem({
        ...(ITEMS[row(2).purchaseId] ?? [])[0]!,
        quantity: '0.1',
        unitPrice: '0.2',
      })._unsafeUnwrap().reportedLineValue
    ).toBe('0.02');
    expect(
      toItem({ ...(ITEMS[row(2).purchaseId] ?? [])[0]!, quantity: null })._unsafeUnwrap()
        .reportedLineValue
    ).toBeNull();
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
      'supplier',
      true
    )._unsafeUnwrap();
    expect(group.party).toEqual({
      displayKind: 'natural_person',
      partyId: null,
      name: null,
      fiscalCode: null,
    });
    expect(group.key).toBeNull();
    const none = toTotalsGroup(
      { ...measures, key: null, supplierBucket: 'none', party: null },
      'supplier',
      true
    )._unsafeUnwrap();
    expect(none).toMatchObject({ noSupplier: true, party: null });
  });
});
