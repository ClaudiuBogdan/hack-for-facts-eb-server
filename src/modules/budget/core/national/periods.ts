/**
 * National budget — strict common `ReportPeriodInput` handling.
 *
 * The input shape is the carried common one (`{ type, selection: @oneOf
 * { interval, dates } }`). Unlike the legacy analytics planner there is no
 * fallback: labels must match the declared type exactly, an interval must be
 * ordered, and a date list must be non-empty, unique and already ascending.
 * Interval sizes are computed arithmetically before any expansion, so an
 * oversized interval is refused without materialising it.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import { objectWithKeys, oneOfMember } from './input-rules.js';
import { isOneOf, PERIOD_TYPES, type PeriodType } from './vocabulary.js';

export interface PeriodPlan {
  readonly type: PeriodType;
  /** Every requested label exactly once, ascending. */
  readonly labels: readonly string[];
}

export interface PeriodRules {
  readonly allowedTypes: readonly PeriodType[];
  readonly maxLabels: number;
}

const LABEL_PATTERN: Readonly<Record<PeriodType, RegExp>> = {
  MONTH: /^(\d{4})-(0[1-9]|1[0-2])$/u,
  QUARTER: /^(\d{4})-Q([1-4])$/u,
  YEAR: /^(\d{4})$/u,
};

const PER_YEAR: Readonly<Record<PeriodType, number>> = { MONTH: 12, QUARTER: 4, YEAR: 1 };

/**
 * Ordinal of a strict label within its type (`year * perYear + index`), or
 * null. Year 0000 is refused: it is not a valid PostgreSQL date year.
 */
export const periodOrdinal = (type: PeriodType, label: string): number | null => {
  const match = LABEL_PATTERN[type].exec(label);
  const yearText = match?.[1];
  if (yearText === undefined) return null;
  const year = Number.parseInt(yearText, 10);
  if (year === 0) return null;
  const sub = match?.[2];
  const index = sub === undefined ? 0 : Number.parseInt(sub, 10) - 1;
  return year * PER_YEAR[type] + index;
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Label of an ordinal (inverse of `periodOrdinal`). */
export const periodLabel = (type: PeriodType, ordinal: number): string => {
  const year = Math.floor(ordinal / PER_YEAR[type]);
  const index = ordinal - year * PER_YEAR[type];
  const yyyy = String(year).padStart(4, '0');
  switch (type) {
    case 'MONTH':
      return `${yyyy}-${pad2(index + 1)}`;
    case 'QUARTER':
      return `${yyyy}-Q${String(index + 1)}`;
    case 'YEAR':
      return yyyy;
  }
};

/**
 * Validate a `ReportPeriodInput` against a root's period rules. `field` names
 * the input path in error messages (e.g. `input.period`).
 */
export const validateReportPeriod = (
  raw: unknown,
  field: string,
  rules: PeriodRules
): Result<PeriodPlan, ApiError> => {
  const input = objectWithKeys(raw, field, ['type', 'selection']);
  if (input.isErr()) return err(input.error);
  const type = input.value['type'];
  if (!isOneOf(PERIOD_TYPES, type)) {
    return err(invalidInput(`${field}.type must be MONTH, QUARTER or YEAR`, `${field}.type`));
  }
  if (!rules.allowedTypes.includes(type)) {
    return err(
      invalidInput(
        `${field}.type ${type} is not supported here (allowed: ${rules.allowedTypes.join(', ')})`,
        `${field}.type`
      )
    );
  }
  const selection = oneOfMember(input.value['selection'], `${field}.selection`, [
    'interval',
    'dates',
  ]);
  if (selection.isErr()) return err(selection.error);
  const memberField = `${field}.selection.${selection.value.key}`;
  return selection.value.key === 'interval'
    ? planInterval(type, selection.value.value, memberField, rules)
    : planDates(type, selection.value.value, memberField, rules);
};

const strictOrdinal = (
  type: PeriodType,
  value: unknown,
  field: string
): Result<number, ApiError> => {
  const ordinal = typeof value === 'string' ? periodOrdinal(type, value) : null;
  return ordinal === null
    ? err(invalidInput(`${field} must be a ${type} label (${formatHint(type)})`, field))
    : ok(ordinal);
};

const formatHint = (type: PeriodType): string =>
  type === 'MONTH' ? 'YYYY-MM' : type === 'QUARTER' ? 'YYYY-QN' : 'YYYY';

const planInterval = (
  type: PeriodType,
  raw: unknown,
  field: string,
  rules: PeriodRules
): Result<PeriodPlan, ApiError> => {
  const interval = objectWithKeys(raw, field, ['start', 'end']);
  if (interval.isErr()) return err(interval.error);
  const start = strictOrdinal(type, interval.value['start'], `${field}.start`);
  if (start.isErr()) return err(start.error);
  const end = strictOrdinal(type, interval.value['end'], `${field}.end`);
  if (end.isErr()) return err(end.error);
  if (start.value > end.value) {
    return err(invalidInput(`${field}.start must not be after ${field}.end`, field));
  }
  const count = end.value - start.value + 1;
  if (count > rules.maxLabels) {
    return err(
      invalidInput(
        `${field} spans ${String(count)} labels; at most ${String(rules.maxLabels)} allowed`,
        field
      )
    );
  }
  const labels: string[] = [];
  for (let ordinal = start.value; ordinal <= end.value; ordinal++) {
    labels.push(periodLabel(type, ordinal));
  }
  return ok({ type, labels });
};

const planDates = (
  type: PeriodType,
  raw: unknown,
  field: string,
  rules: PeriodRules
): Result<PeriodPlan, ApiError> => {
  // GraphQL list input coercion (shared with MCP): one label is a one-element list.
  const values: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  if (values.length === 0) {
    return err(invalidInput(`${field} must be a non-empty list`, field));
  }
  if (values.length > rules.maxLabels) {
    return err(invalidInput(`${field} allows at most ${String(rules.maxLabels)} labels`, field));
  }
  const labels: string[] = [];
  let previous: number | null = null;
  for (const [index, value] of values.entries()) {
    const ordinal = strictOrdinal(type, value, `${field}[${String(index)}]`);
    if (ordinal.isErr()) return err(ordinal.error);
    if (previous !== null && ordinal.value <= previous) {
      return err(invalidInput(`${field} must be unique and ascending`, field));
    }
    previous = ordinal.value;
    labels.push(periodLabel(type, ordinal.value));
  }
  return ok({ type, labels });
};

// ── calendar helpers (pure arithmetic on strict labels) ──────────────────────

const lastDayOfMonth = (year: number, month: number): number => {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

export interface CalendarBounds {
  /** First calendar day, `YYYY-MM-DD`. */
  readonly start: string;
  /** Last calendar day, `YYYY-MM-DD`. */
  readonly end: string;
  /** The month whose report closes the period (`YYYY-MM`). */
  readonly endpointMonth: string;
}

/** Calendar bounds and endpoint month of a strict label. */
export const calendarBounds = (type: PeriodType, label: string): CalendarBounds | null => {
  const ordinal = periodOrdinal(type, label);
  if (ordinal === null) return null;
  const year = Math.floor(ordinal / PER_YEAR[type]);
  const index = ordinal - year * PER_YEAR[type];
  const monthsPer = 12 / PER_YEAR[type];
  const firstMonth = index * monthsPer + 1;
  const lastMonth = firstMonth + monthsPer - 1;
  const yyyy = String(year).padStart(4, '0');
  return {
    start: `${yyyy}-${pad2(firstMonth)}-01`,
    end: `${yyyy}-${pad2(lastMonth)}-${pad2(lastDayOfMonth(year, lastMonth))}`,
    endpointMonth: `${yyyy}-${pad2(lastMonth)}`,
  };
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** A real calendar date `YYYY-MM-DD` (year 0001–9999; no Feb 31). */
export const isCalendarDate = (value: string): boolean => {
  const match = ISO_DATE.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return false;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= lastDayOfMonth(year, month);
};

/** A real calendar date that is the last day of its month. */
export const isMonthEnd = (value: string): boolean => {
  if (!isCalendarDate(value)) return false;
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  return (
    year !== undefined &&
    month !== undefined &&
    day !== undefined &&
    day === lastDayOfMonth(year, month)
  );
};

/** Numeric year of a strict label. */
export const labelYear = (type: PeriodType, label: string): number | null => {
  const ordinal = periodOrdinal(type, label);
  return ordinal === null ? null : Math.floor(ordinal / PER_YEAR[type]);
};
