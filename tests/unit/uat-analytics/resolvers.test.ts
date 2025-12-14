import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';
import { describe, it, expect } from 'vitest';

import { makeUATAnalyticsResolvers } from '@/modules/uat-analytics/shell/graphql/resolvers.js';

import type { NormalizationService, NormalizationFactors } from '@/modules/normalization/index.js';
import type { UATAnalyticsRepository } from '@/modules/uat-analytics/core/ports.js';
import type { HeatmapUATDataPoint } from '@/modules/uat-analytics/core/types.js';

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
  population = 10000
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
function createFakeRepo(dataPoints: HeatmapUATDataPoint[]): UATAnalyticsRepository {
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
 * Creates the base filter input for GraphQL.
 */
function createBaseFilter() {
  return {
    account_category: 'ch' as const,
    report_period: {
      type: 'YEAR' as const,
      selection: { dates: ['2023'] },
    },
    report_type: 'PRINCIPAL_AGGREGATED',
  };
}

/**
 * Type for the heatmapUATData resolver args.
 */
interface HeatmapUATDataArgs {
  filter: ReturnType<typeof createBaseFilter> & {
    normalization?: string;
    currency?: string;
    inflation_adjusted?: boolean;
  };
  normalization?: string;
  currency?: string;
  inflation_adjusted?: boolean;
}

/**
 * Type for the heatmapUATData resolver result.
 */
interface HeatmapUATDataResult {
  uat_id: string;
  uat_code: string;
  uat_name: string;
  siruta_code: string;
  county_code: string | null;
  county_name: string | null;
  region: string | null;
  population: number | null;
  amount: number;
  total_amount: number;
  per_capita_amount: number;
}

/**
 * Calls the heatmapUATData resolver with proper typing.
 */
async function callResolver(
  resolvers: ReturnType<typeof makeUATAnalyticsResolvers>,
  args: HeatmapUATDataArgs
): Promise<HeatmapUATDataResult[]> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Test helper needs dynamic access to resolver
  return (resolvers as any).Query.heatmapUATData({}, args) as Promise<HeatmapUATDataResult[]>;
}

// =============================================================================
// Tests
// =============================================================================

describe('UAT Analytics Resolvers', () => {
  describe('Normalization Mode Mapping', () => {
    it('should map "total" to RON total', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
        normalization: 'total',
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.total_amount).toBe(500);
      expect(result[0]!.amount).toBe(500); // total, not per capita
    });

    it('should map "per_capita" to RON per capita', async () => {
      const dataPoints = [createDataPoint(1, 2023, 1000, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: createBaseFilter(),
          normalization: 'per_capita',
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.total_amount).toBe(1000);
      expect(result[0]!.amount).toBe(10); // 1000 / 100 = 10 per capita
    });

    it('should map "percent_gdp" to % of GDP', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
        normalization: 'percent_gdp',
      });

      expect(result).toHaveLength(1);
      // (500 / 1,000,000) * 100 = 0.05 (% of GDP)
      expect(result[0]!.amount).toBe(0.05);
      expect(result[0]!.total_amount).toBe(500);
    });

    it('should map "total_euro" to EUR total (legacy mode)', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: createBaseFilter(),
          normalization: 'total_euro',
        }
      );

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR
      expect(result[0]!.total_amount).toBe(100);
      expect(result[0]!.amount).toBe(100); // total, not per capita
    });

    it('should map "per_capita_euro" to EUR per capita (legacy mode)', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: createBaseFilter(),
          normalization: 'per_capita_euro',
        }
      );

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR, then 100 / 100 = 1 per capita
      expect(result[0]!.total_amount).toBe(100);
      expect(result[0]!.amount).toBe(1);
    });
  });

  describe('Separate Parameters', () => {
    it('should use currency parameter for EUR conversion', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: createBaseFilter(),
          normalization: 'total',
          currency: 'EUR',
        }
      );

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR
      expect(result[0]!.total_amount).toBe(100);
    });

    it('should use currency parameter for USD conversion', async () => {
      const dataPoints = [createDataPoint(1, 2023, 450, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
        normalization: 'total',
        currency: 'USD',
      });

      expect(result).toHaveLength(1);
      // 450 RON / 4.5 = 100 USD
      expect(result[0]!.total_amount).toBe(100);
    });

    it('should use inflation_adjusted parameter', async () => {
      const dataPoints = [createDataPoint(1, 2023, 100, 100)];

      const factors = createIdentityFactors();
      factors.cpi.set('2023', new Decimal(1.1));

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: createBaseFilter(),
          inflation_adjusted: true,
        }
      );

      expect(result).toHaveLength(1);
      // 100 * 1.1 = 110
      expect(result[0]!.total_amount).toBe(110);
    });

    it('should combine normalization and currency parameters', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: createBaseFilter(),
          normalization: 'per_capita',
          currency: 'EUR',
        }
      );

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR, then 100 / 100 = 1 per capita
      expect(result[0]!.total_amount).toBe(100);
      expect(result[0]!.amount).toBe(1);
    });
  });

  describe('Backwards Compatibility - Normalization in Filter', () => {
    it('should read normalization from filter when not at root level', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: {
            ...createBaseFilter(),
            normalization: 'per_capita_euro', // Inside filter
          },
          // No normalization at root level
        }
      );

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR, then 100 / 100 = 1 per capita
      expect(result[0]!.total_amount).toBe(100);
      expect(result[0]!.amount).toBe(1);
    });

    it('should prefer root level normalization over filter', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: {
            ...createBaseFilter(),
            normalization: 'per_capita_euro', // Inside filter - would be EUR
          },
          normalization: 'total', // Root level - should take precedence, RON
        }
      );

      expect(result).toHaveLength(1);
      // Root level 'total' takes precedence, so RON total
      expect(result[0]!.total_amount).toBe(500);
    });

    it('should read currency from filter when not at root level', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: {
            ...createBaseFilter(),
            currency: 'EUR', // Inside filter
          },
        }
      );

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR
      expect(result[0]!.total_amount).toBe(100);
    });

    it('should read inflation_adjusted from filter when not at root level', async () => {
      const dataPoints = [createDataPoint(1, 2023, 100, 100)];

      const factors = createIdentityFactors();
      factors.cpi.set('2023', new Decimal(1.1));

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: {
            ...createBaseFilter(),
            inflation_adjusted: true, // Inside filter
          },
        }
      );

      expect(result).toHaveLength(1);
      // 100 * 1.1 = 110
      expect(result[0]!.total_amount).toBe(110);
    });
  });

  describe('Default Values', () => {
    it('should default to total RON without inflation', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const factors = createIdentityFactors();
      factors.cpi.set('2023', new Decimal(1.1)); // Would change amount if applied

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: createBaseFilter(),
          // No normalization, currency, or inflation_adjusted
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.total_amount).toBe(500); // RON, no inflation
      expect(result[0]!.amount).toBe(500); // total, not per capita
    });
  });

  describe('Output Formatting', () => {
    it('should convert uat_id to string for GraphQL ID type', async () => {
      const dataPoints = [createDataPoint(123, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: createBaseFilter(),
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.uat_id).toBe('123');
      expect(typeof result[0]!.uat_id).toBe('string');
    });

    it('should include all UAT metadata in output', async () => {
      const dataPoints = [createDataPoint(1, 2023, 500, 100)];

      const resolvers = makeUATAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
      });

      const result = await callResolver(
        resolvers,

        {
          filter: createBaseFilter(),
        }
      );

      expect(result).toHaveLength(1);
      expect(result[0]!.uat_code).toBe('UAT1');
      expect(result[0]!.uat_name).toBe('UAT Name 1');
      expect(result[0]!.siruta_code).toBe('10000');
      expect(result[0]!.county_code).toBe('CJ');
      expect(result[0]!.county_name).toBe('Cluj');
      expect(result[0]!.region).toBe('Nord-Vest');
      expect(result[0]!.population).toBe(100);
    });
  });
});
