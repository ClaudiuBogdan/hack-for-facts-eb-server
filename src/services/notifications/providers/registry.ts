import type { Notification } from '../types';
import type { AnalyticsSeries } from '../../../types';
import { fetchAnalyticsSeries } from './seriesAnalyticsProvider';
import { fetchStaticSeries } from './seriesStaticProvider';

export interface ProviderResult {
  series: AnalyticsSeries;
  metadata?: Record<string, any>;
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


