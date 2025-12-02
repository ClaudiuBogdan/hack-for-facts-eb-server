/* eslint-disable @typescript-eslint/naming-convention -- Matching database and GraphQL schema naming */
import { type Result } from 'neverthrow';

import type { AnalyticsError } from './errors.js';
import type { Dataset } from '../../datasets/index.js';
import type {
  NormalizationMode,
  NormalizationOptions,
  AnalyticsFilter,
  PeriodType,
} from '@/common/types/analytics.js';
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

export interface IntermediatePoint {
  x: string; // Original label
  year: number; // Parsed for lookups
  y: number; // Using number here to match spec, but implementation might use Decimal
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

export interface RawAnalyticsDataPoint {
  year: number;
  period_value: number; // Month (1-12) or Quarter (1-4) or Year (YYYY)
  amount: string; // Raw numeric from DB
}

export interface AnalyticsRepository {
  getAggregatedSeries(
    filter: AnalyticsFilter
  ): Promise<Result<RawAnalyticsDataPoint[], AnalyticsError>>;
}
