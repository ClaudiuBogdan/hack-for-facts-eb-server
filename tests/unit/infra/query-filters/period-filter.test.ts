import { Kysely, PostgresDialect } from 'kysely';
import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  parsePeriodDate,
  extractYear,
  formatDateFromRow,
  parseMonthPeriods,
  parseQuarterPeriods,
  parseYears,
  buildPeriodConditions,
  createFilterContext,
  andConditions,
  type SqlCondition,
} from '@/infra/database/query-filters/index.js';

// Create a minimal Kysely instance just for compilation (no actual DB connection needed)
const db = new Kysely<unknown>({
  dialect: new PostgresDialect({
    pool: null as unknown as never, // We won't execute, just compile
  }),
});

// Helper to compile conditions to SQL string for assertions
function compileConditions(conditions: SqlCondition[]): {
  sql: string;
  parameters: readonly unknown[];
} {
  const combined = andConditions(conditions);
  return combined.compile(db);
}

// ============================================================================
// parsePeriodDate
// ============================================================================

describe('parsePeriodDate', () => {
  it('parses year-only format', () => {
    expect(parsePeriodDate('2023')).toEqual({ year: 2023 });
    expect(parsePeriodDate('2020')).toEqual({ year: 2020 });
    expect(parsePeriodDate('1999')).toEqual({ year: 1999 });
  });

  it('parses year-month format', () => {
    expect(parsePeriodDate('2023-06')).toEqual({ year: 2023, month: 6 });
    expect(parsePeriodDate('2023-01')).toEqual({ year: 2023, month: 1 });
    expect(parsePeriodDate('2023-12')).toEqual({ year: 2023, month: 12 });
  });

  it('parses year-quarter format', () => {
    expect(parsePeriodDate('2023-Q1')).toEqual({ year: 2023, quarter: 1 });
    expect(parsePeriodDate('2023-Q2')).toEqual({ year: 2023, quarter: 2 });
    expect(parsePeriodDate('2023-Q3')).toEqual({ year: 2023, quarter: 3 });
    expect(parsePeriodDate('2023-Q4')).toEqual({ year: 2023, quarter: 4 });
  });

  it('returns null for invalid formats', () => {
    expect(parsePeriodDate('')).toBeNull();
    expect(parsePeriodDate('invalid')).toBeNull();
    expect(parsePeriodDate('2023-13')).toBeNull(); // Invalid month
    expect(parsePeriodDate('2023-00')).toBeNull(); // Invalid month
    expect(parsePeriodDate('2023-Q5')).toBeNull(); // Invalid quarter
    expect(parsePeriodDate('2023-Q0')).toBeNull(); // Invalid quarter
    expect(parsePeriodDate('23')).toBeNull(); // Too short
  });
});

// ============================================================================
// extractYear
// ============================================================================

describe('extractYear', () => {
  it('extracts year from various formats', () => {
    expect(extractYear('2023')).toBe(2023);
    expect(extractYear('2023-06')).toBe(2023);
    expect(extractYear('2023-Q2')).toBe(2023);
    expect(extractYear('2023-01-15')).toBe(2023);
  });

  it('returns null for invalid inputs', () => {
    expect(extractYear('')).toBeNull();
    expect(extractYear('123')).toBeNull();
    expect(extractYear('abcd')).toBeNull();
  });
});

// ============================================================================
// formatDateFromRow
// ============================================================================

describe('formatDateFromRow', () => {
  it('formats yearly data', () => {
    expect(formatDateFromRow(2023, 2023, Frequency.YEAR)).toBe('2023');
    expect(formatDateFromRow(2020, 2020, Frequency.YEAR)).toBe('2020');
  });

  it('formats monthly data with padded month', () => {
    expect(formatDateFromRow(2023, 1, Frequency.MONTH)).toBe('2023-01');
    expect(formatDateFromRow(2023, 6, Frequency.MONTH)).toBe('2023-06');
    expect(formatDateFromRow(2023, 12, Frequency.MONTH)).toBe('2023-12');
  });

  it('formats quarterly data', () => {
    expect(formatDateFromRow(2023, 1, Frequency.QUARTER)).toBe('2023-Q1');
    expect(formatDateFromRow(2023, 2, Frequency.QUARTER)).toBe('2023-Q2');
    expect(formatDateFromRow(2023, 3, Frequency.QUARTER)).toBe('2023-Q3');
    expect(formatDateFromRow(2023, 4, Frequency.QUARTER)).toBe('2023-Q4');
  });
});

// ============================================================================
// Period List Parsing
// ============================================================================

describe('parseMonthPeriods', () => {
  it('parses valid month periods', () => {
    const result = parseMonthPeriods(['2023-01', '2023-06', '2023-12']);
    expect(result).toEqual([
      { year: 2023, month: 1 },
      { year: 2023, month: 6 },
      { year: 2023, month: 12 },
    ]);
  });

  it('filters out invalid periods', () => {
    const result = parseMonthPeriods(['2023-01', '2023', '2023-Q1', 'invalid']);
    expect(result).toEqual([{ year: 2023, month: 1 }]);
  });
});

describe('parseQuarterPeriods', () => {
  it('parses valid quarter periods', () => {
    const result = parseQuarterPeriods(['2023-Q1', '2023-Q4']);
    expect(result).toEqual([
      { year: 2023, quarter: 1 },
      { year: 2023, quarter: 4 },
    ]);
  });

  it('filters out invalid periods', () => {
    const result = parseQuarterPeriods(['2023-Q1', '2023-01', '2023', 'invalid']);
    expect(result).toEqual([{ year: 2023, quarter: 1 }]);
  });
});

describe('parseYears', () => {
  it('extracts years from various formats', () => {
    const result = parseYears(['2020', '2021', '2022-06', '2023-Q1']);
    expect(result).toEqual([2020, 2021, 2022, 2023]);
  });

  it('filters out invalid entries', () => {
    const result = parseYears(['2020', 'invalid', '', '2023']);
    expect(result).toEqual([2020, 2023]);
  });
});

// ============================================================================
// buildPeriodConditions
// ============================================================================

describe('buildPeriodConditions', () => {
  const ctx = createFilterContext();

  describe('frequency flags', () => {
    it('adds is_yearly flag for YEAR frequency', () => {
      const conditions = buildPeriodConditions(
        { interval: { start: '2020', end: '2023' } },
        Frequency.YEAR,
        ctx
      );
      const compiled = compileConditions(conditions);
      // The flag may be inlined as TRUE or parameterized - both are safe
      expect(compiled.sql).toContain('eli.is_yearly');
    });

    it('adds is_quarterly flag for QUARTER frequency', () => {
      const conditions = buildPeriodConditions(
        { interval: { start: '2020-Q1', end: '2023-Q4' } },
        Frequency.QUARTER,
        ctx
      );
      const compiled = compileConditions(conditions);
      // The flag may be inlined as TRUE or parameterized - both are safe
      expect(compiled.sql).toContain('eli.is_quarterly');
    });

    it('does not add flag for MONTH frequency', () => {
      const conditions = buildPeriodConditions(
        { interval: { start: '2023-01', end: '2023-06' } },
        Frequency.MONTH,
        ctx
      );
      const compiled = compileConditions(conditions);
      expect(compiled.sql).not.toContain('is_yearly');
      expect(compiled.sql).not.toContain('is_quarterly');
    });
  });

  describe('year interval', () => {
    it('builds year range conditions', () => {
      const conditions = buildPeriodConditions(
        { interval: { start: '2020', end: '2023' } },
        Frequency.YEAR,
        ctx
      );
      const compiled = compileConditions(conditions);
      expect(compiled.sql).toContain('eli.year >= $');
      expect(compiled.sql).toContain('eli.year <= $');
      expect(compiled.parameters).toContain(2020);
      expect(compiled.parameters).toContain(2023);
    });
  });

  describe('month interval', () => {
    it('builds tuple comparison for month interval', () => {
      const conditions = buildPeriodConditions(
        { interval: { start: '2023-01', end: '2023-06' } },
        Frequency.MONTH,
        ctx
      );
      const compiled = compileConditions(conditions);
      // Should have tuple comparisons
      expect(compiled.sql).toContain('eli.year');
      expect(compiled.sql).toContain('eli.month');
      expect(compiled.parameters).toContain(2023);
      expect(compiled.parameters).toContain(1);
      expect(compiled.parameters).toContain(6);
    });
  });

  describe('quarter interval', () => {
    it('builds tuple comparison for quarter interval', () => {
      const conditions = buildPeriodConditions(
        { interval: { start: '2023-Q1', end: '2023-Q4' } },
        Frequency.QUARTER,
        ctx
      );
      const compiled = compileConditions(conditions);
      expect(compiled.sql).toContain('eli.year');
      expect(compiled.sql).toContain('eli.quarter');
      expect(compiled.parameters).toContain(2023);
      expect(compiled.parameters).toContain(1);
      expect(compiled.parameters).toContain(4);
    });
  });

  describe('discrete dates', () => {
    it('builds IN clause for year dates', () => {
      const conditions = buildPeriodConditions(
        { dates: ['2020', '2022', '2023'] },
        Frequency.YEAR,
        ctx
      );
      const compiled = compileConditions(conditions);
      expect(compiled.sql).toContain('eli.year IN');
      expect(compiled.parameters).toContain(2020);
      expect(compiled.parameters).toContain(2022);
      expect(compiled.parameters).toContain(2023);
    });

    it('builds OR conditions for month dates', () => {
      const conditions = buildPeriodConditions(
        { dates: ['2023-01', '2023-06'] },
        Frequency.MONTH,
        ctx
      );
      const compiled = compileConditions(conditions);
      // Should have year/month conditions joined with OR
      expect(compiled.sql).toContain('OR');
      expect(compiled.parameters).toContain(2023);
      expect(compiled.parameters).toContain(1);
      expect(compiled.parameters).toContain(6);
    });

    it('builds OR conditions for quarter dates', () => {
      const conditions = buildPeriodConditions(
        { dates: ['2023-Q1', '2023-Q3'] },
        Frequency.QUARTER,
        ctx
      );
      const compiled = compileConditions(conditions);
      expect(compiled.sql).toContain('OR');
      expect(compiled.parameters).toContain(2023);
      expect(compiled.parameters).toContain(1);
      expect(compiled.parameters).toContain(3);
    });
  });

  // NOTE: Table aliases are fixed to trusted internal constants.
});
