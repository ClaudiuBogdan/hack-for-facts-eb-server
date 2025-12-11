/**
 * Normalization Dataset Registry
 *
 * Defines the required datasets for each normalization dimension,
 * grouped by frequency. The system validates these datasets exist
 * at startup.
 *
 * FALLBACK STRATEGY:
 * - If monthly exists → can generate quarterly and yearly
 * - If quarterly exists → can generate yearly
 * - Yearly is the minimum required for each dimension
 */

import { Frequency } from '@/common/types/temporal.js';

/**
 * Normalization dimensions.
 */
export type NormalizationDimension = 'cpi' | 'eur' | 'usd' | 'gdp' | 'population';

/**
 * Dataset frequency levels.
 */
export type DatasetFrequency = 'yearly' | 'quarterly' | 'monthly';

/**
 * Maps Frequency enum to DatasetFrequency.
 */
export function frequencyToDatasetFrequency(frequency: Frequency): DatasetFrequency {
  switch (frequency) {
    case Frequency.MONTH:
      return 'monthly';
    case Frequency.QUARTER:
      return 'quarterly';
    case Frequency.YEAR:
      return 'yearly';
  }
}

/**
 * Dataset configuration for a dimension.
 */
export interface DimensionDatasets {
  /** Dataset ID for yearly data (required) */
  yearly: string;
  /** Dataset ID for quarterly data (optional) */
  quarterly?: string;
  /** Dataset ID for monthly data (optional) */
  monthly?: string;
}

/**
 * Complete registry of normalization datasets.
 */
export interface NormalizationDatasetRegistry {
  cpi: DimensionDatasets;
  eur: DimensionDatasets;
  usd: DimensionDatasets;
  gdp: DimensionDatasets;
  population: DimensionDatasets;
}

/**
 * The hardcoded dataset registry.
 *
 * This defines which datasets are required for normalization.
 * The yearly datasets are required; monthly/quarterly are optional
 * but provide better accuracy when available.
 */
export const NORMALIZATION_DATASETS: NormalizationDatasetRegistry = {
  /**
   * Consumer Price Index (CPI) - for inflation adjustment
   * Source: INSSE (Romanian National Institute of Statistics)
   */
  cpi: {
    yearly: 'ro.economics.cpi.yearly',
    // quarterly: 'ro.economics.cpi.quarterly', // Future
    // monthly: 'ro.economics.cpi.monthly', // Future
  },

  /**
   * RON/EUR Exchange Rate - for EUR currency conversion
   * Source: BNR (National Bank of Romania)
   */
  eur: {
    yearly: 'ro.economics.exchange.ron_eur.yearly',
    // quarterly: 'ro.economics.exchange.ron_eur.quarterly', // Future
    // monthly: 'ro.economics.exchange.ron_eur.monthly', // Future
  },

  /**
   * RON/USD Exchange Rate - for USD currency conversion
   * Source: BNR (National Bank of Romania)
   */
  usd: {
    yearly: 'ro.economics.exchange.ron_usd.yearly',
    // quarterly: 'ro.economics.exchange.ron_usd.quarterly', // Future
    // monthly: 'ro.economics.exchange.ron_usd.monthly', // Future
  },

  /**
   * Gross Domestic Product (GDP) - for percent_gdp normalization
   * Source: INSSE
   * Note: GDP is only available yearly (sometimes quarterly)
   */
  gdp: {
    yearly: 'ro.economics.gdp.yearly',
    // quarterly: 'ro.economics.gdp.quarterly', // Future
    // Monthly GDP doesn't exist
  },

  /**
   * Population - for per_capita normalization
   * Source: INSSE
   * Note: Population is typically only available yearly
   */
  population: {
    yearly: 'ro.demographics.population.yearly',
    // Population doesn't change significantly within a year
  },
};

/**
 * Gets all required dataset IDs (yearly datasets for each dimension).
 */
export function getRequiredDatasetIds(): string[] {
  return [
    NORMALIZATION_DATASETS.cpi.yearly,
    NORMALIZATION_DATASETS.eur.yearly,
    NORMALIZATION_DATASETS.usd.yearly,
    NORMALIZATION_DATASETS.gdp.yearly,
    NORMALIZATION_DATASETS.population.yearly,
  ];
}

/**
 * Gets all dataset IDs (including optional ones) for a dimension.
 */
export function getDimensionDatasetIds(dimension: NormalizationDimension): string[] {
  const config = NORMALIZATION_DATASETS[dimension];
  const ids: string[] = [config.yearly];

  if (config.quarterly !== undefined) {
    ids.push(config.quarterly);
  }

  if (config.monthly !== undefined) {
    ids.push(config.monthly);
  }

  return ids;
}

/**
 * Gets all dataset IDs in the registry (required and optional).
 */
export function getAllDatasetIds(): string[] {
  const dimensions: NormalizationDimension[] = ['cpi', 'eur', 'usd', 'gdp', 'population'];
  const ids: string[] = [];

  for (const dimension of dimensions) {
    ids.push(...getDimensionDatasetIds(dimension));
  }

  return ids;
}

/**
 * Gets the best available dataset ID for a dimension at a given frequency.
 *
 * Returns the dataset at the requested frequency if available,
 * otherwise falls back to the next available lower frequency.
 *
 * @param dimension - The normalization dimension
 * @param frequency - The requested frequency
 * @returns The best available dataset ID
 */
export function getBestAvailableDatasetId(
  dimension: NormalizationDimension,
  frequency: DatasetFrequency
): string {
  const config = NORMALIZATION_DATASETS[dimension];

  if (frequency === 'monthly' && config.monthly !== undefined) {
    return config.monthly;
  }

  if ((frequency === 'monthly' || frequency === 'quarterly') && config.quarterly !== undefined) {
    return config.quarterly;
  }

  // Always fall back to yearly (required)
  return config.yearly;
}

/**
 * Checks if higher frequency data is available for a dimension.
 */
export function hasHigherFrequencyData(
  dimension: NormalizationDimension,
  frequency: DatasetFrequency
): boolean {
  const config = NORMALIZATION_DATASETS[dimension];

  if (frequency === 'yearly') {
    return config.quarterly !== undefined || config.monthly !== undefined;
  }

  if (frequency === 'quarterly') {
    return config.monthly !== undefined;
  }

  return false;
}
