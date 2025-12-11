import { Decimal } from 'decimal.js';

import type { FactorMap } from './factor-maps.js';
import type { Currency, NormalizationMode } from '@/common/types/analytics.js';
import type { NormalizableDataPoint } from '@/common/types/temporal.js';

// Re-export canonical types from analytics
export type { Currency, NormalizationMode } from '@/common/types/analytics.js';

// Re-export NormalizableDataPoint from temporal
export type { NormalizableDataPoint } from '@/common/types/temporal.js';

/**
 * Configuration for the transformation pipeline.
 *
 * IMPORTANT: This interface uses camelCase for internal processing.
 * The GraphQL layer uses snake_case (inflation_adjusted, show_period_growth)
 * which gets mapped to this interface by the resolvers.
 */
export interface TransformationOptions {
  /** Whether to adjust values for inflation to a reference year (typically 2024) */
  inflationAdjusted: boolean;
  /** Target currency for the output */
  currency: Currency;
  /** Normalization mode (total, per_capita, percent_gdp) */
  normalization: NormalizationMode;
  /** Whether to show period-over-period growth percentage */
  showPeriodGrowth?: boolean;
}

/**
 * Frequency-matched normalization factors.
 *
 * Each FactorMap is keyed by period label matching the data frequency:
 * - YEARLY: "2023", "2024"
 * - QUARTERLY: "2023-Q1", "2023-Q2"
 * - MONTHLY: "2023-01", "2023-02"
 *
 * Factor maps are generated at query time using generateFactorMap(),
 * which applies fallback logic (monthly → yearly) to ensure complete maps.
 *
 * These factors are applied per-period to each data point in a time series
 * BEFORE any aggregation is performed.
 */
export interface NormalizationFactors {
  /** CPI factors for inflation adjustment (reference year has factor 1.0) */
  cpi: FactorMap;
  /** RON to EUR exchange rates */
  eur: FactorMap;
  /** RON to USD exchange rates */
  usd: FactorMap;
  /** Nominal GDP values (for percent_gdp normalization) */
  gdp: FactorMap;
  /** Population values (for per_capita normalization) */
  population: FactorMap;
}

/**
 * A data point in the normalization pipeline.
 *
 * This type uses field names optimized for the normalization logic:
 * - x: period label for output/display
 * - year: pre-parsed for factor lookup efficiency
 * - y: value being transformed
 *
 * For new code, consider using NormalizableDataPoint from @/common/types/temporal.js
 * which uses more descriptive field names (date, year, value).
 */
export interface DataPoint {
  x: string; // Period label (e.g., "2023", "2023-Q1")
  year: number; // Extracted year for factor lookup
  y: Decimal; // The value
}

/**
 * Converts NormalizableDataPoint to legacy DataPoint format.
 */
export function toLegacyDataPoint(point: NormalizableDataPoint): DataPoint {
  return {
    x: point.date,
    year: point.year,
    y: point.value,
  };
}

/**
 * Converts legacy DataPoint to NormalizableDataPoint format.
 */
export function fromLegacyDataPoint(point: DataPoint): NormalizableDataPoint {
  return {
    date: point.x,
    year: point.year,
    value: point.y,
  };
}
