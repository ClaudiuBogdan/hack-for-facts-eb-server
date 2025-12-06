/**
 * UAT Analytics Module - Ports (Interfaces)
 *
 * Defines the interfaces for external dependencies.
 * Shell layer provides implementations.
 */

import type { UATAnalyticsError } from './errors.js';
import type { HeatmapUATDataPoint } from './types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { Result } from 'neverthrow';

/**
 * Repository interface for UAT analytics queries.
 *
 * The repository returns raw data aggregated by UAT with year grouping.
 * Normalization (EUR conversion, per-capita) is handled by the use-case layer.
 */
export interface UATAnalyticsRepository {
  /**
   * Fetches heatmap data aggregated by UAT.
   *
   * Returns one row per (UAT, year) combination to support
   * year-by-year EUR conversion for multi-year queries.
   *
   * @param filter - Analytics filter with required fields:
   *   - account_category (required)
   *   - report_type (required)
   *   - report_period (required)
   * @returns Array of data points grouped by UAT and year
   */
  getHeatmapData(
    filter: AnalyticsFilter
  ): Promise<Result<HeatmapUATDataPoint[], UATAnalyticsError>>;
}
