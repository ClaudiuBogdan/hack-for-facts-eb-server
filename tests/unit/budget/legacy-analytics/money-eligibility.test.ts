/**
 * The one money-eligibility rule both normalization paths apply (review B/F18):
 * every message, the base-year choice and the input order of `eligible`.
 */
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { eligibleMoneyYears } from '@/modules/budget/core/legacy-analytics/money-eligibility.js';

import type { NormalizationContext } from '@/modules/budget/core/legacy-analytics/normalize.js';

const series = (entries: readonly (readonly [number, string])[]): ReadonlyMap<number, Decimal> =>
  new Map(entries.map(([year, value]) => [year, new Decimal(value)]));

const cpi = series([
  [2023, '100'],
  [2024, '110'],
]);
const fx = series([
  [2023, '4.9'],
  [2024, '4.97'],
]);
const gdp = series([[2024, '1000']]);
const nominal = { mode: 'total', currency: 'RON', inflationAdjusted: false } as const;

describe('eligibleMoneyYears', () => {
  it('keeps every year, in input order, when no factor is needed', () => {
    const result = eligibleMoneyYears(nominal, {}, [2024, 2022, 2023])._unsafeUnwrap();
    expect(result).toEqual({ eligible: [2024, 2022, 2023], baseYear: undefined });
  });

  it('refuses a missing factor series with the shared message', () => {
    expect(
      eligibleMoneyYears({ ...nominal, currency: 'EUR' }, {}, [2024])._unsafeUnwrapErr().message
    ).toBe('Missing monetary factor kind');
    expect(
      eligibleMoneyYears({ ...nominal, mode: 'percent_gdp' }, {}, [2024])._unsafeUnwrapErr().message
    ).toBe('Missing monetary factor kind');
  });

  it.each([
    ['non-finite', series([[2024, 'Infinity']])],
    ['zero', series([[2024, '0']])],
    ['negative', series([[2024, '-1']])],
  ])('refuses a %s factor value', (_label, bad) => {
    expect(
      eligibleMoneyYears(
        { ...nominal, currency: 'EUR' },
        { fxRate: bad },
        [2024]
      )._unsafeUnwrapErr().message
    ).toBe('Invalid monetary factor value');
  });

  it('needs a CPI base year for real terms, but not for percent of GDP', () => {
    const real = { ...nominal, inflationAdjusted: true };
    expect(
      eligibleMoneyYears(real, { cpiIndex: new Map() }, [2024])._unsafeUnwrapErr().message
    ).toBe('CPI base year is unavailable');
    expect(
      eligibleMoneyYears(
        { ...real, mode: 'percent_gdp' },
        { gdp, cpiIndex: new Map() },
        [2024, 2023]
      )._unsafeUnwrap()
    ).toEqual({ eligible: [2024], baseYear: undefined });
  });

  it('takes the latest CPI year as the base and rates EUR at that base year', () => {
    const context: NormalizationContext = { cpiIndex: cpi, fxRate: series([[2024, '4.97']]) };
    const real = { mode: 'total', currency: 'EUR', inflationAdjusted: true } as const;
    // 2022 has no CPI; 2023 and 2024 rate at the base year 2024, which fx covers.
    expect(eligibleMoneyYears(real, context, [2023, 2022, 2024])._unsafeUnwrap()).toEqual({
      eligible: [2023, 2024],
      baseYear: 2024,
    });
  });

  it('rates nominal EUR at each year, so a year without a rate drops out', () => {
    const context: NormalizationContext = { fxRate: fx };
    expect(
      eligibleMoneyYears(
        { ...nominal, currency: 'EUR' },
        context,
        [2022, 2024, 2023]
      )._unsafeUnwrap()
    ).toEqual({ eligible: [2024, 2023], baseYear: undefined });
  });
});
