import { Decimal } from 'decimal.js';
import { ok, err } from 'neverthrow';
import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  getHeatmapData,
  type GetHeatmapDataDeps,
} from '@/modules/uat-analytics/core/usecases/get-heatmap-data.js';

import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { NormalizationService, NormalizationFactors } from '@/modules/normalization/index.js';
import type { UATAnalyticsError } from '@/modules/uat-analytics/core/errors.js';
import type { UATAnalyticsRepository } from '@/modules/uat-analytics/core/ports.js';
import type {
  HeatmapUATDataPoint,
  HeatmapTransformationOptions,
} from '@/modules/uat-analytics/core/types.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a UAT data point for testing.
 */
function createDataPoint(
  uatId: number,
  year: number,
  amount: number,
  population: number | null = 10000
): HeatmapUATDataPoint {
  return {
    uat_id: uatId,
    uat_code: `UAT${String(uatId)}`,
    uat_name: `UAT Name ${String(uatId)}`,
    siruta_code: `${String(uatId)}0000`,
    county_code: 'CJ',
    county_name: 'Cluj',
    region: 'Nord-Vest',
    population,
    year,
    total_amount: new Decimal(amount),
  };
}

/**
 * Creates a minimal filter for testing.
 */
function createFilter(overrides: Partial<AnalyticsFilter> = {}): AnalyticsFilter {
  return {
    account_category: 'ch',
    report_period: {
      type: Frequency.YEAR,
      selection: { interval: { start: '2023', end: '2024' } },
    },
    report_type: 'PRINCIPAL_AGGREGATED',
    ...overrides,
  };
}

/**
 * Creates a fake repository that returns the given data points.
 */
function createFakeRepo(dataPoints: HeatmapUATDataPoint[]): UATAnalyticsRepository {
  return {
    getHeatmapData: async () => ok(dataPoints),
  };
}

/**
 * Creates a fake repo that returns an error.
 */
function createFailingRepo(errorMessage: string): UATAnalyticsRepository {
  return {
    getHeatmapData: async () =>
      err({
        type: 'DATABASE_ERROR' as const,
        cause: errorMessage,
      } as UATAnalyticsError),
  };
}

/**
 * Creates identity normalization factors (no transformation).
 */
function createIdentityFactors(): NormalizationFactors {
  return {
    cpi: new Map([
      ['2023', new Decimal(1)],
      ['2024', new Decimal(1)],
    ]),
    eur: new Map([
      ['2023', new Decimal(1)],
      ['2024', new Decimal(1)],
    ]),
    usd: new Map([
      ['2023', new Decimal(1)],
      ['2024', new Decimal(1)],
    ]),
    gdp: new Map([
      ['2023', new Decimal(1000000)],
      ['2024', new Decimal(1000000)],
    ]),
    population: new Map([
      ['2023', new Decimal(19000000)],
      ['2024', new Decimal(19000000)],
    ]),
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
 * Creates test normalization factors with specific values.
 */
function createTestFactors(overrides: Partial<NormalizationFactors> = {}): NormalizationFactors {
  return {
    ...createIdentityFactors(),
    ...overrides,
  };
}

/**
 * Creates default transformation options.
 */
function createOptions(
  overrides: Partial<HeatmapTransformationOptions> = {}
): HeatmapTransformationOptions {
  return {
    inflationAdjusted: false,
    currency: 'RON',
    perCapita: false,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('getHeatmapData', () => {
  describe('Basic Aggregation', () => {
    it('should return empty result for no data', async () => {
      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo([]),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(0);
      }
    });

    it('should aggregate data points by UAT across years', async () => {
      const dataPoints = [
        createDataPoint(1, 2023, 1000),
        createDataPoint(1, 2024, 2000),
        createDataPoint(2, 2023, 500),
      ];

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(2);

        const uat1 = result.value.find((p) => p.uat_id === 1);
        expect(uat1?.total_amount).toBe(3000); // 1000 + 2000

        const uat2 = result.value.find((p) => p.uat_id === 2);
        expect(uat2?.total_amount).toBe(500);
      }
    });

    it('should preserve UAT metadata', async () => {
      const dataPoints = [createDataPoint(1, 2023, 1000, 25000)];

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const point = result.value[0];
        expect(point?.uat_code).toBe('UAT1');
        expect(point?.uat_name).toBe('UAT Name 1');
        expect(point?.siruta_code).toBe('10000');
        expect(point?.county_code).toBe('CJ');
        expect(point?.county_name).toBe('Cluj');
        expect(point?.region).toBe('Nord-Vest');
        expect(point?.population).toBe(25000);
      }
    });
  });

  describe('Validation', () => {
    it('should return error when report_type is missing', async () => {
      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo([]),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getHeatmapData(deps, {
        filter: {
          account_category: 'ch',
          report_period: {
            type: Frequency.YEAR,
            selection: { interval: { start: '2023', end: '2024' } },
          },
          // report_type is missing
        } as AnalyticsFilter,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('MISSING_REQUIRED_FILTER');
      }
    });
  });

  describe('Currency Conversion', () => {
    it('should convert amounts to EUR', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500)];

      const factors = createTestFactors({
        eur: new Map([['2023', new Decimal(5)]]),
      });

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ currency: 'EUR' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 500 RON / 5 = 100 EUR
        expect(result.value[0]?.total_amount).toBe(100);
      }
    });

    it('should apply different rates per year before aggregation', async () => {
      const dataPoints = [
        createDataPoint(1, 2023, 500), // 500 / 5 = 100 EUR
        createDataPoint(1, 2024, 600), // 600 / 6 = 100 EUR
      ];

      const factors = createTestFactors({
        eur: new Map([
          ['2023', new Decimal(5)],
          ['2024', new Decimal(6)],
        ]),
      });

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ currency: 'EUR' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // (500/5) + (600/6) = 100 + 100 = 200 EUR
        expect(result.value[0]?.total_amount).toBe(200);
      }
    });

    it('should not convert when currency is RON', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500)];

      const factors = createTestFactors({
        eur: new Map([['2023', new Decimal(5)]]),
      });

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ currency: 'RON' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value[0]?.total_amount).toBe(500);
      }
    });
  });

  describe('Inflation Adjustment', () => {
    it('should apply CPI factors when inflation adjusted', async () => {
      const dataPoints = [createDataPoint(1, 2023, 100)];

      const factors = createTestFactors({
        cpi: new Map([['2023', new Decimal(1.1)]]),
      });

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ inflationAdjusted: true }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 100 * 1.1 = 110
        expect(result.value[0]?.total_amount).toBe(110);
      }
    });

    it('should not apply CPI when inflation not adjusted', async () => {
      const dataPoints = [createDataPoint(1, 2023, 100)];

      const factors = createTestFactors({
        cpi: new Map([['2023', new Decimal(1.1)]]),
      });

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ inflationAdjusted: false }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value[0]?.total_amount).toBe(100);
      }
    });

    it('should apply inflation before currency conversion', async () => {
      const dataPoints = [createDataPoint(1, 2023, 100)];

      const factors = createTestFactors({
        cpi: new Map([['2023', new Decimal(1.1)]]),
        eur: new Map([['2023', new Decimal(5)]]),
      });

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ inflationAdjusted: true, currency: 'EUR' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // (100 * 1.1) / 5 = 110 / 5 = 22
        expect(result.value[0]?.total_amount).toBe(22);
      }
    });
  });

  describe('Per Capita Calculation', () => {
    it('should divide by UAT population when per capita enabled', async () => {
      const dataPoints = [createDataPoint(1, 2023, 10000, 1000)];

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ perCapita: true }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 10000 / 1000 = 10
        expect(result.value[0]?.amount).toBe(10);
        expect(result.value[0]?.per_capita_amount).toBe(10);
        expect(result.value[0]?.total_amount).toBe(10000);
      }
    });

    it('should return total as primary amount when per capita disabled', async () => {
      const dataPoints = [createDataPoint(1, 2023, 10000, 1000)];

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ perCapita: false }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value[0]?.amount).toBe(10000);
        expect(result.value[0]?.per_capita_amount).toBe(10); // Still calculated
        expect(result.value[0]?.total_amount).toBe(10000);
      }
    });

    it('should handle null population', async () => {
      const dataPoints = [createDataPoint(1, 2023, 10000, null)];

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ perCapita: true }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Per capita should be 0 when population is null
        expect(result.value[0]?.amount).toBe(0);
        expect(result.value[0]?.per_capita_amount).toBe(0);
      }
    });

    it('should handle zero population', async () => {
      const dataPoints = [createDataPoint(1, 2023, 10000, 0)];

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ perCapita: true }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value[0]?.per_capita_amount).toBe(0);
      }
    });

    it('should apply per capita after currency conversion', async () => {
      const dataPoints = [createDataPoint(1, 2023, 5000, 1000)];

      const factors = createTestFactors({
        eur: new Map([['2023', new Decimal(5)]]),
      });

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ currency: 'EUR', perCapita: true }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // (5000 / 5) / 1000 = 1000 / 1000 = 1
        expect(result.value[0]?.amount).toBe(1);
        expect(result.value[0]?.total_amount).toBe(1000);
      }
    });
  });

  describe('Transformation Order', () => {
    it('should apply: inflation -> currency -> aggregate -> per_capita', async () => {
      const dataPoints = [
        createDataPoint(1, 2023, 100, 10), // Inflation: 110, EUR: 22
        createDataPoint(1, 2024, 100, 10), // Inflation: 100, EUR: 20
      ];

      const factors = createTestFactors({
        cpi: new Map([
          ['2023', new Decimal(1.1)],
          ['2024', new Decimal(1)],
        ]),
        eur: new Map([
          ['2023', new Decimal(5)],
          ['2024', new Decimal(5)],
        ]),
      });

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({
          inflationAdjusted: true,
          currency: 'EUR',
          perCapita: true,
        }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 2023: (100 * 1.1) / 5 = 22 EUR
        // 2024: (100 * 1) / 5 = 20 EUR
        // Total: 42 EUR
        // Per capita: 42 / 10 = 4.2
        expect(result.value[0]?.total_amount).toBe(42);
        expect(result.value[0]?.amount).toBe(4.2);
      }
    });
  });

  describe('Error Handling', () => {
    it('should propagate repository errors', async () => {
      const deps: GetHeatmapDataDeps = {
        repo: createFailingRepo('Connection failed'),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DATABASE_ERROR');
      }
    });

    it('should handle normalization service errors', async () => {
      const dataPoints = [createDataPoint(1, 2023, 100)];

      const failingService = {
        generateFactors: async () => {
          throw new Error('Dataset not found');
        },
      } as unknown as NormalizationService;

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: failingService,
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        options: createOptions({ currency: 'EUR' }),
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('NORMALIZATION_ERROR');
      }
    });
  });

  describe('Default Options', () => {
    it('should use default options when not provided', async () => {
      const dataPoints = [createDataPoint(1, 2023, 100, 10)];

      const deps: GetHeatmapDataDeps = {
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      };

      const result = await getHeatmapData(deps, {
        filter: createFilter(),
        // options not provided
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Default: no inflation, RON, no per capita
        // amount should equal total_amount (not per capita)
        expect(result.value[0]?.amount).toBe(100);
        expect(result.value[0]?.total_amount).toBe(100);
      }
    });
  });
});
