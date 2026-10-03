/**
 * National budget — projection of dense period metadata into the common series.
 *
 * Both series roots return `{ ...domain identity, series: DataSeries, periods }`
 * (no `series.series` wrapper). The invariants are checked here once:
 *
 * - `periods` holds every requested label exactly once, in plan order;
 * - `series.data` holds exactly the AVAILABLE labels, in that order;
 * - a value exists iff the period is AVAILABLE, and values occur only in data
 *   (period metadata is numberless by type: it cannot carry `value`).
 *
 * No zero-fill, interpolation, cumulative sum or second numeric projection.
 */

import { err, ok, type Result } from 'neverthrow';

import { Frequency, type DataSeries } from '@/common/types/temporal.js';
import { serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import type { PeriodPlan } from './periods.js';
import type { PeriodType } from './vocabulary.js';
import type { Decimal } from 'decimal.js';

export const AVAILABLE = 'AVAILABLE';

/** Numberless period metadata: a date, a status, and no `value` field. */
export interface PeriodMetadata {
  readonly date: string;
  readonly status: string;
  readonly value?: never;
}

export interface ProjectedEntry<P extends PeriodMetadata> {
  readonly period: P;
  /** The exact amount of an AVAILABLE period; null otherwise. */
  readonly value: Decimal | null;
}

export interface SeriesEnvelope<P extends PeriodMetadata> {
  readonly series: DataSeries;
  readonly periods: readonly P[];
}

const FREQUENCY: Readonly<Record<PeriodType, Frequency>> = {
  MONTH: Frequency.MONTH,
  QUARTER: Frequency.QUARTER,
  YEAR: Frequency.YEAR,
};

const violation = (detail: string): ApiError =>
  serviceUnavailable(`national series projection is inconsistent: ${detail}`);

export const projectSeries = <P extends PeriodMetadata>(
  plan: PeriodPlan,
  entries: readonly ProjectedEntry<P>[]
): Result<SeriesEnvelope<P>, ApiError> => {
  if (entries.length !== plan.labels.length) {
    return err(violation(`expected ${String(plan.labels.length)} periods`));
  }
  const data: DataSeries['data'] = [];
  const periods: P[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = plan.labels[index];
    if (entry.period.date !== label) {
      return err(violation(`period ${String(index)} is not ${String(label)}`));
    }
    const available = entry.period.status === AVAILABLE;
    if (available !== (entry.value !== null)) {
      return err(violation(`period ${label} status/value mismatch`));
    }
    if (entry.value !== null) data.push({ date: label, value: entry.value });
    periods.push(entry.period);
  }
  return ok({ series: { frequency: FREQUENCY[plan.type], data }, periods });
};
