import { describe, expect, it } from 'vitest';

import {
  calendarBounds,
  validateReportPeriod,
  type PeriodRules,
} from '@/modules/budget/core/national/periods.js';

const ANY: PeriodRules = { allowedTypes: ['MONTH', 'QUARTER', 'YEAR'], maxLabels: 300 };

const fieldOf = (raw: unknown, rules: PeriodRules = ANY): string | undefined => {
  const result = validateReportPeriod(raw, 'input.period', rules);
  return result.isErr() && result.error.type === 'InvalidInput' ? result.error.field : undefined;
};

describe('national strict ReportPeriodInput', () => {
  it('expands intervals densely and ascending for each period type', () => {
    const month = validateReportPeriod(
      { type: 'MONTH', selection: { interval: { start: '2025-11', end: '2026-02' } } },
      'input.period',
      ANY
    );
    expect(month._unsafeUnwrap().labels).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    const quarter = validateReportPeriod(
      { type: 'QUARTER', selection: { interval: { start: '2024-Q4', end: '2025-Q2' } } },
      'input.period',
      ANY
    );
    expect(quarter._unsafeUnwrap().labels).toEqual(['2024-Q4', '2025-Q1', '2025-Q2']);
    const year = validateReportPeriod(
      { type: 'YEAR', selection: { dates: ['2018', '2020', '2025'] } },
      'input.period',
      ANY
    );
    expect(year._unsafeUnwrap()).toEqual({ type: 'YEAR', labels: ['2018', '2020', '2025'] });
  });

  it('refuses labels that do not match the declared type exactly (no fallback)', () => {
    const cases: unknown[] = [
      { type: 'MONTH', selection: { dates: ['2025'] } },
      { type: 'MONTH', selection: { dates: ['2025-1'] } },
      { type: 'MONTH', selection: { dates: ['2025-13'] } },
      { type: 'MONTH', selection: { dates: [' 2025-01'] } },
      { type: 'QUARTER', selection: { dates: ['2025-Q5'] } },
      { type: 'QUARTER', selection: { dates: ['2025-q1'] } },
      { type: 'YEAR', selection: { dates: [2025] } },
      { type: 'YEAR', selection: { dates: ['2025-01'] } },
    ];
    for (const raw of cases)
      expect(fieldOf(raw)).toMatch(/^input\.period\.selection\.dates\[0\]$/u);
  });

  it('enforces @oneOf exclusivity, non-empty ascending unique dates and ordered intervals', () => {
    expect(fieldOf({ type: 'YEAR', selection: {} })).toBe('input.period.selection');
    expect(
      fieldOf({
        type: 'YEAR',
        selection: { interval: { start: '2020', end: '2021' }, dates: ['2020'] },
      })
    ).toBe('input.period.selection');
    expect(fieldOf({ type: 'YEAR', selection: { interval: null, dates: null } })).toBe(
      'input.period.selection'
    );
    expect(fieldOf({ type: 'YEAR', selection: { dates: [] } })).toBe(
      'input.period.selection.dates'
    );
    expect(fieldOf({ type: 'YEAR', selection: { dates: ['2021', '2020'] } })).toBe(
      'input.period.selection.dates'
    );
    expect(fieldOf({ type: 'YEAR', selection: { dates: ['2020', '2020'] } })).toBe(
      'input.period.selection.dates'
    );
    expect(fieldOf({ type: 'YEAR', selection: { interval: { start: '2021', end: '2020' } } })).toBe(
      'input.period.selection.interval'
    );
    expect(fieldOf({ type: 'YEAR', selection: { dates: ['2020'] }, extra: 1 })).toBe(
      'input.period.extra'
    );
  });

  it('applies per-root type and size bounds before expanding an interval', () => {
    const yearOnly: PeriodRules = { allowedTypes: ['YEAR'], maxLabels: 20 };
    expect(fieldOf({ type: 'MONTH', selection: { dates: ['2025-01'] } }, yearOnly)).toBe(
      'input.period.type'
    );
    expect(
      fieldOf({ type: 'YEAR', selection: { interval: { start: '2000', end: '2020' } } }, yearOnly)
    ).toBe('input.period.selection.interval');
    const huge = validateReportPeriod(
      { type: 'MONTH', selection: { interval: { start: '0001-01', end: '9999-12' } } },
      'input.period',
      ANY
    );
    expect(huge.isErr()).toBe(true);
    const twenty = validateReportPeriod(
      { type: 'YEAR', selection: { interval: { start: '2001', end: '2020' } } },
      'input.period',
      yearOnly
    );
    expect(twenty._unsafeUnwrap().labels).toHaveLength(20);
  });

  it('derives calendar bounds and the endpoint month of each grid label', () => {
    expect(calendarBounds('MONTH', '2024-02')).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
      endpointMonth: '2024-02',
    });
    expect(calendarBounds('MONTH', '2025-02')?.end).toBe('2025-02-28');
    expect(calendarBounds('QUARTER', '2025-Q2')).toEqual({
      start: '2025-04-01',
      end: '2025-06-30',
      endpointMonth: '2025-06',
    });
    expect(calendarBounds('YEAR', '2025')).toEqual({
      start: '2025-01-01',
      end: '2025-12-31',
      endpointMonth: '2025-12',
    });
    expect(calendarBounds('YEAR', '2025-01')).toBeNull();
  });
});
