import { describe, expect, it } from 'vitest';

import { mapFinancialIndicators } from '@/modules/ngos/core/financials.js';
import { mapFinancialStatement } from '@/modules/ngos/shell/repo/organization-repo.js';

/** Exact loader shape: ordered {code, name, normalizedName} for I1..I46. */
const dictionary = (label: (n: number) => string) =>
  Array.from({ length: 46 }, (_, index) => ({
    code: `I${String(index + 1)}`,
    name: label(index + 1),
    normalizedName: `normalized_${String(index + 1)}`,
  }));
const LABELS = dictionary((n) => `Label ${String(n)}`);

describe('MFP NGO statement indicators', () => {
  it('keeps exact integer strings, blanks as null and zero as a reported value', () => {
    const values = {
      I1: '0',
      I2: '-0',
      I3: '007',
      I4: '-123',
      I5: '123456789012345678901',
    };
    const result = mapFinancialIndicators(LABELS, values);
    expect(result.isOk()).toBe(true);
    const indicators = result._unsafeUnwrap();
    expect(indicators).toHaveLength(46);
    expect(indicators.slice(0, 6)).toEqual([
      { code: 'I1', label: 'Label 1', value: '0' },
      { code: 'I2', label: 'Label 2', value: '-0' },
      { code: 'I3', label: 'Label 3', value: '007' },
      { code: 'I4', label: 'Label 4', value: '-123' },
      { code: 'I5', label: 'Label 5', value: '123456789012345678901' },
      { code: 'I6', label: 'Label 6', value: null },
    ]);
    expect(indicators.filter((indicator) => indicator.value === null)).toHaveLength(41);
  });

  it('orders by numeric code and uses the verbatim dictionary name, not the normalized one', () => {
    const shuffled = dictionary((n) => `Venituri ${String(n)} (31.12.2024) ă ș ț`).reverse();
    const indicators = mapFinancialIndicators(shuffled, { I10: '5' })._unsafeUnwrap();
    expect(indicators.map((indicator) => indicator.code).slice(0, 11)).toEqual([
      'I1',
      'I2',
      'I3',
      'I4',
      'I5',
      'I6',
      'I7',
      'I8',
      'I9',
      'I10',
      'I11',
    ]);
    expect(indicators[9]).toEqual({
      code: 'I10',
      label: 'Venituri 10 (31.12.2024) ă ș ț',
      value: '5',
    });
  });

  it.each([
    ['plus sign (not in the parser contract)', { I1: '+5' }],
    ['decimal', { I1: '1.5' }],
    ['empty string', { I1: '' }],
    ['lone minus', { I1: '-' }],
    ['numeric JSON value', { I1: 5 }],
    ['code outside the dictionary', { I47: '1' }],
  ])('rejects %s instead of guessing a value', (_label, values) => {
    expect(mapFinancialIndicators(LABELS, values).isErr()).toBe(true);
  });

  it('rejects dictionaries that are not exactly I1..I46', () => {
    const rest = LABELS.slice(1);
    for (const definitions of [
      LABELS.slice(0, 45),
      [...LABELS.slice(0, 45), { code: 'I1', name: 'Duplicate', normalizedName: 'duplicate' }],
      [{ code: 'I0', name: 'Label 0', normalizedName: 'normalized_0' }, ...rest],
      [{ code: 'I1', normalizedName: 'normalized_1' }, ...rest],
    ])
      expect(mapFinancialIndicators(definitions, {}).isErr()).toBe(true);
  });

  it('binds labels and source links to each statement year', () => {
    const row = (year: number, i3: string) => ({
      fiscal_year: year,
      source_row_number: 17,
      source_url: `https://data.gov.ro/situatii_financiare_${String(year)}.csv`,
      dictionary_url: `https://data.gov.ro/dictionar_${String(year)}.csv`,
      captured_at: '2026-09-28 04:26:52.123+00',
      indicator_definitions: dictionary((n) => (n === 3 ? i3 : `Label ${String(n)}`)),
      indicators: { I3: '42' },
    });
    const fy2023 = mapFinancialStatement(row(2023, 'Avansuri'))._unsafeUnwrap();
    const fy2024 = mapFinancialStatement(row(2024, 'Stocuri'))._unsafeUnwrap();
    expect(fy2023.indicators[2]).toEqual({ code: 'I3', label: 'Avansuri', value: '42' });
    expect(fy2024.indicators[2]).toEqual({ code: 'I3', label: 'Stocuri', value: '42' });
    expect(fy2024).toMatchObject({
      fiscalYear: 2024,
      sourceUrl: 'https://data.gov.ro/situatii_financiare_2024.csv',
      dictionaryUrl: 'https://data.gov.ro/dictionar_2024.csv',
      sourceRowNumber: 17,
      capturedAt: '2026-09-28T04:26:52.123Z',
    });
    const invalid = mapFinancialStatement({ ...row(2024, 'Stocuri'), indicators: { I3: 42 } });
    expect(invalid.isErr() && invalid.error.type).toBe('Database');
  });
});
