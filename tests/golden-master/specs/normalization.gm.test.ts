/**
 * Golden Master Tests: Normalization Combinations
 *
 * Comprehensive tests for all normalization modes:
 * - Normalization: total, per_capita, percent_gdp
 * - Currency: RON, EUR, USD
 * - Inflation adjustment: true, false
 * - Period types: YEAR, QUARTER, MONTH
 *
 * These tests ensure that normalization factors are correctly applied
 * across all combinations and period types.
 *
 * All queries use historical data (2016-2024) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Normalization Combinations', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  // ===========================================================================
  // Aggregated Line Items - Normalization Combinations
  // ===========================================================================

  describe('Aggregated Line Items - Currency Combinations', () => {
    const QUERY = /* GraphQL */ `
      query AggregatedLineItems($filter: AnalyticsFilterInput!, $limit: Int) {
        aggregatedLineItems(filter: $filter, limit: $limit) {
          nodes {
            fn_c: functional_code
            fn_n: functional_name
            ec_c: economic_code
            ec_n: economic_name
            amount
            count
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    it('[GM] aggregatedLineItems - total-ron-yearly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2023' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'RON',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-ron-yearly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - total-eur-yearly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2023' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'EUR',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-eur-yearly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - total-usd-yearly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2023' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'USD',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-usd-yearly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - total-ron-inflation-yearly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2023' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'RON',
          inflation_adjusted: true,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-ron-inflation-yearly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - total-eur-inflation-yearly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2023' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'EUR',
          inflation_adjusted: true,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-eur-inflation-yearly.snap.json'
      );
    });
  });

  describe('Aggregated Line Items - Per Capita Combinations', () => {
    const QUERY = /* GraphQL */ `
      query AggregatedLineItems($filter: AnalyticsFilterInput!, $limit: Int) {
        aggregatedLineItems(filter: $filter, limit: $limit) {
          nodes {
            fn_c: functional_code
            fn_n: functional_name
            ec_c: economic_code
            ec_n: economic_name
            amount
            count
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    it('[GM] aggregatedLineItems - per-capita-ron-yearly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2023' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
          currency: 'RON',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-per-capita-ron-yearly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - per-capita-eur-yearly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2023' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
          currency: 'EUR',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-per-capita-eur-yearly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - per-capita-ron-inflation-yearly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2023' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
          currency: 'RON',
          inflation_adjusted: true,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-per-capita-ron-inflation-yearly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - per-capita-eur-inflation-yearly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2023' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
          currency: 'EUR',
          inflation_adjusted: true,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-per-capita-eur-inflation-yearly.snap.json'
      );
    });
  });

  describe('Aggregated Line Items - Percent GDP', () => {
    const QUERY = /* GraphQL */ `
      query AggregatedLineItems($filter: AnalyticsFilterInput!, $limit: Int) {
        aggregatedLineItems(filter: $filter, limit: $limit) {
          nodes {
            fn_c: functional_code
            fn_n: functional_name
            ec_c: economic_code
            ec_n: economic_name
            amount
            count
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    it('[GM] aggregatedLineItems - percent-gdp-yearly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'YEAR',
            selection: { interval: { start: '2020', end: '2023' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'percent_gdp',
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-percent-gdp-yearly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - percent-gdp-quarterly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'percent_gdp',
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-percent-gdp-quarterly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - percent-gdp-monthly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2023-01', end: '2023-06' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'percent_gdp',
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-percent-gdp-monthly.snap.json'
      );
    });
  });

  // ===========================================================================
  // Aggregated Line Items - Quarterly Period Tests
  // ===========================================================================

  describe('Aggregated Line Items - Quarterly Periods', () => {
    const QUERY = /* GraphQL */ `
      query AggregatedLineItems($filter: AnalyticsFilterInput!, $limit: Int) {
        aggregatedLineItems(filter: $filter, limit: $limit) {
          nodes {
            fn_c: functional_code
            fn_n: functional_name
            ec_c: economic_code
            ec_n: economic_name
            amount
            count
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    it('[GM] aggregatedLineItems - total-eur-quarterly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'EUR',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-eur-quarterly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - total-usd-quarterly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'USD',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-usd-quarterly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - total-ron-inflation-quarterly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'RON',
          inflation_adjusted: true,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-ron-inflation-quarterly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - per-capita-ron-quarterly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
          currency: 'RON',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-per-capita-ron-quarterly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - per-capita-eur-quarterly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
          currency: 'EUR',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-per-capita-eur-quarterly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - per-capita-eur-inflation-quarterly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
          currency: 'EUR',
          inflation_adjusted: true,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-per-capita-eur-inflation-quarterly.snap.json'
      );
    });
  });

  // ===========================================================================
  // Aggregated Line Items - Monthly Period Tests
  // ===========================================================================

  describe('Aggregated Line Items - Monthly Periods', () => {
    const QUERY = /* GraphQL */ `
      query AggregatedLineItems($filter: AnalyticsFilterInput!, $limit: Int) {
        aggregatedLineItems(filter: $filter, limit: $limit) {
          nodes {
            fn_c: functional_code
            fn_n: functional_name
            ec_c: economic_code
            ec_n: economic_name
            amount
            count
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    it('[GM] aggregatedLineItems - total-eur-monthly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2023-01', end: '2023-06' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'EUR',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-eur-monthly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - total-usd-monthly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2023-01', end: '2023-06' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'USD',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-usd-monthly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - total-ron-inflation-monthly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2023-01', end: '2023-06' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'RON',
          inflation_adjusted: true,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-total-ron-inflation-monthly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - per-capita-ron-monthly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2023-01', end: '2023-06' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
          currency: 'RON',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-per-capita-ron-monthly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - per-capita-eur-monthly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2023-01', end: '2023-06' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
          currency: 'EUR',
          inflation_adjusted: false,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-per-capita-eur-monthly.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - per-capita-eur-inflation-monthly', async () => {
      const variables = {
        filter: {
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2023-01', end: '2023-06' } },
          },
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
          currency: 'EUR',
          inflation_adjusted: true,
        },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/aggregated-per-capita-eur-inflation-monthly.snap.json'
      );
    });
  });

  // ===========================================================================
  // Entity Analytics - Normalization Combinations
  // ===========================================================================

  describe('Entity Analytics - Normalization Combinations', () => {
    const QUERY = /* GraphQL */ `
      query EntityAnalytics($filter: AnalyticsFilterInput!, $sort: SortOrder, $limit: Int) {
        entityAnalytics(filter: $filter, sort: $sort, limit: $limit) {
          nodes {
            entity_cui
            entity_name
            entity_type
            county_code
            amount
            total_amount
            per_capita_amount
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    it('[GM] entityAnalytics - percent-gdp-yearly', async () => {
      const variables = {
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'YEAR',
            selection: { dates: ['2023'] },
          },
          normalization: 'percent_gdp',
        },
        sort: { by: 'TOTAL_AMOUNT', order: 'DESC' },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/entity-percent-gdp-yearly.snap.json'
      );
    });

    it('[GM] entityAnalytics - percent-gdp-quarterly', async () => {
      const variables = {
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
          },
          normalization: 'percent_gdp',
        },
        sort: { by: 'TOTAL_AMOUNT', order: 'DESC' },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/entity-percent-gdp-quarterly.snap.json'
      );
    });

    it('[GM] entityAnalytics - percent-gdp-monthly', async () => {
      const variables = {
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2023-01', end: '2023-06' } },
          },
          normalization: 'percent_gdp',
        },
        sort: { by: 'TOTAL_AMOUNT', order: 'DESC' },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/entity-percent-gdp-monthly.snap.json'
      );
    });

    it('[GM] entityAnalytics - total-usd-yearly', async () => {
      const variables = {
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'YEAR',
            selection: { dates: ['2023'] },
          },
          normalization: 'total',
          currency: 'USD',
          inflation_adjusted: false,
        },
        sort: { by: 'TOTAL_AMOUNT', order: 'DESC' },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/entity-total-usd-yearly.snap.json'
      );
    });

    it('[GM] entityAnalytics - total-ron-inflation-yearly', async () => {
      const variables = {
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'YEAR',
            selection: { dates: ['2023'] },
          },
          normalization: 'total',
          currency: 'RON',
          inflation_adjusted: true,
        },
        sort: { by: 'TOTAL_AMOUNT', order: 'DESC' },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/entity-total-ron-inflation-yearly.snap.json'
      );
    });

    it('[GM] entityAnalytics - per-capita-eur-inflation-yearly', async () => {
      const variables = {
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'YEAR',
            selection: { dates: ['2023'] },
          },
          normalization: 'per_capita',
          currency: 'EUR',
          inflation_adjusted: true,
          min_population: 1000,
        },
        sort: { by: 'PER_CAPITA_AMOUNT', order: 'DESC' },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/entity-per-capita-eur-inflation-yearly.snap.json'
      );
    });

    it('[GM] entityAnalytics - per-capita-ron-quarterly', async () => {
      const variables = {
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'QUARTER',
            selection: { interval: { start: '2023-Q1', end: '2023-Q4' } },
          },
          normalization: 'per_capita',
          currency: 'RON',
          inflation_adjusted: false,
          min_population: 1000,
        },
        sort: { by: 'PER_CAPITA_AMOUNT', order: 'DESC' },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/entity-per-capita-ron-quarterly.snap.json'
      );
    });

    it('[GM] entityAnalytics - per-capita-eur-monthly', async () => {
      const variables = {
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'MONTH',
            selection: { interval: { start: '2023-01', end: '2023-06' } },
          },
          normalization: 'per_capita',
          currency: 'EUR',
          inflation_adjusted: false,
          min_population: 1000,
        },
        sort: { by: 'PER_CAPITA_AMOUNT', order: 'DESC' },
        limit: 20,
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/entity-per-capita-eur-monthly.snap.json'
      );
    });
  });

  // ===========================================================================
  // Execution Analytics - Additional Normalization Tests
  // ===========================================================================

  describe('Execution Analytics - Additional Normalization', () => {
    const QUERY = /* GraphQL */ `
      query ExecutionAnalytics($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          data {
            x
            y
          }
        }
      }
    `;

    it('[GM] executionAnalytics - total-ron-inflation-yearly', async () => {
      const variables = {
        inputs: [
          {
            seriesId: 'total-ron-inflation',
            filter: {
              account_category: 'ch',
              report_type: 'PRINCIPAL_AGGREGATED',
              report_period: {
                type: 'YEAR',
                selection: { interval: { start: '2020', end: '2023' } },
              },
              normalization: 'total',
              currency: 'RON',
              inflation_adjusted: true,
            },
          },
        ],
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/execution-total-ron-inflation-yearly.snap.json'
      );
    });

    it('[GM] executionAnalytics - total-usd-yearly', async () => {
      const variables = {
        inputs: [
          {
            seriesId: 'total-usd',
            filter: {
              account_category: 'ch',
              report_type: 'PRINCIPAL_AGGREGATED',
              report_period: {
                type: 'YEAR',
                selection: { interval: { start: '2020', end: '2023' } },
              },
              normalization: 'total',
              currency: 'USD',
              inflation_adjusted: false,
            },
          },
        ],
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/execution-total-usd-yearly.snap.json'
      );
    });

    it('[GM] executionAnalytics - percent-gdp-yearly', async () => {
      const variables = {
        inputs: [
          {
            seriesId: 'percent-gdp',
            filter: {
              account_category: 'ch',
              report_type: 'PRINCIPAL_AGGREGATED',
              report_period: {
                type: 'YEAR',
                selection: { interval: { start: '2020', end: '2023' } },
              },
              normalization: 'percent_gdp',
            },
          },
        ],
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/execution-percent-gdp-yearly.snap.json'
      );
    });

    it('[GM] executionAnalytics - percent-gdp-quarterly', async () => {
      const variables = {
        inputs: [
          {
            seriesId: 'percent-gdp-quarterly',
            filter: {
              account_category: 'ch',
              report_type: 'PRINCIPAL_AGGREGATED',
              report_period: {
                type: 'QUARTER',
                selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
              },
              normalization: 'percent_gdp',
            },
          },
        ],
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/execution-percent-gdp-quarterly.snap.json'
      );
    });

    it('[GM] executionAnalytics - percent-gdp-monthly', async () => {
      const variables = {
        inputs: [
          {
            seriesId: 'percent-gdp-monthly',
            filter: {
              account_category: 'ch',
              report_type: 'PRINCIPAL_AGGREGATED',
              report_period: {
                type: 'MONTH',
                selection: { interval: { start: '2023-01', end: '2023-06' } },
              },
              normalization: 'percent_gdp',
            },
          },
        ],
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/execution-percent-gdp-monthly.snap.json'
      );
    });

    it('[GM] executionAnalytics - per-capita-monthly', async () => {
      const variables = {
        inputs: [
          {
            seriesId: 'per-capita-monthly',
            filter: {
              account_category: 'ch',
              report_type: 'PRINCIPAL_AGGREGATED',
              report_period: {
                type: 'MONTH',
                selection: { interval: { start: '2023-01', end: '2023-06' } },
              },
              normalization: 'per_capita',
            },
          },
        ],
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/execution-per-capita-monthly.snap.json'
      );
    });

    it('[GM] executionAnalytics - total-eur-quarterly', async () => {
      const variables = {
        inputs: [
          {
            seriesId: 'total-eur-quarterly',
            filter: {
              account_category: 'ch',
              report_type: 'PRINCIPAL_AGGREGATED',
              report_period: {
                type: 'QUARTER',
                selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
              },
              normalization: 'total',
              currency: 'EUR',
              inflation_adjusted: false,
            },
          },
        ],
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/execution-total-eur-quarterly.snap.json'
      );
    });

    it('[GM] executionAnalytics - total-eur-inflation-quarterly', async () => {
      const variables = {
        inputs: [
          {
            seriesId: 'total-eur-inflation-quarterly',
            filter: {
              account_category: 'ch',
              report_type: 'PRINCIPAL_AGGREGATED',
              report_period: {
                type: 'QUARTER',
                selection: { interval: { start: '2022-Q1', end: '2023-Q4' } },
              },
              normalization: 'total',
              currency: 'EUR',
              inflation_adjusted: true,
            },
          },
        ],
      };

      const data = await client.query(QUERY, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/execution-total-eur-inflation-quarterly.snap.json'
      );
    });
  });

  // ===========================================================================
  // Heatmap - Normalization Tests
  // ===========================================================================

  describe('Heatmap - Normalization', () => {
    it('[GM] heatmapCountyData - per-capita-eur-inflation', async () => {
      const query = /* GraphQL */ `
        query CountyHeatmap(
          $filter: AnalyticsFilterInput!
          $normalization: HeatmapNormalization
          $currency: HeatmapCurrency
          $inflation_adjusted: Boolean
        ) {
          heatmapCountyData(
            filter: $filter
            normalization: $normalization
            currency: $currency
            inflation_adjusted: $inflation_adjusted
          ) {
            county_code
            county_name
            amount
            total_amount
            per_capita_amount
          }
        }
      `;

      const variables = {
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'YEAR',
            selection: { dates: ['2023'] },
          },
        },
        normalization: 'per_capita',
        currency: 'EUR',
        inflation_adjusted: true,
      };

      const data = await client.query(query, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/heatmap-county-per-capita-eur-inflation.snap.json'
      );
    });

    it('[GM] heatmapUATData - per-capita-eur-inflation', async () => {
      const query = /* GraphQL */ `
        query UATHeatmap(
          $filter: AnalyticsFilterInput!
          $normalization: HeatmapNormalization
          $currency: HeatmapCurrency
          $inflation_adjusted: Boolean
        ) {
          heatmapUATData(
            filter: $filter
            normalization: $normalization
            currency: $currency
            inflation_adjusted: $inflation_adjusted
          ) {
            uat_id
            uat_name
            county_code
            amount
            total_amount
            per_capita_amount
          }
        }
      `;

      const variables = {
        filter: {
          account_category: 'ch',
          report_type: 'PRINCIPAL_AGGREGATED',
          report_period: {
            type: 'YEAR',
            selection: { dates: ['2023'] },
          },
          county_codes: ['CJ'],
        },
        normalization: 'per_capita',
        currency: 'EUR',
        inflation_adjusted: true,
      };

      const data = await client.query(query, variables);
      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/normalization/heatmap-uat-per-capita-eur-inflation.snap.json'
      );
    });
  });
});
