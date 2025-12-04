import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  parseMonthPeriods,
  parseQuarterPeriods,
  parseYears,
  buildPeriodConditions,
  type PeriodSelection,
} from '@/modules/execution-analytics/shell/repo/period-filter-builder.js';

// ============================================================================
// parseMonthPeriods
// ============================================================================

describe('parseMonthPeriods', () => {
  it('parses valid month date strings', () => {
    const result = parseMonthPeriods(['2024-01', '2024-06', '2024-12']);
    expect(result).toEqual([
      { year: 2024, month: 1 },
      { year: 2024, month: 6 },
      { year: 2024, month: 12 },
    ]);
  });

  it('filters out invalid dates', () => {
    const result = parseMonthPeriods(['2024-01', 'invalid', '2024-06']);
    expect(result).toEqual([
      { year: 2024, month: 1 },
      { year: 2024, month: 6 },
    ]);
  });

  it('filters out year-only dates (no month)', () => {
    const result = parseMonthPeriods(['2024', '2024-01', '2025']);
    expect(result).toEqual([{ year: 2024, month: 1 }]);
  });

  it('filters out quarter dates (no month)', () => {
    const result = parseMonthPeriods(['2024-Q1', '2024-01', '2024-Q2']);
    expect(result).toEqual([{ year: 2024, month: 1 }]);
  });

  it('returns empty array for empty input', () => {
    expect(parseMonthPeriods([])).toEqual([]);
  });

  it('returns empty array when no valid months', () => {
    expect(parseMonthPeriods(['invalid', '2024', '2024-Q1'])).toEqual([]);
  });
});

// ============================================================================
// parseQuarterPeriods
// ============================================================================

describe('parseQuarterPeriods', () => {
  it('parses valid quarter date strings', () => {
    const result = parseQuarterPeriods(['2024-Q1', '2024-Q2', '2024-Q3', '2024-Q4']);
    expect(result).toEqual([
      { year: 2024, quarter: 1 },
      { year: 2024, quarter: 2 },
      { year: 2024, quarter: 3 },
      { year: 2024, quarter: 4 },
    ]);
  });

  it('filters out invalid dates', () => {
    const result = parseQuarterPeriods(['2024-Q1', 'invalid', '2024-Q3']);
    expect(result).toEqual([
      { year: 2024, quarter: 1 },
      { year: 2024, quarter: 3 },
    ]);
  });

  it('filters out year-only dates (no quarter)', () => {
    const result = parseQuarterPeriods(['2024', '2024-Q1', '2025']);
    expect(result).toEqual([{ year: 2024, quarter: 1 }]);
  });

  it('filters out month dates (no quarter)', () => {
    const result = parseQuarterPeriods(['2024-01', '2024-Q1', '2024-06']);
    expect(result).toEqual([{ year: 2024, quarter: 1 }]);
  });

  it('returns empty array for empty input', () => {
    expect(parseQuarterPeriods([])).toEqual([]);
  });

  it('returns empty array when no valid quarters', () => {
    expect(parseQuarterPeriods(['invalid', '2024', '2024-01'])).toEqual([]);
  });
});

// ============================================================================
// parseYears
// ============================================================================

describe('parseYears', () => {
  it('parses year from year-only strings', () => {
    const result = parseYears(['2024', '2025', '2026']);
    expect(result).toEqual([2024, 2025, 2026]);
  });

  it('extracts year from month strings', () => {
    const result = parseYears(['2024-01', '2025-06']);
    expect(result).toEqual([2024, 2025]);
  });

  it('extracts year from quarter strings', () => {
    const result = parseYears(['2024-Q1', '2025-Q2']);
    expect(result).toEqual([2024, 2025]);
  });

  it('filters out invalid dates', () => {
    const result = parseYears(['2024', 'invalid', '2025']);
    expect(result).toEqual([2024, 2025]);
  });

  it('returns empty array for empty input', () => {
    expect(parseYears([])).toEqual([]);
  });

  it('returns empty array when no valid years', () => {
    expect(parseYears(['abc', 'def'])).toEqual([]);
  });
});

// ============================================================================
// buildPeriodConditions - MONTH frequency
// ============================================================================

describe('buildPeriodConditions with MONTH frequency', () => {
  describe('interval selection', () => {
    it('builds tuple conditions for month interval', () => {
      const selection: PeriodSelection = {
        interval: { start: '2024-01', end: '2024-06' },
      };

      const conditions = buildPeriodConditions(selection, Frequency.MONTH);

      expect(conditions).toEqual([
        '(eli.year, eli.month) >= (2024, 1)',
        '(eli.year, eli.month) <= (2024, 6)',
      ]);
    });

    it('handles cross-year intervals', () => {
      const selection: PeriodSelection = {
        interval: { start: '2023-11', end: '2024-03' },
      };

      const conditions = buildPeriodConditions(selection, Frequency.MONTH);

      expect(conditions).toEqual([
        '(eli.year, eli.month) >= (2023, 11)',
        '(eli.year, eli.month) <= (2024, 3)',
      ]);
    });

    it('uses custom alias', () => {
      const selection: PeriodSelection = {
        interval: { start: '2024-01', end: '2024-06' },
      };

      const conditions = buildPeriodConditions(selection, Frequency.MONTH, 'x');

      expect(conditions).toEqual([
        '(x.year, x.month) >= (2024, 1)',
        '(x.year, x.month) <= (2024, 6)',
      ]);
    });

    it('falls back to year filtering for invalid month dates', () => {
      const selection: PeriodSelection = {
        interval: { start: '2024', end: '2025' },
      };

      const conditions = buildPeriodConditions(selection, Frequency.MONTH);

      expect(conditions).toEqual(['eli.year >= 2024', 'eli.year <= 2025']);
    });
  });

  describe('dates selection', () => {
    it('builds OR conditions for month dates', () => {
      const selection: PeriodSelection = {
        dates: ['2024-01', '2024-03', '2024-06'],
      };

      const conditions = buildPeriodConditions(selection, Frequency.MONTH);

      expect(conditions).toEqual([
        '((eli.year = 2024 AND eli.month = 1) OR (eli.year = 2024 AND eli.month = 3) OR (eli.year = 2024 AND eli.month = 6))',
      ]);
    });

    it('handles single date', () => {
      const selection: PeriodSelection = {
        dates: ['2024-01'],
      };

      const conditions = buildPeriodConditions(selection, Frequency.MONTH);

      expect(conditions).toEqual(['((eli.year = 2024 AND eli.month = 1))']);
    });

    it('returns empty when no valid month dates', () => {
      const selection: PeriodSelection = {
        dates: ['2024', '2025'], // Year-only, no months
      };

      const conditions = buildPeriodConditions(selection, Frequency.MONTH);

      expect(conditions).toEqual([]);
    });
  });

  describe('combined interval and dates', () => {
    it('builds conditions for both interval and dates', () => {
      const selection: PeriodSelection = {
        interval: { start: '2024-01', end: '2024-06' },
        dates: ['2024-09', '2024-12'],
      };

      const conditions = buildPeriodConditions(selection, Frequency.MONTH);

      expect(conditions).toHaveLength(3);
      expect(conditions[0]).toBe('(eli.year, eli.month) >= (2024, 1)');
      expect(conditions[1]).toBe('(eli.year, eli.month) <= (2024, 6)');
      expect(conditions[2]).toContain('eli.year = 2024 AND eli.month = 9');
    });
  });
});

// ============================================================================
// buildPeriodConditions - QUARTER frequency
// ============================================================================

describe('buildPeriodConditions with QUARTER frequency', () => {
  describe('interval selection', () => {
    it('builds tuple conditions for quarter interval', () => {
      const selection: PeriodSelection = {
        interval: { start: '2024-Q1', end: '2024-Q3' },
      };

      const conditions = buildPeriodConditions(selection, Frequency.QUARTER);

      expect(conditions).toEqual([
        '(eli.year, eli.quarter) >= (2024, 1)',
        '(eli.year, eli.quarter) <= (2024, 3)',
      ]);
    });

    it('handles cross-year intervals', () => {
      const selection: PeriodSelection = {
        interval: { start: '2023-Q3', end: '2024-Q2' },
      };

      const conditions = buildPeriodConditions(selection, Frequency.QUARTER);

      expect(conditions).toEqual([
        '(eli.year, eli.quarter) >= (2023, 3)',
        '(eli.year, eli.quarter) <= (2024, 2)',
      ]);
    });

    it('falls back to year filtering for invalid quarter dates', () => {
      const selection: PeriodSelection = {
        interval: { start: '2024', end: '2025' },
      };

      const conditions = buildPeriodConditions(selection, Frequency.QUARTER);

      expect(conditions).toEqual(['eli.year >= 2024', 'eli.year <= 2025']);
    });
  });

  describe('dates selection', () => {
    it('builds OR conditions for quarter dates', () => {
      const selection: PeriodSelection = {
        dates: ['2024-Q1', '2024-Q3', '2024-Q4'],
      };

      const conditions = buildPeriodConditions(selection, Frequency.QUARTER);

      expect(conditions).toEqual([
        '((eli.year = 2024 AND eli.quarter = 1) OR (eli.year = 2024 AND eli.quarter = 3) OR (eli.year = 2024 AND eli.quarter = 4))',
      ]);
    });

    it('returns empty when no valid quarter dates', () => {
      const selection: PeriodSelection = {
        dates: ['2024', '2024-01'], // No quarters
      };

      const conditions = buildPeriodConditions(selection, Frequency.QUARTER);

      expect(conditions).toEqual([]);
    });
  });
});

// ============================================================================
// buildPeriodConditions - YEAR frequency
// ============================================================================

describe('buildPeriodConditions with YEAR frequency', () => {
  describe('interval selection', () => {
    it('builds year range conditions', () => {
      const selection: PeriodSelection = {
        interval: { start: '2020', end: '2024' },
      };

      const conditions = buildPeriodConditions(selection, Frequency.YEAR);

      expect(conditions).toEqual(['eli.year >= 2020', 'eli.year <= 2024']);
    });

    it('extracts year from month strings', () => {
      const selection: PeriodSelection = {
        interval: { start: '2020-01', end: '2024-12' },
      };

      const conditions = buildPeriodConditions(selection, Frequency.YEAR);

      expect(conditions).toEqual(['eli.year >= 2020', 'eli.year <= 2024']);
    });

    it('extracts year from quarter strings', () => {
      const selection: PeriodSelection = {
        interval: { start: '2020-Q1', end: '2024-Q4' },
      };

      const conditions = buildPeriodConditions(selection, Frequency.YEAR);

      expect(conditions).toEqual(['eli.year >= 2020', 'eli.year <= 2024']);
    });
  });

  describe('dates selection', () => {
    it('builds IN condition for years', () => {
      const selection: PeriodSelection = {
        dates: ['2020', '2022', '2024'],
      };

      const conditions = buildPeriodConditions(selection, Frequency.YEAR);

      expect(conditions).toEqual(['eli.year IN (2020, 2022, 2024)']);
    });

    it('extracts years from various date formats', () => {
      const selection: PeriodSelection = {
        dates: ['2020', '2022-01', '2024-Q1'],
      };

      const conditions = buildPeriodConditions(selection, Frequency.YEAR);

      expect(conditions).toEqual(['eli.year IN (2020, 2022, 2024)']);
    });

    it('returns empty when no valid years', () => {
      const selection: PeriodSelection = {
        dates: ['invalid', 'abc'],
      };

      const conditions = buildPeriodConditions(selection, Frequency.YEAR);

      expect(conditions).toEqual([]);
    });
  });
});

// ============================================================================
// buildPeriodConditions - Edge cases
// ============================================================================

describe('buildPeriodConditions edge cases', () => {
  it('handles empty selection', () => {
    const selection: PeriodSelection = {};

    const conditions = buildPeriodConditions(selection, Frequency.YEAR);

    expect(conditions).toEqual([]);
  });

  it('handles undefined interval', () => {
    const selection: PeriodSelection = {
      interval: undefined,
      dates: ['2024'],
    };

    const conditions = buildPeriodConditions(selection, Frequency.YEAR);

    expect(conditions).toEqual(['eli.year IN (2024)']);
  });

  it('handles undefined dates', () => {
    const selection: PeriodSelection = {
      interval: { start: '2024', end: '2025' },
      dates: undefined,
    };

    const conditions = buildPeriodConditions(selection, Frequency.YEAR);

    expect(conditions).toEqual(['eli.year >= 2024', 'eli.year <= 2025']);
  });

  it('handles empty dates array', () => {
    const selection: PeriodSelection = {
      dates: [],
    };

    const conditions = buildPeriodConditions(selection, Frequency.YEAR);

    expect(conditions).toEqual([]);
  });
});
