import { Decimal } from 'decimal.js';
import { ok, err } from 'neverthrow';
import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  getEntityAnalytics,
  type GetEntityAnalyticsDeps,
  type NormalizationFactorProvider,
} from '@/modules/entity-analytics/core/usecases/get-entity-analytics.js';

import type { EntityAnalyticsRepository } from '@/modules/entity-analytics/core/ports.js';
import type {
  EntityAnalyticsInput,
  EntityAnalyticsRow,
  EntityAnalyticsSort,
} from '@/modules/entity-analytics/core/types.js';
// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates an entity analytics row for testing.
 */
function createRow(
  entityCui: string,
  entityName: string,
  totalAmount: number,
  population: number | null = null,
  options: Partial<EntityAnalyticsRow> = {}
): EntityAnalyticsRow {
  const perCapitaAmount =
    population !== null && population > 0
      ? new Decimal(totalAmount).div(population)
      : new Decimal(0);

  return {
    entity_cui: entityCui,
    entity_name: entityName,
    entity_type: options.entity_type ?? 'uat',
    uat_id: options.uat_id ?? 1,
    county_code: options.county_code ?? 'AB',
    county_name: options.county_name ?? 'Alba',
    population,
    total_amount: new Decimal(totalAmount),
    per_capita_amount: perCapitaAmount,
    ...options,
  };
}

/**
 * Creates a minimal filter for testing.
 */
function createFilter(
  overrides: Partial<EntityAnalyticsInput['filter']> = {}
): EntityAnalyticsInput['filter'] {
  return {
    account_category: 'ch',
    report_period: {
      type: Frequency.YEAR,
      selection: { interval: { start: '2023', end: '2024' } },
    },
    normalization: 'total',
    currency: 'RON',
    inflation_adjusted: false,
    show_period_growth: false,
    ...overrides,
  };
}

/**
 * Creates a fake repository that returns the given rows.
 */
function createFakeRepo(
  rows: EntityAnalyticsRow[],
  totalCount?: number
): EntityAnalyticsRepository {
  return {
    getEntityAnalytics: async () =>
      ok({
        items: rows,
        totalCount: totalCount ?? rows.length,
      }),
  };
}

/**
 * Creates a fake repo that returns an error.
 */
function createFailingRepo(errorMessage: string): EntityAnalyticsRepository {
  return {
    getEntityAnalytics: async () =>
      err({
        type: 'DatabaseError' as const,
        message: errorMessage,
        retryable: true,
      }),
  };
}

/**
 * Creates a fake normalization provider with identity factors (no transformation).
 */
function createIdentityNormalization(): NormalizationFactorProvider {
  return {
    generateFactors: async () => ({
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
    }),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('getEntityAnalytics', () => {
  describe('Basic Response Structure', () => {
    it('should return empty result for no data', async () => {
      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo([]),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(0);
        expect(result.value.pageInfo.totalCount).toBe(0);
        expect(result.value.pageInfo.hasNextPage).toBe(false);
        expect(result.value.pageInfo.hasPreviousPage).toBe(false);
      }
    });

    it('should return entity data points with correct structure', async () => {
      const rows = [
        createRow('CUI001', 'Primaria A', 1000000, 50000, {
          entity_type: 'uat',
          county_code: 'AB',
          county_name: 'Alba',
          uat_id: 1,
        }),
      ];

      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        expect(node?.entity_cui).toBe('CUI001');
        expect(node?.entity_name).toBe('Primaria A');
        expect(node?.entity_type).toBe('uat');
        expect(node?.uat_id).toBe('1'); // Converted to string for GraphQL ID
        expect(node?.county_code).toBe('AB');
        expect(node?.county_name).toBe('Alba');
        expect(node?.population).toBe(50000);
        expect(node?.total_amount).toBe(1000000);
        expect(node?.amount).toBe(1000000); // Same as total_amount
        expect(node?.per_capita_amount).toBe(20); // 1000000 / 50000
      }
    });

    it('should handle null population (non-UAT entities)', async () => {
      const rows = [
        createRow('CUI001', 'Ministry of Finance', 5000000, null, {
          entity_type: 'ministry',
          uat_id: null,
          county_code: null,
          county_name: null,
        }),
      ];

      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const node = result.value.nodes[0];
        expect(node?.population).toBeNull();
        expect(node?.per_capita_amount).toBe(0);
        expect(node?.uat_id).toBeNull();
      }
    });
  });

  describe('Pagination', () => {
    it('should calculate hasNextPage correctly', async () => {
      const rows = [createRow('CUI001', 'Entity A', 1000)];

      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo(rows, 100), // Total count is 100
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
        limit: 10,
        offset: 0,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.pageInfo.totalCount).toBe(100);
        expect(result.value.pageInfo.hasNextPage).toBe(true);
        expect(result.value.pageInfo.hasPreviousPage).toBe(false);
      }
    });

    it('should calculate hasPreviousPage correctly', async () => {
      const rows = [createRow('CUI001', 'Entity A', 1000)];

      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo(rows, 100),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
        limit: 10,
        offset: 50,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.pageInfo.hasPreviousPage).toBe(true);
        expect(result.value.pageInfo.hasNextPage).toBe(true);
      }
    });

    it('should handle last page correctly', async () => {
      const rows = [createRow('CUI001', 'Entity A', 1000)];

      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo(rows, 95),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
        limit: 10,
        offset: 90,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.pageInfo.hasNextPage).toBe(false);
        expect(result.value.pageInfo.hasPreviousPage).toBe(true);
      }
    });

    it('should use default limit of 50', async () => {
      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo([]),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
        // No limit specified
      });

      expect(result.isOk()).toBe(true);
    });

    it('should cap limit at MAX_LIMIT', async () => {
      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo([]),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
        limit: 999999, // Should be capped
      });

      expect(result.isOk()).toBe(true);
    });

    it('should handle negative offset as 0', async () => {
      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo([]),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
        offset: -10,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.pageInfo.hasPreviousPage).toBe(false);
      }
    });
  });

  describe('Sorting', () => {
    it('should use default sort (TOTAL_AMOUNT DESC) when not specified', async () => {
      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo([]),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
        // No sort specified
      });

      expect(result.isOk()).toBe(true);
    });

    it('should accept valid sort configurations', async () => {
      const sortConfigs: EntityAnalyticsSort[] = [
        { by: 'AMOUNT', order: 'ASC' },
        { by: 'TOTAL_AMOUNT', order: 'DESC' },
        { by: 'PER_CAPITA_AMOUNT', order: 'ASC' },
        { by: 'ENTITY_NAME', order: 'ASC' },
        { by: 'ENTITY_TYPE', order: 'DESC' },
        { by: 'POPULATION', order: 'DESC' },
        { by: 'COUNTY_NAME', order: 'ASC' },
        { by: 'COUNTY_CODE', order: 'ASC' },
      ];

      for (const sort of sortConfigs) {
        const deps: GetEntityAnalyticsDeps = {
          repo: createFakeRepo([]),
          normalization: createIdentityNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter(),
          sort,
        });

        expect(result.isOk()).toBe(true);
      }
    });
  });

  describe('Error Handling', () => {
    it('should propagate repository errors', async () => {
      const deps: GetEntityAnalyticsDeps = {
        repo: createFailingRepo('Connection failed'),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
        expect(result.error.message).toBe('Connection failed');
      }
    });

    it('should handle normalization factor generation errors', async () => {
      const failingNormalization: NormalizationFactorProvider = {
        generateFactors: async () => {
          throw new Error('Dataset not found');
        },
      };

      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo([]),
        normalization: failingNormalization,
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('NormalizationDataError');
      }
    });
  });

  describe('GDP Normalization with Non-Yearly Periods', () => {
    it('should correctly normalize percent_gdp with quarterly periods', async () => {
      // Regression test: GDP normalization was returning 0 for quarterly/monthly periods
      // because periodLabels were generated without frequency, defaulting to yearly labels
      const rows = [
        createRow('CUI001', 'Entity A', 1000000, 50000),
        createRow('CUI002', 'Entity B', 2000000, 100000),
      ];

      // Create normalization provider with quarterly GDP factors
      const quarterlyNormalization: NormalizationFactorProvider = {
        generateFactors: async (frequency) => {
          // Ensure we're called with the correct frequency
          expect(frequency).toBe(Frequency.QUARTER);

          return {
            cpi: new Map([
              ['2023-Q1', new Decimal(1)],
              ['2023-Q2', new Decimal(1)],
              ['2023-Q3', new Decimal(1)],
              ['2023-Q4', new Decimal(1)],
            ]),
            eur: new Map([
              ['2023-Q1', new Decimal(1)],
              ['2023-Q2', new Decimal(1)],
              ['2023-Q3', new Decimal(1)],
              ['2023-Q4', new Decimal(1)],
            ]),
            usd: new Map([
              ['2023-Q1', new Decimal(1)],
              ['2023-Q2', new Decimal(1)],
              ['2023-Q3', new Decimal(1)],
              ['2023-Q4', new Decimal(1)],
            ]),
            gdp: new Map([
              ['2023-Q1', new Decimal(100000000)], // 100M GDP
              ['2023-Q2', new Decimal(100000000)],
              ['2023-Q3', new Decimal(100000000)],
              ['2023-Q4', new Decimal(100000000)],
            ]),
            population: new Map([
              ['2023-Q1', new Decimal(19000000)],
              ['2023-Q2', new Decimal(19000000)],
              ['2023-Q3', new Decimal(19000000)],
              ['2023-Q4', new Decimal(19000000)],
            ]),
          };
        },
      };

      // Capture the factorMap passed to the repo
      let capturedFactorMap: Map<string, Decimal> | undefined;
      const repoWithCapture: EntityAnalyticsRepository = {
        getEntityAnalytics: async (_filter, factorMap) => {
          capturedFactorMap = factorMap;
          return ok({ items: rows, totalCount: 2 });
        },
      };

      const deps: GetEntityAnalyticsDeps = {
        repo: repoWithCapture,
        normalization: quarterlyNormalization,
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter({
          report_period: {
            type: Frequency.QUARTER,
            selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
          },
          normalization: 'percent_gdp',
        }),
      });

      expect(result.isOk()).toBe(true);

      // Verify the factorMap has quarterly keys (not yearly)
      expect(capturedFactorMap).toBeDefined();
      expect(capturedFactorMap?.has('2023-Q1')).toBe(true);
      expect(capturedFactorMap?.has('2023-Q2')).toBe(true);
      expect(capturedFactorMap?.has('2023-Q3')).toBe(true);
      expect(capturedFactorMap?.has('2023-Q4')).toBe(true);

      // Should NOT have yearly keys
      expect(capturedFactorMap?.has('2023')).toBe(false);

      // Verify the multiplier is non-zero (100 / 100M = 1e-6)
      const q1Factor = capturedFactorMap?.get('2023-Q1');
      expect(q1Factor).toBeDefined();
      expect(q1Factor?.isZero()).toBe(false);
      expect(q1Factor?.toNumber()).toBeCloseTo(0.000001, 9); // 100 / 100M
    });

    it('should correctly normalize percent_gdp with monthly periods', async () => {
      const rows = [createRow('CUI001', 'Entity A', 500000, 25000)];

      // Create normalization provider with monthly GDP factors
      const monthlyNormalization: NormalizationFactorProvider = {
        generateFactors: async (frequency) => {
          expect(frequency).toBe(Frequency.MONTH);

          const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
          const gdpMap = new Map<string, Decimal>();
          const cpiMap = new Map<string, Decimal>();
          const eurMap = new Map<string, Decimal>();
          const usdMap = new Map<string, Decimal>();
          const popMap = new Map<string, Decimal>();

          for (const month of months) {
            const label = `2023-${month}`;
            gdpMap.set(label, new Decimal(50000000)); // 50M GDP
            cpiMap.set(label, new Decimal(1));
            eurMap.set(label, new Decimal(1));
            usdMap.set(label, new Decimal(1));
            popMap.set(label, new Decimal(19000000));
          }

          return {
            cpi: cpiMap,
            eur: eurMap,
            usd: usdMap,
            gdp: gdpMap,
            population: popMap,
          };
        },
      };

      let capturedFactorMap: Map<string, Decimal> | undefined;
      const repoWithCapture: EntityAnalyticsRepository = {
        getEntityAnalytics: async (_filter, factorMap) => {
          capturedFactorMap = factorMap;
          return ok({ items: rows, totalCount: 1 });
        },
      };

      const deps: GetEntityAnalyticsDeps = {
        repo: repoWithCapture,
        normalization: monthlyNormalization,
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter({
          report_period: {
            type: Frequency.MONTH,
            selection: { interval: { start: '2023-01', end: '2023-12' } },
          },
          normalization: 'percent_gdp',
        }),
      });

      expect(result.isOk()).toBe(true);

      // Verify the factorMap has monthly keys
      expect(capturedFactorMap).toBeDefined();
      expect(capturedFactorMap?.has('2023-01')).toBe(true);
      expect(capturedFactorMap?.has('2023-06')).toBe(true);
      expect(capturedFactorMap?.has('2023-12')).toBe(true);

      // Should NOT have yearly keys
      expect(capturedFactorMap?.has('2023')).toBe(false);

      // Verify the multiplier is non-zero
      const janFactor = capturedFactorMap?.get('2023-01');
      expect(janFactor).toBeDefined();
      expect(janFactor?.isZero()).toBe(false);
      expect(janFactor?.toNumber()).toBeCloseTo(0.000002, 9); // 100 / 50M
    });
  });

  describe('Edge Cases', () => {
    it('should handle entities with zero population', async () => {
      const rows = [
        createRow('CUI001', 'Entity A', 1000, 0, {
          per_capita_amount: new Decimal(0),
        }),
      ];

      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes[0]?.per_capita_amount).toBe(0);
      }
    });

    it('should handle multiple entity types', async () => {
      const rows = [
        createRow('CUI001', 'Primaria A', 1000000, 50000, { entity_type: 'uat' }),
        createRow('CUI002', 'Consiliul Judetean B', 5000000, 200000, {
          entity_type: 'admin_county_council',
        }),
        createRow('CUI003', 'Ministry C', 10000000, null, { entity_type: 'ministry' }),
      ];

      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(3);
        expect(result.value.nodes.map((n) => n.entity_type)).toEqual([
          'uat',
          'admin_county_council',
          'ministry',
        ]);
      }
    });

    it('should convert uat_id to string for GraphQL ID type', async () => {
      const rows = [createRow('CUI001', 'Entity A', 1000, 50000, { uat_id: 12345 })];

      const deps: GetEntityAnalyticsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
      };

      const result = await getEntityAnalytics(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes[0]?.uat_id).toBe('12345');
        expect(typeof result.value.nodes[0]?.uat_id).toBe('string');
      }
    });
  });

  describe('Normalization - Full Combination Matrix', () => {
    /**
     * Helper to create a normalization provider for quarterly periods.
     */
    function createQuarterlyNormalization(
      overrides: Partial<{
        cpi: Map<string, Decimal>;
        eur: Map<string, Decimal>;
        usd: Map<string, Decimal>;
        gdp: Map<string, Decimal>;
        population: Map<string, Decimal>;
      }> = {}
    ): NormalizationFactorProvider {
      const quarters = ['2023-Q1', '2023-Q2', '2023-Q3', '2023-Q4'];
      const defaultCpi = new Map(quarters.map((q) => [q, new Decimal(1.1)]));
      const defaultEur = new Map(quarters.map((q) => [q, new Decimal(5)]));
      const defaultUsd = new Map(quarters.map((q) => [q, new Decimal(4.5)]));
      const defaultGdp = new Map(quarters.map((q) => [q, new Decimal(100_000_000_000)]));
      const defaultPop = new Map(quarters.map((q) => [q, new Decimal(19_000_000)]));

      return {
        generateFactors: async (frequency) => {
          expect(frequency).toBe(Frequency.QUARTER);
          return {
            cpi: overrides.cpi ?? defaultCpi,
            eur: overrides.eur ?? defaultEur,
            usd: overrides.usd ?? defaultUsd,
            gdp: overrides.gdp ?? defaultGdp,
            population: overrides.population ?? defaultPop,
          };
        },
      };
    }

    /**
     * Helper to create a normalization provider for monthly periods.
     */
    function createMonthlyNormalization(
      overrides: Partial<{
        cpi: Map<string, Decimal>;
        eur: Map<string, Decimal>;
        usd: Map<string, Decimal>;
        gdp: Map<string, Decimal>;
        population: Map<string, Decimal>;
      }> = {}
    ): NormalizationFactorProvider {
      const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
      const labels = months.map((m) => `2023-${m}`);
      const defaultCpi = new Map(labels.map((l) => [l, new Decimal(1.1)]));
      const defaultEur = new Map(labels.map((l) => [l, new Decimal(5)]));
      const defaultUsd = new Map(labels.map((l) => [l, new Decimal(4.5)]));
      const defaultGdp = new Map(labels.map((l) => [l, new Decimal(50_000_000_000)]));
      const defaultPop = new Map(labels.map((l) => [l, new Decimal(19_000_000)]));

      return {
        generateFactors: async (frequency) => {
          expect(frequency).toBe(Frequency.MONTH);
          return {
            cpi: overrides.cpi ?? defaultCpi,
            eur: overrides.eur ?? defaultEur,
            usd: overrides.usd ?? defaultUsd,
            gdp: overrides.gdp ?? defaultGdp,
            population: overrides.population ?? defaultPop,
          };
        },
      };
    }

    /**
     * Helper to create a repo that captures the factor map.
     */
    function createCapturingRepo(
      onCapture: (factorMap: Map<string, Decimal>) => void,
      rows: EntityAnalyticsRow[] = []
    ): EntityAnalyticsRepository {
      const defaultRows = [createRow('CUI001', 'Entity A', 1000000, 50000)];
      return {
        getEntityAnalytics: async (_filter, factorMap) => {
          onCapture(factorMap);
          return ok({
            items: rows.length > 0 ? rows : defaultRows,
            totalCount: rows.length > 0 ? rows.length : 1,
          });
        },
      };
    }

    describe('per_capita with quarterly periods', () => {
      it('should generate quarterly factor keys for per_capita + RON', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createQuarterlyNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.QUARTER,
              selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
            },
            normalization: 'per_capita',
            currency: 'RON',
            inflation_adjusted: false,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();
        expect(capturedFactorMap?.has('2023-Q1')).toBe(true);
        expect(capturedFactorMap?.has('2023-Q4')).toBe(true);
        expect(capturedFactorMap?.has('2023')).toBe(false);
      });

      it('should generate quarterly factor keys for per_capita + EUR + inflation', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createQuarterlyNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.QUARTER,
              selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
            },
            normalization: 'per_capita',
            currency: 'EUR',
            inflation_adjusted: true,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();
        expect(capturedFactorMap?.has('2023-Q1')).toBe(true);
        expect(capturedFactorMap?.size).toBe(4);
      });

      it('should generate quarterly factor keys for per_capita + USD', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createQuarterlyNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.QUARTER,
              selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
            },
            normalization: 'per_capita',
            currency: 'USD',
            inflation_adjusted: false,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();
        expect(capturedFactorMap?.has('2023-Q1')).toBe(true);
      });
    });

    describe('per_capita with monthly periods', () => {
      it('should generate monthly factor keys for per_capita + RON', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createMonthlyNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.MONTH,
              selection: { interval: { start: '2023-01', end: '2023-12' } },
            },
            normalization: 'per_capita',
            currency: 'RON',
            inflation_adjusted: false,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();
        expect(capturedFactorMap?.has('2023-01')).toBe(true);
        expect(capturedFactorMap?.has('2023-06')).toBe(true);
        expect(capturedFactorMap?.has('2023-12')).toBe(true);
        expect(capturedFactorMap?.has('2023')).toBe(false);
        expect(capturedFactorMap?.size).toBe(12);
      });

      it('should generate monthly factor keys for per_capita + EUR + inflation', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createMonthlyNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.MONTH,
              selection: { interval: { start: '2023-01', end: '2023-12' } },
            },
            normalization: 'per_capita',
            currency: 'EUR',
            inflation_adjusted: true,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();
        expect(capturedFactorMap?.has('2023-01')).toBe(true);
        expect(capturedFactorMap?.size).toBe(12);
      });
    });

    describe('total with USD and non-yearly periods', () => {
      it('should generate quarterly factor keys for total + USD', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createQuarterlyNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.QUARTER,
              selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
            },
            normalization: 'total',
            currency: 'USD',
            inflation_adjusted: false,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();
        expect(capturedFactorMap?.has('2023-Q1')).toBe(true);
        expect(capturedFactorMap?.size).toBe(4);
      });

      it('should generate quarterly factor keys for total + USD + inflation', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createQuarterlyNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.QUARTER,
              selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
            },
            normalization: 'total',
            currency: 'USD',
            inflation_adjusted: true,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();
        expect(capturedFactorMap?.has('2023-Q1')).toBe(true);
      });

      it('should generate monthly factor keys for total + USD', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createMonthlyNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.MONTH,
              selection: { interval: { start: '2023-01', end: '2023-12' } },
            },
            normalization: 'total',
            currency: 'USD',
            inflation_adjusted: false,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();
        expect(capturedFactorMap?.has('2023-01')).toBe(true);
        expect(capturedFactorMap?.has('2023-12')).toBe(true);
        expect(capturedFactorMap?.size).toBe(12);
      });
    });

    describe('total with EUR and non-yearly periods', () => {
      it('should generate quarterly factor keys for total + EUR + inflation', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createQuarterlyNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.QUARTER,
              selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
            },
            normalization: 'total',
            currency: 'EUR',
            inflation_adjusted: true,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();
        expect(capturedFactorMap?.has('2023-Q1')).toBe(true);
      });

      it('should generate monthly factor keys for total + EUR', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createMonthlyNormalization(),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.MONTH,
              selection: { interval: { start: '2023-01', end: '2023-12' } },
            },
            normalization: 'total',
            currency: 'EUR',
            inflation_adjusted: false,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();
        expect(capturedFactorMap?.has('2023-01')).toBe(true);
        expect(capturedFactorMap?.size).toBe(12);
      });
    });

    describe('Varying factors across periods', () => {
      it('should apply different quarterly factors correctly', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        // Create varying EUR rates per quarter
        const varyingEurRates = new Map([
          ['2023-Q1', new Decimal(4.8)],
          ['2023-Q2', new Decimal(4.9)],
          ['2023-Q3', new Decimal(5.0)],
          ['2023-Q4', new Decimal(5.1)],
        ]);

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createQuarterlyNormalization({ eur: varyingEurRates }),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.QUARTER,
              selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
            },
            normalization: 'total',
            currency: 'EUR',
            inflation_adjusted: false,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();

        // Each quarter should have its own factor
        expect(capturedFactorMap?.get('2023-Q1')?.toNumber()).toBeCloseTo(1 / 4.8, 10);
        expect(capturedFactorMap?.get('2023-Q2')?.toNumber()).toBeCloseTo(1 / 4.9, 10);
        expect(capturedFactorMap?.get('2023-Q3')?.toNumber()).toBeCloseTo(1 / 5.0, 10);
        expect(capturedFactorMap?.get('2023-Q4')?.toNumber()).toBeCloseTo(1 / 5.1, 10);
      });

      it('should apply different monthly CPI factors with inflation', async () => {
        let capturedFactorMap: Map<string, Decimal> | undefined;

        // Create varying CPI rates per month (declining inflation)
        const months = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
        const varyingCpi = new Map(
          months.map((m, i) => [`2023-${m}`, new Decimal(1.12 - i * 0.01)])
        );

        const deps: GetEntityAnalyticsDeps = {
          repo: createCapturingRepo((fm) => {
            capturedFactorMap = fm;
          }),
          normalization: createMonthlyNormalization({ cpi: varyingCpi }),
        };

        const result = await getEntityAnalytics(deps, {
          filter: createFilter({
            report_period: {
              type: Frequency.MONTH,
              selection: { interval: { start: '2023-01', end: '2023-12' } },
            },
            normalization: 'total',
            currency: 'RON',
            inflation_adjusted: true,
          }),
        });

        expect(result.isOk()).toBe(true);
        expect(capturedFactorMap).toBeDefined();

        // January: CPI = 1.12
        expect(capturedFactorMap?.get('2023-01')?.toNumber()).toBeCloseTo(1.12, 10);
        // June: CPI = 1.07 (1.12 - 5*0.01)
        expect(capturedFactorMap?.get('2023-06')?.toNumber()).toBeCloseTo(1.07, 10);
        // December: CPI = 1.01 (1.12 - 11*0.01)
        expect(capturedFactorMap?.get('2023-12')?.toNumber()).toBeCloseTo(1.01, 10);
      });
    });
  });
});
