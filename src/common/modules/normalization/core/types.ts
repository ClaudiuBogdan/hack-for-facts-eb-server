import { Decimal } from 'decimal.js';

/**
 * Supported currencies for normalization.
 */
export type Currency = 'RON' | 'EUR' | 'USD';

/**
 * Normalization modes.
 * - 'total': Standard value (possibly adjusted for inflation/currency).
 * - 'per_capita': Value divided by population.
 * - 'percent_gdp': Value divided by nominal GDP.
 */
export type NormalizationMode = 'total' | 'per_capita' | 'percent_gdp';

/**
 * Granularity of the data.
 * Used to parse year from period labels.
 */
export type Granularity = 'ANNUAL' | 'QUARTERLY' | 'MONTHLY';

/**
 * Configuration for the transformation pipeline.
 */
export interface TransformationOptions {
  inflationAdjusted: boolean;
  currency: Currency;
  normalization: NormalizationMode;
  showPeriodGrowth?: boolean;
}

/**
 * External factors required for normalization.
 * These should be loaded by the Shell and passed to Core.
 *
 * All maps are Key: Year (number) -> Value: Factor (Decimal).
 */
export interface NormalizationFactors {
  cpi: Map<number, Decimal>; // Consumer Price Index (Inflation factor)
  eur: Map<number, Decimal>; // EUR Exchange Rate
  usd: Map<number, Decimal>; // USD Exchange Rate
  gdp: Map<number, Decimal>; // Nominal GDP
  population: Map<number, Decimal>; // Population
}

/**
 * A data point in the normalization pipeline.
 * 'y' is always a Decimal to ensure precision.
 */
export interface DataPoint {
  x: string; // Period label (e.g., "2023", "2023-Q1")
  year: number; // Extracted year for factor lookup
  y: Decimal; // The value
}
