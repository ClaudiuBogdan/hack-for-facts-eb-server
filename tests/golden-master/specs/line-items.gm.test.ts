/**
 * Golden Master Tests: Line Items (Aggregated & Execution)
 *
 * Tests line item queries with various scenarios:
 * - aggregatedLineItems: Classification-level aggregation
 * - executionLineItems: Individual line item queries
 * - Filtering, pagination, and sorting
 *
 * All queries use historical data (2016-2024) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Line Items', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  // ===========================================================================
  // Aggregated Line Items Scenarios
  // ===========================================================================

  it('[GM] aggregatedLineItems - aggregated-default', async () => {
    const query = /* GraphQL */ `
      query AggregatedDefault($filter: AnalyticsFilterInput!, $limit: Int) {
        aggregatedLineItems(filter: $filter, limit: $limit) {
          nodes {
            functional_code
            functional_name
            economic_code
            economic_name
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

    const variables = {
      filter: {
        account_category: 'ch',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 'YEAR',
          selection: {
            dates: ['2023'],
          },
        },
        normalization: 'total',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/line-items/aggregated-default.snap.json');
  });

  it('[GM] aggregatedLineItems - aggregated-filtered', async () => {
    const query = /* GraphQL */ `
      query AggregatedFiltered($filter: AnalyticsFilterInput!, $limit: Int) {
        aggregatedLineItems(filter: $filter, limit: $limit) {
          nodes {
            functional_code
            functional_name
            economic_code
            economic_name
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

    const variables = {
      filter: {
        account_category: 'ch',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 'YEAR',
          selection: {
            dates: ['2023'],
          },
        },
        functional_prefixes: ['65'],
        normalization: 'total',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/line-items/aggregated-filtered.snap.json');
  });

  it('[GM] aggregatedLineItems - aggregated-economic', async () => {
    const query = /* GraphQL */ `
      query AggregatedEconomic($filter: AnalyticsFilterInput!, $limit: Int) {
        aggregatedLineItems(filter: $filter, limit: $limit) {
          nodes {
            functional_code
            functional_name
            economic_code
            economic_name
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

    const variables = {
      filter: {
        account_category: 'ch',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 'YEAR',
          selection: {
            dates: ['2023'],
          },
        },
        economic_prefixes: ['10'],
        normalization: 'total',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/line-items/aggregated-economic.snap.json');
  });

  it('[GM] aggregatedLineItems - aggregated-county', async () => {
    const query = /* GraphQL */ `
      query AggregatedCounty($filter: AnalyticsFilterInput!, $limit: Int) {
        aggregatedLineItems(filter: $filter, limit: $limit) {
          nodes {
            functional_code
            functional_name
            economic_code
            economic_name
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

    const variables = {
      filter: {
        account_category: 'ch',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 'YEAR',
          selection: {
            dates: ['2023'],
          },
        },
        county_codes: ['CJ'],
        normalization: 'total',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/line-items/aggregated-county.snap.json');
  });

  // ===========================================================================
  // Execution Line Items Scenarios
  // ===========================================================================

  it('[GM] executionLineItems - execution-by-entity', async () => {
    const query = /* GraphQL */ `
      query ExecutionByEntity($filter: AnalyticsFilterInput!, $limit: Int, $sort: SortOrder) {
        executionLineItems(filter: $filter, limit: $limit, sort: $sort) {
          nodes {
            line_item_id
            report_id
            year
            month
            entity_cui
            account_category
            functional_code
            economic_code
            ytd_amount
            monthly_amount
          }
          pageInfo {
            totalCount
            hasNextPage
            hasPreviousPage
          }
        }
      }
    `;

    const variables = {
      filter: {
        account_category: 'ch',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 'YEAR',
          selection: {
            dates: ['2023'],
          },
        },
        entity_cuis: ['4305857'],
      },
      sort: {
        by: 'ytd_amount',
        order: 'DESC',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/line-items/execution-by-entity.snap.json');
  });

  it('[GM] executionLineItems - execution-by-classification', async () => {
    const query = /* GraphQL */ `
      query ExecutionByClassification(
        $filter: AnalyticsFilterInput!
        $limit: Int
        $sort: SortOrder
      ) {
        executionLineItems(filter: $filter, limit: $limit, sort: $sort) {
          nodes {
            line_item_id
            report_id
            year
            month
            entity_cui
            account_category
            functional_code
            economic_code
            ytd_amount
            monthly_amount
          }
          pageInfo {
            totalCount
            hasNextPage
            hasPreviousPage
          }
        }
      }
    `;

    const variables = {
      filter: {
        account_category: 'ch',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 'YEAR',
          selection: {
            dates: ['2023'],
          },
        },
        functional_prefixes: ['65.03'],
        economic_prefixes: ['10'],
        county_codes: ['CJ'],
      },
      sort: {
        by: 'ytd_amount',
        order: 'DESC',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/line-items/execution-by-classification.snap.json'
    );
  });

  it('[GM] executionLineItems - execution-paginated', async () => {
    const query = /* GraphQL */ `
      query ExecutionPaginated(
        $filter: AnalyticsFilterInput!
        $limit: Int
        $offset: Int
        $sort: SortOrder
      ) {
        executionLineItems(filter: $filter, limit: $limit, offset: $offset, sort: $sort) {
          nodes {
            line_item_id
            report_id
            year
            month
            entity_cui
            account_category
            functional_code
            economic_code
            ytd_amount
            monthly_amount
          }
          pageInfo {
            totalCount
            hasNextPage
            hasPreviousPage
          }
        }
      }
    `;

    const variables = {
      filter: {
        account_category: 'ch',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 'YEAR',
          selection: {
            dates: ['2023'],
          },
        },
        county_codes: ['CJ'],
      },
      sort: {
        by: 'ytd_amount',
        order: 'DESC',
      },
      limit: 20,
      offset: 0,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/line-items/execution-paginated.snap.json');
  });

  it('[GM] executionLineItems - execution-sorted-by-amount', async () => {
    const query = /* GraphQL */ `
      query ExecutionSortedByAmount($filter: AnalyticsFilterInput!, $limit: Int, $sort: SortOrder) {
        executionLineItems(filter: $filter, limit: $limit, sort: $sort) {
          nodes {
            line_item_id
            report_id
            year
            month
            entity_cui
            account_category
            functional_code
            economic_code
            ytd_amount
            monthly_amount
          }
          pageInfo {
            totalCount
            hasNextPage
            hasPreviousPage
          }
        }
      }
    `;

    const variables = {
      filter: {
        account_category: 'ch',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 'YEAR',
          selection: {
            dates: ['2023'],
          },
        },
        county_codes: ['B'],
        entity_types: ['uat'],
      },
      sort: {
        by: 'ytd_amount',
        order: 'DESC',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/line-items/execution-sorted-by-amount.snap.json'
    );
  });
});
