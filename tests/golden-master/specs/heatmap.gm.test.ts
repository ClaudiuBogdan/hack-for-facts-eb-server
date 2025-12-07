/**
 * Golden Master Tests: Heatmap (County & UAT Analytics)
 *
 * Tests heatmap visualization queries with various scenarios:
 * - County-level aggregation
 * - UAT-level aggregation
 * - Filtering by county, functional classification, etc.
 *
 * All queries use historical data (2016-2024) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Heatmap', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  // ===========================================================================
  // County-Level Scenarios
  // ===========================================================================

  it('[GM] heatmapCountyData - county-total-2023', async () => {
    const query = /* GraphQL */ `
      query CountyTotal2023($filter: AnalyticsFilterInput!) {
        heatmapCountyData(filter: $filter) {
          county_code
          county_name
          county_population
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
          selection: {
            dates: ['2023'],
          },
        },
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/heatmap/county-total-2023.snap.json');
  });

  it('[GM] heatmapCountyData - county-total-2022', async () => {
    const query = /* GraphQL */ `
      query CountyTotal2022($filter: AnalyticsFilterInput!) {
        heatmapCountyData(filter: $filter) {
          county_code
          county_name
          county_population
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
          selection: {
            dates: ['2022'],
          },
        },
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/heatmap/county-total-2022.snap.json');
  });

  it('[GM] heatmapCountyData - county-income-2023', async () => {
    const query = /* GraphQL */ `
      query CountyIncome2023($filter: AnalyticsFilterInput!) {
        heatmapCountyData(filter: $filter) {
          county_code
          county_name
          county_population
          amount
          total_amount
          per_capita_amount
        }
      }
    `;

    const variables = {
      filter: {
        account_category: 'vn',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 'YEAR',
          selection: {
            dates: ['2023'],
          },
        },
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/heatmap/county-income-2023.snap.json');
  });

  it('[GM] heatmapCountyData - county-filtered-functional', async () => {
    const query = /* GraphQL */ `
      query CountyFilteredFunctional($filter: AnalyticsFilterInput!) {
        heatmapCountyData(filter: $filter) {
          county_code
          county_name
          county_population
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
          selection: {
            dates: ['2023'],
          },
        },
        functional_prefixes: ['65'],
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/heatmap/county-filtered-functional.snap.json'
    );
  });

  // ===========================================================================
  // UAT-Level Scenarios
  // ===========================================================================

  it('[GM] heatmapUATData - uat-cluj-2023', async () => {
    const query = /* GraphQL */ `
      query UATCluj2023($filter: AnalyticsFilterInput!) {
        heatmapUATData(filter: $filter) {
          uat_id
          uat_code
          uat_name
          siruta_code
          county_code
          county_name
          population
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
          selection: {
            dates: ['2023'],
          },
        },
        county_codes: ['CJ'],
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/heatmap/uat-cluj-2023.snap.json');
  });

  it('[GM] heatmapUATData - uat-timis-2023', async () => {
    const query = /* GraphQL */ `
      query UATTimis2023($filter: AnalyticsFilterInput!) {
        heatmapUATData(filter: $filter) {
          uat_id
          uat_code
          uat_name
          siruta_code
          county_code
          county_name
          population
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
          selection: {
            dates: ['2023'],
          },
        },
        county_codes: ['TM'],
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/heatmap/uat-timis-2023.snap.json');
  });

  it('[GM] heatmapUATData - uat-bucuresti-2023', async () => {
    const query = /* GraphQL */ `
      query UATBucuresti2023($filter: AnalyticsFilterInput!) {
        heatmapUATData(filter: $filter) {
          uat_id
          uat_code
          uat_name
          siruta_code
          county_code
          county_name
          population
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
          selection: {
            dates: ['2023'],
          },
        },
        county_codes: ['B'],
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/heatmap/uat-bucuresti-2023.snap.json');
  });

  it('[GM] heatmapUATData - uat-income-cluj-2023', async () => {
    const query = /* GraphQL */ `
      query UATIncomeCluj2023($filter: AnalyticsFilterInput!) {
        heatmapUATData(filter: $filter) {
          uat_id
          uat_code
          uat_name
          siruta_code
          county_code
          county_name
          population
          amount
          total_amount
          per_capita_amount
        }
      }
    `;

    const variables = {
      filter: {
        account_category: 'vn',
        report_type: 'PRINCIPAL_AGGREGATED',
        report_period: {
          type: 'YEAR',
          selection: {
            dates: ['2023'],
          },
        },
        county_codes: ['CJ'],
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot('../snapshots/heatmap/uat-income-cluj-2023.snap.json');
  });

  it('[GM] heatmapUATData - uat-filtered-functional', async () => {
    const query = /* GraphQL */ `
      query UATFilteredFunctional($filter: AnalyticsFilterInput!) {
        heatmapUATData(filter: $filter) {
          uat_id
          uat_code
          uat_name
          siruta_code
          county_code
          county_name
          population
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
          selection: {
            dates: ['2023'],
          },
        },
        county_codes: ['CJ'],
        functional_prefixes: ['65'],
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchFileSnapshot(
      '../snapshots/heatmap/uat-filtered-functional.snap.json'
    );
  });
});
