import { Decimal } from 'decimal.js';
import { ok, err } from 'neverthrow';
import { describe, expect, it, afterEach, vi, beforeEach } from 'vitest';

import { createApp } from '@/app/build-app.js';
import { makeEntityAnalyticsRepo } from '@/modules/entity-analytics/shell/repo/entity-analytics-repo.js';

import { makeTestConfig } from '../fixtures/builders.js';
import { makeFakeBudgetDb, makeFakeDatasetRepo } from '../fixtures/fakes.js';

import type { EntityAnalyticsRepository } from '@/modules/entity-analytics/core/ports.js';
import type {
  EntityAnalyticsRow,
  EntityAnalyticsResult,
} from '@/modules/entity-analytics/core/types.js';
import type { FastifyInstance } from 'fastify';

// Mock the entity analytics repo module
vi.mock('@/modules/entity-analytics/shell/repo/entity-analytics-repo.js', () => ({
  makeEntityAnalyticsRepo: vi.fn(),
}));

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

// =============================================================================
// Tests
// =============================================================================

describe('EntityAnalytics GraphQL API', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app != null) {
      await app.close();
    }
    vi.clearAllMocks();
  });

  describe('Basic Query', () => {
    beforeEach(() => {
      const rows = [
        createRow('CUI001', 'Primaria A', 1000000, 50000, {
          entity_type: 'uat',
          county_code: 'AB',
          county_name: 'Alba',
          uat_id: 1,
        }),
        createRow('CUI002', 'Primaria B', 500000, 25000, {
          entity_type: 'uat',
          county_code: 'CJ',
          county_name: 'Cluj',
          uat_id: 2,
        }),
      ];

      const mockResult: EntityAnalyticsResult = {
        items: rows,
        totalCount: 2,
      };

      const mockRepo: EntityAnalyticsRepository = {
        getEntityAnalytics: vi.fn(async () => ok(mockResult)),
      };

      vi.mocked(makeEntityAnalyticsRepo).mockReturnValue(mockRepo);
    });

    it('should return entity analytics data', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          entityAnalytics(
            filter: {
              account_category: ch
              report_period: {
                type: YEAR
                selection: {
                  interval: {
                    start: "2023"
                    end: "2024"
                  }
                }
              }
              normalization: total
              inflation_adjusted: false
              show_period_growth: false
            }
          ) {
            nodes {
              entity_cui
              entity_name
              entity_type
              uat_id
              county_code
              county_name
              population
              amount
              total_amount
              per_capita_amount
            }
            pageInfo {
              totalCount
              hasNextPage
              hasPreviousPage
            }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.entityAnalytics.nodes).toHaveLength(2);
      expect(body.data.entityAnalytics.nodes[0]).toEqual({
        entity_cui: 'CUI001',
        entity_name: 'Primaria A',
        entity_type: 'uat',
        uat_id: '1',
        county_code: 'AB',
        county_name: 'Alba',
        population: 50000,
        amount: 1000000,
        total_amount: 1000000,
        per_capita_amount: 20,
      });
      expect(body.data.entityAnalytics.pageInfo.totalCount).toBe(2);
    });

    it('should accept sort parameters', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          entityAnalytics(
            filter: {
              account_category: ch
              report_period: {
                type: YEAR
                selection: {
                  interval: {
                    start: "2023"
                    end: "2024"
                  }
                }
              }
              normalization: per_capita
              inflation_adjusted: false
              show_period_growth: false
            }
            sort: {
              by: "PER_CAPITA_AMOUNT"
              order: "DESC"
            }
            limit: 10
            offset: 0
          ) {
            nodes {
              entity_cui
              per_capita_amount
            }
            pageInfo {
              totalCount
            }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.entityAnalytics.nodes).toBeDefined();
    });

    it('should support all sort field options', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const sortFields = [
        'AMOUNT',
        'TOTAL_AMOUNT',
        'PER_CAPITA_AMOUNT',
        'ENTITY_NAME',
        'ENTITY_TYPE',
        'POPULATION',
        'COUNTY_NAME',
        'COUNTY_CODE',
      ];

      for (const field of sortFields) {
        const query = `
          query {
            entityAnalytics(
              filter: {
                account_category: ch
                report_period: {
                  type: YEAR
                  selection: { interval: { start: "2023", end: "2024" } }
                }
              }
              sort: { by: "${field}", order: "ASC" }
            ) {
              nodes { entity_cui }
            }
          }
        `;

        const response = await app.inject({
          method: 'POST',
          url: '/graphql',
          payload: { query },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.errors).toBeUndefined();
      }
    });
  });

  describe('Legacy Normalization Modes', () => {
    beforeEach(() => {
      const rows = [createRow('CUI001', 'Entity A', 1000000, 50000)];
      const mockResult: EntityAnalyticsResult = { items: rows, totalCount: 1 };
      const mockRepo: EntityAnalyticsRepository = {
        getEntityAnalytics: vi.fn(async () => ok(mockResult)),
      };
      vi.mocked(makeEntityAnalyticsRepo).mockReturnValue(mockRepo);
    });

    it('should accept total_euro normalization mode', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          entityAnalytics(
            filter: {
              account_category: ch
              report_period: {
                type: YEAR
                selection: { interval: { start: "2023", end: "2024" } }
              }
              normalization: total_euro
            }
          ) {
            nodes { entity_cui }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();
    });

    it('should accept per_capita_euro normalization mode', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          entityAnalytics(
            filter: {
              account_category: vn
              report_period: {
                type: YEAR
                selection: { interval: { start: "2023", end: "2024" } }
              }
              normalization: per_capita_euro
            }
          ) {
            nodes { entity_cui }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();
    });
  });

  describe('Null Population Handling', () => {
    beforeEach(() => {
      const rows = [
        createRow('CUI001', 'Ministry of Finance', 5000000, null, {
          entity_type: 'ministry',
          uat_id: null,
          county_code: null,
          county_name: null,
        }),
      ];
      const mockResult: EntityAnalyticsResult = { items: rows, totalCount: 1 };
      const mockRepo: EntityAnalyticsRepository = {
        getEntityAnalytics: vi.fn(async () => ok(mockResult)),
      };
      vi.mocked(makeEntityAnalyticsRepo).mockReturnValue(mockRepo);
    });

    it('should handle entities with null population', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          entityAnalytics(
            filter: {
              account_category: ch
              report_period: {
                type: YEAR
                selection: { interval: { start: "2023", end: "2024" } }
              }
            }
          ) {
            nodes {
              entity_cui
              entity_name
              entity_type
              population
              per_capita_amount
            }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.entityAnalytics.nodes[0].population).toBeNull();
      expect(body.data.entityAnalytics.nodes[0].per_capita_amount).toBe(0);
    });
  });

  describe('Pagination', () => {
    beforeEach(() => {
      const rows = [createRow('CUI001', 'Entity A', 1000000, 50000)];
      const mockResult: EntityAnalyticsResult = { items: rows, totalCount: 100 };
      const mockRepo: EntityAnalyticsRepository = {
        getEntityAnalytics: vi.fn(async () => ok(mockResult)),
      };
      vi.mocked(makeEntityAnalyticsRepo).mockReturnValue(mockRepo);
    });

    it('should return correct pagination info', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          entityAnalytics(
            filter: {
              account_category: ch
              report_period: {
                type: YEAR
                selection: { interval: { start: "2023", end: "2024" } }
              }
            }
            limit: 10
            offset: 50
          ) {
            pageInfo {
              totalCount
              hasNextPage
              hasPreviousPage
            }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.entityAnalytics.pageInfo).toEqual({
        totalCount: 100,
        hasNextPage: true,
        hasPreviousPage: true,
      });
    });
  });

  describe('Error Handling', () => {
    it('should return error when repository fails', async () => {
      const mockRepo: EntityAnalyticsRepository = {
        getEntityAnalytics: vi.fn(async () =>
          err({
            type: 'DatabaseError' as const,
            message: 'Connection failed',
            retryable: true,
          })
        ),
      };
      vi.mocked(makeEntityAnalyticsRepo).mockReturnValue(mockRepo);

      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          entityAnalytics(
            filter: {
              account_category: ch
              report_period: {
                type: YEAR
                selection: { interval: { start: "2023", end: "2024" } }
              }
            }
          ) {
            nodes { entity_cui }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.errors).toBeDefined();
      expect(body.errors[0].message).toContain('DatabaseError');
    });
  });

  describe('Period Types', () => {
    beforeEach(() => {
      const rows = [createRow('CUI001', 'Entity A', 1000000, 50000)];
      const mockResult: EntityAnalyticsResult = { items: rows, totalCount: 1 };
      const mockRepo: EntityAnalyticsRepository = {
        getEntityAnalytics: vi.fn(async () => ok(mockResult)),
      };
      vi.mocked(makeEntityAnalyticsRepo).mockReturnValue(mockRepo);
    });

    it('should accept MONTH period type', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          entityAnalytics(
            filter: {
              account_category: ch
              report_period: {
                type: MONTH
                selection: { interval: { start: "2023-01", end: "2023-12" } }
              }
            }
          ) {
            nodes { entity_cui }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().errors).toBeUndefined();
    });

    it('should accept QUARTER period type', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
          config: makeTestConfig(),
        },
      });

      const query = `
        query {
          entityAnalytics(
            filter: {
              account_category: ch
              report_period: {
                type: QUARTER
                selection: { interval: { start: "2023-Q1", end: "2023-Q4" } }
              }
            }
          ) {
            nodes { entity_cui }
          }
        }
      `;

      const response = await app.inject({
        method: 'POST',
        url: '/graphql',
        payload: { query },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().errors).toBeUndefined();
    });
  });
});
