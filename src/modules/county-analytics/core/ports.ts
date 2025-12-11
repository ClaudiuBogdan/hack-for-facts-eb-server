/**
 * County Analytics Module - Ports (Interfaces)
 *
 * Defines the interfaces for external dependencies.
 * Shell layer provides implementations.
 */

import type { CountyAnalyticsError } from './errors.js';
import type { HeatmapCountyDataPoint } from './types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { Result } from 'neverthrow';

/**
 * Repository interface for county analytics queries.
 *
 * The repository returns raw data aggregated by county with year grouping.
 * Normalization (EUR conversion, per-capita) is handled by the use-case layer.
 */
export interface CountyAnalyticsRepository {
  /**
   * Fetches heatmap data aggregated by county.
   *
   * Uses a dual-CTE approach:
   * 1. filtered_aggregates: Aggregate ExecutionLineItems by entity_cui
   * 2. county_info: Compute county metadata (population, entity_cui)
   * 3. Main query: LEFT JOIN to roll up entities -> counties
   *
   * Returns one row per (county, year) combination to support
   * year-by-year EUR conversion for multi-year queries.
   *
   * @param filter - Analytics filter with required fields:
   *   - account_category (required)
   *   - report_type (required)
   *   - report_period (required)
   * @returns Array of data points grouped by county and year
   */
  getHeatmapData(
    filter: AnalyticsFilter
  ): Promise<Result<HeatmapCountyDataPoint[], CountyAnalyticsError>>;
}
