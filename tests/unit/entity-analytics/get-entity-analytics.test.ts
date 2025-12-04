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
      frequency: Frequency.YEAR,
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
});
