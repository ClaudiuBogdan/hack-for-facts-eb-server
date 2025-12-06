import { Decimal } from 'decimal.js';
import { ok, err } from 'neverthrow';
import { describe, it, expect } from 'vitest';

import { makeCountyAnalyticsResolvers } from '@/modules/county-analytics/shell/graphql/resolvers.js';

import type { CountyAnalyticsRepository } from '@/modules/county-analytics/core/ports.js';
import type { HeatmapCountyDataPoint } from '@/modules/county-analytics/core/types.js';
import type { EntityRepository } from '@/modules/entity/core/ports.js';
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
 * Creates a fake entity repository.
 */
function createFakeEntityRepo(): EntityRepository {
  return {
    getById: async () => ok(null),
    getAll: async () =>
      ok({
        nodes: [],
        pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
      }),
    getChildren: async () => ok([]),
    getParents: async () => ok([]),
    getCountyEntity: async (countyCode: string | null) => {
      if (countyCode === null) {
        return ok(null);
      }
      return ok({
        cui: `${countyCode}0001`,
        name: `County Entity ${countyCode}`,
        entity_type: 'admin_county_council',
        default_report_type: 'Executie bugetara agregata la nivel de ordonator principal',
        address: null,
        is_uat: false,
        uat_id: null,
        last_updated: new Date(),
        main_creditor_1_cui: null,
        main_creditor_2_cui: null,
      });
    },
  };
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
 * Type for the heatmapCountyData resolver args.
 */
interface HeatmapCountyDataArgs {
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
 * Type for the heatmapCountyData resolver result.
 */
interface HeatmapCountyDataResult {
  county_code: string;
  county_name: string;
  county_population: number;
  county_entity_cui: string | null;
  amount: number;
  total_amount: number;
  per_capita_amount: number;
}

/**
 * Calls the heatmapCountyData resolver with proper typing.
 */
async function callResolver(
  resolvers: ReturnType<typeof makeCountyAnalyticsResolvers>,
  args: HeatmapCountyDataArgs
): Promise<HeatmapCountyDataResult[]> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Test helper needs dynamic access to resolver
  return (resolvers as any).Query.heatmapCountyData({}, args) as Promise<HeatmapCountyDataResult[]>;
}

// =============================================================================
// Tests
// =============================================================================

describe('County Analytics Resolvers', () => {
  describe('Normalization Mode Mapping', () => {
    it('should map "total" to RON total', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
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
      const dataPoints = [createDataPoint('CJ', 2023, 1000, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
        normalization: 'per_capita',
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.total_amount).toBe(1000);
      expect(result[0]!.amount).toBe(10); // 1000 / 100 = 10 per capita
    });

    it('should map "total_euro" to EUR total (legacy mode)', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
        normalization: 'total_euro',
      });

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR
      expect(result[0]!.total_amount).toBe(100);
      expect(result[0]!.amount).toBe(100); // total, not per capita
    });

    it('should map "per_capita_euro" to EUR per capita (legacy mode)', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
        normalization: 'per_capita_euro',
      });

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR, then 100 / 100 = 1 per capita
      expect(result[0]!.total_amount).toBe(100);
      expect(result[0]!.amount).toBe(1);
    });
  });

  describe('Separate Parameters', () => {
    it('should use currency parameter for EUR conversion', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
        normalization: 'total',
        currency: 'EUR',
      });

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR
      expect(result[0]!.total_amount).toBe(100);
    });

    it('should use inflation_adjusted parameter', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 100, 100)];

      const factors = createIdentityFactors();
      factors.cpi.set('2023', new Decimal(1.1));

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
        inflation_adjusted: true,
      });

      expect(result).toHaveLength(1);
      // 100 * 1.1 = 110
      expect(result[0]!.total_amount).toBe(110);
    });

    it('should combine normalization and currency parameters', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
        normalization: 'per_capita',
        currency: 'EUR',
      });

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR, then 100 / 100 = 1 per capita
      expect(result[0]!.total_amount).toBe(100);
      expect(result[0]!.amount).toBe(1);
    });
  });

  describe('Backwards Compatibility - Normalization in Filter', () => {
    it('should read normalization from filter when not at root level', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: {
          ...createBaseFilter(),
          normalization: 'per_capita_euro', // Inside filter
        },
        // No normalization at root level
      });

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR, then 100 / 100 = 1 per capita
      expect(result[0]!.total_amount).toBe(100);
      expect(result[0]!.amount).toBe(1);
    });

    it('should prefer root level normalization over filter', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: {
          ...createBaseFilter(),
          normalization: 'per_capita_euro', // Inside filter - would be EUR
        },
        normalization: 'total', // Root level - should take precedence, RON
      });

      expect(result).toHaveLength(1);
      // Root level 'total' takes precedence, so RON total
      expect(result[0]!.total_amount).toBe(500);
    });

    it('should read currency from filter when not at root level', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: {
          ...createBaseFilter(),
          currency: 'EUR', // Inside filter
        },
      });

      expect(result).toHaveLength(1);
      // 500 RON / 5 = 100 EUR
      expect(result[0]!.total_amount).toBe(100);
    });

    it('should read inflation_adjusted from filter when not at root level', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 100, 100)];

      const factors = createIdentityFactors();
      factors.cpi.set('2023', new Decimal(1.1));

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: {
          ...createBaseFilter(),
          inflation_adjusted: true, // Inside filter
        },
      });

      expect(result).toHaveLength(1);
      // 100 * 1.1 = 110
      expect(result[0]!.total_amount).toBe(110);
    });
  });

  describe('Default Values', () => {
    it('should default to total RON without inflation', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const factors = createIdentityFactors();
      factors.cpi.set('2023', new Decimal(1.1)); // Would change amount if applied

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(factors),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
        // No normalization, currency, or inflation_adjusted
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.total_amount).toBe(500); // RON, no inflation
      expect(result[0]!.amount).toBe(500); // total, not per capita
    });
  });

  describe('Output Formatting', () => {
    it('should include county_entity_cui for field resolver', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.county_entity_cui).toBe('CJ0001');
    });

    it('should include all county metadata in output', async () => {
      const dataPoints = [createDataPoint('TM', 2023, 500, 650000)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      const result = await callResolver(resolvers, {
        filter: createBaseFilter(),
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.county_code).toBe('TM');
      expect(result[0]!.county_name).toBe('County TM');
      expect(result[0]!.county_population).toBe(650000);
    });
  });

  /* eslint-disable @typescript-eslint/no-unsafe-call -- Test helper needs dynamic access to field resolver */
  describe('Field Resolver - county_entity', () => {
    it('should resolve county_entity using entityRepo', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo: createFakeEntityRepo(),
      });

      // Get the field resolver
      const fieldResolver = (resolvers as any).HeatmapCountyDataPoint.county_entity;

      const parent = {
        county_code: 'CJ',
        county_name: 'County CJ',
        county_population: 100,
        county_entity_cui: 'CJ0001',
        amount: 500,
        total_amount: 500,
        per_capita_amount: 5,
      };

      const entity = await fieldResolver(parent);

      expect(entity).not.toBeNull();
      expect(entity.cui).toBe('CJ0001');
      expect(entity.name).toBe('County Entity CJ');
    });

    it('should return null when entityRepo returns error', async () => {
      const dataPoints = [createDataPoint('CJ', 2023, 500, 100)];

      const entityRepo: EntityRepository = {
        ...createFakeEntityRepo(),
        getCountyEntity: async () =>
          err({ type: 'DatabaseError' as const, message: 'Failed', retryable: false }),
      };

      const resolvers = makeCountyAnalyticsResolvers({
        repo: createFakeRepo(dataPoints),
        normalizationService: createFakeNormalizationService(),
        entityRepo,
      });

      // Get the field resolver
      const fieldResolver = (resolvers as any).HeatmapCountyDataPoint.county_entity;

      const parent = {
        county_code: 'CJ',
        county_name: 'County CJ',
        county_population: 100,
        county_entity_cui: 'CJ0001',
        amount: 500,
        total_amount: 500,
        per_capita_amount: 5,
      };

      const entity = await fieldResolver(parent);

      expect(entity).toBeNull();
    });
  });
  /* eslint-enable @typescript-eslint/no-unsafe-call -- Re-enable after field resolver test block */
});
