/**
 * Golden Master Tests: Entity Analytics
 *
 * Tests the entityAnalytics GraphQL query with various scenarios:
 * - Sorting (by amount, per capita, name)
 * - Filtering (by county, entity type)
 * - Pagination
 * - Aggregate filters (min/max amount)
 *
 * All queries use historical data (2016-2024) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Entity Analytics', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  // ===========================================================================
  // Sorting Scenarios
  // ===========================================================================

  it('[GM] entityAnalytics - top-by-amount', async () => {
    const query = /* GraphQL */ `
      query TopByAmount($filter: AnalyticsFilterInput!, $sort: SortOrder, $limit: Int) {
        entityAnalytics(filter: $filter, sort: $sort, limit: $limit) {
          nodes {
            entity_cui
            entity_name
            entity_type
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
      sort: {
        by: 'TOTAL_AMOUNT',
        order: 'DESC',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entity-analytics/top-by-amount.snap.json'
    );
  });

  it('[GM] entityAnalytics - top-by-per-capita', async () => {
    const query = /* GraphQL */ `
      query TopByPerCapita($filter: AnalyticsFilterInput!, $sort: SortOrder, $limit: Int) {
        entityAnalytics(filter: $filter, sort: $sort, limit: $limit) {
          nodes {
            entity_cui
            entity_name
            entity_type
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
        normalization: 'per_capita',
        min_population: 1000,
      },
      sort: {
        by: 'PER_CAPITA_AMOUNT',
        order: 'DESC',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entity-analytics/top-by-per-capita.snap.json'
    );
  });

  it('[GM] entityAnalytics - sorted-by-name', async () => {
    const query = /* GraphQL */ `
      query SortedByName($filter: AnalyticsFilterInput!, $sort: SortOrder, $limit: Int) {
        entityAnalytics(filter: $filter, sort: $sort, limit: $limit) {
          nodes {
            entity_cui
            entity_name
            entity_type
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
        county_codes: ['CJ'],
      },
      sort: {
        by: 'ENTITY_NAME',
        order: 'ASC',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entity-analytics/sorted-by-name.snap.json'
    );
  });

  // ===========================================================================
  // Filter Scenarios
  // ===========================================================================

  it('[GM] entityAnalytics - filtered-by-county', async () => {
    const query = /* GraphQL */ `
      query FilteredByCounty($filter: AnalyticsFilterInput!, $sort: SortOrder, $limit: Int) {
        entityAnalytics(filter: $filter, sort: $sort, limit: $limit) {
          nodes {
            entity_cui
            entity_name
            entity_type
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
        county_codes: ['TM'],
      },
      sort: {
        by: 'TOTAL_AMOUNT',
        order: 'DESC',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entity-analytics/filtered-by-county.snap.json'
    );
  });

  it('[GM] entityAnalytics - filtered-by-entity-type', async () => {
    const query = /* GraphQL */ `
      query FilteredByEntityType($filter: AnalyticsFilterInput!, $sort: SortOrder, $limit: Int) {
        entityAnalytics(filter: $filter, sort: $sort, limit: $limit) {
          nodes {
            entity_cui
            entity_name
            entity_type
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
        entity_types: ['uat'],
      },
      sort: {
        by: 'TOTAL_AMOUNT',
        order: 'DESC',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entity-analytics/filtered-by-entity-type.snap.json'
    );
  });

  // ===========================================================================
  // Pagination Scenarios
  // ===========================================================================

  it('[GM] entityAnalytics - pagination-first-page', async () => {
    const query = /* GraphQL */ `
      query PaginationFirstPage(
        $filter: AnalyticsFilterInput!
        $sort: SortOrder
        $limit: Int
        $offset: Int
      ) {
        entityAnalytics(filter: $filter, sort: $sort, limit: $limit, offset: $offset) {
          nodes {
            entity_cui
            entity_name
            entity_type
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
      sort: {
        by: 'TOTAL_AMOUNT',
        order: 'DESC',
      },
      limit: 20,
      offset: 0,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entity-analytics/pagination-first-page.snap.json'
    );
  });

  it('[GM] entityAnalytics - pagination-second-page', async () => {
    const query = /* GraphQL */ `
      query PaginationSecondPage(
        $filter: AnalyticsFilterInput!
        $sort: SortOrder
        $limit: Int
        $offset: Int
      ) {
        entityAnalytics(filter: $filter, sort: $sort, limit: $limit, offset: $offset) {
          nodes {
            entity_cui
            entity_name
            entity_type
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
      sort: {
        by: 'TOTAL_AMOUNT',
        order: 'DESC',
      },
      limit: 20,
      offset: 20,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entity-analytics/pagination-second-page.snap.json'
    );
  });

  // ===========================================================================
  // Aggregate Filter Scenarios
  // ===========================================================================

  describe('Aggregate Filters', () => {
    it('[GM] entityAnalytics - aggregate-min-amount', async () => {
      const query = /* GraphQL */ `
        query AggregateMinAmount(
          $filter: AnalyticsFilterInput!
          $sort: SortOrder
          $limit: Int
          $offset: Int
        ) {
          entityAnalytics(filter: $filter, sort: $sort, limit: $limit, offset: $offset) {
            nodes {
              entity_cui
              entity_name
              entity_type
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
          aggregate_min_amount: 1000000000, // 1 billion RON minimum
        },
        sort: {
          by: 'TOTAL_AMOUNT',
          order: 'DESC',
        },
        limit: 50,
        offset: 0,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/entity-analytics/aggregate-min-amount.snap.json'
      );
    });

    it('[GM] entityAnalytics - aggregate-max-amount', async () => {
      const query = /* GraphQL */ `
        query AggregateMaxAmount(
          $filter: AnalyticsFilterInput!
          $sort: SortOrder
          $limit: Int
          $offset: Int
        ) {
          entityAnalytics(filter: $filter, sort: $sort, limit: $limit, offset: $offset) {
            nodes {
              entity_cui
              entity_name
              entity_type
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
          aggregate_max_amount: 10000000, // 10 million RON maximum
        },
        sort: {
          by: 'TOTAL_AMOUNT',
          order: 'DESC',
        },
        limit: 50,
        offset: 0,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/entity-analytics/aggregate-max-amount.snap.json'
      );
    });

    it('[GM] entityAnalytics - aggregate-min-max-amount', async () => {
      const query = /* GraphQL */ `
        query AggregateMinMaxAmount(
          $filter: AnalyticsFilterInput!
          $sort: SortOrder
          $limit: Int
          $offset: Int
        ) {
          entityAnalytics(filter: $filter, sort: $sort, limit: $limit, offset: $offset) {
            nodes {
              entity_cui
              entity_name
              entity_type
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
          aggregate_min_amount: 100000000, // 100 million RON minimum
          aggregate_max_amount: 500000000, // 500 million RON maximum
        },
        sort: {
          by: 'TOTAL_AMOUNT',
          order: 'DESC',
        },
        limit: 50,
        offset: 0,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/entity-analytics/aggregate-min-max-amount.snap.json'
      );
    });

    it('[GM] entityAnalytics - aggregate-filters-with-normalization', async () => {
      const query = /* GraphQL */ `
        query AggregateFiltersWithNormalization(
          $filter: AnalyticsFilterInput!
          $sort: SortOrder
          $limit: Int
          $offset: Int
        ) {
          entityAnalytics(filter: $filter, sort: $sort, limit: $limit, offset: $offset) {
            nodes {
              entity_cui
              entity_name
              entity_type
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
          normalization: 'total_euro',
          aggregate_min_amount: 100, // After EUR conversion
          aggregate_max_amount: 100000, // After EUR conversion
        },
        sort: {
          by: 'TOTAL_AMOUNT',
          order: 'DESC',
        },
        limit: 25,
        offset: 0,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/entity-analytics/aggregate-filters-with-normalization.snap.json'
      );
    });
  });
});
