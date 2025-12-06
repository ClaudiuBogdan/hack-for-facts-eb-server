/**
 * UAT Analytics Module - Core Types
 *
 * Domain types for UAT heatmap analytics.
 */

import { Decimal } from 'decimal.js';

/**
 * Heatmap data point representing aggregated budget data for a single UAT.
 *
 * This is the repository output type with raw values.
 * Normalization (EUR conversion, per-capita) is applied in the use-case layer.
 */
export interface HeatmapUATDataPoint {
  /** UAT database ID (number in DB, converted to string for GraphQL) */
  uat_id: number;

  /** UAT code (used for entity_cui matching) */
  uat_code: string;

  /** UAT display name */
  uat_name: string;

  /** SIRUTA code - unique UAT identifier in Romanian administrative system */
  siruta_code: string;

  /** County code (e.g., 'CJ', 'TM') */
  county_code: string | null;

  /** County name */
  county_name: string | null;

  /** Region name (e.g., 'Nord-Vest') */
  region: string | null;

  /** UAT population (used for per-capita calculations) */
  population: number | null;

  /** Year of the data (used for multi-year EUR conversion) */
  year: number;

  /** Raw aggregated amount in RON */
  total_amount: Decimal;
}

/**
 * Normalized heatmap data point ready for GraphQL output.
 *
 * All amounts are converted to the target normalization mode.
 */
export interface NormalizedHeatmapDataPoint {
  uat_id: number;
  uat_code: string;
  uat_name: string;
  siruta_code: string;
  county_code: string | null;
  county_name: string | null;
  region: string | null;
  population: number | null;

  /** Primary display amount (based on normalization mode) */
  amount: number;

  /** Total amount (RON or EUR based on currency mode) */
  total_amount: number;

  /** Per-capita amount (always calculated for display) */
  per_capita_amount: number;
}

/**
 * Normalization mode for heatmap data.
 *
 * Controls the primary display amount:
 * - total: Raw total in RON or EUR
 * - per_capita: Divided by UAT population
 */
export type HeatmapNormalizationMode = 'total' | 'per_capita';

/**
 * Currency for heatmap data output.
 */
export type HeatmapCurrency = 'RON' | 'EUR';

/**
 * Transformation options for heatmap normalization.
 *
 * Following the normalization pipeline order:
 * 1. Inflation adjustment (if inflationAdjusted=true)
 * 2. Currency conversion (if currency=EUR)
 * 3. Aggregate by UAT
 * 4. Per-capita (if normalization=per_capita)
 */
export interface HeatmapTransformationOptions {
  /** Whether to adjust for inflation using CPI factors */
  inflationAdjusted: boolean;

  /** Target currency (RON or EUR) */
  currency: HeatmapCurrency;

  /** Whether to apply per-capita division using UAT population */
  perCapita: boolean;
}
