import { ok, err, Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';

import {
  NORMALIZATION_DATASETS,
  getRequiredDatasetIds,
  type NormalizationDimension,
} from '../../core/dataset-registry.js';
import {
  generateFactorMap,
  datasetToFactorMap,
  type FactorDatasets,
  type FactorMap,
} from '../../core/factor-maps.js';
import { normalizeData } from '../../core/logic.js';

import type { DataPoint, NormalizationFactors, TransformationOptions } from '../../core/types.js';
import type { DatasetRepo } from '@/modules/datasets/index.js';

/**
 * Cached raw datasets (before frequency-specific generation).
 */
interface CachedDatasets {
  cpi: FactorDatasets;
  eur: FactorDatasets;
  usd: FactorDatasets;
  gdp: FactorDatasets;
  population: FactorDatasets;
}

/**
 * Error thrown when required normalization datasets are missing.
 */
export class NormalizationDatasetError extends Error {
  constructor(
    public readonly missingDatasets: string[],
    public readonly errors: Map<string, string>
  ) {
    const details = missingDatasets
      .map((id) => `  - ${id}: ${errors.get(id) ?? 'Unknown error'}`)
      .join('\n');
    super(`Required normalization datasets are missing:\n${details}`);
    this.name = 'NormalizationDatasetError';
  }
}

/**
 * Service for normalizing financial data with frequency-matched factors.
 *
 * This service:
 * 1. Validates required datasets exist at initialization
 * 2. Loads datasets from the repository
 * 3. Generates frequency-matched factor maps (using fallback strategy)
 * 4. Applies normalization transformations
 *
 * See docs/normalization-factors.md for detailed rationale.
 *
 * IMPORTANT: Use `NormalizationService.create()` to instantiate.
 * The constructor is private to ensure validation runs before use.
 */
export class NormalizationService {
  private cachedDatasets: CachedDatasets | null = null;

  private constructor(private readonly datasetRepo: DatasetRepo) {}

  /**
   * Creates and validates a NormalizationService.
   *
   * Validates that all required normalization datasets exist before
   * returning the service. Throws NormalizationDatasetError if any
   * required datasets are missing.
   *
   * @param datasetRepo - The dataset repository
   * @throws NormalizationDatasetError if required datasets are missing
   */
  static async create(datasetRepo: DatasetRepo): Promise<NormalizationService> {
    const service = new NormalizationService(datasetRepo);
    await service.validateRequiredDatasets();
    return service;
  }

  /**
   * Validates that all required normalization datasets exist.
   * @throws NormalizationDatasetError if any required datasets are missing
   */
  private async validateRequiredDatasets(): Promise<void> {
    const requiredIds = getRequiredDatasetIds();
    const missingDatasets: string[] = [];
    const errors = new Map<string, string>();

    const results = await Promise.all(
      requiredIds.map(async (id) => {
        const result = await this.datasetRepo.getById(id);
        return { id, result };
      })
    );

    for (const { id, result } of results) {
      if (result.isErr()) {
        missingDatasets.push(id);
        errors.set(id, result.error.message);
      }
    }

    if (missingDatasets.length > 0) {
      throw new NormalizationDatasetError(missingDatasets, errors);
    }
  }

  /**
   * Loads a dataset and converts to FactorMap.
   */
  private async loadDatasetAsFactorMap(id: string): Promise<FactorMap> {
    const result = await this.datasetRepo.getById(id);

    if (result.isErr()) {
      // This should not happen after validation, but handle gracefully
      console.warn(`[NormalizationService] Failed to load dataset ${id}: ${result.error.message}`);
      return new Map();
    }

    return datasetToFactorMap(result.value.points);
  }

  /**
   * Loads a dimension's datasets at all available frequencies.
   */
  private async loadDimensionDatasets(dimension: NormalizationDimension): Promise<FactorDatasets> {
    const config = NORMALIZATION_DATASETS[dimension];

    const yearly = await this.loadDatasetAsFactorMap(config.yearly);

    const result: FactorDatasets = { yearly };

    if (config.quarterly !== undefined) {
      result.quarterly = await this.loadDatasetAsFactorMap(config.quarterly);
    }

    if (config.monthly !== undefined) {
      result.monthly = await this.loadDatasetAsFactorMap(config.monthly);
    }

    return result;
  }

  /**
   * Loads all required datasets (cached).
   */
  private async loadDatasets(): Promise<CachedDatasets> {
    if (this.cachedDatasets !== null) return this.cachedDatasets;

    const [cpi, eur, usd, gdp, population] = await Promise.all([
      this.loadDimensionDatasets('cpi'),
      this.loadDimensionDatasets('eur'),
      this.loadDimensionDatasets('usd'),
      this.loadDimensionDatasets('gdp'),
      this.loadDimensionDatasets('population'),
    ]);

    this.cachedDatasets = { cpi, eur, usd, gdp, population };

    return this.cachedDatasets;
  }

  /**
   * Generates frequency-matched normalization factors.
   *
   * @param frequency - Target frequency for the factor maps
   * @param startYear - First year in the data range
   * @param endYear - Last year in the data range
   */
  public async generateFactors(
    frequency: Frequency,
    startYear: number,
    endYear: number
  ): Promise<NormalizationFactors> {
    const datasets = await this.loadDatasets();

    return {
      cpi: generateFactorMap(frequency, startYear, endYear, datasets.cpi),
      eur: generateFactorMap(frequency, startYear, endYear, datasets.eur),
      usd: generateFactorMap(frequency, startYear, endYear, datasets.usd),
      gdp: generateFactorMap(frequency, startYear, endYear, datasets.gdp),
      population: generateFactorMap(frequency, startYear, endYear, datasets.population),
    };
  }

  /**
   * Normalizes data points using frequency-matched factors.
   *
   * @param data - Data points to normalize (must have x as period label)
   * @param options - Transformation options
   * @param frequency - Frequency of the data (determines factor matching)
   * @param yearRange - Year range for factor generation [start, end]
   */
  public async normalize(
    data: DataPoint[],
    options: TransformationOptions,
    frequency: Frequency,
    yearRange: [number, number]
  ): Promise<Result<DataPoint[], string>> {
    try {
      const factors = await this.generateFactors(frequency, yearRange[0], yearRange[1]);
      const normalized = normalizeData(data, options, factors);
      return ok(normalized);
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Clears the cached datasets.
   * Call this if datasets are updated and need to be reloaded.
   */
  public invalidateCache(): void {
    this.cachedDatasets = null;
  }
}
