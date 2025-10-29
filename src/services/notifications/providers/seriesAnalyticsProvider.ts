import type { Notification } from '../types';
import type { AnalyticsSeries, AnalyticsFilter as RepoAnalyticsFilter } from '../../../types';
import type { SeriesMeta } from './registry';
import { executionLineItemRepository } from '../../../db/repositories';
import { getNormalizationUnit } from '../../../db/repositories/utils';
import type { AnalyticsSeriesAlertConfig } from '../../../schemas/alerts';

type MonthlyTrendPoint = { year: number; month: number; value: number };
type QuarterlyTrendPoint = { year: number; quarter: number; value: number };
type YearlyTrendPoint = { year: number; value: number };

export async function fetchAnalyticsSeries(
  notification: Notification,
  periodKey: string
): Promise<{ series: AnalyticsSeries; metadata?: SeriesMeta } | null> {
  const config = notification.config as AnalyticsSeriesAlertConfig | null;
  const filter = (config?.filter as unknown) as RepoAnalyticsFilter | undefined;
  if (!filter) return null;

  const unit = getNormalizationUnit(filter.normalization);
  const type = filter.report_period?.type;

  // TODO: fix this
  if(!filter.report_period) return null;

  if (type === 'MONTH') {
    const monthly: MonthlyTrendPoint[] = await executionLineItemRepository.getMonthlyTrend(filter);
    const series: AnalyticsSeries = {
      seriesId: 'alert-series',
      xAxis: { name: 'Month', type: 'STRING', unit: 'month' },
      yAxis: { name: 'Amount', type: 'FLOAT', unit },
      data: monthly.map((p) => ({ x: `${p.year}-${String(p.month).padStart(2, '0')}`, y: p.value })),
    };
    const meta = computeSeriesMeta(series, 'MONTH', config);
    return { series, metadata: { periodKey, periodType: 'MONTH', ...meta } };
  }

  if (type === 'QUARTER') {
    const quarterly: QuarterlyTrendPoint[] = await executionLineItemRepository.getQuarterlyTrend(filter);
    const series: AnalyticsSeries = {
      seriesId: 'alert-series',
      xAxis: { name: 'Quarter', type: 'STRING', unit: 'quarter' },
      yAxis: { name: 'Amount', type: 'FLOAT', unit },
      data: quarterly.map((p) => ({ x: `${p.year}-Q${p.quarter}`, y: p.value })),
    };
    const meta = computeSeriesMeta(series, 'QUARTER', config);
    return { series, metadata: { periodKey, periodType: 'QUARTER', ...meta } };
  }

  const yearly: YearlyTrendPoint[] = await executionLineItemRepository.getYearlyTrend(filter);
  const series: AnalyticsSeries = {
    seriesId: 'alert-series',
    xAxis: { name: 'Year', type: 'INTEGER', unit: 'year' },
    yAxis: { name: 'Amount', type: 'FLOAT', unit },
    data: yearly.map((p) => ({ x: String(p.year), y: p.value })),
  };
  const meta = computeSeriesMeta(series, 'YEAR', config);
  return { series, metadata: { periodKey, periodType: 'YEAR', ...meta } };
}

type PeriodKind = 'MONTH' | 'QUARTER' | 'YEAR';

function computeSeriesMeta(
  series: AnalyticsSeries,
  kind: PeriodKind,
  cfg: AnalyticsSeriesAlertConfig | null
): SeriesMeta {
  const data = series.data;
  if (!data || data.length === 0) return {};
  const current = data[data.length - 1];
  const prev = data.length > 1 ? data[data.length - 2] : undefined;

  const prevDeltaAbs = prev ? current.y - prev.y : undefined;
  const prevDeltaPct = prev && prev.y ? (prevDeltaAbs! / prev.y) * 100 : undefined;

  let yoyTargetX: string | undefined;
  if (kind === 'MONTH') {
    const [yStr, mStr] = current.x.split('-');
    yoyTargetX = `${Number(yStr) - 1}-${mStr}`;
  } else if (kind === 'QUARTER') {
    const [yStr, qStr] = current.x.split('-Q');
    yoyTargetX = `${Number(yStr) - 1}-Q${qStr}`;
  } else {
    yoyTargetX = String(Number(current.x) - 1);
  }
  const yoyPoint = yoyTargetX ? data.find(p => p.x === yoyTargetX) : undefined;
  const yoyDeltaAbs = yoyPoint ? current.y - yoyPoint.y : undefined;
  const yoyDeltaPct = yoyPoint && yoyPoint.y ? (yoyDeltaAbs! / yoyPoint.y) * 100 : undefined;

  const windowSize = kind === 'MONTH' ? 12 : kind === 'QUARTER' ? 8 : 5;
  const window = data.slice(-windowSize);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const p of window) {
    min = Math.min(min, p.y);
    max = Math.max(max, p.y);
    sum += p.y;
  }
  const avg = window.length ? sum / window.length : 0;

  const conditions = Array.isArray(cfg?.conditions) ? cfg!.conditions.map(c => ({
    operator: c.operator,
    threshold: c.threshold,
    unit: c.unit,
    met: evaluateCondition(current.y, c.operator, c.threshold),
  })) : undefined;

  return {
    current,
    comparisons: {
      prev: prev ? { abs: prevDeltaAbs, pct: prevDeltaPct } : undefined,
      yoy: yoyPoint ? { abs: yoyDeltaAbs, pct: yoyDeltaPct } : undefined,
    },
    stats: { min, max, avg, count: window.length },
    conditions,
  };
}

function evaluateCondition(value: number, op: 'gt'|'gte'|'lt'|'lte'|'eq', threshold: number): boolean {
  switch (op) {
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq': return value === threshold;
  }
}

