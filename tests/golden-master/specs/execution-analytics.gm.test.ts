/**
 * Golden Master Tests: Execution Analytics
 *
 * Tests the executionAnalytics GraphQL query with various scenarios:
 * - Period types (YEAR, QUARTER, MONTH)
 * - Normalization modes (total, per_capita)
 * - Filters (county, functional classification, entity type)
 * - Multi-series queries
 *
 * All queries use historical data (2016-2024) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Execution Analytics', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  // ===========================================================================
  // Yearly Scenarios
  // ===========================================================================

  it('[GM] executionAnalytics - yearly-totals', async () => {
    const query = /* GraphQL */ `
      query YearlyTotals($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'yearly-totals',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2020',
                  end: '2023',
                },
              },
            },
            normalization: 'total',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/yearly-totals.snap.json'
    );
  });

  it('[GM] executionAnalytics - yearly-per-capita', async () => {
    const query = /* GraphQL */ `
      query YearlyPerCapita($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'yearly-per-capita',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2020',
                  end: '2023',
                },
              },
            },
            normalization: 'per_capita',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/yearly-per-capita.snap.json'
    );
  });

  it('[GM] executionAnalytics - yearly-with-economic-filter', async () => {
    const query = /* GraphQL */ `
      query YearlyWithEconomicFilter($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'yearly-economic-filter',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2020',
                  end: '2023',
                },
              },
            },
            normalization: 'total',
            economic_prefixes: ['10'],
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/yearly-with-economic-filter.snap.json'
    );
  });

  // ===========================================================================
  // Quarterly Scenarios
  // ===========================================================================

  it('[GM] executionAnalytics - quarterly-totals', async () => {
    const query = /* GraphQL */ `
      query QuarterlyTotals($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'quarterly-totals',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'QUARTER',
              selection: {
                interval: {
                  start: '2022-Q1',
                  end: '2023-Q4',
                },
              },
            },
            normalization: 'total',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/quarterly-totals.snap.json'
    );
  });

  it('[GM] executionAnalytics - quarterly-per-capita', async () => {
    const query = /* GraphQL */ `
      query QuarterlyPerCapita($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'quarterly-per-capita',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'QUARTER',
              selection: {
                interval: {
                  start: '2022-Q1',
                  end: '2023-Q4',
                },
              },
            },
            normalization: 'per_capita',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/quarterly-per-capita.snap.json'
    );
  });

  // ===========================================================================
  // Monthly Scenarios
  // ===========================================================================

  it('[GM] executionAnalytics - monthly-totals', async () => {
    const query = /* GraphQL */ `
      query MonthlyTotals($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'monthly-totals',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'MONTH',
              selection: {
                dates: ['2023-01', '2023-02', '2023-03', '2023-04', '2023-05', '2023-06'],
              },
            },
            normalization: 'total',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/monthly-totals.snap.json'
    );
  });

  // ===========================================================================
  // Filtered Scenarios
  // ===========================================================================

  it('[GM] executionAnalytics - filtered-by-county', async () => {
    const query = /* GraphQL */ `
      query FilteredByCounty($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'county-cj',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2020',
                  end: '2023',
                },
              },
            },
            county_codes: ['CJ'],
            normalization: 'total',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/filtered-by-county.snap.json'
    );
  });

  it('[GM] executionAnalytics - filtered-by-functional', async () => {
    const query = /* GraphQL */ `
      query FilteredByFunctional($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'functional-education',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2020',
                  end: '2023',
                },
              },
            },
            functional_prefixes: ['65'],
            normalization: 'total',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/filtered-by-functional.snap.json'
    );
  });

  it('[GM] executionAnalytics - filtered-by-entity-type', async () => {
    const query = /* GraphQL */ `
      query FilteredByEntityType($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'entity-type-uat',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2020',
                  end: '2023',
                },
              },
            },
            entity_types: ['uat'],
            normalization: 'total',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/filtered-by-entity-type.snap.json'
    );
  });

  // ===========================================================================
  // Additional Normalization Scenarios
  // ===========================================================================

  it('[GM] executionAnalytics - yearly-total-euro', async () => {
    const query = /* GraphQL */ `
      query YearlyTotalEuro($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'yearly-total-euro',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2020',
                  end: '2023',
                },
              },
            },
            normalization: 'total_euro',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/yearly-total-euro.snap.json'
    );
  });

  it('[GM] executionAnalytics - income-vs-expenses', async () => {
    const query = /* GraphQL */ `
      query IncomeVsExpenses($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'income-yearly',
          filter: {
            account_category: 'vn',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2018',
                  end: '2023',
                },
              },
            },
            normalization: 'total',
          },
        },
        {
          seriesId: 'expenses-yearly',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2018',
                  end: '2023',
                },
              },
            },
            normalization: 'total',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/income-vs-expenses.snap.json'
    );
  });

  // ===========================================================================
  // Multi-Series Scenarios
  // ===========================================================================

  it('[GM] executionAnalytics - multi-series', async () => {
    const query = /* GraphQL */ `
      query MultiSeries($inputs: [AnalyticsInput!]!) {
        executionAnalytics(inputs: $inputs) {
          seriesId
          xAxis {
            name
            type
            unit
          }
          yAxis {
            name
            type
            unit
          }
          data {
            x
            y
          }
        }
      }
    `;

    const variables = {
      inputs: [
        {
          seriesId: 'income',
          filter: {
            account_category: 'vn',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2020',
                  end: '2023',
                },
              },
            },
            normalization: 'total',
          },
        },
        {
          seriesId: 'expenses',
          filter: {
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2020',
                  end: '2023',
                },
              },
            },
            normalization: 'total',
          },
        },
      ],
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/execution-analytics/multi-series.snap.json'
    );
  });
});
