/**
 * Period Filter Builder
 *
 * Provides utilities for building period-based SQL filters that work correctly
 * with different time frequencies (MONTH, QUARTER, YEAR).
 *
 * Key insight: For MONTH and QUARTER queries, we must filter by tuple (year, month)
 * or (year, quarter) to get correct results. Year-only filtering is insufficient.
 */

import { Frequency } from '@/common/types/temporal.js';

import { parsePeriodDate, extractYear, type ParsedPeriod } from './query-helpers.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Period selection from the filter - either an interval or discrete dates.
 *
 * Note: Properties are typed with `| undefined` to support exactOptionalPropertyTypes.
 */
export interface PeriodSelection {
  interval?: { start: string; end: string } | undefined;
  dates?: readonly string[] | undefined;
}

/**
 * Parsed month period with required month field.
 */
export interface MonthPeriod {
  year: number;
  month: number;
}

/**
 * Parsed quarter period with required quarter field.
 */
export interface QuarterPeriod {
  year: number;
  quarter: number;
}

/**
 * Parsed year period.
 */
export interface YearPeriod {
  year: number;
}

// ============================================================================
// Period Parsing
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
// SQL Condition Builders
// ============================================================================

/**
 * Builds SQL conditions for period filtering based on frequency.
 *
 * Returns an array of SQL condition strings (without WHERE keyword).
 *
 * @param selection - Period selection (interval or dates)
 * @param frequency - Time frequency (MONTH, QUARTER, YEAR)
 * @param alias - Table alias (default: 'eli')
 */
export function buildPeriodConditions(
  selection: PeriodSelection,
  frequency: Frequency,
  alias = 'eli'
): string[] {
  const conditions: string[] = [];

  if (selection.interval !== undefined) {
    const intervalConditions = buildIntervalConditions(selection.interval, frequency, alias);
    conditions.push(...intervalConditions);
  }

  if (selection.dates !== undefined && selection.dates.length > 0) {
    const dateConditions = buildDateListConditions(selection.dates, frequency, alias);
    if (dateConditions !== null) {
      conditions.push(dateConditions);
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
  alias: string
): string[] {
  const start = parsePeriodDate(interval.start);
  const end = parsePeriodDate(interval.end);

  if (frequency === Frequency.MONTH && isMonthPeriod(start) && isMonthPeriod(end)) {
    return buildMonthIntervalConditions(start, end, alias);
  }

  if (frequency === Frequency.QUARTER && isQuarterPeriod(start) && isQuarterPeriod(end)) {
    return buildQuarterIntervalConditions(start, end, alias);
  }

  // YEAR frequency or fallback
  return buildYearIntervalConditions(interval, start, end, alias);
}

/**
 * Builds month interval conditions using tuple comparison.
 */
function buildMonthIntervalConditions(
  start: MonthPeriod,
  end: MonthPeriod,
  alias: string
): string[] {
  return [
    `(${alias}.year, ${alias}.month) >= (${String(start.year)}, ${String(start.month)})`,
    `(${alias}.year, ${alias}.month) <= (${String(end.year)}, ${String(end.month)})`,
  ];
}

/**
 * Builds quarter interval conditions using tuple comparison.
 */
function buildQuarterIntervalConditions(
  start: QuarterPeriod,
  end: QuarterPeriod,
  alias: string
): string[] {
  return [
    `(${alias}.year, ${alias}.quarter) >= (${String(start.year)}, ${String(start.quarter)})`,
    `(${alias}.year, ${alias}.quarter) <= (${String(end.year)}, ${String(end.quarter)})`,
  ];
}

/**
 * Builds year interval conditions.
 */
function buildYearIntervalConditions(
  interval: { start: string; end: string },
  start: ParsedPeriod | null,
  end: ParsedPeriod | null,
  alias: string
): string[] {
  const conditions: string[] = [];
  const startYear = start?.year ?? extractYear(interval.start);
  const endYear = end?.year ?? extractYear(interval.end);

  if (startYear !== null) {
    conditions.push(`${alias}.year >= ${String(startYear)}`);
  }
  if (endYear !== null) {
    conditions.push(`${alias}.year <= ${String(endYear)}`);
  }

  return conditions;
}

/**
 * Builds conditions for a list of discrete dates.
 */
function buildDateListConditions(
  dates: readonly string[],
  frequency: Frequency,
  alias: string
): string | null {
  if (frequency === Frequency.MONTH) {
    return buildMonthDateListCondition(dates, alias);
  }

  if (frequency === Frequency.QUARTER) {
    return buildQuarterDateListCondition(dates, alias);
  }

  // YEAR frequency
  return buildYearDateListCondition(dates, alias);
}

/**
 * Builds OR condition for month dates.
 */
function buildMonthDateListCondition(dates: readonly string[], alias: string): string | null {
  const periods = parseMonthPeriods(dates);
  if (periods.length === 0) return null;

  const tupleConditions = periods
    .map((p) => `(${alias}.year = ${String(p.year)} AND ${alias}.month = ${String(p.month)})`)
    .join(' OR ');

  return `(${tupleConditions})`;
}

/**
 * Builds OR condition for quarter dates.
 */
function buildQuarterDateListCondition(dates: readonly string[], alias: string): string | null {
  const periods = parseQuarterPeriods(dates);
  if (periods.length === 0) return null;

  const tupleConditions = periods
    .map((p) => `(${alias}.year = ${String(p.year)} AND ${alias}.quarter = ${String(p.quarter)})`)
    .join(' OR ');

  return `(${tupleConditions})`;
}

/**
 * Builds IN condition for year dates.
 */
function buildYearDateListCondition(dates: readonly string[], alias: string): string | null {
  const years = parseYears(dates);
  if (years.length === 0) return null;

  return `${alias}.year IN (${years.join(', ')})`;
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
