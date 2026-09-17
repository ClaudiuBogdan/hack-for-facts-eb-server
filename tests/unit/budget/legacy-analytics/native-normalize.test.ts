import { describe, expect, it } from 'vitest';

import { legacyDecimal } from '../../../../src/modules/budget/core/legacy-analytics/decimal.js';
import {
  normalizeNativePoints as normalizeNativeResult,
  selectedPeriodLabels,
} from '../../../../src/modules/budget/core/legacy-analytics/native-normalize.js';

import type { NormalizationPlan } from '../../../../src/modules/budget/core/legacy-analytics/types.js';

const normalizeNativePoints = (...args: Parameters<typeof normalizeNativeResult>) =>
  normalizeNativeResult(...args)._unsafeUnwrap();
const plan: NormalizationPlan = {
  mode: 'total',
  currency: 'RON',
  inflationAdjusted: false,
  showPeriodGrowth: false,
};
const annual = (values: Record<number, string>) =>
  new Map(Object.entries(values).map(([year, value]) => [Number(year), legacyDecimal(value)]));
const selected = [2022, 2023, 2024].map((year) => ({ x: String(year), year }));
const points = selected.map((p) => ({ ...p, y: legacyDecimal(300) }));

describe('native exact-year series', () => {
  it('uses each annual denominator and keeps an interior gap instead of a partial total', () => {
    const result = normalizeNativePoints(
      points,
      { ...plan, mode: 'per_capita' },
      {},
      'YEAR',
      selected,
      annual({ 2022: '100', 2024: '200' })
    );
    expect(result.points.map((p) => [p.x, p.y.toString()])).toEqual([
      ['2022', '3'],
      ['2024', '1.5'],
    ]);
    expect(result.missingPeriods).toEqual(['2023']);
  });
  it('records unavailable selected coverage even without nominal facts', () => {
    expect(
      normalizeNativePoints([], { ...plan, mode: 'per_capita' }, {}, 'YEAR', selected, new Map())
        .missingPeriods
    ).toEqual(['2022', '2023', '2024']);
  });
  it('keeps genuine zero and negative values', () => {
    const result = normalizeNativePoints(
      [
        { x: '2022', year: 2022, y: legacyDecimal(0) },
        { x: '2024', year: 2024, y: legacyDecimal(-2) },
      ],
      plan,
      {},
      'YEAR',
      selected
    );
    expect(result.points.map((p) => p.y.toString())).toEqual(['0', '-2']);
    expect(result.missingPeriods).toEqual([]);
  });
  it('uses real base-year FX and never carries currency or CPI coverage forward', () => {
    const result = normalizeNativePoints(
      points,
      { ...plan, currency: 'EUR', inflationAdjusted: true },
      { cpiIndex: annual({ 2022: '100', 2023: '120' }), fxRate: annual({ 2022: '4', 2023: '5' }) },
      'YEAR',
      selected
    );
    expect(result.points.map((p) => p.y.toString())).toEqual(['72', '60']);
    expect(result.missingPeriods).toEqual(['2024']);
    expect(result.cpiBaseYear).toBe(2023);
  });
  it('keeps GDP exclusive and reports its missing year', () => {
    const result = normalizeNativePoints(
      points,
      { ...plan, mode: 'percent_gdp', currency: 'EUR', inflationAdjusted: true },
      { gdp: annual({ 2022: '1000', 2024: '2000' }) },
      'YEAR',
      selected
    );
    expect(result.points.map((p) => p.y.toString())).toEqual(['30', '15']);
    expect(result.missingPeriods).toEqual(['2023']);
    expect(result.cpiBaseYear).toBeNull();
  });
  it('does not compute growth across gaps or a zero predecessor', () => {
    const growth = { ...plan, mode: 'per_capita' as const, showPeriodGrowth: true };
    const result = normalizeNativePoints(
      points,
      growth,
      {},
      'YEAR',
      selected,
      annual({ 2022: '100', 2024: '200' })
    );
    expect(result.points).toEqual([]);
    expect(result.missingPeriods).toEqual(['2022', '2023', '2024']);
    const zero = normalizeNativePoints(
      [{ ...points[0]!, y: legacyDecimal(0) }, points[1]!],
      { ...plan, showPeriodGrowth: true },
      {},
      'YEAR',
      selected.slice(0, 2)
    );
    expect(zero.points).toEqual([]);
    expect(zero.missingPeriods).toEqual(['2022', '2023']);
  });
  it('computes growth from the exact normalized predecessor, retaining zero growth', () => {
    const result = normalizeNativePoints(
      points,
      { ...plan, mode: 'per_capita', showPeriodGrowth: true },
      {},
      'YEAR',
      selected,
      annual({ 2022: '100', 2023: '200', 2024: '200' })
    );
    expect(result.points.map((p) => [p.x, p.y.toString()])).toEqual([
      ['2023', '-50'],
      ['2024', '0'],
    ]);
    expect(result.missingPeriods).toEqual(['2022']);
  });
  it('intersects sparse dates with month bounds and does not invent intermediate labels', () => {
    const labels = selectedPeriodLabels(
      {
        years: { from: 2023, to: 2024 },
        tupleRange: { start: { year: 2023, sub: 11 }, end: { year: 2024, sub: 2 } },
        tupleList: [
          { year: 2023, sub: 10 },
          { year: 2023, sub: 12 },
          { year: 2024, sub: 2 },
          { year: 2024, sub: 3 },
        ],
      },
      'MONTH'
    );
    expect(labels.map((p) => p.x)).toEqual(['2023-12', '2024-02']);
  });
  it('broadcasts annual coverage to selected quarter labels only', () => {
    const labels = selectedPeriodLabels(
      {
        years: { in: [2023] },
        tupleList: [
          { year: 2023, sub: 2 },
          { year: 2023, sub: 4 },
        ],
      },
      'QUARTER'
    );
    const result = normalizeNativePoints(
      [],
      { ...plan, currency: 'EUR' },
      { fxRate: new Map() },
      'QUARTER',
      labels
    );
    expect(result.missingPeriods).toEqual(['2023-Q2', '2023-Q4']);
  });
});

it('rejects missing required kinds and present invalid factors instead of making coverage gaps', () => {
  expect(
    normalizeNativeResult(points, { ...plan, currency: 'EUR' }, {}, 'YEAR', selected).isErr()
  ).toBe(true);
  for (const invalid of ['0', '-1', 'NaN', 'Infinity']) {
    expect(
      normalizeNativeResult(
        points,
        { ...plan, currency: 'EUR' },
        { fxRate: annual({ 2022: invalid }) },
        'YEAR',
        selected
      ).isErr()
    ).toBe(true);
    expect(
      normalizeNativeResult(
        points,
        { ...plan, inflationAdjusted: true, currency: 'EUR' },
        { cpiIndex: annual({ 2022: '100', 2024: '120' }), fxRate: annual({ 2024: invalid }) },
        'YEAR',
        selected
      ).isErr()
    ).toBe(true);
  }
  expect(
    normalizeNativeResult(
      points,
      { ...plan, inflationAdjusted: true },
      { cpiIndex: new Map() },
      'YEAR',
      selected
    ).isErr()
  ).toBe(true);
});

it('preserves sparse year/date intersections across the full supported year range', () => {
  const tupleList = Array.from({ length: 10000 }, (_, year) => ({ year, sub: (year % 12) + 1 }));
  const labels = selectedPeriodLabels(
    {
      years: { from: 0, to: 9999 },
      yearList: [9999, 0, 2024, 2024],
      tupleList,
      tupleRange: { start: { year: 1, sub: 1 }, end: { year: 9999, sub: 12 } },
    },
    'MONTH'
  );
  expect(labels).toEqual([
    { x: '2024-09', year: 2024 },
    { x: '9999-04', year: 9999 },
  ]);
});
