/**
 * Grouped-series REST request mappers.
 */

import { Frequency } from '@/common/types/temporal.js';

import type { GroupedSeriesDataBody } from './schemas.js';
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
  series: GroupedSeriesDataBody['series'][number]
): MapRequestSeries {
  if (series.type === 'line-items-aggregated-yearly') {
    return {
      ...series,
      filter: {
        ...series.filter,
        report_period: toReportPeriodInput(series.filter.report_period),
      },
    };
  }

  if (series.type === 'commitments-analytics') {
    return {
      ...series,
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
        period: toReportPeriodInput(period),
      }
    : rest;
}

export function mapGroupedSeriesBodyToRequest(
  body: GroupedSeriesDataBody
): GroupedSeriesDataRequest {
  return {
    granularity: body.granularity,
    series: body.series.map((series) => toMapRequestSeries(series)),
  };
}
