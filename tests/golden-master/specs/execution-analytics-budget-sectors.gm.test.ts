/**
 * Golden Master Tests: Execution Analytics with Budget Sector Filtering
 *
 * Tests the executionAnalytics GraphQL query with budget_sector_ids filter
 * for all 5 budget sector variations:
 *   1. Bugetul de stat (central administration)
 *   2. Bugetul local (local administration)
 *   3. Bugetul asigurarilor sociale de stat
 *   4. Bugetul fondului de somaj
 *   5. Bugetul fondului de sanatate (FNUASS)
 *
 * All queries use historical data (2016-2024) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Execution Analytics - Budget Sectors', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  const QUERY = /* GraphQL */ `
    query GetExecutionLineItemsAnalytics($inputs: [AnalyticsInput!]!) {
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

  // ===========================================================================
  // Single Budget Sector Tests
  // ===========================================================================

  it('[GM] executionAnalytics - budget-sector-1-state', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'budget-sector-1-state',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2016',
                  end: '2024',
                },
              },
            },
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            budget_sector_ids: ['1'],
            normalization: 'total_euro',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/budget-sector-1-state.snap.json'
    );
  });

  it('[GM] executionAnalytics - budget-sector-2-local', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'budget-sector-2-local',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2016',
                  end: '2024',
                },
              },
            },
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            budget_sector_ids: ['2'],
            normalization: 'total_euro',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/budget-sector-2-local.snap.json'
    );
  });

  it('[GM] executionAnalytics - budget-sector-3-social-insurance', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'budget-sector-3-social-insurance',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2016',
                  end: '2024',
                },
              },
            },
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            budget_sector_ids: ['3'],
            normalization: 'total_euro',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/budget-sector-3-social-insurance.snap.json'
    );
  });

  it('[GM] executionAnalytics - budget-sector-4-unemployment', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'budget-sector-4-unemployment',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2016',
                  end: '2024',
                },
              },
            },
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            budget_sector_ids: ['4'],
            normalization: 'total_euro',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/budget-sector-4-unemployment.snap.json'
    );
  });

  it('[GM] executionAnalytics - budget-sector-5-health', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'budget-sector-5-health',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2016',
                  end: '2024',
                },
              },
            },
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            budget_sector_ids: ['5'],
            normalization: 'total_euro',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/budget-sector-5-health.snap.json'
    );
  });

  // ===========================================================================
  // Multi-Series Budget Sector Comparison
  // ===========================================================================

  it('[GM] executionAnalytics - budget-sectors-state-vs-local', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'state-budget',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2016',
                  end: '2024',
                },
              },
            },
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            budget_sector_ids: ['1'],
            normalization: 'total_euro',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
        {
          seriesId: 'local-budget',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2016',
                  end: '2024',
                },
              },
            },
            account_category: 'ch',
            report_type: 'PRINCIPAL_AGGREGATED',
            budget_sector_ids: ['2'],
            normalization: 'total_euro',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/budget-sectors-state-vs-local.snap.json'
    );
  });
});
