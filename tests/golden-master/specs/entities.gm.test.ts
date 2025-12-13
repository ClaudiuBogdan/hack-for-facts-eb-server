/**
 * Golden Master Tests: Entities (Entity, UAT, Report)
 *
 * Tests entity-related queries with various scenarios:
 * - Single entity lookups
 * - Entity listing with filters
 * - UAT queries
 * - Report queries
 *
 * All queries use historical data (2016-2024) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Entities', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  // ===========================================================================
  // Entity Scenarios
  // ===========================================================================

  it('[GM] entity - entity-by-cui', async () => {
    const query = /* GraphQL */ `
      query EntityByCui($cui: ID!) {
        entity(cui: $cui) {
          cui
          name
          entity_type
          default_report_type
          uat_id
          is_uat
          is_main_creditor
          address
        }
      }
    `;

    const variables = {
      cui: '4305857',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/entities/entity-by-cui.snap.json');
  });

  it('[GM] entity - entity-with-analytics', async () => {
    const query = /* GraphQL */ `
      query EntityWithAnalytics($cui: ID!, $period: ReportPeriodInput!) {
        entity(cui: $cui) {
          cui
          name
          entity_type
          totalIncome(period: $period)
          totalExpenses(period: $period)
          budgetBalance(period: $period)
        }
      }
    `;

    const variables = {
      cui: '4305857',
      period: {
        type: 'YEAR',
        selection: {
          dates: ['2023'],
        },
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entities/entity-with-analytics.snap.json'
    );
  });

  it('[GM] entity - entity-details-with-per-capita-normalization', async () => {
    const query = /* GraphQL */ `
      query GetEntityDetails(
        $cui: ID!
        $normalization: Normalization
        $reportPeriod: ReportPeriodInput!
        $reportType: ReportType
        $trendPeriod: ReportPeriodInput!
      ) {
        entity(cui: $cui) {
          cui
          name
          entity_type
          is_uat
          uat {
            county_name
            county_code
            name
            siruta_code
            population
          }
          totalIncome(period: $reportPeriod, reportType: $reportType, normalization: $normalization)
          totalExpenses(
            period: $reportPeriod
            reportType: $reportType
            normalization: $normalization
          )
          budgetBalance(
            period: $reportPeriod
            reportType: $reportType
            normalization: $normalization
          )
          incomeTrend(
            period: $trendPeriod
            reportType: $reportType
            normalization: $normalization
          ) {
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
          expensesTrend(
            period: $trendPeriod
            reportType: $reportType
            normalization: $normalization
          ) {
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
          balanceTrend(
            period: $trendPeriod
            reportType: $reportType
            normalization: $normalization
          ) {
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
      }
    `;

    const variables = {
      cui: '4305857', // Cluj-Napoca
      normalization: 'per_capita',
      reportPeriod: {
        type: 'QUARTER',
        selection: {
          interval: { start: '2022-Q1', end: '2022-Q1' },
        },
      },
      reportType: 'PRINCIPAL_AGGREGATED',
      trendPeriod: {
        type: 'QUARTER',
        selection: {
          interval: { start: '2022-Q1', end: '2022-Q4' },
        },
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entities/entity-details-with-per-capita-normalization.snap.json'
    );
  });

  it('[GM] entities - entities-list', async () => {
    const query = /* GraphQL */ `
      query EntitiesList($filter: EntityFilter, $limit: Int, $offset: Int) {
        entities(filter: $filter, limit: $limit, offset: $offset) {
          nodes {
            cui
            name
            entity_type
            is_uat
            is_main_creditor
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
        is_uat: true,
      },
      limit: 20,
      offset: 0,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/entities/entities-list.snap.json');
  });

  it('[GM] entities - entities-search', async () => {
    const query = /* GraphQL */ `
      query EntitiesSearch($filter: EntityFilter, $limit: Int) {
        entities(filter: $filter, limit: $limit) {
          nodes {
            cui
            name
            entity_type
            is_uat
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
        search: 'Cluj-Napoca',
      },
      limit: 20,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/entities/entities-search.snap.json');
  });

  it('[GM] entities - entities-by-type', async () => {
    const query = /* GraphQL */ `
      query EntitiesByType($filter: EntityFilter, $limit: Int) {
        entities(filter: $filter, limit: $limit) {
          nodes {
            cui
            name
            entity_type
            is_uat
            is_main_creditor
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
        entity_type: 'admin_county_council',
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entities/entities-by-type.snap.json'
    );
  });

  // ===========================================================================
  // UAT Scenarios
  // ===========================================================================

  it('[GM] uat - uat-by-id', async () => {
    const query = /* GraphQL */ `
      query UatById($id: ID!) {
        uat(id: $id) {
          id
          uat_key
          uat_code
          siruta_code
          name
          county_code
          county_name
          region
          population
        }
      }
    `;

    const variables = {
      id: '1',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/entities/uat-by-id.snap.json');
  });

  it('[GM] uats - uats-by-county', async () => {
    const query = /* GraphQL */ `
      query UatsByCounty($filter: UATFilterInput, $limit: Int) {
        uats(filter: $filter, limit: $limit) {
          nodes {
            id
            uat_key
            uat_code
            siruta_code
            name
            county_code
            county_name
            population
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
        county_code: 'CJ',
      },
      limit: 100,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/entities/uats-by-county.snap.json');
  });

  it('[GM] uats - uats-list-all', async () => {
    const query = /* GraphQL */ `
      query UatsList($limit: Int, $offset: Int) {
        uats(limit: $limit, offset: $offset) {
          nodes {
            id
            uat_key
            uat_code
            name
            county_code
            county_name
            population
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
      limit: 50,
      offset: 0,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/entities/uats-list-all.snap.json');
  });

  it('[GM] entity - entity-with-uat-county-entity', async () => {
    // This test verifies that UAT.county_entity returns the correct county entity.
    // Previously there was a bug where it would return any entity linked to the
    // county UAT (e.g., social assistance agencies) instead of the actual county entity.
    const query = /* GraphQL */ `
      query EntityWithUatCountyEntity($cui: ID!) {
        entity(cui: $cui) {
          cui
          name
          entity_type
          is_uat
          uat {
            id
            name
            county_code
            county_name
            siruta_code
            county_entity {
              cui
              name
              entity_type
              is_uat
            }
          }
        }
      }
    `;

    const variables = {
      // MUNICIPIUL SIBIU - a municipality whose UAT should reference JUDEȚUL SIBIU as county_entity
      cui: '4270740',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/entities/entity-with-uat-county-entity.snap.json'
    );
  });

  // ===========================================================================
  // Report Scenarios
  // ===========================================================================

  it('[GM] reports - reports-list', async () => {
    const query = /* GraphQL */ `
      query ReportsList($filter: ReportFilter, $limit: Int) {
        reports(filter: $filter, limit: $limit) {
          nodes {
            report_id
            entity_cui
            report_type
            report_date
            reporting_year
            reporting_period
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
        entity_cui: '4305857',
        reporting_year: 2023,
      },
      limit: 20,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/entities/reports-list.snap.json');
  });
});
