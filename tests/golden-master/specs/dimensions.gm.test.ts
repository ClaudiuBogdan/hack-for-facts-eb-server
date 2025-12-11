/**
 * Golden Master Tests: Dimensions (Classifications, Budget Sectors, Funding Sources)
 *
 * Tests dimension lookup queries with various scenarios:
 * - Functional classifications
 * - Economic classifications
 * - Budget sectors
 * - Funding sources
 *
 * All queries use historical data (2016-2024) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Dimensions', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  // ===========================================================================
  // Functional Classification Scenarios
  // ===========================================================================

  it('[GM] functionalClassifications - functional-all', async () => {
    const query = /* GraphQL */ `
      query FunctionalAll($limit: Int) {
        functionalClassifications(limit: $limit) {
          nodes {
            functional_code
            functional_name
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
      limit: 100,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/dimensions/functional-all.snap.json'
    );
  });

  it('[GM] functionalClassification - functional-by-code', async () => {
    const query = /* GraphQL */ `
      query FunctionalByCode($code: ID!) {
        functionalClassification(code: $code) {
          functional_code
          functional_name
        }
      }
    `;

    const variables = {
      code: '65.03',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/dimensions/functional-by-code.snap.json'
    );
  });

  it('[GM] functionalClassifications - functional-filtered', async () => {
    const query = /* GraphQL */ `
      query FunctionalFiltered($filter: FunctionalClassificationFilterInput, $limit: Int) {
        functionalClassifications(filter: $filter, limit: $limit) {
          nodes {
            functional_code
            functional_name
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
        functional_codes: ['65.03', '65.03.01', '65.03.02', '65.03.03'],
      },
      limit: 50,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/dimensions/functional-filtered.snap.json'
    );
  });

  // ===========================================================================
  // Economic Classification Scenarios
  // ===========================================================================

  it('[GM] economicClassifications - economic-all', async () => {
    const query = /* GraphQL */ `
      query EconomicAll($limit: Int) {
        economicClassifications(limit: $limit) {
          nodes {
            economic_code
            economic_name
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
      limit: 100,
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot('../snapshots/dimensions/economic-all.snap.json');
  });

  it('[GM] economicClassification - economic-by-code', async () => {
    const query = /* GraphQL */ `
      query EconomicByCode($code: ID!) {
        economicClassification(code: $code) {
          economic_code
          economic_name
        }
      }
    `;

    const variables = {
      code: '10.01.01',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/dimensions/economic-by-code.snap.json'
    );
  });

  // ===========================================================================
  // Budget Sector Scenarios
  // ===========================================================================

  it('[GM] budgetSectors - budget-sectors-all', async () => {
    const query = /* GraphQL */ `
      query BudgetSectorsAll($limit: Int) {
        budgetSectors(limit: $limit) {
          nodes {
            sector_id
            sector_description
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
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/dimensions/budget-sectors-all.snap.json'
    );
  });

  it('[GM] budgetSector - budget-sector-by-id', async () => {
    const query = /* GraphQL */ `
      query BudgetSectorById($id: ID!) {
        budgetSector(id: $id) {
          sector_id
          sector_description
        }
      }
    `;

    const variables = {
      id: '1',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/dimensions/budget-sector-by-id.snap.json'
    );
  });

  // ===========================================================================
  // Funding Source Scenarios
  // ===========================================================================

  it('[GM] fundingSources - funding-sources-all', async () => {
    const query = /* GraphQL */ `
      query FundingSourcesAll($limit: Int) {
        fundingSources(limit: $limit) {
          nodes {
            source_id
            source_description
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
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/dimensions/funding-sources-all.snap.json'
    );
  });

  it('[GM] fundingSource - funding-source-by-id', async () => {
    const query = /* GraphQL */ `
      query FundingSourceById($id: ID!) {
        fundingSource(id: $id) {
          source_id
          source_description
        }
      }
    `;

    const variables = {
      id: '1',
    };

    const data = await client.query(query, variables);

    await expect(data).toMatchNormalizedSnapshot(
      '../snapshots/dimensions/funding-source-by-id.snap.json'
    );
  });
});
