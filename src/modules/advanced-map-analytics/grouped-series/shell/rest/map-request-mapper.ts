/**
 * Grouped-series REST request mappers.
 */

import { Frequency } from '@/common/types/temporal.js';

import type { GroupedSeriesDataBody, GroupedSeriesDataBodyInput } from './schemas.js';
import type { GroupedSeriesDataRequest, MapRequestSeries } from '../../core/types.js';
import type { PeriodDate, ReportPeriodInput } from '@/common/types/analytics.js';

function toFrequency(value: 'MONTH' | 'QUARTER' | 'YEAR'): Frequency {
  if (value === 'MONTH') {
    return Frequency.MONTH;
  }

  if (value === 'QUARTER') {
    return Frequency.QUARTER;
  }

  return Frequency.YEAR;
}

function toReportPeriodInput(period: {
  type: 'MONTH' | 'QUARTER' | 'YEAR';
  selection: { interval: { start: string; end: string } } | { dates: string[] };
}): ReportPeriodInput {
  const selection: ReportPeriodInput['selection'] =
    'interval' in period.selection
      ? {
          interval: {
            start: period.selection.interval.start as PeriodDate,
            end: period.selection.interval.end as PeriodDate,
          },
          dates: undefined,
        }
      : {
          dates: period.selection.dates as PeriodDate[],
          interval: undefined,
        };

  return {
    type: toFrequency(period.type),
    selection,
  };
}

export function toMapRequestSeries(
  series: GroupedSeriesDataBodyInput['series'][number],
  id: string
): MapRequestSeries {
  if (series.type === 'uploaded-map-dataset') {
    return {
      ...series,
      id,
    };
  }

  if (series.type === 'line-items-aggregated-yearly') {
    return {
      ...series,
      id,
      filter: {
        ...series.filter,
        report_period: toReportPeriodInput(series.filter.report_period),
      },
    };
  }

  if (series.type === 'commitments-analytics') {
    return {
      ...series,
      id,
      filter: {
        ...series.filter,
        report_period: toReportPeriodInput(series.filter.report_period),
      },
    };
  }

  const { period, ...rest } = series;
  return period !== undefined
    ? {
        ...rest,
        id,
        period: toReportPeriodInput(period),
      }
    : {
        ...rest,
        id,
      };
}

function buildGeneratedSeriesId(preferredIndex: number, usedIds: Set<string>): string {
  let candidate = `series_${String(preferredIndex + 1)}`;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `series_${String(preferredIndex + 1)}_${String(suffix)}`;
    suffix += 1;
  }

  return candidate;
}

export function mapGroupedSeriesBodyToRequest(
  body: GroupedSeriesDataBody | GroupedSeriesDataBodyInput
): GroupedSeriesDataRequest {
  const usedIds = new Set<string>();

  return {
    granularity: body.granularity,
    series: body.series.map((series, index) => {
      const explicitId =
        typeof series.id === 'string' && series.id.trim() !== '' ? series.id.trim() : undefined;
      const id = explicitId ?? buildGeneratedSeriesId(index, usedIds);
      usedIds.add(id);
      return toMapRequestSeries(series, id);
    }),
  };
}
