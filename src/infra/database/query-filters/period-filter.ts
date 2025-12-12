/**
 * Period Filter
 *
 * Builds parameterized SQL conditions for period-based filtering (dates, intervals).
 * Handles MONTH, QUARTER, and YEAR frequencies with correct tuple comparisons.
 *
 * Key insight: For MONTH and QUARTER queries, we must filter by tuple (year, month)
 * or (year, quarter) to get correct results. Year-only filtering is insufficient.
 *
 * SECURITY: All values are automatically parameterized via Kysely's sql`` template.
 */

import { sql, type RawBuilder } from 'kysely';

import { Frequency } from '@/common/types/temporal.js';

import { col } from './composer.js';

import type {
  FilterContext,
  SqlCondition,
  ParsedPeriod,
  MonthPeriod,
  QuarterPeriod,
  PeriodSelection,
} from './types.js';

// ============================================================================
// Period Parsing
// ============================================================================

/**
 * Parses a period date string into its components.
 *
 * Handles formats:
 * - YYYY (e.g., "2024") - returns { year: 2024 }
 * - YYYY-MM (e.g., "2024-03") - returns { year: 2024, month: 3 }
 * - YYYY-QN (e.g., "2024-Q1") - returns { year: 2024, quarter: 1 }
 *
 * @param dateStr - Date string to parse
 * @returns Parsed period components, or null if parsing fails
 */
export function parsePeriodDate(dateStr: string): ParsedPeriod | null {
  // Try year-only format: YYYY
  const yearOnlyMatch = /^(\d{4})$/.exec(dateStr);
  if (yearOnlyMatch?.[1] !== undefined) {
    return { year: parseInt(yearOnlyMatch[1], 10) };
  }

  // Try year-month format: YYYY-MM
  const yearMonthMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(dateStr);
  if (yearMonthMatch?.[1] !== undefined && yearMonthMatch[2] !== undefined) {
    return {
      year: parseInt(yearMonthMatch[1], 10),
      month: parseInt(yearMonthMatch[2], 10),
    };
  }

  // Try year-quarter format: YYYY-QN
  const yearQuarterMatch = /^(\d{4})-Q([1-4])$/.exec(dateStr);
  if (yearQuarterMatch?.[1] !== undefined && yearQuarterMatch[2] !== undefined) {
    return {
      year: parseInt(yearQuarterMatch[1], 10),
      quarter: parseInt(yearQuarterMatch[2], 10),
    };
  }

  return null;
}

/**
 * Extracts year from a date string.
 *
 * @param dateStr - Date string to parse
 * @returns The year as a number, or null if parsing fails
 */
export function extractYear(dateStr: string): number | null {
  if (dateStr.length < 4) {
    return null;
  }

  const yearPart = dateStr.substring(0, 4);
  if (!/^\d{4}$/.test(yearPart)) {
    return null;
  }

  const year = parseInt(yearPart, 10);
  return Number.isNaN(year) ? null : year;
}

/**
 * Formats database row to date string based on frequency.
 *
 * Output format matches the DataPoint.date specification:
 * - YEARLY: YYYY (e.g., 2024)
 * - MONTHLY: YYYY-MM (e.g., 2024-03)
 * - QUARTERLY: YYYY-QN (e.g., 2024-Q1)
 */
export function formatDateFromRow(year: number, periodValue: number, frequency: Frequency): string {
  if (frequency === Frequency.MONTH) {
    const month = String(periodValue).padStart(2, '0');
    return `${String(year)}-${month}`;
  }

  if (frequency === Frequency.QUARTER) {
    return `${String(year)}-Q${String(periodValue)}`;
  }

  // YEARLY
  return String(year);
}

// ============================================================================
// Period List Parsing
// ============================================================================

/**
 * Parses dates into month periods, filtering out invalid ones.
 */
export function parseMonthPeriods(dates: readonly string[]): MonthPeriod[] {
  return dates
    .map((d) => parsePeriodDate(d))
    .filter((p): p is MonthPeriod => p?.month !== undefined);
}

/**
 * Parses dates into quarter periods, filtering out invalid ones.
 */
export function parseQuarterPeriods(dates: readonly string[]): QuarterPeriod[] {
  return dates
    .map((d) => parsePeriodDate(d))
    .filter((p): p is QuarterPeriod => p?.quarter !== undefined);
}

/**
 * Parses dates into year values, filtering out invalid ones.
 */
export function parseYears(dates: readonly string[]): number[] {
  return dates.map((d) => extractYear(d)).filter((y): y is number => y !== null);
}

// ============================================================================
// Type Guards
// ============================================================================

function isMonthPeriod(period: ParsedPeriod | null): period is MonthPeriod {
  return period?.month !== undefined;
}

function isQuarterPeriod(period: ParsedPeriod | null): period is QuarterPeriod {
  return period?.quarter !== undefined;
}

// ============================================================================
// SQL Condition Builders (Parameterized)
// ============================================================================

/**
 * Builds parameterized SQL conditions for period filtering based on frequency.
 *
 * @param selection - Period selection (interval or dates)
 * @param frequency - Time frequency (MONTH, QUARTER, YEAR)
 * @param ctx - Filter context with table aliases
 * @returns Array of parameterized SqlCondition RawBuilders
 */
export function buildPeriodConditions(
  selection: PeriodSelection,
  frequency: Frequency,
  ctx: FilterContext
): SqlCondition[] {
  const a = ctx.lineItemAlias;
  const conditions: SqlCondition[] = [];

  // Add frequency flag condition
  if (frequency === Frequency.QUARTER) {
    conditions.push(sql`${col(a, 'is_quarterly')} = TRUE`);
  } else if (frequency === Frequency.YEAR) {
    conditions.push(sql`${col(a, 'is_yearly')} = TRUE`);
  }

  // Handle interval selection
  if (selection.interval !== undefined) {
    const intervalConditions = buildIntervalConditions(selection.interval, frequency, a);
    conditions.push(...intervalConditions);
  }

  // Handle discrete dates selection
  if (selection.dates !== undefined && selection.dates.length > 0) {
    const dateCondition = buildDateListConditions(selection.dates, frequency, a);
    if (dateCondition !== null) {
      conditions.push(dateCondition);
    }
  }

  return conditions;
}

/**
 * Builds conditions for an interval selection.
 */
function buildIntervalConditions(
  interval: { start: string; end: string },
  frequency: Frequency,
  alias: 'eli'
): SqlCondition[] {
  const start = parsePeriodDate(interval.start);
  const end = parsePeriodDate(interval.end);

  if (frequency === Frequency.MONTH && isMonthPeriod(start) && isMonthPeriod(end)) {
    return [
      sql`(${col(alias, 'year')}, ${col(alias, 'month')}) >= (${start.year}, ${start.month})`,
      sql`(${col(alias, 'year')}, ${col(alias, 'month')}) <= (${end.year}, ${end.month})`,
    ];
  }

  if (frequency === Frequency.QUARTER && isQuarterPeriod(start) && isQuarterPeriod(end)) {
    return [
      sql`(${col(alias, 'year')}, ${col(alias, 'quarter')}) >= (${start.year}, ${start.quarter})`,
      sql`(${col(alias, 'year')}, ${col(alias, 'quarter')}) <= (${end.year}, ${end.quarter})`,
    ];
  }

  // YEAR frequency or fallback
  const conditions: SqlCondition[] = [];
  const startYear = start?.year ?? extractYear(interval.start);
  const endYear = end?.year ?? extractYear(interval.end);

  if (startYear !== null) {
    conditions.push(sql`${col(alias, 'year')} >= ${startYear}`);
  }
  if (endYear !== null) {
    conditions.push(sql`${col(alias, 'year')} <= ${endYear}`);
  }

  return conditions;
}

/**
 * Builds conditions for a list of discrete dates.
 */
function buildDateListConditions(
  dates: readonly string[],
  frequency: Frequency,
  alias: 'eli'
): RawBuilder<unknown> | null {
  if (frequency === Frequency.MONTH) {
    const periods = parseMonthPeriods(dates);
    if (periods.length === 0) return null;

    const tupleConditions = periods.map(
      (p) => sql`(${col(alias, 'year')} = ${p.year} AND ${col(alias, 'month')} = ${p.month})`
    );

    return sql`(${sql.join(tupleConditions, sql` OR `)})`;
  }

  if (frequency === Frequency.QUARTER) {
    const periods = parseQuarterPeriods(dates);
    if (periods.length === 0) return null;

    const tupleConditions = periods.map(
      (p) => sql`(${col(alias, 'year')} = ${p.year} AND ${col(alias, 'quarter')} = ${p.quarter})`
    );

    return sql`(${sql.join(tupleConditions, sql` OR `)})`;
  }

  // YEAR frequency
  const years = parseYears(dates);
  if (years.length === 0) return null;

  return sql`${col(alias, 'year')} IN (${sql.join(years)})`;
}
