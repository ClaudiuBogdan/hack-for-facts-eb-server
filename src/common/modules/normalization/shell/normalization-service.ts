import { Decimal } from 'decimal.js';
import { ok, err, Result } from 'neverthrow';

import { normalizeData } from '../core/logic.js';
import { DataPoint, NormalizationFactors, TransformationOptions } from '../core/types.js';

import type { DatasetRepo } from '@/modules/datasets/index.js';

// Dataset IDs
const DATASET_IDS = {
  CPI: 'ro.economics.cpi.annual',
  EUR: 'ro.economics.exchange.ron_eur.annual',
  USD: 'ro.economics.exchange.ron_usd.annual',
  GDP: 'ro.economics.gdp.annual',
  POPULATION: 'ro.demographics.population.annual',
} as const;

export class NormalizationService {
  private factors: NormalizationFactors | null = null;

  constructor(private readonly datasetRepo: DatasetRepo) {}

  private async getDatasetMap(id: string): Promise<Map<number, Decimal>> {
    const result = await this.datasetRepo.getById(id);
    const map = new Map<number, Decimal>();

    if (result.isErr()) {
      // We log warning but return empty map so the app doesn't crash if optional dataset is missing.
      // For critical datasets (like CPI if inflation adjustment is requested), logic will default to factor 1.0.
      // In a stricter system, we might want to fail if specific options are requested but data is missing.
      console.warn(`[NormalizationService] Failed to load dataset ${id}: ${result.error.message}`);
      return map;
    }

    const dataset = result.value;
    for (const point of dataset.points) {
      // Parse year from x (e.g. "2023", "2023-Q1", "2023-01")
      // We assume the first 4 chars are the year.
      const yearStr = point.x.substring(0, 4);
      const year = parseInt(yearStr, 10);
      if (!isNaN(year)) {
        map.set(year, point.y);
      }
    }
    return map;
  }

  private async loadFactors(): Promise<NormalizationFactors> {
    if (this.factors !== null) return this.factors;

    const [cpi, eur, usd, gdp, population] = await Promise.all([
      this.getDatasetMap(DATASET_IDS.CPI),
      this.getDatasetMap(DATASET_IDS.EUR),
      this.getDatasetMap(DATASET_IDS.USD),
      this.getDatasetMap(DATASET_IDS.GDP),
      this.getDatasetMap(DATASET_IDS.POPULATION),
    ]);

    this.factors = { cpi, eur, usd, gdp, population };
    return this.factors;
  }

  /**
   * Normalizes the given data points based on the provided options.
   * Fetches necessary datasets (CPI, Exchange Rates, etc.) from the repository if not cached.
   */
  public async normalize(
    data: DataPoint[],
    options: TransformationOptions
  ): Promise<Result<DataPoint[], string>> {
    try {
      const factors = await this.loadFactors();
      const normalized = normalizeData(data, options, factors);
      return ok(normalized);
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  }

  public invalidateCache() {
    this.factors = null;
  }
}

export function createNormalizationService(repo: DatasetRepo): NormalizationService {
  return new NormalizationService(repo);
}
