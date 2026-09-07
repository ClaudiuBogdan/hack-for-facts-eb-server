/** Explicit interactive request policies, not historical coverage or performance claims. */
import { err, ok, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';

import { createInvalidInputError, type GroupedSeriesError } from './errors.js';

import type { ExecutionMapSeries, GroupedSeriesDataRequest } from './types.js';

// Match the existing INS map period envelope. Reject; never sample or truncate.
const MAX_MAP_PERIODS = 1000;
// The existing 256-group, 4096-member envelope becomes a weighted work budget.
const MAX_GROUP_MEMBER_YEARS = 256 * 4096;

function selectedYears(period: ExecutionMapSeries['filter']['report_period']): number | null {
  const width = period.type === Frequency.YEAR ? 1 : period.type === Frequency.MONTH ? 12 : 4;
  const pattern =
    period.type === Frequency.YEAR
      ? /^(\d{4})$/u
      : period.type === Frequency.MONTH
        ? /^(\d{4})-(0[1-9]|1[0-2])$/u
        : /^(\d{4})-Q([1-4])$/u;
  const ordinal = (value: string): number | null => {
    const match = pattern.exec(value);
    const year = Number(match?.[1]);
    return match === null || year < 1 || year > 9999
      ? null
      : year * width + Number(match[2] ?? 1) - 1;
  };
  const { interval, dates } = period.selection;
  if (interval !== undefined) {
    const start = ordinal(interval.start);
    const end = ordinal(interval.end);
    if (start === null || end === null || end < start || end - start + 1 > MAX_MAP_PERIODS)
      return null;
    return Math.floor(end / width) - Math.floor(start / width) + 1;
  }
  if (dates.length === 0 || dates.length > MAX_MAP_PERIODS) return null;
  const parsed = dates.map(ordinal);
  if (parsed.includes(null) || new Set(parsed).size !== parsed.length) return null;
  return new Set(parsed.map((value) => Math.floor((value ?? 0) / width))).size;
}

/** No source IO or period expansion may precede this check. */
export function validateFinancialMapWork(
  request: GroupedSeriesDataRequest
): Result<void, GroupedSeriesError> {
  const years = new Map<string, number>();
  for (const series of request.series) {
    if (series.type !== 'line-items-aggregated-yearly' && series.type !== 'commitments-analytics')
      continue;
    const count = selectedYears(series.filter.report_period);
    if (count === null)
      return err(
        createInvalidInputError(
          `Series ${series.id} requires ordered, frequency-matched periods with unique dates and at most 1000 selected periods`
        )
      );
    years.set(series.id, count);
  }
  let work = 0;
  for (const group of request.groups ?? []) {
    work += group.memberTerritoryCodes.length * (years.get(group.sourceSeriesId) ?? 0);
    if (work > MAX_GROUP_MEMBER_YEARS)
      return err(
        createInvalidInputError(
          'Map groups exceed the request budget of 1048576 member-years; reduce groups, members or periods'
        )
      );
  }
  return ok(undefined);
}
