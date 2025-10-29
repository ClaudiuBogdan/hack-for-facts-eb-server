import type { Notification } from '../types';
import type { AnalyticsSeries, AxisDataType } from '../../../types';
import { staticDatasetsRepository } from '../../../db/repositories/staticDatasetsRepository';
import type { StaticSeriesAlertConfig } from '../../../schemas/alerts';
import type { SeriesMeta } from './registry';

export async function fetchStaticSeries(
  notification: Notification,
  periodKey: string
): Promise<{ series: AnalyticsSeries; metadata?: SeriesMeta } | null> {
  const config = notification.config as StaticSeriesAlertConfig | null;
  const datasetId = config?.datasetId;
  if (!datasetId) return null;

  const dataset = await staticDatasetsRepository.getDatasetById(datasetId);
  const series: AnalyticsSeries = {
    seriesId: dataset.id,
    xAxis: {
      name: dataset.xAxis.name,
      type: dataset.xAxis.type as AxisDataType,
      unit: dataset.xAxis.unit,
    },
    yAxis: {
      name: dataset.yAxis.name,
      type: dataset.yAxis.type as AxisDataType,
      unit: dataset.yAxis.unit,
    },
    data: dataset.data.map((p) => ({ x: String(p.x), y: p.y })),
  };

  const meta = computeSeriesMeta(series, config);

  return {
    series,
    metadata: {
      periodKey,
      datasetId,
      sourceName: dataset.sourceName,
      sourceUrl: dataset.sourceUrl,
      ...meta,
    },
  };
}

function computeSeriesMeta(series: AnalyticsSeries, cfg: StaticSeriesAlertConfig | null): SeriesMeta {
  const data = series.data;
  if (!data || data.length === 0) return {};
  const current = data[data.length - 1];
  const prev = data.length > 1 ? data[data.length - 2] : undefined;

  const prevDeltaAbs = prev ? current.y - prev.y : undefined;
  const prevDeltaPct = prev && prev.y ? (prevDeltaAbs! / prev.y) * 100 : undefined;

  // Attempt simple YoY based on axis unit
  let yoyKey: string | undefined;
  if (series.xAxis.unit === 'month') {
    const [yStr, mStr] = current.x.split('-');
    yoyKey = `${Number(yStr) - 1}-${mStr}`;
  } else if (series.xAxis.unit === 'quarter') {
    const [yStr, qStr] = current.x.split('-Q');
    yoyKey = `${Number(yStr) - 1}-Q${qStr}`;
  } else if (series.xAxis.unit === 'year') {
    yoyKey = String(Number(current.x) - 1);
  }
  const yoyPoint = yoyKey ? data.find(p => p.x === yoyKey) : undefined;
  const yoyDeltaAbs = yoyPoint ? current.y - yoyPoint.y : undefined;
  const yoyDeltaPct = yoyPoint && yoyPoint.y ? (yoyDeltaAbs! / yoyPoint.y) * 100 : undefined;

  const windowSize = series.xAxis.unit === 'month' ? 12 : series.xAxis.unit === 'quarter' ? 8 : 5;
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

