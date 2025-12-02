import { ok } from 'neverthrow';
import { describe, expect, it, afterEach, vi, beforeEach } from 'vitest';

import { createApp } from '@/app.js';
import { makeAnalyticsRepo } from '@/modules/execution-analytics/shell/repo/analytics-repo.js';

import { makeHealthChecker } from '../fixtures/builders.js';
import { makeFakeBudgetDb, makeFakeDatasetRepo } from '../fixtures/fakes.js';

import type {
  AnalyticsFilter,
  AnalyticsRepository,
  RawAnalyticsDataPoint,
} from '@/modules/execution-analytics/core/types.js';
import type { FastifyInstance } from 'fastify';

// Mock the analytics repo module
vi.mock('@/modules/execution-analytics/shell/repo/analytics-repo.js', () => ({
  makeAnalyticsRepo: vi.fn(),
}));

describe('GraphQL API', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app != null) {
      await app.close();
    }
  });

  it('can query health', async () => {
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        budgetDb: makeFakeBudgetDb(),
        datasetRepo: makeFakeDatasetRepo(),
      },
    });

    const query = `
      query {
        health
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
    expect(body.data).toEqual({ health: 'ok' });
  });

  it('can query ready status', async () => {
    const dbChecker = makeHealthChecker({ name: 'database', status: 'healthy' });
    app = await createApp({
      fastifyOptions: { logger: false },
      deps: {
        healthCheckers: [dbChecker],
        budgetDb: makeFakeBudgetDb(),
        datasetRepo: makeFakeDatasetRepo(),
      },
    });

    const query = `
      query {
        ready {
          status
          checks {
            name
            status
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
    expect(body.data.ready.status).toBe('ok');
    expect(body.data.ready.checks).toHaveLength(1);
    expect(body.data.ready.checks[0]).toEqual({ name: 'database', status: 'healthy' });
  });

  // TODO: fix this test using https://the-guild.dev/graphql/tools/docs/mocking
  describe('ReportType enum deserialization', () => {
    let capturedFilter: AnalyticsFilter | null = null;

    beforeEach(() => {
      capturedFilter = null;

      // Create a mock repository that captures the filter argument
      const mockRepo: AnalyticsRepository = {
        getAggregatedSeries: vi.fn(async (filter: AnalyticsFilter) => {
          capturedFilter = filter;
          return ok([] as RawAnalyticsDataPoint[]);
        }),
      };

      // Make the mock factory return our mock repo
      vi.mocked(makeAnalyticsRepo).mockReturnValue(mockRepo);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('deserializes PRINCIPAL_AGGREGATED enum to Romanian text value', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
        },
      });

      const query = `
        query {
          executionAnalytics(inputs: [{
            filter: {
              account_category: vn
              report_period: {
                type: YEAR
                selection: {
                  interval: {
                    start: "2023"
                    end: "2023"
                  }
                }
              }
              report_type: PRINCIPAL_AGGREGATED
              normalization: total
              inflation_adjusted: false
              show_period_growth: false
            }
            seriesId: "test-series"
          }]) {
            seriesId
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

      // Verify the repository received the correct deserialized enum value
      expect(capturedFilter).not.toBeNull();
      expect(capturedFilter!.report_type).toBe(
        'Executie bugetara agregata la nivel de ordonator principal'
      );
    });

    it('deserializes SECONDARY_AGGREGATED enum to Romanian text value', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
        },
      });

      const query = `
        query {
          executionAnalytics(inputs: [{
            filter: {
              account_category: ch
              report_period: {
                type: YEAR
                selection: {
                  interval: {
                    start: "2023"
                    end: "2023"
                  }
                }
              }
              report_type: SECONDARY_AGGREGATED
              normalization: total
              inflation_adjusted: false
              show_period_growth: false
            }
            seriesId: "test-series"
          }]) {
            seriesId
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

      expect(capturedFilter).not.toBeNull();
      expect(capturedFilter!.report_type).toBe(
        'Executie bugetara agregata la nivel de ordonator secundar'
      );
    });

    it('deserializes DETAILED enum to Romanian text value', async () => {
      app = await createApp({
        fastifyOptions: { logger: false },
        deps: {
          budgetDb: makeFakeBudgetDb(),
          datasetRepo: makeFakeDatasetRepo(),
        },
      });

      const query = `
        query {
          executionAnalytics(inputs: [{
            filter: {
              account_category: vn
              report_period: {
                type: YEAR
                selection: {
                  interval: {
                    start: "2023"
                    end: "2023"
                  }
                }
              }
              report_type: DETAILED
              normalization: total
              inflation_adjusted: false
              show_period_growth: false
            }
            seriesId: "test-series"
          }]) {
            seriesId
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

      expect(capturedFilter).not.toBeNull();
      expect(capturedFilter!.report_type).toBe('Executie bugetara detaliata');
    });
  });
});
