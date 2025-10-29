import type { Notification } from '../types';
import type { AnalyticsSeries } from '../../../types';
import { fetchAnalyticsSeries } from './seriesAnalyticsProvider';
import { fetchStaticSeries } from './seriesStaticProvider';

export interface SeriesComparisonDelta { abs?: number; pct?: number }
export interface SeriesMeta {
  current?: { x: string; y: number };
  comparisons?: { prev?: SeriesComparisonDelta; yoy?: SeriesComparisonDelta };
  stats?: { min: number; max: number; avg: number; count: number };
  conditions?: Array<{ operator: 'gt'|'gte'|'lt'|'lte'|'eq'; threshold: number; unit: string; met: boolean }>;
  periodType?: 'MONTH' | 'QUARTER' | 'YEAR';
  periodKey?: string;
  datasetId?: string; sourceName?: string; sourceUrl?: string;
}

export interface ProviderResult {
  series: AnalyticsSeries;
  metadata?: SeriesMeta;
}

export async function fetchNotificationSeries(
  notification: Notification,
  periodKey: string
): Promise<ProviderResult | null> {
  if (notification.notificationType === 'alert_series_analytics') {
    return fetchAnalyticsSeries(notification, periodKey);
  }
  if (notification.notificationType === 'alert_series_static') {
    return fetchStaticSeries(notification, periodKey);
  }
  return null;
}
