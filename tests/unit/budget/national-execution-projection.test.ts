import { describe, expect, it } from 'vitest';

import {
  basisInterval,
  classifyCoverage,
  projectExecutionSeries,
  summarizeCoverage,
} from '@/modules/budget/core/national/execution-projection.js';
import { NationalDecimal, toWireDataSeries } from '@/modules/budget/core/national/values.js';

import {
  EXECUTION_EVIDENCE,
  EXECUTION_REASONS,
  VIEW_INTERVALS,
} from '../../fixtures/national-budget/evidence.js';

import type { NationalSeriesViewRow } from '@/modules/budget/core/national/models.js';
import type { ValueBasis } from '@/modules/budget/core/national/vocabulary.js';

const ITEM = 'mfin.bgc.revenue.total';

const row = (
  date: string,
  interval: readonly [string, string],
  reason: string,
  value: string | null,
  valueBasis: ValueBasis | null = value === null ? null : 'REPORTED_CUMULATIVE'
): NationalSeriesViewRow => ({
  itemId: ITEM,
  date,
  periodStart: interval[0],
  periodEnd: interval[1],
  reason,
  value: value === null ? null : new NationalDecimal(value),
  valueBasis,
  endpoint: null,
  predecessor: null,
});

describe('execution coverage', () => {
  it('summarises selected months with explicit missing months and a scope note', () => {
    const coverage = summarizeCoverage(['2025-03', '2025-06', '2025-04'])._unsafeUnwrap();
    expect(coverage).toMatchObject({
      firstMonth: '2025-03',
      lastMonth: '2025-06',
      calendarMonthCount: 4,
      selectedMonthCount: 3,
      missingMonths: ['2025-05'],
    });
    expect(coverage.note).toMatch(/not proof/u);
    expect(summarizeCoverage([]).isErr()).toBe(true);
    expect(summarizeCoverage(['2025-03', '2025-03']).isErr()).toBe(true);
  });

  it('classifies a period by its endpoint month only', () => {
    const coverage = { firstMonth: '2006-02', lastMonth: '2026-07' };
    expect(classifyCoverage('2006-03', coverage)).toBe('INSIDE');
    expect(classifyCoverage('2006-01', coverage)).toBe('before_first_release');
    expect(classifyCoverage('2026-09', coverage)).toBe('after_last_release');
  });
});

describe('value interval of each reviewed grid', () => {
  it('starts YTD and full year on 1 January and differences at their period start', () => {
    const cases = [
      ['MONTH', 'YTD', '2025-06', '2025-01-01', '2025-06-30'],
      ['MONTH', 'PERIOD_DIFFERENCE', '2025-06', '2025-06-01', '2025-06-30'],
      ['QUARTER', 'YTD', '2025-Q2', '2025-01-01', '2025-06-30'],
      ['QUARTER', 'PERIOD_DIFFERENCE', '2025-Q2', '2025-04-01', '2025-06-30'],
      ['YEAR', 'FULL_YEAR', '2025', '2025-01-01', '2025-12-31'],
    ] as const;
    for (const [type, basis, label, start, end] of cases) {
      const interval = basisInterval(type, basis, label);
      expect([interval?.valueStart, interval?.end]).toEqual([start, end]);
    }
  });
});

describe('national execution series projection', () => {
  const coverage = { firstMonth: '2006-02', lastMonth: '2026-07' };

  it('keeps June 2025 monthly unavailable while Q2 and June YTD are available', () => {
    const monthly = projectExecutionSeries(
      ITEM,
      'PERIOD_DIFFERENCE',
      { type: 'MONTH', labels: ['2025-05', '2025-06'] },
      coverage,
      [
        row('2025-05', VIEW_INTERVALS.may2025Month, EXECUTION_REASONS.may2025, null),
        row('2025-06', VIEW_INTERVALS.june2025Month, EXECUTION_REASONS.june2025Month, null),
      ]
    )._unsafeUnwrap();
    expect(monthly.series.data).toEqual([]);
    expect(monthly.periods.map((p) => [p.date, p.status, p.reason, p.periodStart])).toEqual([
      ['2025-05', 'UNAVAILABLE', 'missing_endpoint_release', '2025-05-01'],
      ['2025-06', 'UNAVAILABLE', 'missing_predecessor_release', '2025-06-01'],
    ]);

    const quarterly = projectExecutionSeries(
      ITEM,
      'PERIOD_DIFFERENCE',
      { type: 'QUARTER', labels: ['2025-Q2'] },
      coverage,
      [
        row(
          '2025-Q2',
          VIEW_INTERVALS.q2_2025Difference,
          'available',
          EXECUTION_EVIDENCE.revenueQ2_2025Difference,
          'DERIVED_DIFFERENCE_BETWEEN_REPORTS'
        ),
      ]
    )._unsafeUnwrap();
    expect(toWireDataSeries(quarterly.series).data).toEqual([
      { date: '2025-Q2', value: '169195939317.60994' },
    ]);
    expect(quarterly.periods[0]).toMatchObject({
      status: 'AVAILABLE',
      reason: null,
      valueBasis: 'DERIVED_DIFFERENCE_BETWEEN_REPORTS',
      periodStart: '2025-04-01',
      periodEnd: '2025-06-30',
    });

    const ytd = projectExecutionSeries(
      ITEM,
      'YTD',
      { type: 'MONTH', labels: ['2025-06'] },
      coverage,
      [
        row(
          '2025-06',
          VIEW_INTERVALS.june2025Ytd,
          'available',
          EXECUTION_EVIDENCE.revenueYtdJune2025
        ),
      ]
    )._unsafeUnwrap();
    expect(toWireDataSeries(ytd.series)).toEqual({
      frequency: 'MONTH',
      data: [{ date: '2025-06', value: '310520639938.72993' }],
    });
    expect(ytd.periods[0]).toMatchObject({
      date: '2025-06',
      periodStart: '2025-01-01',
      periodEnd: '2025-06-30',
    });
  });

  it('keeps the YTD value interval on a quarterly display grid', () => {
    const projection = projectExecutionSeries(
      ITEM,
      'YTD',
      { type: 'QUARTER', labels: ['2025-Q2'] },
      coverage,
      [
        row(
          '2025-Q2',
          VIEW_INTERVALS.june2025Ytd,
          'available',
          EXECUTION_EVIDENCE.revenueYtdJune2025
        ),
      ]
    )._unsafeUnwrap();
    expect(projection.series.frequency).toBe('QUARTER');
    expect(projection.periods[0]).toMatchObject({
      date: '2025-Q2',
      periodStart: '2025-01-01',
      periodEnd: '2025-06-30',
    });
  });

  it('refuses a view interval that is not the requested basis interval', () => {
    const asBucket = projectExecutionSeries(
      ITEM,
      'YTD',
      { type: 'MONTH', labels: ['2025-06'] },
      coverage,
      [
        row(
          '2025-06',
          VIEW_INTERVALS.june2025Month,
          'available',
          EXECUTION_EVIDENCE.revenueYtdJune2025
        ),
      ]
    );
    expect(asBucket._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    const invalidDate = projectExecutionSeries(
      ITEM,
      'YTD',
      { type: 'MONTH', labels: ['2025-06'] },
      coverage,
      [row('2025-06', ['2025-01-01', '2025-06-31'], 'available', '1')]
    );
    expect(invalidDate.isErr()).toBe(true);
  });

  it('passes unknown view reasons through verbatim and never surfaces their values', () => {
    const projection = projectExecutionSeries(
      ITEM,
      'YTD',
      { type: 'MONTH', labels: ['2006-07'] },
      coverage,
      [row('2006-07', VIEW_INTERVALS.july2006Ytd, 'some_future_reason', '123')]
    )._unsafeUnwrap();
    expect(projection.series.data).toEqual([]);
    expect(projection.periods[0]).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'some_future_reason',
    });
    const incompatible = projectExecutionSeries(
      ITEM,
      'PERIOD_DIFFERENCE',
      { type: 'MONTH', labels: ['2006-07'] },
      coverage,
      [row('2006-07', VIEW_INTERVALS.july2006Month, EXECUTION_REASONS.july2006Calendar, null)]
    )._unsafeUnwrap();
    expect(incompatible.periods[0]).toMatchObject({
      reason: 'incompatible_endpoint_coverage',
      periodStart: '2006-07-01',
      periodEnd: '2006-07-31',
    });
  });

  it('derives outside-coverage intervals from the basis, with no value or operand', () => {
    const outside = projectExecutionSeries(
      ITEM,
      'FULL_YEAR',
      { type: 'YEAR', labels: ['2005', '2025', '2026'] },
      coverage,
      [row('2025', VIEW_INTERVALS.full2025, 'available', EXECUTION_EVIDENCE.revenueFullYear2025)]
    )._unsafeUnwrap();
    expect(
      outside.periods.map((p) => [p.date, p.status, p.reason, p.periodStart, p.periodEnd])
    ).toEqual([
      ['2005', 'OUT_OF_COVERAGE', 'before_first_release', '2005-01-01', '2005-12-31'],
      ['2025', 'AVAILABLE', null, '2025-01-01', '2025-12-31'],
      ['2026', 'OUT_OF_COVERAGE', 'after_last_release', '2026-01-01', '2026-12-31'],
    ]);
    expect(toWireDataSeries(outside.series).data).toEqual([
      { date: '2025', value: '662698173101.34997' },
    ]);
    expect(outside.periods[0]).toMatchObject({
      valueBasis: null,
      endpoint: null,
      predecessor: null,
    });

    const ytdAfter = projectExecutionSeries(
      ITEM,
      'YTD',
      { type: 'MONTH', labels: ['2026-09'] },
      coverage,
      []
    )._unsafeUnwrap();
    expect(ytdAfter.periods[0]).toMatchObject({
      status: 'OUT_OF_COVERAGE',
      periodStart: '2026-01-01',
      periodEnd: '2026-09-30',
    });

    const missing = projectExecutionSeries(
      ITEM,
      'YTD',
      { type: 'MONTH', labels: ['2026-06', '2026-07'] },
      coverage,
      [
        row(
          '2026-07',
          ['2026-01-01', '2026-07-31'],
          'available',
          EXECUTION_EVIDENCE.revenueYtdJuly2026
        ),
      ]
    );
    expect(missing._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
  });

  it('refuses an available row without a value and duplicated rows', () => {
    expect(
      projectExecutionSeries(ITEM, 'YTD', { type: 'MONTH', labels: ['2025-06'] }, coverage, [
        row('2025-06', VIEW_INTERVALS.june2025Ytd, 'available', null),
      ]).isErr()
    ).toBe(true);
    expect(
      projectExecutionSeries(ITEM, 'YTD', { type: 'MONTH', labels: ['2025-06'] }, coverage, [
        row(
          '2025-06',
          VIEW_INTERVALS.june2025Ytd,
          'available',
          EXECUTION_EVIDENCE.revenueYtdJune2025
        ),
        row(
          '2025-06',
          VIEW_INTERVALS.june2025Ytd,
          'available',
          EXECUTION_EVIDENCE.revenueYtdJune2025
        ),
      ]).isErr()
    ).toBe(true);
  });

  it('does not sum YTDs: each label carries only its own view value', () => {
    const projection = projectExecutionSeries(
      ITEM,
      'YTD',
      { type: 'MONTH', labels: ['2026-07'] },
      coverage,
      [
        row(
          '2026-07',
          ['2026-01-01', '2026-07-31'],
          'available',
          EXECUTION_EVIDENCE.revenueYtdJuly2026
        ),
      ]
    )._unsafeUnwrap();
    expect(toWireDataSeries(projection.series).data).toEqual([
      { date: '2026-07', value: '412307346364.04004' },
    ]);
  });
});
