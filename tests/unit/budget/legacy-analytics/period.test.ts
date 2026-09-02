/**
 * Period plan — the legacy `buildPeriodConditions` semantics plus the
 * bounded-years gate (the ONE delta: an empty/unparseable selection is
 * `InvalidInput`, not a scan of every year).
 */

import { describe, expect, it } from 'vitest';

import {
  formatPeriodLabel,
  parsePeriodDate,
  planPeriod,
  previousPeriodLabel,
} from '../../../../src/modules/budget/core/legacy-analytics/period.js';

describe('parsePeriodDate / labels', () => {
  it('parses the three legacy formats and rejects the rest', () => {
    expect(parsePeriodDate('2024')).toEqual({ year: 2024 });
    expect(parsePeriodDate('2024-03')).toEqual({ year: 2024, month: 3 });
    expect(parsePeriodDate('2024-Q2')).toEqual({ year: 2024, quarter: 2 });
    expect(parsePeriodDate('2024-13')).toBeNull();
    expect(parsePeriodDate('2024-Q5')).toBeNull();
    expect(parsePeriodDate('24')).toBeNull();
  });

  it('formats sparse labels YYYY / YYYY-QN / YYYY-MM', () => {
    expect(formatPeriodLabel(2024, 2024, 'YEAR')).toBe('2024');
    expect(formatPeriodLabel(2024, 3, 'QUARTER')).toBe('2024-Q3');
    expect(formatPeriodLabel(2024, 7, 'MONTH')).toBe('2024-07');
  });

  it('computes the previous label across year boundaries', () => {
    expect(previousPeriodLabel('2024', 'YEAR')).toBe('2023');
    expect(previousPeriodLabel('2024-Q1', 'QUARTER')).toBe('2023-Q4');
    expect(previousPeriodLabel('2024-Q3', 'QUARTER')).toBe('2024-Q2');
    expect(previousPeriodLabel('2024-01', 'MONTH')).toBe('2023-12');
    expect(previousPeriodLabel('2024-10', 'MONTH')).toBe('2024-09');
    expect(previousPeriodLabel('garbage', 'MONTH')).toBeNull();
  });
});

describe('planPeriod', () => {
  it('YEAR interval → bounded year range (the pruning predicate)', () => {
    const plan = planPeriod({ interval: { start: '2020', end: '2023' } }, 'YEAR')._unsafeUnwrap();
    expect(plan).toEqual({ years: { from: 2020, to: 2023 } });
  });

  it('MONTH interval with month bounds → tuple range', () => {
    const plan = planPeriod(
      { interval: { start: '2022-11', end: '2023-02' } },
      'MONTH'
    )._unsafeUnwrap();
    expect(plan.years).toEqual({ from: 2022, to: 2023 });
    expect(plan.tupleRange).toEqual({
      start: { year: 2022, sub: 11 },
      end: { year: 2023, sub: 2 },
    });
  });

  it('QUARTER interval with year-only bounds falls back to the year range (legacy)', () => {
    const plan = planPeriod(
      { interval: { start: '2021', end: '2022' } },
      'QUARTER'
    )._unsafeUnwrap();
    expect(plan).toEqual({ years: { from: 2021, to: 2022 } });
  });

  it('MONTH dates → tuple list, invalid entries dropped (legacy)', () => {
    const plan = planPeriod({ dates: ['2023-01', 'nope', '2023-03'] }, 'MONTH')._unsafeUnwrap();
    expect(plan.tupleList).toEqual([
      { year: 2023, sub: 1 },
      { year: 2023, sub: 3 },
    ]);
    expect(plan.years).toEqual({ in: [2023] });
  });

  it('YEAR dates → the deduplicated year list IS the pruning predicate', () => {
    const plan = planPeriod({ dates: ['2021', '2023', '2021'] }, 'YEAR')._unsafeUnwrap();
    expect(plan).toEqual({ years: { in: [2021, 2023] } });
  });

  it('interval AND dates are both carried (legacy applied both)', () => {
    const plan = planPeriod(
      { interval: { start: '2022-Q1', end: '2022-Q4' }, dates: ['2022-Q2'] },
      'QUARTER'
    )._unsafeUnwrap();
    expect(plan.tupleRange).toBeDefined();
    expect(plan.tupleList).toEqual([{ year: 2022, sub: 2 }]);
    const yearly = planPeriod(
      { interval: { start: '2020', end: '2023' }, dates: ['2021'] },
      'YEAR'
    )._unsafeUnwrap();
    expect(yearly).toEqual({ years: { from: 2020, to: 2023 }, yearList: [2021] });
  });

  it('DELTA: empty / unparseable selections are InvalidInput (legacy scanned every year)', () => {
    expect(planPeriod({}, 'YEAR')._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(planPeriod({ dates: [] }, 'YEAR')._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(planPeriod({ dates: ['x'] }, 'MONTH')._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect(
      planPeriod({ interval: { start: 'abc', end: '2023' } }, 'YEAR')._unsafeUnwrapErr().type
    ).toBe('InvalidInput');
  });
});
