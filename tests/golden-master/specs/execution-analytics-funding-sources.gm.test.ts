/**
 * Golden Master Tests: Execution Analytics with Funding Source Filtering
 *
 * Tests the executionAnalytics GraphQL query with funding_source_ids filter
 * for all 10 funding source variations:
 *   1. Integral de la buget (Fully from budget)
 *   2. Credite externe (External credits/loans)
 *   3. Credite interne (Internal credits/loans)
 *   4. Fonduri externe nerambursabile (Non-refundable external funds - EU)
 *   5. Activitati finantate integral din venituri proprii (Activities fully funded from own revenues)
 *   6. Integral venituri proprii (Fully own revenues)
 *   7. Venituri proprii si subventii (Own revenues and subsidies)
 *   8. Buget aferent activitatii din privatizare (Budget for privatization activities)
 *   9. Bugetul Fondului pentru Mediu (Environmental Fund budget)
 *   10. Bugetul Trezoreriei Statului (State Treasury budget)
 *
 * All queries use historical data (2016-2024) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Execution Analytics - Funding Sources', () => {
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
  // Single Funding Source Tests
  // ===========================================================================

  it('[GM] executionAnalytics - funding-source-1-budget', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'funding-source-1-budget',
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
            funding_source_ids: ['1'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-source-1-budget.snap.json'
    );
  });

  it('[GM] executionAnalytics - funding-source-2-external-credits', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'funding-source-2-external-credits',
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
            funding_source_ids: ['2'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-source-2-external-credits.snap.json'
    );
  });

  it('[GM] executionAnalytics - funding-source-3-internal-credits', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'funding-source-3-internal-credits',
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
            funding_source_ids: ['3'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-source-3-internal-credits.snap.json'
    );
  });

  it('[GM] executionAnalytics - funding-source-4-eu-funds', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'funding-source-4-eu-funds',
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
            funding_source_ids: ['4'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-source-4-eu-funds.snap.json'
    );
  });

  it('[GM] executionAnalytics - funding-source-5-own-revenues-full', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'funding-source-5-own-revenues-full',
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
            funding_source_ids: ['5'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-source-5-own-revenues-full.snap.json'
    );
  });

  it('[GM] executionAnalytics - funding-source-6-own-revenues', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'funding-source-6-own-revenues',
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
            funding_source_ids: ['6'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-source-6-own-revenues.snap.json'
    );
  });

  it('[GM] executionAnalytics - funding-source-7-revenues-subsidies', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'funding-source-7-revenues-subsidies',
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
            funding_source_ids: ['7'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-source-7-revenues-subsidies.snap.json'
    );
  });

  it('[GM] executionAnalytics - funding-source-8-privatization', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'funding-source-8-privatization',
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
            funding_source_ids: ['8'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-source-8-privatization.snap.json'
    );
  });

  it('[GM] executionAnalytics - funding-source-9-environmental', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'funding-source-9-environmental',
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
            funding_source_ids: ['9'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-source-9-environmental.snap.json'
    );
  });

  it('[GM] executionAnalytics - funding-source-10-treasury', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'funding-source-10-treasury',
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
            funding_source_ids: ['10'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-source-10-treasury.snap.json'
    );
  });

  // ===========================================================================
  // Multi-Series Funding Source Comparisons
  // ===========================================================================

  it('[GM] executionAnalytics - funding-sources-budget-vs-eu-funds', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'from-budget',
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
            funding_source_ids: ['1'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
        {
          seriesId: 'eu-funds',
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
            funding_source_ids: ['4'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-sources-budget-vs-eu-funds.snap.json'
    );
  });

  it('[GM] executionAnalytics - funding-sources-credits-comparison', async () => {
    const variables = {
      inputs: [
        {
          seriesId: 'external-credits',
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
            funding_source_ids: ['2'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
        {
          seriesId: 'internal-credits',
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
            funding_source_ids: ['3'],
            budget_sector_ids: [],
            normalization: 'total',
            exclude: {
              economic_prefixes: ['51', '55.01'],
            },
          },
        },
      ],
    };

    const data = await client.query(QUERY, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/execution-analytics/funding-sources-credits-comparison.snap.json'
    );
  });
});
