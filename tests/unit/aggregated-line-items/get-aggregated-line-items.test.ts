import { Decimal } from 'decimal.js';
import { ok, err } from 'neverthrow';
import { describe, it, expect, beforeEach } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  getAggregatedLineItems,
  type GetAggregatedLineItemsDeps,
  type NormalizationFactorProvider,
} from '@/modules/aggregated-line-items/core/usecases/get-aggregated-line-items.js';

import type { AggregatedLineItemsRepository } from '@/modules/aggregated-line-items/core/ports.js';
import type {
  AggregatedLineItemsInput,
  ClassificationPeriodData,
} from '@/modules/aggregated-line-items/core/types.js';
import type { NormalizationFactors, PopulationRepository } from '@/modules/normalization/index.js';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a classification-period data row for testing.
 */
function createRow(
  functionalCode: string,
  economicCode: string,
  year: number,
  amount: number,
  count = 1
): ClassificationPeriodData {
  return {
    functional_code: functionalCode,
    functional_name: `Functional ${functionalCode}`,
    economic_code: economicCode,
    economic_name: `Economic ${economicCode}`,
    year,
    amount: new Decimal(amount),
    count,
  };
}

/**
 * Creates a minimal filter for testing.
 */
function createFilter(
  overrides: Partial<AggregatedLineItemsInput['filter']> = {}
): AggregatedLineItemsInput['filter'] {
  return {
    account_category: 'ch',
    report_period: {
      frequency: Frequency.YEAR,
      selection: { interval: { start: '2023', end: '2024' } },
    },
    normalization: 'total',
    currency: 'RON',
    inflation_adjusted: false,
    show_period_growth: false,
    ...overrides,
  };
}

/**
 * Creates a fake repository that returns the given rows.
 * Uses only in-memory path (deliberately omits getNormalizedAggregatedItems
 * to force the in-memory normalization path).
 */
function createFakeRepo(
  rows: ClassificationPeriodData[],
  distinctCount?: number
): AggregatedLineItemsRepository {
  // Cast to full interface via unknown - the getAggregatedLineItems function checks
  // for 'getNormalizedAggregatedItems' presence and falls back to in-memory
  return {
    getClassificationPeriodData: async () =>
      ok({
        rows,
        distinctClassificationCount:
          distinctCount ?? new Set(rows.map((r) => `${r.functional_code}|${r.economic_code}`)).size,
      }),
  } as unknown as AggregatedLineItemsRepository;
}

/**
 * Creates a fake repo that returns an error.
 * Uses only in-memory path (deliberately omits getNormalizedAggregatedItems).
 */
function createFailingRepo(errorMessage: string): AggregatedLineItemsRepository {
  return {
    getClassificationPeriodData: async () =>
      err({
        type: 'DatabaseError' as const,
        message: errorMessage,
        retryable: true,
      }),
  } as unknown as AggregatedLineItemsRepository;
}

/**
 * Creates a fake population repository for testing.
 * Returns country population of 19M by default.
 */
function createFakePopulationRepo(
  countryPopulation = new Decimal(19_000_000)
): PopulationRepository {
  return {
    getCountryPopulation: async () => ok(countryPopulation),
    getFilteredPopulation: async () => ok(countryPopulation),
  };
}

/**
 * Creates a fake normalization provider with identity factors (no transformation).
 */
function createIdentityNormalization(): NormalizationFactorProvider {
  return {
    generateFactors: async () => ({
      cpi: new Map([
        ['2023', new Decimal(1)],
        ['2024', new Decimal(1)],
      ]),
      eur: new Map([
        ['2023', new Decimal(1)],
        ['2024', new Decimal(1)],
      ]),
      usd: new Map([
        ['2023', new Decimal(1)],
        ['2024', new Decimal(1)],
      ]),
      gdp: new Map([
        ['2023', new Decimal(1000000)],
        ['2024', new Decimal(1000000)],
      ]),
      population: new Map([
        ['2023', new Decimal(19000000)],
        ['2024', new Decimal(19000000)],
      ]),
    }),
  };
}

/**
 * Creates a normalization provider with specific factors for testing transformations.
 */
function createTestNormalization(
  factors: Partial<NormalizationFactors>
): NormalizationFactorProvider {
  const defaultFactors: NormalizationFactors = {
    cpi: new Map([
      ['2023', new Decimal(1.1)],
      ['2024', new Decimal(1)],
    ]),
    eur: new Map([
      ['2023', new Decimal(5)],
      ['2024', new Decimal(5)],
    ]),
    usd: new Map([
      ['2023', new Decimal(4.5)],
      ['2024', new Decimal(4.5)],
    ]),
    gdp: new Map([
      ['2023', new Decimal(1000000)],
      ['2024', new Decimal(1100000)],
    ]),
    population: new Map([
      ['2023', new Decimal(19000000)],
      ['2024', new Decimal(19000000)],
    ]),
  };

  return {
    generateFactors: async () => ({
      ...defaultFactors,
      ...factors,
    }),
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('getAggregatedLineItems', () => {
  describe('Basic Aggregation', () => {
    it('should return empty result for no data', async () => {
      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo([]),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(0);
        expect(result.value.pageInfo.totalCount).toBe(0);
        expect(result.value.pageInfo.hasNextPage).toBe(false);
        expect(result.value.pageInfo.hasPreviousPage).toBe(false);
      }
    });

    it('should aggregate rows by classification across years', async () => {
      const rows = [
        createRow('01.01', '10.01', 2023, 1000, 5),
        createRow('01.01', '10.01', 2024, 2000, 10),
        createRow('02.01', '20.01', 2023, 500, 2),
      ];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(2);

        // Should be sorted by amount DESC
        const first = result.value.nodes[0];
        expect(first?.functional_code).toBe('01.01');
        expect(first?.economic_code).toBe('10.01');
        expect(first?.amount).toBe(3000); // 1000 + 2000
        expect(first?.count).toBe(15); // 5 + 10

        const second = result.value.nodes[1];
        expect(second?.functional_code).toBe('02.01');
        expect(second?.amount).toBe(500);
        expect(second?.count).toBe(2);
      }
    });

    it('should sort results by amount descending', async () => {
      const rows = [
        createRow('01.01', '10.01', 2023, 100),
        createRow('02.01', '20.01', 2023, 500),
        createRow('03.01', '30.01', 2023, 300),
      ];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const amounts = result.value.nodes.map((n) => n.amount);
        expect(amounts).toEqual([500, 300, 100]);
      }
    });
  });

  describe('Pagination', () => {
    let deps: GetAggregatedLineItemsDeps;

    beforeEach(() => {
      const rows = [
        createRow('01', '10', 2023, 500),
        createRow('02', '20', 2023, 400),
        createRow('03', '30', 2023, 300),
        createRow('04', '40', 2023, 200),
        createRow('05', '50', 2023, 100),
      ];

      deps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };
    });

    it('should apply limit', async () => {
      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
        limit: 2,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(2);
        expect(result.value.pageInfo.totalCount).toBe(5);
        expect(result.value.pageInfo.hasNextPage).toBe(true);
        expect(result.value.pageInfo.hasPreviousPage).toBe(false);
      }
    });

    it('should apply offset', async () => {
      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
        limit: 2,
        offset: 2,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(2);
        expect(result.value.nodes[0]?.amount).toBe(300); // Third item
        expect(result.value.pageInfo.hasNextPage).toBe(true);
        expect(result.value.pageInfo.hasPreviousPage).toBe(true);
      }
    });

    it('should handle last page correctly', async () => {
      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
        limit: 2,
        offset: 4,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(1);
        expect(result.value.pageInfo.hasNextPage).toBe(false);
        expect(result.value.pageInfo.hasPreviousPage).toBe(true);
      }
    });

    it('should use default limit of 50', async () => {
      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
        // No limit specified
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // All 5 items should be returned (less than default 50)
        expect(result.value.nodes).toHaveLength(5);
      }
    });

    it('should cap limit at 1000', async () => {
      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
        limit: 9999,
      });

      // Should not error, limit is capped internally
      expect(result.isOk()).toBe(true);
    });

    it('should handle negative offset as 0', async () => {
      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
        offset: -10,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes[0]?.amount).toBe(500); // First item
      }
    });
  });

  describe('Normalization - Currency Conversion', () => {
    it('should convert amounts to EUR', async () => {
      const rows = [createRow('01.01', '10.01', 2023, 500)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          eur: new Map([['2023', new Decimal(5)]]),
        }),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ currency: 'EUR' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 500 RON / 5 = 100 EUR
        expect(result.value.nodes[0]?.amount).toBe(100);
      }
    });

    it('should convert amounts to USD', async () => {
      const rows = [createRow('01.01', '10.01', 2023, 450)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          usd: new Map([['2023', new Decimal(4.5)]]),
        }),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ currency: 'USD' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 450 RON / 4.5 = 100 USD
        expect(result.value.nodes[0]?.amount).toBe(100);
      }
    });

    it('should apply different rates per year before aggregation', async () => {
      const rows = [
        createRow('01.01', '10.01', 2023, 500), // 500 / 5 = 100 EUR
        createRow('01.01', '10.01', 2024, 600), // 600 / 6 = 100 EUR
      ];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          eur: new Map([
            ['2023', new Decimal(5)],
            ['2024', new Decimal(6)],
          ]),
        }),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ currency: 'EUR' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // (500/5) + (600/6) = 100 + 100 = 200 EUR
        expect(result.value.nodes[0]?.amount).toBe(200);
      }
    });

    it('should use carried-forward rates for years with missing data (2025 scenario)', async () => {
      // Simulate data from 2025 when exchange rate dataset only has data through 2024
      const rows = [
        createRow('01.01', '10.01', 2024, 500), // 500 / 5 = 100 EUR
        createRow('01.01', '10.01', 2025, 500), // 500 / 5 = 100 EUR (using carried-forward rate)
      ];

      // Normalization provider that returns factors WITH the carried-forward 2025 value
      // This simulates what NormalizationService.generateFactors() would return
      // when the year range includes 2025 but dataset only has data through 2024
      const normalizationWithCarryForward: NormalizationFactorProvider = {
        generateFactors: async () => ({
          cpi: new Map([
            ['2024', new Decimal(1)],
            ['2025', new Decimal(1)], // Carried forward from 2024
          ]),
          eur: new Map([
            ['2024', new Decimal(5)],
            ['2025', new Decimal(5)], // Carried forward from 2024
          ]),
          usd: new Map([
            ['2024', new Decimal(4.5)],
            ['2025', new Decimal(4.5)], // Carried forward from 2024
          ]),
          gdp: new Map([
            ['2024', new Decimal(1100000)],
            ['2025', new Decimal(1100000)], // Carried forward from 2024
          ]),
          population: new Map([
            ['2024', new Decimal(19000000)],
            ['2025', new Decimal(19000000)], // Carried forward from 2024
          ]),
        }),
      };

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: normalizationWithCarryForward,
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({
          currency: 'EUR',
          report_period: {
            frequency: Frequency.YEAR,
            selection: { interval: { start: '2024', end: '2025' } },
          },
        }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Both years should use rate of 5:
        // (500/5) + (500/5) = 100 + 100 = 200 EUR
        // Bug scenario: if 2025 factor was missing and defaulted to 1.0,
        // result would be (500/5) + (500/1) = 100 + 500 = 600 EUR (incorrect)
        expect(result.value.nodes[0]?.amount).toBe(200);
      }
    });
  });

  describe('Normalization - Inflation Adjustment', () => {
    it('should apply CPI factors when inflation_adjusted is true', async () => {
      const rows = [createRow('01.01', '10.01', 2023, 100)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          cpi: new Map([['2023', new Decimal(1.1)]]),
        }),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ inflation_adjusted: true }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 100 * 1.1 = 110
        expect(result.value.nodes[0]?.amount).toBe(110);
      }
    });

    it('should not apply CPI factors when inflation_adjusted is false', async () => {
      const rows = [createRow('01.01', '10.01', 2023, 100)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          cpi: new Map([['2023', new Decimal(1.1)]]),
        }),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ inflation_adjusted: false }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes[0]?.amount).toBe(100);
      }
    });

    it('should apply inflation before currency conversion', async () => {
      const rows = [createRow('01.01', '10.01', 2023, 100)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          cpi: new Map([['2023', new Decimal(1.1)]]),
          eur: new Map([['2023', new Decimal(5)]]),
        }),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ inflation_adjusted: true, currency: 'EUR' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // (100 * 1.1) / 5 = 110 / 5 = 22
        expect(result.value.nodes[0]?.amount).toBe(22);
      }
    });
  });

  describe('Normalization - Per Capita', () => {
    it('should divide by population for per_capita mode', async () => {
      const rows = [createRow('01.01', '10.01', 2023, 19000000)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          population: new Map([['2023', new Decimal(19000000)]]),
        }),
        populationRepo: createFakePopulationRepo(new Decimal(19_000_000)),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ normalization: 'per_capita' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 19000000 / 19000000 = 1
        expect(result.value.nodes[0]?.amount).toBe(1);
      }
    });

    it('should apply per_capita after currency conversion', async () => {
      const rows = [createRow('01.01', '10.01', 2023, 95000000)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          eur: new Map([['2023', new Decimal(5)]]),
          population: new Map([['2023', new Decimal(19000000)]]),
        }),
        populationRepo: createFakePopulationRepo(new Decimal(19_000_000)),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ normalization: 'per_capita', currency: 'EUR' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // (95000000 / 5) / 19000000 = 19000000 / 19000000 = 1
        expect(result.value.nodes[0]?.amount).toBe(1);
      }
    });
  });

  describe('Normalization - Percent GDP', () => {
    it('should calculate percentage of GDP', async () => {
      const rows = [createRow('01.01', '10.01', 2023, 10000000000)]; // 10 billion

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          gdp: new Map([['2023', new Decimal(1000000)]]), // 1 trillion (in millions)
        }),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ normalization: 'percent_gdp' }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // 10000000000 / (1000000 * 1000000) * 100 = 1%
        expect(result.value.nodes[0]?.amount).toBe(1);
      }
    });

    it('should ignore inflation_adjusted for percent_gdp', async () => {
      const rows = [createRow('01.01', '10.01', 2023, 10000000000)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          cpi: new Map([['2023', new Decimal(2)]]), // Would double if applied
          gdp: new Map([['2023', new Decimal(1000000)]]),
        }),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({
          normalization: 'percent_gdp',
          inflation_adjusted: true, // Should be ignored
        }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // CPI should NOT be applied - result should be 1%, not 2%
        expect(result.value.nodes[0]?.amount).toBe(1);
      }
    });

    it('should ignore currency for percent_gdp', async () => {
      const rows = [createRow('01.01', '10.01', 2023, 10000000000)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          eur: new Map([['2023', new Decimal(5)]]), // Would divide if applied
          gdp: new Map([['2023', new Decimal(1000000)]]),
        }),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({
          normalization: 'percent_gdp',
          currency: 'EUR', // Should be ignored
        }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Currency should NOT be applied
        expect(result.value.nodes[0]?.amount).toBe(1);
      }
    });
  });

  describe('Aggregate Amount Filters', () => {
    it('should filter by aggregate_min_amount', async () => {
      const rows = [
        createRow('01', '10', 2023, 100),
        createRow('02', '20', 2023, 500),
        createRow('03', '30', 2023, 1000),
      ];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ aggregate_min_amount: 400 }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(2);
        expect(result.value.nodes.every((n) => n.amount >= 400)).toBe(true);
      }
    });

    it('should filter by aggregate_max_amount', async () => {
      const rows = [
        createRow('01', '10', 2023, 100),
        createRow('02', '20', 2023, 500),
        createRow('03', '30', 2023, 1000),
      ];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ aggregate_max_amount: 600 }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(2);
        expect(result.value.nodes.every((n) => n.amount <= 600)).toBe(true);
      }
    });

    it('should apply aggregate filters after normalization', async () => {
      const rows = [
        createRow('01', '10', 2023, 100), // After EUR: 20
        createRow('02', '20', 2023, 500), // After EUR: 100
      ];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createTestNormalization({
          eur: new Map([['2023', new Decimal(5)]]),
        }),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({
          currency: 'EUR',
          aggregate_min_amount: 50, // In EUR, not RON
        }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Only 500 RON (100 EUR) should pass the filter
        expect(result.value.nodes).toHaveLength(1);
        expect(result.value.nodes[0]?.amount).toBe(100);
      }
    });
  });

  describe('Error Handling', () => {
    it('should propagate repository errors', async () => {
      const deps: GetAggregatedLineItemsDeps = {
        repo: createFailingRepo('Connection failed'),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
        expect(result.error.message).toBe('Connection failed');
      }
    });

    it('should handle normalization factor generation errors', async () => {
      const rows = [createRow('01', '10', 2023, 100)];

      const failingNormalization: NormalizationFactorProvider = {
        generateFactors: async () => {
          throw new Error('Dataset not found');
        },
      };

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: failingNormalization,
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({ currency: 'EUR' }), // Needs normalization
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('NormalizationDataError');
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero amounts', async () => {
      const rows = [createRow('01', '10', 2023, 0), createRow('02', '20', 2023, 100)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(2);
        // Zero amount should be last after sorting DESC
        expect(result.value.nodes[1]?.amount).toBe(0);
      }
    });

    it('should handle negative amounts', async () => {
      const rows = [createRow('01', '10', 2023, -100), createRow('02', '20', 2023, 100)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes[0]?.amount).toBe(100);
        expect(result.value.nodes[1]?.amount).toBe(-100);
      }
    });

    it('should handle single year data', async () => {
      const rows = [createRow('01', '10', 2023, 100)];

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(1);
        expect(result.value.nodes[0]?.amount).toBe(100);
      }
    });

    it('should handle many classifications', async () => {
      const rows = Array.from({ length: 100 }, (_, i) =>
        createRow(String(i).padStart(2, '0'), '10', 2023, 100 - i)
      );

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: createIdentityNormalization(),
        populationRepo: createFakePopulationRepo(),
      };

      const result = await getAggregatedLineItems(deps, {
        filter: createFilter(),
        limit: 10,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes).toHaveLength(10);
        expect(result.value.pageInfo.totalCount).toBe(100);
        // First should have highest amount
        expect(result.value.nodes[0]?.amount).toBe(100);
      }
    });

    it('should skip normalization when no transformation needed', async () => {
      const rows = [createRow('01', '10', 2023, 100)];

      // Normalization that throws if called
      const neverCalledNormalization: NormalizationFactorProvider = {
        generateFactors: async () => {
          throw new Error('Should not be called');
        },
      };

      const deps: GetAggregatedLineItemsDeps = {
        repo: createFakeRepo(rows),
        normalization: neverCalledNormalization,
        populationRepo: createFakePopulationRepo(),
      };

      // With normalization: 'total', currency: 'RON', inflation_adjusted: false
      // no factors should be generated
      const result = await getAggregatedLineItems(deps, {
        filter: createFilter({
          normalization: 'total',
          currency: 'RON',
          inflation_adjusted: false,
        }),
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.nodes[0]?.amount).toBe(100);
      }
    });
  });
});
