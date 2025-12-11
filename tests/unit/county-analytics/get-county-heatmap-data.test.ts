import { Decimal } from 'decimal.js';
import { ok, err } from 'neverthrow';
import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { createDatabaseError } from '@/modules/county-analytics/core/errors.js';
import { getCountyHeatmapData } from '@/modules/county-analytics/core/usecases/get-county-heatmap-data.js';

import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { CountyAnalyticsRepository } from '@/modules/county-analytics/core/ports.js';
import type {
  HeatmapCountyDataPoint,
  CountyHeatmapTransformationOptions,
} from '@/modules/county-analytics/core/types.js';
import type { NormalizationService, NormalizationFactors } from '@/modules/normalization/index.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a county data point for testing.
 */
function createDataPoint(
  countyCode: string,
  year: number,
  amount: number,
  population = 500000
): HeatmapCountyDataPoint {
  return {
    county_code: countyCode,
    county_name: `County ${countyCode}`,
    county_population: population,
    county_entity_cui: `${countyCode}0001`,
    year,
    total_amount: new Decimal(amount),
  };
}

/**
 * Creates identity normalization factors.
 */
function createIdentityFactors(): NormalizationFactors {
  return {
    cpi: new Map([['2023', new Decimal(1)]]),
    eur: new Map([['2023', new Decimal(5)]]), // 5 RON per EUR for clear conversion
    usd: new Map([['2023', new Decimal(4.5)]]),
    gdp: new Map([['2023', new Decimal(1000000)]]),
    population: new Map([['2023', new Decimal(19000000)]]),
  };
}

/**
 * Creates a fake repository.
 */
function createFakeRepo(dataPoints: HeatmapCountyDataPoint[]): CountyAnalyticsRepository {
  return {
    getHeatmapData: async () => ok(dataPoints),
  };
}

/**
 * Creates a fake normalization service.
 */
function createFakeNormalizationService(
  factors: NormalizationFactors = createIdentityFactors()
): NormalizationService {
  return {
    generateFactors: async () => factors,
  } as unknown as NormalizationService;
}

/**
 * Creates the base filter input.
 */
function createBaseFilter(overrides: Partial<AnalyticsFilter> = {}): AnalyticsFilter {
  return {
    account_category: 'ch',
    report_period: {
      type: Frequency.YEAR,
      selection: { interval: { start: '2023', end: '2023' } },
    },
    report_type: 'PRINCIPAL_AGGREGATED',
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('getCountyHeatmapData', () => {
  describe('Basic Aggregation', () => {
    it('should return empty result for no data', async () => {
      const deps = {
        repo: createFakeRepo([]),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getCountyHeatmapData(deps, { filter: createBaseFilter() });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('should return single county data point', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 1000000, 700000)];
      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getCountyHeatmapData(deps, { filter: createBaseFilter() });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data).toHaveLength(1);
      expect(data[0]!.county_code).toBe('CJ');
      expect(data[0]!.total_amount).toBe(1000000);
    });

    it('should aggregate data points by county across years', async () => {
      const dataPoints = [
        createDataPoint('CJ', 2022, 500000, 700000),
        createDataPoint('CJ', 2023, 600000, 700000),
      ];
      const factors = createIdentityFactors();
      factors.cpi.set('2022', new Decimal(1));
      factors.eur.set('2022', new Decimal(5));

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const result = await getCountyHeatmapData(deps, {
        filter: {
          ...createBaseFilter(),
          report_period: {
            type: Frequency.YEAR,
            selection: { interval: { start: '2022', end: '2023' } },
          },
        },
      });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data).toHaveLength(1);
      // 500000 + 600000 = 1100000
      expect(data[0]!.total_amount).toBe(1100000);
    });

    it('should preserve county metadata', async () => {
      const dataPoints = [createDataPoint('TM', 2023, 800000, 650000)];
      dataPoints[0]!.county_entity_cui = 'TM0001';

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getCountyHeatmapData(deps, { filter: createBaseFilter() });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data[0]!.county_name).toBe('County TM');
      expect(data[0]!.county_population).toBe(650000);
      expect(data[0]!.county_entity_cui).toBe('TM0001');
    });
  });

  describe('Bucharest Special Case', () => {
    it('should handle Bucharest county (code B)', async () => {
      const dataPoints = [createDataPoint('B', 2023, 5000000, 2000000)];

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getCountyHeatmapData(deps, { filter: createBaseFilter() });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data).toHaveLength(1);
      expect(data[0]!.county_code).toBe('B');
      expect(data[0]!.total_amount).toBe(5000000);
    });
  });

  describe('Validation', () => {
    it('should return error when report_type is missing', async () => {
      const deps = {
        repo: createFakeRepo([]),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getCountyHeatmapData(deps, {
        filter: {
          account_category: 'ch',
          report_period: {
            type: Frequency.YEAR,
            selection: { interval: { start: '2023', end: '2023' } },
          },
          // report_type is missing
        } as AnalyticsFilter,
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('MISSING_REQUIRED_FILTER');
    });
  });

  describe('Currency Conversion', () => {
    it('should convert amounts to EUR', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100000)];

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const options: CountyHeatmapTransformationOptions = {
        inflationAdjusted: false,
        currency: 'EUR',
        perCapita: false,
      };

      const result = await getCountyHeatmapData(deps, {
        filter: createBaseFilter(),
        options,
      });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      // 500 RON / 5 = 100 EUR
      expect(data[0]!.total_amount).toBe(100);
    });

    it('should apply different rates per year before aggregation', async () => {
      const dataPoints = [
        createDataPoint('CJ', 2022, 500, 100000),
        createDataPoint('CJ', 2023, 500, 100000),
      ];

      const factors = createIdentityFactors();
      factors.eur.set('2022', new Decimal(4)); // 4 RON per EUR in 2022
      factors.eur.set('2023', new Decimal(5)); // 5 RON per EUR in 2023

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const options: CountyHeatmapTransformationOptions = {
        inflationAdjusted: false,
        currency: 'EUR',
        perCapita: false,
      };

      const result = await getCountyHeatmapData(deps, {
        filter: {
          ...createBaseFilter(),
          report_period: {
            type: Frequency.YEAR,
            selection: { interval: { start: '2022', end: '2023' } },
          },
        },
        options,
      });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      // 500/4 + 500/5 = 125 + 100 = 225 EUR
      expect(data[0]!.total_amount).toBe(225);
    });
  });

  describe('Inflation Adjustment', () => {
    it('should apply CPI factors when inflation adjusted', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 100, 100000)];

      const factors = createIdentityFactors();
      factors.cpi.set('2023', new Decimal(1.1));

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const options: CountyHeatmapTransformationOptions = {
        inflationAdjusted: true,
        currency: 'RON',
        perCapita: false,
      };

      const result = await getCountyHeatmapData(deps, {
        filter: createBaseFilter(),
        options,
      });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      // 100 * 1.1 = 110
      expect(data[0]!.total_amount).toBe(110);
    });

    it('should apply inflation before currency conversion', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 100, 100000)];

      const factors = createIdentityFactors();
      factors.cpi.set('2023', new Decimal(1.1));
      factors.eur.set('2023', new Decimal(5));

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const options: CountyHeatmapTransformationOptions = {
        inflationAdjusted: true,
        currency: 'EUR',
        perCapita: false,
      };

      const result = await getCountyHeatmapData(deps, {
        filter: createBaseFilter(),
        options,
      });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      // 100 * 1.1 / 5 = 22 EUR
      expect(data[0]!.total_amount).toBe(22);
    });
  });

  describe('Per Capita Calculation', () => {
    it('should divide by county population when per capita enabled', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 1000000, 500000)];

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const options: CountyHeatmapTransformationOptions = {
        inflationAdjusted: false,
        currency: 'RON',
        perCapita: true,
      };

      const result = await getCountyHeatmapData(deps, {
        filter: createBaseFilter(),
        options,
      });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      // 1000000 / 500000 = 2 per capita
      expect(data[0]!.amount).toBe(2);
      expect(data[0]!.per_capita_amount).toBe(2);
      expect(data[0]!.total_amount).toBe(1000000);
    });

    it('should handle zero population gracefully', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 1000, 0)];

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const options: CountyHeatmapTransformationOptions = {
        inflationAdjusted: false,
        currency: 'RON',
        perCapita: true,
      };

      const result = await getCountyHeatmapData(deps, {
        filter: createBaseFilter(),
        options,
      });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data[0]!.amount).toBe(0);
      expect(data[0]!.per_capita_amount).toBe(0);
    });
  });

  describe('Transformation Order', () => {
    it('should apply: inflation -> currency -> aggregate -> per_capita', async () => {
      const dataPoints = [
        createDataPoint('CJ', 2022, 1000, 100),
        createDataPoint('CJ', 2023, 1000, 100),
      ];

      const factors = createIdentityFactors();
      factors.cpi.set('2022', new Decimal(1.2));
      factors.cpi.set('2023', new Decimal(1.1));
      factors.eur.set('2022', new Decimal(4));
      factors.eur.set('2023', new Decimal(5));

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const options: CountyHeatmapTransformationOptions = {
        inflationAdjusted: true,
        currency: 'EUR',
        perCapita: true,
      };

      const result = await getCountyHeatmapData(deps, {
        filter: {
          ...createBaseFilter(),
          report_period: {
            type: Frequency.YEAR,
            selection: { interval: { start: '2022', end: '2023' } },
          },
        },
        options,
      });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();

      // 2022: 1000 * 1.2 / 4 = 300 EUR
      // 2023: 1000 * 1.1 / 5 = 220 EUR
      // Total: 520 EUR
      // Per capita: 520 / 100 = 5.2
      expect(data[0]!.total_amount).toBe(520);
      expect(data[0]!.per_capita_amount).toBe(5.2);
      expect(data[0]!.amount).toBe(5.2);
    });
  });

  describe('Error Handling', () => {
    it('should propagate repository errors', async () => {
      const repo: CountyAnalyticsRepository = {
        getHeatmapData: async () => err(createDatabaseError('Connection failed')),
      };

      const deps = {
        repo,
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getCountyHeatmapData(deps, { filter: createBaseFilter() });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('DATABASE_ERROR');
    });

    it('should handle normalization service errors', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 1000, 100000)];

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: {
          generateFactors: async () => {
            throw new Error('Failed to load factors');
          },
        } as unknown as NormalizationService,
      };

      const result = await getCountyHeatmapData(deps, { filter: createBaseFilter() });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('NORMALIZATION_ERROR');
    });
  });

  describe('Default Values', () => {
    it('should default to total RON without inflation', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const factors = createIdentityFactors();
      factors.cpi.set('2023', new Decimal(1.1)); // Would change if applied

      const deps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const result = await getCountyHeatmapData(deps, {
        filter: createBaseFilter(),
        // No options - use defaults
      });

      expect(result.isOk()).toBe(true);
      const data = result._unsafeUnwrap();
      expect(data[0]!.total_amount).toBe(500); // RON, no inflation
      expect(data[0]!.amount).toBe(500); // total, not per capita
    });
  });
});
