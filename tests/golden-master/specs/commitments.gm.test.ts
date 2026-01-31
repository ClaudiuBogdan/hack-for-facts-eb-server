/**
 * Golden Master Tests: Commitments (Budget Commitments)
 *
 * Tests the commitments GraphQL queries with various scenarios:
 * - commitmentsSummary: Period-based summary (Monthly, Quarterly, Yearly)
 * - commitmentsLineItems: Individual line item queries with pagination
 * - commitmentsAnalytics: Time-series analytics for various metrics
 * - commitmentsAggregated: Classification-level aggregation
 * - commitmentVsExecution: Comparison between commitments and execution
 *
 * All queries use historical data (2019-2025) for deterministic results.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { getClient, type GoldenMasterClient } from '../client.js';

describe('[Golden Master] Commitments', () => {
  let client: GoldenMasterClient;

  beforeAll(async () => {
    client = await getClient();
  }, 60_000);

  // ===========================================================================
  // 1. commitmentsSummary Query
  // ===========================================================================

  describe('commitmentsSummary', () => {
    // -------------------------------------------------------------------------
    // Monthly Summary
    // -------------------------------------------------------------------------

    it('[GM] commitmentsSummary - monthly-basic', async () => {
      const query = /* GraphQL */ `
        query MonthlySummary($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsSummary(filter: $filter, limit: $limit) {
            nodes {
              ... on CommitmentsMonthlySummary {
                year
                month
                entity_cui
                entity_name
                report_type
                credite_angajament
                plati_trezor
                plati_non_trezor
                receptii_totale
                receptii_neplatite_change
                total_plati
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
        filter: {
          report_period: {
            type: 'MONTH',
            selection: {
              interval: {
                start: '2023-03',
                end: '2023-06',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
        },
        limit: 20,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/summary-monthly-basic.snap.json'
      );
    });

    // -------------------------------------------------------------------------
    // Quarterly Summary
    // -------------------------------------------------------------------------

    it('[GM] commitmentsSummary - quarterly-basic', async () => {
      const query = /* GraphQL */ `
        query QuarterlySummary($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsSummary(filter: $filter, limit: $limit) {
            nodes {
              ... on CommitmentsQuarterlySummary {
                year
                quarter
                entity_cui
                entity_name
                report_type
                credite_angajament
                limita_credit_angajament
                credite_bugetare
                credite_angajament_initiale
                credite_bugetare_initiale
                credite_angajament_definitive
                credite_bugetare_definitive
                credite_angajament_disponibile
                credite_bugetare_disponibile
                receptii_totale
                plati_trezor
                plati_non_trezor
                receptii_neplatite
                total_plati
                execution_rate
                commitment_rate
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
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: {
              interval: {
                start: '2023-Q1',
                end: '2023-Q4',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
        },
        limit: 20,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/summary-quarterly-basic.snap.json'
      );
    });

    // -------------------------------------------------------------------------
    // Yearly Summary
    // -------------------------------------------------------------------------

    it('[GM] commitmentsSummary - yearly-basic', async () => {
      const query = /* GraphQL */ `
        query YearlySummary($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsSummary(filter: $filter, limit: $limit) {
            nodes {
              ... on CommitmentsAnnualSummary {
                year
                entity_cui
                entity_name
                report_type
                credite_angajament
                limita_credit_angajament
                credite_bugetare
                credite_angajament_initiale
                credite_bugetare_initiale
                credite_angajament_definitive
                credite_bugetare_definitive
                credite_angajament_disponibile
                credite_bugetare_disponibile
                receptii_totale
                plati_trezor
                plati_non_trezor
                receptii_neplatite
                total_plati
                execution_rate
                commitment_rate
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
        filter: {
          report_period: {
            type: 'YEAR',
            selection: {
              interval: {
                start: '2020',
                end: '2023',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
        },
        limit: 20,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/summary-yearly-basic.snap.json'
      );
    });

    // -------------------------------------------------------------------------
    // Filtered Summary
    // -------------------------------------------------------------------------

    it('[GM] commitmentsSummary - filtered-by-entity', async () => {
      const query = /* GraphQL */ `
        query FilteredSummary($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsSummary(filter: $filter, limit: $limit) {
            nodes {
              ... on CommitmentsQuarterlySummary {
                year
                quarter
                entity_cui
                entity_name
                report_type
                credite_angajament
                plati_trezor
                total_plati
                execution_rate
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
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: {
              interval: {
                start: '2022-Q1',
                end: '2023-Q4',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          entity_cuis: ['4305857'],
        },
        limit: 20,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/summary-filtered-by-entity.snap.json'
      );
    });

    it('[GM] commitmentsSummary - filtered-by-county', async () => {
      const query = /* GraphQL */ `
        query FilteredByCounty($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsSummary(filter: $filter, limit: $limit) {
            nodes {
              ... on CommitmentsAnnualSummary {
                year
                entity_cui
                entity_name
                report_type
                credite_angajament
                plati_trezor
                total_plati
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
        filter: {
          report_period: {
            type: 'YEAR',
            selection: {
              interval: {
                start: '2021',
                end: '2023',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          county_codes: ['CJ'],
        },
        limit: 20,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/summary-filtered-by-county.snap.json'
      );
    });

    it('[GM] commitmentsSummary - filtered-by-functional', async () => {
      const query = /* GraphQL */ `
        query FilteredByFunctional($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsSummary(filter: $filter, limit: $limit) {
            nodes {
              ... on CommitmentsAnnualSummary {
                year
                entity_cui
                entity_name
                report_type
                credite_angajament
                plati_trezor
                total_plati
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
        filter: {
          report_period: {
            type: 'YEAR',
            selection: {
              interval: {
                start: '2021',
                end: '2023',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          functional_prefixes: ['65'],
        },
        limit: 20,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/summary-filtered-by-functional.snap.json'
      );
    });

    // -------------------------------------------------------------------------
    // Summary with Normalization
    // -------------------------------------------------------------------------

    it('[GM] commitmentsSummary - with-per-capita-normalization', async () => {
      const query = /* GraphQL */ `
        query PerCapitaSummary($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsSummary(filter: $filter, limit: $limit) {
            nodes {
              ... on CommitmentsAnnualSummary {
                year
                entity_cui
                entity_name
                report_type
                credite_angajament
                plati_trezor
                total_plati
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
        filter: {
          report_period: {
            type: 'YEAR',
            selection: {
              interval: {
                start: '2021',
                end: '2023',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'per_capita',
        },
        limit: 20,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/summary-per-capita.snap.json'
      );
    });

    it('[GM] commitmentsSummary - with-total-euro-normalization', async () => {
      const query = /* GraphQL */ `
        query TotalEuroSummary($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsSummary(filter: $filter, limit: $limit) {
            nodes {
              ... on CommitmentsAnnualSummary {
                year
                entity_cui
                entity_name
                report_type
                credite_angajament
                plati_trezor
                total_plati
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
        filter: {
          report_period: {
            type: 'YEAR',
            selection: {
              interval: {
                start: '2021',
                end: '2023',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          normalization: 'total',
          currency: 'EUR',
        },
        limit: 20,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/summary-total-euro.snap.json'
      );
    });
  });

  // ===========================================================================
  // 2. commitmentsLineItems Query
  // ===========================================================================

  describe('commitmentsLineItems', () => {
    it('[GM] commitmentsLineItems - basic-with-pagination', async () => {
      const query = /* GraphQL */ `
        query LineItemsBasic($filter: CommitmentsFilterInput!, $limit: Int, $offset: Int) {
          commitmentsLineItems(filter: $filter, limit: $limit, offset: $offset) {
            nodes {
              id
              year
              month
              report_type
              entity_cui
              entity_name
              budget_sector_id
              budget_sector_name
              funding_source_id
              funding_source_name
              functional_code
              functional_name
              economic_code
              economic_name
              credite_angajament
              plati_trezor
              plati_non_trezor
              receptii_totale
              is_quarterly
              quarter
              is_yearly
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
          report_period: {
            type: 'YEAR',
            selection: {
              dates: ['2023'],
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          entity_cuis: ['4305857'],
        },
        limit: 20,
        offset: 0,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/line-items-basic.snap.json'
      );
    });

    it('[GM] commitmentsLineItems - filtered-by-entity', async () => {
      const query = /* GraphQL */ `
        query LineItemsByEntity($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsLineItems(filter: $filter, limit: $limit) {
            nodes {
              id
              year
              month
              entity_cui
              entity_name
              functional_code
              functional_name
              economic_code
              economic_name
              credite_angajament
              plati_trezor
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
          report_period: {
            type: 'YEAR',
            selection: {
              dates: ['2023'],
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          entity_cuis: ['4305857'],
        },
        limit: 50,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/line-items-by-entity.snap.json'
      );
    });

    it('[GM] commitmentsLineItems - filtered-by-functional', async () => {
      const query = /* GraphQL */ `
        query LineItemsByFunctional($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsLineItems(filter: $filter, limit: $limit) {
            nodes {
              id
              year
              month
              entity_cui
              entity_name
              functional_code
              functional_name
              economic_code
              economic_name
              credite_angajament
              plati_trezor
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
          report_period: {
            type: 'YEAR',
            selection: {
              dates: ['2023'],
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          functional_prefixes: ['65.03'],
          entity_cuis: ['4305857'],
        },
        limit: 50,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/line-items-by-functional.snap.json'
      );
    });

    it('[GM] commitmentsLineItems - filtered-by-economic', async () => {
      const query = /* GraphQL */ `
        query LineItemsByEconomic($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsLineItems(filter: $filter, limit: $limit) {
            nodes {
              id
              year
              month
              entity_cui
              entity_name
              functional_code
              functional_name
              economic_code
              economic_name
              credite_angajament
              plati_trezor
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
          report_period: {
            type: 'YEAR',
            selection: {
              dates: ['2023'],
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          economic_prefixes: ['10'],
          entity_cuis: ['4305857'],
        },
        limit: 50,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/line-items-by-economic.snap.json'
      );
    });

    it('[GM] commitmentsLineItems - with-anomaly-field', async () => {
      const query = /* GraphQL */ `
        query LineItemsWithAnomaly($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsLineItems(filter: $filter, limit: $limit) {
            nodes {
              id
              year
              month
              entity_cui
              entity_name
              functional_code
              economic_code
              credite_angajament
              plati_trezor
              anomaly
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
          report_period: {
            type: 'QUARTER',
            selection: {
              interval: {
                start: '2023-Q1',
                end: '2023-Q4',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          entity_cuis: ['4305857'],
        },
        limit: 50,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/line-items-with-anomaly.snap.json'
      );
    });
  });

  // ===========================================================================
  // 3. commitmentsAnalytics Query
  // ===========================================================================

  describe('commitmentsAnalytics', () => {
    // -------------------------------------------------------------------------
    // PLATI_TREZOR Metric
    // -------------------------------------------------------------------------

    it('[GM] commitmentsAnalytics - plati-trezor-monthly', async () => {
      const query = /* GraphQL */ `
        query PlatiTrezorMonthly($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'plati-trezor-monthly',
            metric: 'PLATI_TREZOR',
            filter: {
              report_period: {
                type: 'MONTH',
                selection: {
                  interval: {
                    start: '2023-01',
                    end: '2023-12',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-plati-trezor-monthly.snap.json'
      );
    });

    it('[GM] commitmentsAnalytics - plati-trezor-quarterly', async () => {
      const query = /* GraphQL */ `
        query PlatiTrezorQuarterly($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'plati-trezor-quarterly',
            metric: 'PLATI_TREZOR',
            filter: {
              report_period: {
                type: 'QUARTER',
                selection: {
                  interval: {
                    start: '2021-Q1',
                    end: '2023-Q4',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-plati-trezor-quarterly.snap.json'
      );
    });

    it('[GM] commitmentsAnalytics - plati-trezor-yearly', async () => {
      const query = /* GraphQL */ `
        query PlatiTrezorYearly($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'plati-trezor-yearly',
            metric: 'PLATI_TREZOR',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2020',
                    end: '2023',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-plati-trezor-yearly.snap.json'
      );
    });

    it('[GM] commitmentsAnalytics - national-total-plati-trezor-yearly-2019-2025', async () => {
      const query = /* GraphQL */ `
        query NationalPlatiTrezorYearly($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'national-plati-trezor-yearly',
            metric: 'PLATI_TREZOR',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2019',
                    end: '2025',
                  },
                },
              },
              // NOTE: report_type intentionally omitted to exercise the fallback resolution
              // and cover "national total" aggregation across all entities.
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-national-plati-trezor-yearly-2019-2025.snap.json'
      );
    });

    // -------------------------------------------------------------------------
    // CREDITE_ANGAJAMENT Metric (available for all periods; MONTH uses monthly delta)
    // -------------------------------------------------------------------------

    it('[GM] commitmentsAnalytics - credite-angajament-quarterly', async () => {
      const query = /* GraphQL */ `
        query CrediteAngajamentQuarterly($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'credite-angajament-quarterly',
            metric: 'CREDITE_ANGAJAMENT',
            filter: {
              report_period: {
                type: 'QUARTER',
                selection: {
                  interval: {
                    start: '2022-Q1',
                    end: '2023-Q4',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-credite-angajament-quarterly.snap.json'
      );
    });

    it('[GM] commitmentsAnalytics - credite-angajament-yearly', async () => {
      const query = /* GraphQL */ `
        query CrediteAngajamentYearly($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'credite-angajament-yearly',
            metric: 'CREDITE_ANGAJAMENT',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2020',
                    end: '2023',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-credite-angajament-yearly.snap.json'
      );
    });

    // -------------------------------------------------------------------------
    // RECEPTII_TOTALE Metric
    // -------------------------------------------------------------------------

    it('[GM] commitmentsAnalytics - receptii-totale-quarterly', async () => {
      const query = /* GraphQL */ `
        query ReceptiiTotaleQuarterly($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'receptii-totale-quarterly',
            metric: 'RECEPTII_TOTALE',
            filter: {
              report_period: {
                type: 'QUARTER',
                selection: {
                  interval: {
                    start: '2022-Q1',
                    end: '2023-Q4',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-receptii-totale-quarterly.snap.json'
      );
    });

    // -------------------------------------------------------------------------
    // Multi-Series Query
    // -------------------------------------------------------------------------

    it('[GM] commitmentsAnalytics - multi-series', async () => {
      const query = /* GraphQL */ `
        query MultiSeriesAnalytics($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'plati-trezor',
            metric: 'PLATI_TREZOR',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2020',
                    end: '2023',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
          {
            seriesId: 'credite-angajament',
            metric: 'CREDITE_ANGAJAMENT',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2020',
                    end: '2023',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
          {
            seriesId: 'receptii-totale',
            metric: 'RECEPTII_TOTALE',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2020',
                    end: '2023',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-multi-series.snap.json'
      );
    });

    // -------------------------------------------------------------------------
    // With Normalization and Currency
    // -------------------------------------------------------------------------

    it('[GM] commitmentsAnalytics - with-per-capita-normalization', async () => {
      const query = /* GraphQL */ `
        query PerCapitaAnalytics($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'plati-trezor-per-capita',
            metric: 'PLATI_TREZOR',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2020',
                    end: '2023',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
              normalization: 'per_capita',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-per-capita.snap.json'
      );
    });

    it('[GM] commitmentsAnalytics - with-euro-currency', async () => {
      const query = /* GraphQL */ `
        query EuroCurrencyAnalytics($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'plati-trezor-euro',
            metric: 'PLATI_TREZOR',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2020',
                    end: '2023',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
              normalization: 'total',
              currency: 'EUR',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-euro-currency.snap.json'
      );
    });

    // -------------------------------------------------------------------------
    // With Period Growth
    // -------------------------------------------------------------------------

    it('[GM] commitmentsAnalytics - with-period-growth', async () => {
      const query = /* GraphQL */ `
        query PeriodGrowthAnalytics($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'plati-trezor-with-growth',
            metric: 'PLATI_TREZOR',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2020',
                    end: '2023',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
              show_period_growth: true,
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-with-period-growth.snap.json'
      );
    });

    // -------------------------------------------------------------------------
    // Filtered by County
    // -------------------------------------------------------------------------

    it('[GM] commitmentsAnalytics - filtered-by-county', async () => {
      const query = /* GraphQL */ `
        query CountyFilteredAnalytics($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'plati-trezor-cj',
            metric: 'PLATI_TREZOR',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2020',
                    end: '2023',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
              county_codes: ['CJ'],
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-filtered-by-county.snap.json'
      );
    });
  });

  // ===========================================================================
  // 4. commitmentsAggregated Query
  // ===========================================================================

  describe('commitmentsAggregated', () => {
    it('[GM] commitmentsAggregated - basic', async () => {
      const query = /* GraphQL */ `
        query AggregatedBasic($input: CommitmentsAggregatedInput!) {
          commitmentsAggregated(input: $input) {
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
        input: {
          metric: 'PLATI_TREZOR',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                dates: ['2023'],
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
          },
          limit: 50,
          offset: 0,
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/aggregated-basic.snap.json'
      );
    });

    it('[GM] commitmentsAggregated - filtered-by-functional', async () => {
      const query = /* GraphQL */ `
        query AggregatedByFunctional($input: CommitmentsAggregatedInput!) {
          commitmentsAggregated(input: $input) {
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
        input: {
          metric: 'PLATI_TREZOR',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                dates: ['2023'],
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
            functional_prefixes: ['65'],
          },
          limit: 50,
          offset: 0,
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/aggregated-by-functional.snap.json'
      );
    });

    it('[GM] commitmentsAggregated - filtered-by-economic', async () => {
      const query = /* GraphQL */ `
        query AggregatedByEconomic($input: CommitmentsAggregatedInput!) {
          commitmentsAggregated(input: $input) {
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
        input: {
          metric: 'CREDITE_ANGAJAMENT',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                dates: ['2023'],
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
            economic_prefixes: ['10'],
          },
          limit: 50,
          offset: 0,
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/aggregated-by-economic.snap.json'
      );
    });

    it('[GM] commitmentsAggregated - with-normalization', async () => {
      const query = /* GraphQL */ `
        query AggregatedWithNormalization($input: CommitmentsAggregatedInput!) {
          commitmentsAggregated(input: $input) {
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
        input: {
          metric: 'PLATI_TREZOR',
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                dates: ['2023'],
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
            normalization: 'per_capita',
          },
          limit: 50,
          offset: 0,
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/aggregated-with-normalization.snap.json'
      );
    });

    it('[GM] commitmentsAggregated - quarterly-period', async () => {
      const query = /* GraphQL */ `
        query AggregatedQuarterly($input: CommitmentsAggregatedInput!) {
          commitmentsAggregated(input: $input) {
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
        input: {
          metric: 'RECEPTII_TOTALE',
          filter: {
            report_period: {
              type: 'QUARTER',
              selection: {
                interval: {
                  start: '2023-Q1',
                  end: '2023-Q4',
                },
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
          },
          limit: 50,
          offset: 0,
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/aggregated-quarterly.snap.json'
      );
    });
  });

  // ===========================================================================
  // 5. commitmentVsExecution Query
  // ===========================================================================

  describe('commitmentVsExecution', () => {
    it('[GM] commitmentVsExecution - quarterly-comparison', async () => {
      const query = /* GraphQL */ `
        query QuarterlyComparison($input: CommitmentExecutionComparisonInput!) {
          commitmentVsExecution(input: $input) {
            frequency
            data {
              period
              commitment_value
              execution_value
              difference
              difference_percent
              commitment_growth_percent
              execution_growth_percent
              difference_growth_percent
            }
            total_commitment
            total_execution
            total_difference
            overall_difference_percent
            matched_count
            unmatched_commitment_count
            unmatched_execution_count
          }
        }
      `;

      const variables = {
        input: {
          filter: {
            report_period: {
              type: 'QUARTER',
              selection: {
                interval: {
                  start: '2023-Q1',
                  end: '2023-Q4',
                },
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
            // NOTE: commitmentVsExecution does a full-dimensional join and can be expensive at national scope.
            // Keep GM tests deterministic and fast by scoping to a single known entity.
            entity_cuis: ['4305857'],
            // Further scope the join to a stable, commonly-present functional area to keep this fast.
            functional_prefixes: ['65'],
          },
          commitments_metric: 'PLATI_TREZOR',
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/commitment-vs-execution-quarterly.snap.json'
      );
    });

    it('[GM] commitmentVsExecution - yearly-comparison', async () => {
      const query = /* GraphQL */ `
        query YearlyComparison($input: CommitmentExecutionComparisonInput!) {
          commitmentVsExecution(input: $input) {
            frequency
            data {
              period
              commitment_value
              execution_value
              difference
              difference_percent
              commitment_growth_percent
              execution_growth_percent
              difference_growth_percent
            }
            total_commitment
            total_execution
            total_difference
            overall_difference_percent
            matched_count
            unmatched_commitment_count
            unmatched_execution_count
          }
        }
      `;

      const variables = {
        input: {
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                dates: ['2023'],
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
            entity_cuis: ['4305857'],
            functional_prefixes: ['65'],
          },
          commitments_metric: 'PLATI_TREZOR',
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/commitment-vs-execution-yearly.snap.json'
      );
    });

    it('[GM] commitmentVsExecution - filtered-by-entity', async () => {
      const query = /* GraphQL */ `
        query EntityFilteredComparison($input: CommitmentExecutionComparisonInput!) {
          commitmentVsExecution(input: $input) {
            frequency
            data {
              period
              commitment_value
              execution_value
              difference
              difference_percent
            }
            total_commitment
            total_execution
            total_difference
            overall_difference_percent
            matched_count
            unmatched_commitment_count
            unmatched_execution_count
          }
        }
      `;

      const variables = {
        input: {
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2023',
                  end: '2023',
                },
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
            entity_cuis: ['4305857'],
            functional_prefixes: ['65'],
          },
          commitments_metric: 'PLATI_TREZOR',
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/commitment-vs-execution-by-entity.snap.json'
      );
    });

    it('[GM] commitmentVsExecution - filtered-by-county', async () => {
      const query = /* GraphQL */ `
        query CountyFilteredComparison($input: CommitmentExecutionComparisonInput!) {
          commitmentVsExecution(input: $input) {
            frequency
            data {
              period
              commitment_value
              execution_value
              difference
              difference_percent
            }
            total_commitment
            total_execution
            total_difference
            overall_difference_percent
            matched_count
            unmatched_commitment_count
            unmatched_execution_count
          }
        }
      `;

      const variables = {
        input: {
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2023',
                  end: '2023',
                },
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
            county_codes: ['CJ'],
            entity_cuis: ['4305857'], // keep deterministic; still exercises county filter without widening scope
            functional_prefixes: ['65'],
          },
          commitments_metric: 'PLATI_TREZOR',
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/commitment-vs-execution-by-county.snap.json'
      );
    });

    it('[GM] commitmentVsExecution - with-receptii-metric', async () => {
      const query = /* GraphQL */ `
        query ReceptiiMetricComparison($input: CommitmentExecutionComparisonInput!) {
          commitmentVsExecution(input: $input) {
            frequency
            data {
              period
              commitment_value
              execution_value
              difference
              difference_percent
            }
            total_commitment
            total_execution
            total_difference
            overall_difference_percent
            matched_count
            unmatched_commitment_count
            unmatched_execution_count
          }
        }
      `;

      const variables = {
        input: {
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2023',
                  end: '2023',
                },
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
            entity_cuis: ['4305857'],
            functional_prefixes: ['65'],
          },
          commitments_metric: 'RECEPTII_TOTALE',
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/commitment-vs-execution-receptii.snap.json'
      );
    });

    it('[GM] commitmentVsExecution - with-period-growth', async () => {
      const query = /* GraphQL */ `
        query GrowthComparison($input: CommitmentExecutionComparisonInput!) {
          commitmentVsExecution(input: $input) {
            frequency
            data {
              period
              commitment_value
              execution_value
              difference
              difference_percent
              commitment_growth_percent
              execution_growth_percent
              difference_growth_percent
            }
            total_commitment
            total_execution
            total_difference
            overall_difference_percent
            matched_count
            unmatched_commitment_count
            unmatched_execution_count
          }
        }
      `;

      const variables = {
        input: {
          filter: {
            report_period: {
              type: 'YEAR',
              selection: {
                interval: {
                  start: '2022',
                  end: '2023',
                },
              },
            },
            report_type: 'PRINCIPAL_AGGREGATED',
            show_period_growth: true,
            entity_cuis: ['4305857'],
            functional_prefixes: ['65'],
          },
          commitments_metric: 'PLATI_TREZOR',
        },
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/commitment-vs-execution-with-growth.snap.json'
      );
    });
  });

  // ===========================================================================
  // Edge Cases and Additional Scenarios
  // ===========================================================================

  describe('Edge Cases', () => {
    it('[GM] commitmentsSummary - with-combined-filters', async () => {
      const query = /* GraphQL */ `
        query CombinedFilters($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsSummary(filter: $filter, limit: $limit) {
            nodes {
              ... on CommitmentsQuarterlySummary {
                year
                quarter
                entity_cui
                entity_name
                report_type
                credite_angajament
                plati_trezor
                total_plati
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
        filter: {
          report_period: {
            type: 'QUARTER',
            selection: {
              interval: {
                start: '2022-Q1',
                end: '2023-Q4',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          county_codes: ['CJ'],
          functional_prefixes: ['65'],
          normalization: 'per_capita',
          currency: 'EUR',
        },
        limit: 20,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/summary-combined-filters.snap.json'
      );
    });

    it('[GM] commitmentsAnalytics - limita-credit-angajament-quarterly', async () => {
      const query = /* GraphQL */ `
        query LimitaCreditAngajament($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'limita-credit-angajament',
            metric: 'LIMITA_CREDIT_ANGAJAMENT',
            filter: {
              report_period: {
                type: 'QUARTER',
                selection: {
                  interval: {
                    start: '2022-Q1',
                    end: '2023-Q4',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-limita-credit-angajament.snap.json'
      );
    });

    it('[GM] commitmentsAnalytics - credite-bugetare-yearly', async () => {
      const query = /* GraphQL */ `
        query CrediteBugetare($inputs: [CommitmentsAnalyticsInput!]!) {
          commitmentsAnalytics(inputs: $inputs) {
            seriesId
            metric
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
              growth_percent
            }
          }
        }
      `;

      const variables = {
        inputs: [
          {
            seriesId: 'credite-bugetare',
            metric: 'CREDITE_BUGETARE',
            filter: {
              report_period: {
                type: 'YEAR',
                selection: {
                  interval: {
                    start: '2020',
                    end: '2023',
                  },
                },
              },
              report_type: 'PRINCIPAL_AGGREGATED',
            },
          },
        ],
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/analytics-credite-bugetare.snap.json'
      );
    });

    it('[GM] commitmentsLineItems - monthly-deltas', async () => {
      const query = /* GraphQL */ `
        query MonthlyDeltas($filter: CommitmentsFilterInput!, $limit: Int) {
          commitmentsLineItems(filter: $filter, limit: $limit) {
            nodes {
              id
              year
              month
              entity_cui
              entity_name
              functional_code
              economic_code
              monthly_plati_trezor
              monthly_plati_non_trezor
              monthly_receptii_totale
              monthly_receptii_neplatite_change
              monthly_credite_angajament
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
          report_period: {
            type: 'MONTH',
            selection: {
              interval: {
                start: '2023-01',
                end: '2023-06',
              },
            },
          },
          report_type: 'PRINCIPAL_AGGREGATED',
          entity_cuis: ['4305857'],
        },
        limit: 30,
      };

      const data = await client.query(query, variables);

      await expect(data).toMatchNormalizedSnapshot(
        '../snapshots/commitments/line-items-monthly-deltas.snap.json'
      );
    });
  });
});
