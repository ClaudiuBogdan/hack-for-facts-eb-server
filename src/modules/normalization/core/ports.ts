import type { DataPoint, NormalizationFactors, TransformationOptions } from './types.js';
import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { Frequency } from '@/common/types/temporal.js';
import type { Decimal } from 'decimal.js';
import type { Result } from 'neverthrow';

/**
 * Port for accessing normalization factor datasets.
 *
 * This interface abstracts the dataset repository dependency,
 * allowing the normalization module to be tested independently.
 */
export interface NormalizationDatasetProvider {
  /**
   * Loads a dataset by ID and returns its data points as a factor map.
   * @param id - The dataset ID (e.g., 'ro.economics.cpi.annual')
   * @returns Map of period labels to values, or error if dataset not found
   */
  getDatasetAsFactorMap(
    id: string
  ): Promise<Result<Map<string, import('decimal.js').Decimal>, DatasetProviderError>>;
}

/**
 * Error types for normalization dataset provider operations.
 */
export type DatasetProviderError =
  | { type: 'NotFound'; message: string }
  | { type: 'ParseError'; message: string };

/**
 * Port for the normalization service.
 *
 * Allows other modules to use normalization without depending
 * on the concrete NormalizationService implementation.
 */
export interface NormalizationPort {
  /**
   * Generates frequency-matched normalization factors.
   */
  generateFactors(
    frequency: Frequency,
    startYear: number,
    endYear: number
  ): Promise<NormalizationFactors>;

  /**
   * Normalizes data points using frequency-matched factors.
   */
  normalize(
    data: DataPoint[],
    options: TransformationOptions,
    frequency: Frequency,
    yearRange: [number, number]
  ): Promise<Result<DataPoint[], string>>;

  /**
   * Clears the cached datasets.
   */
  invalidateCache(): void;
}

// -----------------------------------------
// Population Repository
// -----------------------------------------

/**
 * Error types for population repository operations.
 */
export type PopulationError =
  | { type: 'DatabaseError'; message: string; retryable: boolean }
  | { type: 'ValidationError'; message: string };

/**
 * Repository interface for computing filter-based population denominators.
 *
 * Used for per_capita normalization where the population denominator
 * depends on the entities/UATs selected by the filter, not year-specific
 * population data from datasets.
 *
 * IMPORTANT: Population for per_capita is filter-dependent (constant per query),
 * unlike CPI/exchange rates which are year-specific.
 */
export interface PopulationRepository {
  /**
   * Gets total country population (sum of county-level populations).
   *
   * Used when no entity-like filters are specified (default denominator).
   *
   * SQL logic:
   * - Bucharest (county_code = 'B'): Use SIRUTA 179132 (municipality level)
   * - Other counties: Use county-level UAT (where siruta_code = county_code)
   * - Sum across all counties (avoids double-counting sub-municipal UATs)
   *
   * @returns Total country population as Decimal
   */
  getCountryPopulation(): Promise<Result<Decimal, PopulationError>>;

  /**
   * Gets population for entities/UATs matching the filter.
   *
   * Handles complex cases:
   * - Entity CUIs → resolve to UAT IDs
   * - County codes → use county-level populations
   * - County councils → map to county population
   * - Deduplication (UATs in already-selected counties)
   *
   * @param filter - Analytics filter with entity constraints
   * @returns Sum of populations for matching UATs/counties
   */
  getFilteredPopulation(filter: AnalyticsFilter): Promise<Result<Decimal, PopulationError>>;
}
