/**
 * Golden Master Tests: INS Tempo
 *
 * Covers deterministic INS queries:
 * - Dataset listing (filtered by known codes)
 * - Dataset details (dimensions metadata)
 * - Observations for a fixed period and national territory
 * - Text search filtering
 * - UAT data filter
 * - Nested dimension values
 * - Period range + territory filter
 * - UAT indicators
 * - Compare UATs
 * - UAT dashboard
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] INS Tempo', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  it('[GM] insDatasets - filtered-by-code', async () => {
    const query = /* GraphQL */ `
      query InsDatasets($filter: InsDatasetFilterInput, $limit: Int, $offset: Int) {
        insDatasets(filter: $filter, limit: $limit, offset: $offset) {
          nodes {
            code
            name_ro
            name_en
            periodicity
            year_range
            dimension_count
            sync_status
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
      filter: { codes: ['ACC101B', 'ACC101C'] },
      limit: 10,
      offset: 0,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/ins/ins-datasets.snap.json');
  });

  it('[GM] insDataset - acc101b-details', async () => {
    const query = /* GraphQL */ `
      query InsDataset($code: String!) {
        insDataset(code: $code) {
          code
          name_ro
          name_en
          periodicity
          year_range
          dimension_count
          dimensions {
            index
            type
            label_ro
            label_en
            option_count
            classification_type {
              code
              name_ro
              is_hierarchical
            }
          }
        }
      }
    `;

    const variables = {
      code: 'ACC101B',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/ins/ins-dataset-acc101b.snap.json');
  });

  it('[GM] insObservations - acc101b-national-2020', async () => {
    const query = /* GraphQL */ `
      query InsObservations($code: String!, $filter: InsObservationFilterInput) {
        insObservations(datasetCode: $code, limit: 5, offset: 0, filter: $filter) {
          nodes {
            dataset_code
            value
            value_status
            time_period {
              iso_period
            }
            territory {
              code
              siruta_code
            }
            unit {
              code
              symbol
            }
            classifications {
              type_code
              code
            }
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
      code: 'ACC101B',
      filter: {
        territoryCodes: ['RO'],
        period: '2020',
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/ins/ins-observations-acc101b-2020.snap.json'
    );
  });

  it('[GM] insDatasets - search-populatia', async () => {
    const query = /* GraphQL */ `
      query InsDatasets($filter: InsDatasetFilterInput, $limit: Int) {
        insDatasets(filter: $filter, limit: $limit) {
          nodes {
            code
            name_ro
            has_uat_data
            has_county_data
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    const variables = {
      filter: { search: 'populatia' },
      limit: 5,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/ins/ins-datasets-search.snap.json');
  });

  it('[GM] insDatasets - uat-filter', async () => {
    const query = /* GraphQL */ `
      query InsDatasets($filter: InsDatasetFilterInput, $limit: Int) {
        insDatasets(filter: $filter, limit: $limit) {
          nodes {
            code
            name_ro
            has_uat_data
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    const variables = {
      filter: { hasUatData: true },
      limit: 5,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/ins/ins-datasets-uat-filter.snap.json'
    );
  });

  it('[GM] insDatasets - county-and-root-filter', async () => {
    const query = /* GraphQL */ `
      query InsDatasets($filter: InsDatasetFilterInput, $limit: Int) {
        insDatasets(filter: $filter, limit: $limit) {
          nodes {
            code
            has_county_data
            context_path
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    const variables = {
      filter: { hasCountyData: true, rootContextCode: '1' },
      limit: 5,
    };

    const data = await client.query<{
      insDatasets: {
        nodes: {
          has_county_data: boolean;
          context_path: string | null;
        }[];
      };
    }>(query, variables);
    const nodes = data.insDatasets.nodes;
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.has_county_data).toBe(true);
      expect(node.context_path?.startsWith('0.1')).toBe(true);
    }
  });

  it('[GM] insContexts - root-level', async () => {
    const query = /* GraphQL */ `
      query InsContexts($filter: InsContextFilterInput, $limit: Int) {
        insContexts(filter: $filter, limit: $limit) {
          nodes {
            code
            level
            path
            matrix_count
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    const variables = {
      filter: { level: 0 },
      limit: 20,
    };

    const data = await client.query<{
      insContexts: { nodes: { code: string; level: number | null }[] };
    }>(query, variables);
    const nodes = data.insContexts.nodes;
    expect(nodes.length).toBeGreaterThanOrEqual(8);
    expect(nodes.some((node) => node.code === '1')).toBe(true);
  });

  it('[GM] insDataset - dimension-values', async () => {
    const query = /* GraphQL */ `
      query InsDataset($code: String!) {
        insDataset(code: $code) {
          code
          dimensions {
            index
            type
            label_ro
            values(limit: 3) {
              nodes {
                nom_item_id
                dimension_type
                label_ro
                territory {
                  code
                  name_ro
                  level
                }
                time_period {
                  iso_period
                  periodicity
                }
                classification_value {
                  code
                  name_ro
                  type_code
                }
                unit {
                  code
                  symbol
                }
              }
              pageInfo {
                totalCount
                hasNextPage
              }
            }
          }
        }
      }
    `;

    const variables = { code: 'LOC101B' };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/ins/ins-dataset-dimension-values.snap.json'
    );
  });

  it('[GM] insObservations - period-range', async () => {
    const query = /* GraphQL */ `
      query InsObservations($code: String!, $filter: InsObservationFilterInput) {
        insObservations(datasetCode: $code, limit: 10, filter: $filter) {
          nodes {
            dataset_code
            value
            time_period {
              iso_period
            }
            territory {
              code
            }
            classifications {
              type_code
              code
            }
          }
          pageInfo {
            totalCount
          }
        }
      }
    `;

    const variables = {
      code: 'LOC101B',
      filter: {
        periodRange: { start: '2020', end: '2022' },
        territoryCodes: ['RO'],
      },
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/ins/ins-observations-period-range.snap.json'
    );
  });

  it('[GM] insUatIndicators - Cluj-Napoca', async () => {
    const query = /* GraphQL */ `
      query InsUatIndicators($sirutaCode: String!, $datasetCodes: [String!]!, $period: PeriodDate) {
        insUatIndicators(sirutaCode: $sirutaCode, datasetCodes: $datasetCodes, period: $period) {
          dataset_code
          value
          time_period {
            iso_period
          }
          territory {
            code
            siruta_code
            name_ro
          }
          unit {
            code
            symbol
          }
          classifications {
            type_code
            code
          }
        }
      }
    `;

    const variables = {
      sirutaCode: '54975',
      datasetCodes: ['LOC101B', 'GOS106B'],
      period: '2022',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/ins/ins-uat-indicators.snap.json');
  });

  it('[GM] insCompare - Cluj vs Bucuresti', async () => {
    const query = /* GraphQL */ `
      query InsCompare($sirutaCodes: [String!]!, $datasetCode: String!, $period: PeriodDate) {
        insCompare(sirutaCodes: $sirutaCodes, datasetCode: $datasetCode, period: $period) {
          dataset_code
          value
          time_period {
            iso_period
          }
          territory {
            code
            siruta_code
            name_ro
          }
          classifications {
            type_code
            code
          }
        }
      }
    `;

    const variables = {
      sirutaCodes: ['54975', '179132'],
      datasetCode: 'LOC101B',
      period: '2022',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/ins/ins-compare.snap.json');
  });

  it('[GM] insLatestDatasetValues - UAT and county selectors', async () => {
    const query = /* GraphQL */ `
      query InsLatestDatasetValues($entity: InsEntitySelectorInput!, $datasetCodes: [String!]!) {
        insLatestDatasetValues(entity: $entity, datasetCodes: $datasetCodes) {
          dataset {
            code
          }
          latestPeriod
          hasData
          matchStrategy
        }
      }
    `;

    const uat = await client.query<{ insLatestDatasetValues: unknown[] }>(query, {
      entity: { sirutaCode: '54975' },
      datasetCodes: ['POP107D', 'FOM104D'],
    });
    const county = await client.query<{ insLatestDatasetValues: unknown[] }>(query, {
      entity: { territoryCode: 'CJ', territoryLevel: 'NUTS3' },
      datasetCodes: ['POP107D', 'SOM103A'],
    });

    expect(uat.insLatestDatasetValues.length).toBeGreaterThan(0);
    expect(county.insLatestDatasetValues.length).toBeGreaterThan(0);
  });

  it('[GM] insUatDashboard - Cluj-Napoca', async () => {
    const query = /* GraphQL */ `
      query InsUatDashboard($sirutaCode: String!, $period: PeriodDate) {
        insUatDashboard(sirutaCode: $sirutaCode, period: $period) {
          dataset {
            code
            name_ro
            has_uat_data
          }
          observations {
            dataset_code
            value
            time_period {
              iso_period
            }
            unit {
              code
              symbol
            }
            classifications {
              type_code
              code
            }
          }
          latestPeriod
        }
      }
    `;

    const variables = {
      sirutaCode: '54975',
      period: '2022',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/ins/ins-uat-dashboard.snap.json');
  });
});
