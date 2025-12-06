/**
 * County Analytics Module - Core Types
 *
 * Domain types for county-level heatmap analytics.
 */

import { Decimal } from 'decimal.js';

/**
 * Heatmap data point representing aggregated budget data for a single county.
 *
 * This is the repository output type with raw values.
 * Normalization (EUR conversion, per-capita) is applied in the use-case layer.
 */
export interface HeatmapCountyDataPoint {
  /** County code (e.g., 'CJ', 'TM', 'B') - primary identifier */
  county_code: string;

  /** County display name */
  county_name: string;

  /** Total county population (aggregated from all UATs in county) */
  county_population: number;

  /** County entity CUI (used for county_entity field resolver) */
  county_entity_cui: string | null;

  /** Year of the data (used for multi-year EUR conversion) */
  year: number;

  /** Raw aggregated amount in RON */
  total_amount: Decimal;
}

/**
 * Normalized county heatmap data point ready for GraphQL output.
 *
 * All amounts are converted to the target normalization mode.
 */
export interface NormalizedCountyHeatmapDataPoint {
  county_code: string;
  county_name: string;
  county_population: number;
  county_entity_cui: string | null;

  /** Primary display amount (based on normalization mode) */
  amount: number;

  /** Total amount (RON or EUR based on currency mode) */
  total_amount: number;

  /** Per-capita amount (always calculated for display) */
  per_capita_amount: number;
}

/**
 * Re-export transformation options from UAT Analytics for consistency.
 *
 * Following the normalization pipeline order:
 * 1. Inflation adjustment (if inflationAdjusted=true)
 * 2. Currency conversion (if currency=EUR)
 * 3. Aggregate by county
 * 4. Per-capita (if perCapita=true)
 */
export type {
  HeatmapTransformationOptions as CountyHeatmapTransformationOptions,
  HeatmapCurrency,
  HeatmapNormalizationMode,
} from '@/modules/uat-analytics/core/types.js';
