/**
 * Test fakes and mocks
 */

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import type { BudgetDbClient } from '@/infra/database/client.js';
import type {
  DatasetRepo,
  Dataset,
  DatasetRepoError,
  DatasetFileEntry,
} from '@/modules/datasets/index.js';

/**
 * Creates minimal fake datasets for normalization.
 * These are required for the NormalizationService to initialize.
 */
const createMinimalNormalizationDatasets = (): Record<string, Dataset> => {
  // Sample years for testing
  const years = [2020, 2021, 2022, 2023, 2024];

  const createYearlyDataset = (id: string, unit: string, values: number[]): Dataset => ({
    id,
    metadata: {
      id,
      source: 'test',
      lastUpdated: '2024-01-01',
      units: unit,
      frequency: 'yearly',
    },
    i18n: {
      ro: {
        title: `Test ${id}`,
        xAxisLabel: 'An',
        yAxisLabel: unit,
      },
    },
    axes: {
      x: { label: 'Year', type: 'date', frequency: 'yearly' },
      y: { label: 'Value', type: 'number', unit },
    },
    points: years.map((year, i) => ({
      x: String(year),
      y: new Decimal(values[i] ?? values[0] ?? 100),
    })),
  });

  return {
    // CPI dataset - values represent index (base 100)
    'ro.economics.cpi.yearly': createYearlyDataset(
      'ro.economics.cpi.yearly',
      'index',
      [100, 105, 118, 125, 130]
    ),
    // EUR exchange rate - RON per EUR
    'ro.economics.exchange.ron_eur.yearly': createYearlyDataset(
      'ro.economics.exchange.ron_eur.yearly',
      'RON/EUR',
      [4.87, 4.92, 4.93, 4.95, 4.97]
    ),
    // USD exchange rate - RON per USD
    'ro.economics.exchange.ron_usd.yearly': createYearlyDataset(
      'ro.economics.exchange.ron_usd.yearly',
      'RON/USD',
      [4.24, 4.16, 4.69, 4.57, 4.58]
    ),
    // GDP in millions RON
    'ro.economics.gdp.yearly': createYearlyDataset(
      'ro.economics.gdp.yearly',
      'million_ron',
      [1058000, 1182000, 1409000, 1580000, 1700000]
    ),
    // Population
    'ro.demographics.population.yearly': createYearlyDataset(
      'ro.demographics.population.yearly',
      'persons',
      [19328000, 19201000, 19053000, 18968000, 18900000]
    ),
  };
};

interface FakeDatasetRepoOptions {
  /** Custom datasets to include */
  datasets?: Record<string, Dataset>;
  /** If true, includes minimal normalization datasets (default: true) */
  includeNormalizationDatasets?: boolean;
}

/**
 * Creates a fake dataset repository for testing.
 *
 * By default, includes minimal normalization datasets required for the
 * NormalizationService to initialize. Pass `includeNormalizationDatasets: false`
 * to create an empty repo for testing validation errors.
 */
export const makeFakeDatasetRepo = (options: FakeDatasetRepoOptions = {}): DatasetRepo => {
  const { datasets: customDatasets = {}, includeNormalizationDatasets = true } = options;

  // Merge datasets based on options
  const datasets = includeNormalizationDatasets
    ? { ...createMinimalNormalizationDatasets(), ...customDatasets }
    : customDatasets;

  return {
    getById: async (id: string): Promise<Result<Dataset, DatasetRepoError>> => {
      const dataset = datasets[id];
      if (dataset != null) {
        return ok(dataset);
      }
      return err({ type: 'NotFound', message: `Dataset ${id} not found` });
    },
    listAvailable: async (): Promise<Result<DatasetFileEntry[], DatasetRepoError>> => {
      const entries: DatasetFileEntry[] = Object.keys(datasets).map((id) => ({
        id,
        absolutePath: `/fake/${id}.yaml`,
        relativePath: `${id}.yaml`,
      }));
      return ok(entries);
    },
  };
};

export const makeFakeBudgetDb = (): BudgetDbClient => {
  // This is a very basic fake.
  // If you need to mock query results, you might need a more sophisticated mock
  // using something like 'kysely-mock' or manually mocking the chainable methods.
  // For now, since we just need it to pass dependency injection checks,
  // we can cast an empty object or a partial mock.
  return {} as unknown as BudgetDbClient;
};
