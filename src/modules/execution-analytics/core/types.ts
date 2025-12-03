import { Frequency } from '@/common/types/temporal.js';

import type { Dataset } from '../../datasets/index.js';
import type {
  NormalizationMode,
  NormalizationOptions,
  AnalyticsFilter,
  GqlReportPeriodInput,
} from '@/common/types/analytics.js';

// Re-export common types
export type {
  AnalyticsFilter,
  NormalizationOptions,
  AnalyticsSeries,
  Axis,
  AnalyticsDataPoint,
  NormalizationMode,
  Currency,
  PeriodType,
  GqlReportPeriodInput,
  PeriodSelection,
} from '@/common/types/analytics.js';
export { Frequency } from '@/common/types/temporal.js';

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
// GraphQL Input Types
// -----------------------------------------

/** GraphQL filter input - uses GqlReportPeriodInput with type field */
export interface GqlAnalyticsFilterInput extends Omit<AnalyticsFilter, 'report_period'> {
  report_period: GqlReportPeriodInput;
}

/** GraphQL analytics input */
export interface GqlAnalyticsInput {
  seriesId?: string;
  filter: GqlAnalyticsFilterInput & InputNormalizationOptions;
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
  frequency: Frequency;
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
