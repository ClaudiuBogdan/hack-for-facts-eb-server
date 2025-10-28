import type { Notification } from '../types';
import type { AnalyticsSeries, AnalyticsFilter as RepoAnalyticsFilter } from '../../../types';
import { executionLineItemRepository } from '../../../db/repositories';
import { getNormalizationUnit } from '../../../db/repositories/utils';
import type { AnalyticsSeriesAlertConfig } from '../../../schemas/alerts';

type MonthlyTrendPoint = { year: number; month: number; value: number };
type QuarterlyTrendPoint = { year: number; quarter: number; value: number };
type YearlyTrendPoint = { year: number; value: number };

export async function fetchAnalyticsSeries(
  notification: Notification,
  periodKey: string
): Promise<{ series: AnalyticsSeries; metadata?: Record<string, unknown> } | null> {
  const config = notification.config as AnalyticsSeriesAlertConfig | null;
  const filter = (config?.filter as unknown) as RepoAnalyticsFilter | undefined;
  if (!filter) return null;

  const unit = getNormalizationUnit(filter.normalization);
  const type = filter.report_period?.type;

  if (type === 'MONTH') {
    const monthly: MonthlyTrendPoint[] = await executionLineItemRepository.getMonthlyTrend(filter);
    const series: AnalyticsSeries = {
      seriesId: 'alert-series',
      xAxis: { name: 'Month', type: 'STRING', unit: 'month' },
      yAxis: { name: 'Amount', type: 'FLOAT', unit },
      data: monthly.map((p) => ({ x: `${p.year}-${String(p.month).padStart(2, '0')}`, y: p.value })),
    };
    return { series, metadata: { periodKey, periodType: 'MONTH' } };
  }

  if (type === 'QUARTER') {
    const quarterly: QuarterlyTrendPoint[] = await executionLineItemRepository.getQuarterlyTrend(filter);
    const series: AnalyticsSeries = {
      seriesId: 'alert-series',
      xAxis: { name: 'Quarter', type: 'STRING', unit: 'quarter' },
      yAxis: { name: 'Amount', type: 'FLOAT', unit },
      data: quarterly.map((p) => ({ x: `${p.year}-Q${p.quarter}`, y: p.value })),
    };
    return { series, metadata: { periodKey, periodType: 'QUARTER' } };
  }

  const yearly: YearlyTrendPoint[] = await executionLineItemRepository.getYearlyTrend(filter);
  const series: AnalyticsSeries = {
    seriesId: 'alert-series',
    xAxis: { name: 'Year', type: 'INTEGER', unit: 'year' },
    yAxis: { name: 'Amount', type: 'FLOAT', unit },
    data: yearly.map((p) => ({ x: String(p.year), y: p.value })),
  };
  return { series, metadata: { periodKey, periodType: 'YEAR' } };
}


