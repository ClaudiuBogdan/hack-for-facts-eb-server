/**
 * Period parsing + labels + the pruning plan — ported from the legacy
 * `infra/database/query-filters/period-filter.ts` and
 * `execution-analytics/core/period-labels.ts` (same regexes, same fallbacks).
 *
 * ONE intentional delta: legacy emitted NO period predicate when the selection
 * was empty or unparseable (a scan of every year). On the partitioned fact
 * table that is the forbidden unbounded scan (plan 02 §0.3), so the plan is
 * `InvalidInput` instead. `interval` + `dates` together are carried as legacy
 * did (both applied; the endpoint's `@oneOf` was unenforced).
 *
 * The `PeriodDate` scalar is a pass-through (legacy width, see the resolver),
 * so a JSON variable may arrive as a number (`2024`) — legacy's regexes coerced
 * it implicitly; `asText` does the same explicitly before parsing.
 */

import { err, ok, type Result } from 'neverthrow';

import type { LegacyFrequency, LegacyPeriodSelection, PeriodPlan, SubPeriod } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';

export interface ParsedPeriod {
  readonly year: number;
  readonly month?: number;
  readonly quarter?: number;
}

/** The pass-through scalar's value as text (legacy coerced inside the regexes). */
const asText = (value: unknown): string => (typeof value === 'string' ? value : String(value));

/** `YYYY` | `YYYY-MM` | `YYYY-QN` → components (legacy `parsePeriodDate`). */
export const parsePeriodDate = (raw: string): ParsedPeriod | null => {
  const value = asText(raw);
  const yearOnly = /^(\d{4})$/u.exec(value);
  if (yearOnly?.[1] !== undefined) return { year: Number.parseInt(yearOnly[1], 10) };
  const yearMonth = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(value);
  if (yearMonth?.[1] !== undefined && yearMonth[2] !== undefined) {
    return { year: Number.parseInt(yearMonth[1], 10), month: Number.parseInt(yearMonth[2], 10) };
  }
  const yearQuarter = /^(\d{4})-Q([1-4])$/u.exec(value);
  if (yearQuarter?.[1] !== undefined && yearQuarter[2] !== undefined) {
    return {
      year: Number.parseInt(yearQuarter[1], 10),
      quarter: Number.parseInt(yearQuarter[2], 10),
    };
  }
  return null;
};

/** Leading `YYYY` of any label (legacy `extractYear`). */
export const extractYear = (raw: string): number | null => {
  const value = asText(raw);
  if (value.length < 4) return null;
  const head = value.substring(0, 4);
  if (!/^\d{4}$/u.test(head)) return null;
  return Number.parseInt(head, 10);
};

/** `(year, period_value)` → the sparse label (legacy `formatDateFromRow`). */
export const formatPeriodLabel = (
  year: number,
  periodValue: number,
  frequency: LegacyFrequency
): string => {
  if (frequency === 'MONTH') return `${String(year)}-${String(periodValue).padStart(2, '0')}`;
  if (frequency === 'QUARTER') return `${String(year)}-Q${String(periodValue)}`;
  return String(year);
};

/** The previous period's label for the growth rule (legacy `getPreviousPeriodLabel`). */
export const previousPeriodLabel = (label: string, frequency: LegacyFrequency): string | null => {
  if (frequency === 'YEAR') {
    const year = Number.parseInt(label, 10);
    return Number.isNaN(year) ? null : String(year - 1);
  }
  if (frequency === 'QUARTER') {
    const m = /^(\d{4})-Q(\d)$/u.exec(label);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      const year = Number.parseInt(m[1], 10);
      const q = Number.parseInt(m[2], 10);
      return q === 1 ? `${String(year - 1)}-Q4` : `${String(year)}-Q${String(q - 1)}`;
    }
    return null;
  }
  const m = /^(\d{4})-(\d{2})$/u.exec(label);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    const year = Number.parseInt(m[1], 10);
    const month = Number.parseInt(m[2], 10);
    return month === 1
      ? `${String(year - 1)}-12`
      : `${String(year)}-${String(month - 1).padStart(2, '0')}`;
  }
  return null;
};

const subOf = (p: ParsedPeriod, frequency: LegacyFrequency): SubPeriod | null => {
  if (frequency === 'MONTH' && p.month !== undefined) return { year: p.year, sub: p.month };
  if (frequency === 'QUARTER' && p.quarter !== undefined) return { year: p.year, sub: p.quarter };
  return null;
};

const unbounded = (detail: string): ApiError => ({
  type: 'InvalidInput',
  message: `unbounded budget scan: report_period.selection ${detail} (legacy scanned every year; the partitioned facts require bounded years)`,
  field: 'report_period',
});

/**
 * Build the period plan for one series (legacy `buildPeriodConditions`
 * semantics, plus the bounded-years gate).
 */
export const planPeriod = (
  selection: LegacyPeriodSelection,
  frequency: LegacyFrequency
): Result<PeriodPlan, ApiError> => {
  const interval = selection.interval ?? undefined;
  const dates = selection.dates ?? undefined;

  let tupleRange: PeriodPlan['tupleRange'];
  let tupleList: PeriodPlan['tupleList'];
  let yearList: PeriodPlan['yearList'];
  let years: PeriodPlan['years'] | undefined;

  if (interval !== undefined) {
    const start = parsePeriodDate(interval.start);
    const end = parsePeriodDate(interval.end);
    const startSub = start === null ? null : subOf(start, frequency);
    const endSub = end === null ? null : subOf(end, frequency);
    if (frequency !== 'YEAR' && startSub !== null && endSub !== null) {
      tupleRange = { start: startSub, end: endSub };
      years = { from: startSub.year, to: endSub.year };
    } else {
      // YEAR frequency, or a sub-year frequency with year-only bounds: legacy
      // fell back to a plain year range — which IS the pruning predicate.
      const from = start?.year ?? extractYear(interval.start) ?? undefined;
      const to = end?.year ?? extractYear(interval.end) ?? undefined;
      if (from === undefined || to === undefined) {
        return err(unbounded(`interval '${interval.start}'..'${interval.end}' is not parseable`));
      }
      years = { from, to };
    }
  }

  if (dates !== undefined && dates.length > 0) {
    if (frequency === 'YEAR') {
      const parsed = dates.map(extractYear).filter((y): y is number => y !== null);
      if (parsed.length === 0) return err(unbounded('dates contain no parseable year'));
      // With no interval the year list IS the pruning predicate; with one, it is
      // the extra legacy `year IN (…)` on top of the interval range.
      if (years === undefined) years = { in: [...new Set(parsed)] };
      else yearList = parsed;
    } else {
      const parsed = dates
        .map(parsePeriodDate)
        .map((p) => (p === null ? null : subOf(p, frequency)))
        .filter((p): p is SubPeriod => p !== null);
      if (parsed.length === 0) {
        return err(unbounded(`dates contain no parseable ${frequency.toLowerCase()} period`));
      }
      tupleList = parsed;
      years ??= { in: [...new Set(parsed.map((p) => p.year))] };
    }
  }

  if (years === undefined) return err(unbounded('is empty'));

  return ok({
    years,
    ...(tupleRange !== undefined && { tupleRange }),
    ...(tupleList !== undefined && { tupleList }),
    ...(yearList !== undefined && { yearList }),
  });
};
