/**
 * Golden Master Tests: Aggregated Line Items with Various Filters
 *
 * Tests the aggregatedLineItems GraphQL query with:
 * - Budget sector filtering (sectors 1-5)
 * - Funding source filtering (sources 1-10)
 * - Exclusion filters (functional_prefixes, economic_prefixes)
 * - Normalization modes
 *
 * All queries use historical data (2016-2024) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Aggregated Line Items - Filters', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  const QUERY = /* GraphQL */ `
    query AggregatedLineItems($filter: AnalyticsFilterInput!, $limit: Int, $offset: Int) {
      aggregatedLineItems(filter: $filter, limit: $limit, offset: $offset) {
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
          hasNextPage
          hasPreviousPage
        }
      }
    }
  `;

  // ===========================================================================
  // Budget Sector Filtering
  // ===========================================================================

  describe('Budget Sector Filters', () => {
    it('[GM] aggregatedLineItems - budget-sector-1-state', async () => {
      const variables = {
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
          normalization: 'total',
          exclude: {
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/budget-sector-1-state.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - budget-sector-2-local', async () => {
      const variables = {
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
          normalization: 'total',
          exclude: {
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/budget-sector-2-local.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - budget-sector-3-social-insurance', async () => {
      const variables = {
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
          normalization: 'total',
          exclude: {
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/budget-sector-3-social-insurance.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - budget-sector-4-unemployment', async () => {
      const variables = {
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
          normalization: 'total',
          exclude: {
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/budget-sector-4-unemployment.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - budget-sector-5-health', async () => {
      const variables = {
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
          normalization: 'total',
          exclude: {
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/budget-sector-5-health.snap.json'
      );
    });
  });

  // ===========================================================================
  // Funding Source Filtering
  // ===========================================================================

  describe('Funding Source Filters', () => {
    it('[GM] aggregatedLineItems - funding-source-1-budget', async () => {
      const variables = {
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
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/funding-source-1-budget.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - funding-source-2-external-credits', async () => {
      const variables = {
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
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/funding-source-2-external-credits.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - funding-source-3-internal-credits', async () => {
      const variables = {
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
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/funding-source-3-internal-credits.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - funding-source-4-eu-funds', async () => {
      const variables = {
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
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/funding-source-4-eu-funds.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - funding-source-5-own-revenues-full', async () => {
      const variables = {
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
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/funding-source-5-own-revenues-full.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - funding-source-6-own-revenues', async () => {
      const variables = {
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
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/funding-source-6-own-revenues.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - funding-source-7-revenues-subsidies', async () => {
      const variables = {
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
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/funding-source-7-revenues-subsidies.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - funding-source-8-privatization', async () => {
      const variables = {
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
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/funding-source-8-privatization.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - funding-source-9-environmental', async () => {
      const variables = {
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
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/funding-source-9-environmental.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - funding-source-10-treasury', async () => {
      const variables = {
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
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/funding-source-10-treasury.snap.json'
      );
    });
  });

  // ===========================================================================
  // Combined Filters
  // ===========================================================================

  describe('Combined Filters', () => {
    it('[GM] aggregatedLineItems - budget-sector-with-funding-source', async () => {
      const variables = {
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
          funding_source_ids: ['1'],
          normalization: 'total',
          exclude: {
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/budget-sector-with-funding-source.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - no-exclusions', async () => {
      const variables = {
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
          normalization: 'total',
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/no-exclusions.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - with-county-filter', async () => {
      const variables = {
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
          county_codes: ['CJ'],
          normalization: 'total',
          exclude: {
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/with-county-filter.snap.json'
      );
    });
  });

  // ===========================================================================
  // Normalization Modes
  // ===========================================================================

  describe('Normalization Modes', () => {
    it('[GM] aggregatedLineItems - normalization-total-euro', async () => {
      const variables = {
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
          normalization: 'total_euro',
          exclude: {
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/normalization-total-euro.snap.json'
      );
    });

    it('[GM] aggregatedLineItems - normalization-per-capita', async () => {
      const variables = {
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
          normalization: 'per_capita',
          exclude: {
            functional_prefixes: ['42', '43', '47', '36.05'],
            economic_prefixes: ['51', '55.01'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/normalization-per-capita.snap.json'
      );
    });
  });

  // ===========================================================================
  // Income vs Expenses
  // ===========================================================================

  describe('Account Category', () => {
    it('[GM] aggregatedLineItems - income-vn', async () => {
      const variables = {
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
          account_category: 'vn',
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          exclude: {
            functional_prefixes: ['42', '43', '47', '36.05'],
          },
        },
        limit: 100,
      };

      const data = await client.query(QUERY, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/aggregated-line-items/income-vn.snap.json'
      );
    });
  });
});
