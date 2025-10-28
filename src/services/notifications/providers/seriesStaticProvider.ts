import type { Notification } from '../types';
import type { AnalyticsSeries } from '../../../types';
import { staticDatasetsRepository } from '../../../db/repositories/staticDatasetsRepository';
import type { StaticSeriesAlertConfig } from '../../../schemas/alerts';

export async function fetchStaticSeries(
  notification: Notification,
  periodKey: string
): Promise<{ series: AnalyticsSeries; metadata?: Record<string, unknown> } | null> {
  const config = notification.config as StaticSeriesAlertConfig | null;
  const datasetId = config?.datasetId;
  if (!datasetId) return null;

  const dataset = await staticDatasetsRepository.getDatasetById(datasetId);
  const series: AnalyticsSeries = {
    seriesId: dataset.id,
    xAxis: {
      name: dataset.xAxis.name,
      type: dataset.xAxis.type as any,
      unit: dataset.xAxis.unit,
    },
    yAxis: {
      name: dataset.yAxis.name,
      type: dataset.yAxis.type as any,
      unit: dataset.yAxis.unit,
    },
    data: dataset.data.map((p) => ({ x: String(p.x), y: p.y })),
  };

  return {
    series,
    metadata: {
      periodKey,
      datasetId,
      sourceName: dataset.sourceName,
      sourceUrl: dataset.sourceUrl,
    },
  };
}


