/**
 * National budget — pure execution coverage and series projection.
 *
 * The view alone decides availability, definition and qualifier conflicts; this
 * module only maps its rows onto the dense requested grid. A period is inside
 * coverage iff its endpoint month is (quarter: Mar/Jun/Sep/Dec, year: Dec);
 * outside it is OUT_OF_COVERAGE with a server-only reason. Inside coverage a
 * missing view row is SERVICE_UNAVAILABLE, never an empty success.
 *
 * `periodStart`/`periodEnd` describe the interval the VALUE covers, separate
 * from the display date/frequency: YTD (month or quarter) and full year start
 * on 1 January, a period difference starts at its month/quarter. Inside
 * coverage they are the view's own bounds, validated against that rule;
 * outside coverage (no source row) they are derived from the basis, with no
 * value and no operand. Printed partial coverage stays on the operands.
 */

import { err, ok, type Result } from 'neverthrow';

import { serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import {
  calendarBounds,
  isCalendarDate,
  periodLabel,
  periodOrdinal,
  type CalendarBounds,
  type PeriodPlan,
} from './periods.js';
import { projectSeries, type PeriodMetadata, type SeriesEnvelope } from './series.js';
import {
  AFTER_LAST_RELEASE,
  BEFORE_FIRST_RELEASE,
  VIEW_AVAILABLE_REASON,
  type SeriesBasis,
  type SeriesPeriodStatus,
  type ValueBasis,
} from './vocabulary.js';

import type { NationalSeriesViewRow, SeriesOperand } from './models.js';
import type { Decimal } from 'decimal.js';

export const COVERAGE_NOTE =
  'Coverage ends at the last loaded month, with no promise about later months. A missing month has no qualified selected release; that is not proof that no bulletin was published.';

export interface ExecutionCoverage {
  readonly firstMonth: string;
  readonly lastMonth: string;
  readonly calendarMonthCount: number;
  readonly selectedMonthCount: number;
  readonly missingMonths: readonly string[];
  readonly note: string;
}

/** Coverage of the execution lane from its selected calendar months. */
export const summarizeCoverage = (
  selectedMonths: readonly string[]
): Result<ExecutionCoverage, ApiError> => {
  const ordinals = new Set<number>();
  for (const month of selectedMonths) {
    const ordinal = periodOrdinal('MONTH', month);
    if (ordinal === null || ordinals.has(ordinal)) {
      return err(serviceUnavailable(`execution selections are inconsistent at month ${month}`));
    }
    ordinals.add(ordinal);
  }
  if (ordinals.size === 0) return err(serviceUnavailable('execution lane has no selected months'));
  const sorted = [...ordinals].sort((a, b) => a - b);
  const first = sorted[0] ?? 0;
  const last = sorted[sorted.length - 1] ?? 0;
  const missingMonths: string[] = [];
  for (let ordinal = first; ordinal <= last; ordinal++) {
    if (!ordinals.has(ordinal)) missingMonths.push(periodLabel('MONTH', ordinal));
  }
  return ok({
    firstMonth: periodLabel('MONTH', first),
    lastMonth: periodLabel('MONTH', last),
    calendarMonthCount: last - first + 1,
    selectedMonthCount: ordinals.size,
    missingMonths,
    note: COVERAGE_NOTE,
  });
};

export type CoverageClass = 'INSIDE' | typeof BEFORE_FIRST_RELEASE | typeof AFTER_LAST_RELEASE;

/** Inside iff the period's endpoint month lies within `[firstMonth, lastMonth]`. */
export const classifyCoverage = (
  endpointMonth: string,
  coverage: Pick<ExecutionCoverage, 'firstMonth' | 'lastMonth'>
): CoverageClass => {
  if (endpointMonth < coverage.firstMonth) return BEFORE_FIRST_RELEASE;
  if (endpointMonth > coverage.lastMonth) return AFTER_LAST_RELEASE;
  return 'INSIDE';
};

/** The interval a value of `basis` at `label` covers (the reviewed grid). */
export const basisInterval = (
  type: PeriodPlan['type'],
  basis: SeriesBasis,
  label: string
): (CalendarBounds & { readonly valueStart: string }) | null => {
  const bounds = calendarBounds(type, label);
  if (bounds === null) return null;
  const valueStart =
    basis === 'PERIOD_DIFFERENCE' ? bounds.start : `${bounds.end.slice(0, 4)}-01-01`;
  return { ...bounds, valueStart };
};

export interface ExecutionSeriesPeriod extends PeriodMetadata {
  /** Display label (`DataSeries` date). */
  readonly date: string;
  /** First day the value covers (not the display bucket start for YTD). */
  readonly periodStart: string;
  /** Last day the value covers. */
  readonly periodEnd: string;
  readonly status: SeriesPeriodStatus;
  /** Raw lowercase view/server code; null exactly when AVAILABLE. */
  readonly reason: string | null;
  readonly valueBasis: ValueBasis | null;
  readonly endpoint: SeriesOperand | null;
  readonly predecessor: SeriesOperand | null;
}

export interface ExecutionSeriesProjection extends SeriesEnvelope<ExecutionSeriesPeriod> {
  readonly itemId: string;
  readonly basis: SeriesBasis;
}

/** Project one item's view rows onto the requested grid. */
export const projectExecutionSeries = (
  itemId: string,
  basis: SeriesBasis,
  plan: PeriodPlan,
  coverage: Pick<ExecutionCoverage, 'firstMonth' | 'lastMonth'>,
  rows: readonly NationalSeriesViewRow[]
): Result<ExecutionSeriesProjection, ApiError> => {
  const byDate = new Map<string, NationalSeriesViewRow>();
  for (const row of rows) {
    if (row.itemId !== itemId || byDate.has(row.date)) {
      return err(
        serviceUnavailable(`national series rows are inconsistent for ${itemId} ${row.date}`)
      );
    }
    byDate.set(row.date, row);
  }

  const entries: { period: ExecutionSeriesPeriod; value: Decimal | null }[] = [];
  for (const date of plan.labels) {
    const interval = basisInterval(plan.type, basis, date);
    if (interval === null) return err(serviceUnavailable(`invalid planned label ${date}`));
    const place = classifyCoverage(interval.endpointMonth, coverage);
    if (place !== 'INSIDE') {
      entries.push({
        period: {
          date,
          periodStart: interval.valueStart,
          periodEnd: interval.end,
          status: 'OUT_OF_COVERAGE',
          reason: place,
          valueBasis: null,
          endpoint: null,
          predecessor: null,
        },
        value: null,
      });
      continue;
    }
    const row = byDate.get(date);
    if (row === undefined) {
      return err(
        serviceUnavailable(`national series view has no row for ${itemId} ${date} inside coverage`)
      );
    }
    if (
      !isCalendarDate(row.periodStart) ||
      !isCalendarDate(row.periodEnd) ||
      row.periodStart !== interval.valueStart ||
      row.periodEnd !== interval.end
    ) {
      return err(
        serviceUnavailable(
          `national series view interval ${row.periodStart}..${row.periodEnd} for ${itemId} ${date} is not the ${basis} interval ${interval.valueStart}..${interval.end}`
        )
      );
    }
    const base = { date, periodStart: row.periodStart, periodEnd: row.periodEnd };
    const operands = {
      valueBasis: row.valueBasis,
      endpoint: row.endpoint,
      predecessor: row.predecessor,
    };
    if (row.reason === VIEW_AVAILABLE_REASON) {
      if (row.value === null || row.valueBasis === null) {
        return err(
          serviceUnavailable(
            `national series view marks ${itemId} ${date} available without a value`
          )
        );
      }
      entries.push({
        period: { ...base, status: 'AVAILABLE', reason: null, ...operands },
        value: row.value,
      });
      continue;
    }
    if (row.reason.length === 0) {
      return err(
        serviceUnavailable(`national series view has an empty reason for ${itemId} ${date}`)
      );
    }
    // Unavailable: the reason passes through verbatim; any value is never surfaced.
    entries.push({
      period: { ...base, status: 'UNAVAILABLE', reason: row.reason, ...operands },
      value: null,
    });
  }
  return projectSeries(plan, entries).map((envelope) => ({ itemId, basis, ...envelope }));
};
