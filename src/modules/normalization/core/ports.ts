import type { DataPoint, NormalizationFactors, TransformationOptions } from './types.js';
import type { Frequency } from '@/common/types/temporal.js';
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
