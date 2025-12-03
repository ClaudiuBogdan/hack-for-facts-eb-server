import { type Result } from 'neverthrow';

import type { AnalyticsError } from './errors.js';
import type { Dataset } from '../../datasets/index.js';
import type {
  NormalizationMode,
  NormalizationOptions,
  AnalyticsFilter,
  PeriodType,
} from '@/common/types/analytics.js';
import type { DataSeries } from '@/common/types/temporal.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

// Re-export common types
export type {
  AnalyticsFilter,
  NormalizationOptions,
  PeriodType,
  AnalyticsSeries,
  Axis,
  AnalyticsDataPoint,
  NormalizationMode,
  Currency,
} from '@/common/types/analytics.js';

// -----------------------------------------
// Extended Types for Input (Handling Legacy)
// -----------------------------------------

// Legacy normalization types allowed in input but mapped to strict NormalizationMode
export type LegacyNormalizationMode = NormalizationMode | 'total_euro' | 'per_capita_euro';

export interface InputNormalizationOptions extends Omit<NormalizationOptions, 'normalization'> {
  normalization: LegacyNormalizationMode;
}

export interface AnalyticsInput {
  seriesId?: string;
  filter: AnalyticsFilter & InputNormalizationOptions;
}

// -----------------------------------------
// Internal Types
// -----------------------------------------

/**
 * Processing context for the normalization pipeline.
 *
 * Contains the filter options and loaded datasets needed for transformation.
 * The datasets are loaded lazily based on which transformations are requested.
 */
export interface ProcessingContext {
  filter: NormalizationOptions;
  granularity: PeriodType;
  population?: number;
  datasets: {
    cpi?: Dataset;
    exchange?: Dataset;
    gdp?: Dataset;
    population?: Dataset;
  };
}

/**
 * Intermediate data point used during normalization processing.
 *
 * Contains the parsed year for efficient factor lookups during transformation.
 * The y value is a number for GraphQL compatibility, but internal calculations
 * use Decimal for precision.
 */
export interface IntermediatePoint {
  x: string; // Original label (YYYY, YYYY-MM, or YYYY-QN)
  year: number; // Parsed year for factor lookups
  y: number; // Value (number for GraphQL output)
}

// -----------------------------------------
// Dependencies
// -----------------------------------------

export interface AnalyticsDeps {
  budgetDb: BudgetDbClient;
}

// -----------------------------------------
// Repository Interface
// -----------------------------------------

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
 *
 * Example: To get inflation-adjusted total spending from 2020-2023:
 * - Fetch yearly spending: [2020: 100B, 2021: 110B, 2022: 120B, 2023: 130B]
 * - Apply CPI adjustment per year (each year has different factor)
 * - Sum the adjusted values: 100*1.3 + 110*1.2 + 120*1.1 + 130*1.0 = 512B
 *
 * If we aggregated first (460B total) and then tried to apply inflation,
 * we wouldn't know which year's CPI to use, leading to incorrect results.
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
