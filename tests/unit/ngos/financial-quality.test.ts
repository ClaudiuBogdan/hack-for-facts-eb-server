import { describe, expect, it } from 'vitest';

import {
  assessNgoFinancialQuality,
  mapFinancialIndicators,
} from '@/modules/ngos/core/financials.js';
import { mapFinancialStatement } from '@/modules/ngos/shell/repo/organization-repo.js';

const dictionary = (year: number) =>
  Array.from({ length: 46 }, (_, index) => ({
    code: `I${String(index + 1)}`,
    name:
      index === 0
        ? year >= 2024
          ? 'Active imobilizate  -  total'
          : 'A. Active imobilizate  -  total'
        : index === 37
          ? `Venituri totale - la 31.12.${String(year >= 2024 ? 2024 : year >= 2020 ? 2020 : year)}`
          : `Label ${String(index + 1)}`,
  }));
const assess = (values: Record<string, string>, year = 2019) =>
  assessNgoFinancialQuality(year, mapFinancialIndicators(dictionary(year), values)._unsafeUnwrap());

describe('NGO financial review signals', () => {
  it('flags both signals in the published 2019 statement without changing any source value', () => {
    const values = { I1: '6226050000', I14: '6226050000', I38: '6226050000' };
    const result = mapFinancialStatement({
      fiscal_year: 2019,
      source_row_number: 48121,
      source_url: 'https://data.gov.ro/web_ong_an2019.txt',
      dictionary_url: 'https://data.gov.ro/web_ong_an2019.csv',
      captured_at: '2026-09-28T00:00:00Z',
      indicator_definitions: dictionary(2019),
      indicators: values,
    })._unsafeUnwrap();
    expect(result.quality).toEqual({
      ruleVersion: 'ngo-revenue-v1',
      assessment: 'assessed',
      suspected: true,
      reasons: [
        { code: 'IMPLAUSIBLE_REVENUE', detail: 'I38 = 6226050000 lei > 1000000000 lei' },
        { code: 'REVENUE_EQUALS_FIXED_ASSETS', detail: 'I38 = I1 = 6226050000 lei' },
      ],
    });
    for (const [code, value] of Object.entries(values))
      expect(result.indicators.find((indicator) => indicator.code === code)?.value).toBe(value);
  });

  it('uses a strict threshold and keeps positive equality as a separate review signal', () => {
    expect(assess({ I38: '1000000000', I1: '1' }).reasons).toEqual([]);
    expect(assess({ I38: '1000000001', I1: '1' }).reasons.map(({ code }) => code)).toEqual([
      'IMPLAUSIBLE_REVENUE',
    ]);
    expect(assess({ I38: '1000000001' }).reasons.map(({ code }) => code)).toEqual([
      'IMPLAUSIBLE_REVENUE',
    ]);
    expect(assess({ I38: '750', I1: '750' }).reasons.map(({ code }) => code)).toEqual([
      'REVENUE_EQUALS_FIXED_ASSETS',
    ]);
  });

  it('compares exact integers beyond Number precision and does not canonicalize the published strings', () => {
    const indicators = mapFinancialIndicators(dictionary(2019), {
      I38: '0009007199254740993',
      I1: '9007199254740992',
    })._unsafeUnwrap();
    expect(assessNgoFinancialQuality(2019, indicators).reasons.map(({ code }) => code)).toEqual([
      'IMPLAUSIBLE_REVENUE',
    ]);
    expect(indicators.find(({ code }) => code === 'I38')?.value).toBe('0009007199254740993');
    expect(assess({ I38: '000750', I1: '750' }).reasons.map(({ code }) => code)).toEqual([
      'REVENUE_EQUALS_FIXED_ASSETS',
    ]);
  });

  it.each([
    { I38: '0', I1: '0' },
    { I38: '-0', I1: '0' },
    { I38: '-500', I1: '-500' },
    { I38: '500' },
    { I1: '500' },
    {},
  ])(
    'never interprets zeros, negative values or missing cells as positive equality: %j',
    (values) => {
      expect(assess(values).suspected).toBe(false);
      expect(assess(values).reasons).toEqual([]);
    }
  );

  it.each([2008, 2016, 2019, 2020, 2021, 2023, 2024, 2025])(
    'qualifies the audited dictionary of FY%i including reused label dates',
    (year) => {
      expect(assess({ I1: '1', I38: '1' }, year).assessment).toBe('assessed');
    }
  );

  it('marks future years and changed dictionary meanings unsupported, never clean', () => {
    for (const year of [2007, 2026])
      expect(assess({ I1: '6226050000', I38: '6226050000' }, year)).toMatchObject({
        assessment: 'unsupported',
        suspected: null,
        reasons: [],
      });
    for (const code of ['I1', 'I38']) {
      const indicators = mapFinancialIndicators(
        dictionary(2019).map((d) => (d.code === code ? { ...d, name: 'Different meaning' } : d)),
        { I1: '6226050000', I38: '6226050000' }
      )._unsafeUnwrap();
      expect(assessNgoFinancialQuality(2019, indicators)).toMatchObject({
        assessment: 'unsupported',
        suspected: null,
        reasons: [],
      });
    }
  });
});
