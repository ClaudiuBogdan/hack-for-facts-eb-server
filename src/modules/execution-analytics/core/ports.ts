import { type Result } from 'neverthrow';

import type { AnalyticsError } from './errors.js';
import type { AnalyticsFilter } from './types.js';
import type { DataSeries } from '@/common/types/temporal.js';

/**
 * Repository interface for fetching analytics data.
 *
 * IMPORTANT: Aggregate-After-Normalize Pattern
 * --------------------------------------------
 * The repository ALWAYS returns data as a time series (DataSeries) with
 * individual data points per period (year, quarter, or month).
 *
 * This is critical because normalization factors (CPI for inflation,
 * exchange rates, GDP, population) vary by year. To correctly normalize
 * data that spans multiple years, we must:
 *
 * 1. Fetch raw data as time series from the database
 * 2. Apply normalization transformations per-period
 * 3. Aggregate (sum, average, etc.) AFTER normalization if needed
 */
export interface AnalyticsRepository {
  /**
   * Fetches aggregated time series data based on the filter.
   *
   * Returns data grouped by the period type specified in the filter
   * (YEAR, QUARTER, or MONTH). Each data point contains the sum of
   * all matching records for that period.
   *
   * The data is returned in nominal RON. Normalization (inflation,
   * currency, per-capita, etc.) is applied by the service layer
   * AFTER fetching.
   */
  getAggregatedSeries(filter: AnalyticsFilter): Promise<Result<DataSeries, AnalyticsError>>;
}
