import { Decimal } from 'decimal.js';
import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  NormalizationService,
  NormalizationDatasetError,
  getRequiredDatasetIds,
} from '@/modules/normalization/index.js';

import { makeFakeDatasetRepo } from '../../fixtures/fakes.js';

import type { Dataset } from '@/modules/datasets/index.js';
import type { DataPoint, TransformationOptions } from '@/modules/normalization/core/types.js';

/**
 * Creates a mock dataset with the given points.
 */
function createMockDataset(id: string, points: { x: string; y: string }[]): Dataset {
  return {
    id,
    metadata: {
      id,
      source: 'Test',
      sourceUrl: 'https://test.example.com',
      lastUpdated: '2024-01-01',
      units: 'test_units',
    },
    i18n: {
      ro: {
        title: `Test Dataset: ${id}`,
        xAxisLabel: 'Perioadă',
        yAxisLabel: 'Valoare',
      },
      en: {
        title: `Test Dataset: ${id}`,
        xAxisLabel: 'Period',
        yAxisLabel: 'Value',
      },
    },
    axes: {
      x: { label: 'Period', type: 'date', frequency: 'yearly', format: 'YYYY' },
      y: { label: 'Value', type: 'number', unit: 'test' },
    },
    points: points.map((p) => ({ x: p.x, y: new Decimal(p.y) })),
  };
}

/**
 * Creates all required datasets with default mock values.
 */
function createAllRequiredDatasets(): Record<string, Dataset> {
  return {
    'ro.economics.cpi.yearly': createMockDataset('ro.economics.cpi.yearly', [
      { x: '2023', y: '1.1' },
      { x: '2024', y: '1.0' },
    ]),
    'ro.economics.exchange.ron_eur.yearly': createMockDataset(
      'ro.economics.exchange.ron_eur.yearly',
      [
        { x: '2023', y: '5.0' },
        { x: '2024', y: '5.0' },
      ]
    ),
    'ro.economics.exchange.ron_usd.yearly': createMockDataset(
      'ro.economics.exchange.ron_usd.yearly',
      [
        { x: '2023', y: '4.5' },
        { x: '2024', y: '4.6' },
      ]
    ),
    'ro.economics.gdp.yearly': createMockDataset('ro.economics.gdp.yearly', [
      { x: '2023', y: '1000000' },
      { x: '2024', y: '1100000' },
    ]),
    'ro.demographics.population.yearly': createMockDataset('ro.demographics.population.yearly', [
      { x: '2023', y: '19000000' },
      { x: '2024', y: '19000000' },
    ]),
  };
}

describe('NormalizationService', () => {
  describe('create() - Validation', () => {
    it('should create service successfully when all datasets exist', async () => {
      const datasets = createAllRequiredDatasets();
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });

      const service = await NormalizationService.create(repo);

      expect(service).toBeInstanceOf(NormalizationService);
    });

    it('should throw NormalizationDatasetError when datasets are missing', async () => {
      const repo = makeFakeDatasetRepo({ includeNormalizationDatasets: false }); // Empty repo

      await expect(NormalizationService.create(repo)).rejects.toThrow(NormalizationDatasetError);
    });

    it('should include all missing dataset IDs in error', async () => {
      const repo = makeFakeDatasetRepo({ includeNormalizationDatasets: false });

      try {
        await NormalizationService.create(repo);
        expect.fail('Should have thrown NormalizationDatasetError');
      } catch (error) {
        expect(error).toBeInstanceOf(NormalizationDatasetError);
        const datasetError = error as NormalizationDatasetError;

        const requiredIds = getRequiredDatasetIds();
        expect(datasetError.missingDatasets).toHaveLength(requiredIds.length);
        for (const id of requiredIds) {
          expect(datasetError.missingDatasets).toContain(id);
        }
      }
    });

    it('should throw when only some datasets are missing', async () => {
      // Only provide CPI dataset
      const datasets = {
        'ro.economics.cpi.yearly': createMockDataset('ro.economics.cpi.yearly', [
          { x: '2023', y: '1.1' },
        ]),
      };
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });

      try {
        await NormalizationService.create(repo);
        expect.fail('Should have thrown NormalizationDatasetError');
      } catch (error) {
        expect(error).toBeInstanceOf(NormalizationDatasetError);
        const datasetError = error as NormalizationDatasetError;

        // Should be missing 4 datasets (all except CPI)
        expect(datasetError.missingDatasets).toHaveLength(4);
        expect(datasetError.missingDatasets).not.toContain('ro.economics.cpi.yearly');
        expect(datasetError.missingDatasets).toContain('ro.economics.exchange.ron_eur.yearly');
      }
    });

    it('should include error messages for each missing dataset', async () => {
      const repo = makeFakeDatasetRepo({ includeNormalizationDatasets: false });

      try {
        await NormalizationService.create(repo);
        expect.fail('Should have thrown NormalizationDatasetError');
      } catch (error) {
        expect(error).toBeInstanceOf(NormalizationDatasetError);
        const datasetError = error as NormalizationDatasetError;

        // Each missing dataset should have an error message
        for (const id of datasetError.missingDatasets) {
          expect(datasetError.errors.has(id)).toBe(true);
          expect(datasetError.errors.get(id)).toContain('not found');
        }
      }
    });

    it('should format error message with all missing datasets', async () => {
      const repo = makeFakeDatasetRepo({ includeNormalizationDatasets: false });

      try {
        await NormalizationService.create(repo);
        expect.fail('Should have thrown NormalizationDatasetError');
      } catch (error) {
        expect(error).toBeInstanceOf(NormalizationDatasetError);
        const datasetError = error as NormalizationDatasetError;

        // Error message should contain all missing dataset IDs
        const message = datasetError.message;
        expect(message).toContain('Required normalization datasets are missing');
        expect(message).toContain('ro.economics.cpi.yearly');
        expect(message).toContain('ro.demographics.population.yearly');
      }
    });
  });

  describe('generateFactors()', () => {
    it('should generate yearly factors from datasets', async () => {
      const datasets = createAllRequiredDatasets();
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });
      const service = await NormalizationService.create(repo);

      const factors = await service.generateFactors(Frequency.YEAR, 2023, 2024);

      expect(factors.cpi.get('2023')?.toNumber()).toBe(1.1);
      expect(factors.cpi.get('2024')?.toNumber()).toBe(1);
      expect(factors.eur.get('2023')?.toNumber()).toBe(5);
      expect(factors.usd.get('2023')?.toNumber()).toBe(4.5);
      expect(factors.gdp.get('2023')?.toNumber()).toBe(1000000);
      expect(factors.population.get('2023')?.toNumber()).toBe(19000000);
    });

    it('should generate monthly factors with yearly fallback', async () => {
      const datasets = createAllRequiredDatasets();
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });
      const service = await NormalizationService.create(repo);

      const factors = await service.generateFactors(Frequency.MONTH, 2023, 2023);

      // Should have 12 months
      expect(factors.cpi.size).toBe(12);

      // All months should use yearly fallback (1.1)
      expect(factors.cpi.get('2023-01')?.toNumber()).toBe(1.1);
      expect(factors.cpi.get('2023-06')?.toNumber()).toBe(1.1);
      expect(factors.cpi.get('2023-12')?.toNumber()).toBe(1.1);
    });

    it('should generate quarterly factors with yearly fallback', async () => {
      const datasets = createAllRequiredDatasets();
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });
      const service = await NormalizationService.create(repo);

      const factors = await service.generateFactors(Frequency.QUARTER, 2023, 2024);

      // Should have 8 quarters (2 years)
      expect(factors.cpi.size).toBe(8);

      // 2023 quarters should use 2023 yearly value
      expect(factors.cpi.get('2023-Q1')?.toNumber()).toBe(1.1);
      expect(factors.cpi.get('2023-Q4')?.toNumber()).toBe(1.1);
      // 2024 quarters should use 2024 yearly value
      expect(factors.cpi.get('2024-Q1')?.toNumber()).toBe(1);
      expect(factors.cpi.get('2024-Q4')?.toNumber()).toBe(1);
    });

    it('should cache datasets between calls', async () => {
      const datasets = createAllRequiredDatasets();
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });
      const service = await NormalizationService.create(repo);

      // First call loads datasets
      const factors1 = await service.generateFactors(Frequency.YEAR, 2023, 2024);
      // Second call should use cache
      const factors2 = await service.generateFactors(Frequency.YEAR, 2023, 2024);

      expect(factors1.cpi.get('2023')?.toNumber()).toBe(factors2.cpi.get('2023')?.toNumber());
    });
  });

  describe('normalize()', () => {
    it('should normalize data with yearly factors', async () => {
      const datasets = createAllRequiredDatasets();
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });
      const service = await NormalizationService.create(repo);

      const data: DataPoint[] = [
        { x: '2023', year: 2023, y: new Decimal(100) },
        { x: '2024', year: 2024, y: new Decimal(100) },
      ];
      const options: TransformationOptions = {
        normalization: 'total',
        currency: 'EUR',
        inflationAdjusted: true,
      };

      const result = await service.normalize(data, options, Frequency.YEAR, [2023, 2024]);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 2023: 100 * 1.1 (CPI) / 5.0 (EUR) = 22
        expect(result.value[0]!.y.toNumber()).toBe(22);
        // 2024: 100 * 1.0 (CPI) / 5.0 (EUR) = 20
        expect(result.value[1]!.y.toNumber()).toBe(20);
      }
    });

    it('should normalize percent_gdp', async () => {
      const datasets = createAllRequiredDatasets();
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });
      const service = await NormalizationService.create(repo);

      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(10000) }];
      const options: TransformationOptions = {
        normalization: 'percent_gdp',
        currency: 'RON',
        inflationAdjusted: false,
      };

      const result = await service.normalize(data, options, Frequency.YEAR, [2023, 2023]);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 10000 / 1000000 * 100 = 1%
        expect(result.value[0]!.y.toNumber()).toBe(1);
      }
    });

    it('should normalize per_capita', async () => {
      const datasets = createAllRequiredDatasets();
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });
      const service = await NormalizationService.create(repo);

      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(19000000) }];
      const options: TransformationOptions = {
        normalization: 'per_capita',
        currency: 'RON',
        inflationAdjusted: false,
      };

      const result = await service.normalize(data, options, Frequency.YEAR, [2023, 2023]);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 19000000 / 19000000 = 1 per capita
        expect(result.value[0]!.y.toNumber()).toBe(1);
      }
    });

    it('should return Result.ok with normalized data', async () => {
      const datasets = createAllRequiredDatasets();
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });
      const service = await NormalizationService.create(repo);

      const data: DataPoint[] = [{ x: '2023', year: 2023, y: new Decimal(100) }];
      const options: TransformationOptions = {
        normalization: 'total',
        currency: 'RON',
        inflationAdjusted: false,
      };

      const result = await service.normalize(data, options, Frequency.YEAR, [2023, 2023]);

      expect(result.isOk()).toBe(true);
      expect(result.isErr()).toBe(false);
    });
  });

  describe('invalidateCache()', () => {
    it('should clear cached datasets', async () => {
      const datasets = createAllRequiredDatasets();
      const repo = makeFakeDatasetRepo({ datasets, includeNormalizationDatasets: false });
      const service = await NormalizationService.create(repo);

      // Generate factors to populate cache
      await service.generateFactors(Frequency.YEAR, 2023, 2024);

      // Invalidate cache
      service.invalidateCache();

      // Next call should reload datasets (we can't easily test this without more complex mocking,
      // but at least verify the method doesn't throw)
      const factors = await service.generateFactors(Frequency.YEAR, 2023, 2024);
      expect(factors.cpi.get('2023')?.toNumber()).toBe(1.1);
    });
  });
});

describe('NormalizationDatasetError', () => {
  it('should have correct error name', () => {
    const error = new NormalizationDatasetError(
      ['test.dataset'],
      new Map([['test.dataset', 'Not found']])
    );
    expect(error.name).toBe('NormalizationDatasetError');
  });

  it('should expose missingDatasets property', () => {
    const missing = ['test.dataset.1', 'test.dataset.2'];
    const errors = new Map([
      ['test.dataset.1', 'Not found'],
      ['test.dataset.2', 'Access denied'],
    ]);
    const error = new NormalizationDatasetError(missing, errors);

    expect(error.missingDatasets).toEqual(missing);
    expect(error.errors).toEqual(errors);
  });

  it('should format message with dataset details', () => {
    const missing = ['test.dataset.1'];
    const errors = new Map([['test.dataset.1', 'Dataset not found']]);
    const error = new NormalizationDatasetError(missing, errors);

    expect(error.message).toContain('test.dataset.1');
    expect(error.message).toContain('Dataset not found');
  });
});
