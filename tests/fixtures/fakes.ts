/**
 * Test fakes and mocks
 */

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import type { BudgetDbClient } from '@/infra/database/client.js';
import type {
  BudgetSectorRepository,
  BudgetSector,
  BudgetSectorFilter,
  BudgetSectorConnection,
} from '@/modules/budget-sector/index.js';
import type {
  DatasetRepo,
  Dataset,
  DatasetRepoError,
  DatasetFileEntry,
} from '@/modules/datasets/index.js';
import type {
  FundingSourceRepository,
  ExecutionLineItemRepository,
  FundingSource,
  FundingSourceFilter,
  FundingSourceConnection,
  ExecutionLineItem,
  ExecutionLineItemFilter,
  ExecutionLineItemConnection,
} from '@/modules/funding-sources/index.js';

/**
 * Creates minimal fake datasets for normalization.
 * These are required for the NormalizationService to initialize.
 */
const createMinimalNormalizationDatasets = (): Record<string, Dataset> => {
  // Sample years for testing
  const years = [2020, 2021, 2022, 2023, 2024];

  const createYearlyDataset = (id: string, unit: string, values: number[]): Dataset => ({
    id,
    metadata: {
      id,
      source: 'test',
      lastUpdated: '2024-01-01',
      units: unit,
      frequency: 'yearly',
    },
    i18n: {
      ro: {
        title: `Test ${id}`,
        xAxisLabel: 'An',
        yAxisLabel: unit,
      },
    },
    axes: {
      x: { label: 'Year', type: 'date', frequency: 'yearly' },
      y: { label: 'Value', type: 'number', unit },
    },
    points: years.map((year, i) => ({
      x: String(year),
      y: new Decimal(values[i] ?? values[0] ?? 100),
    })),
  });

  return {
    // CPI dataset - values represent index (base 100)
    'ro.economics.cpi.yearly': createYearlyDataset(
      'ro.economics.cpi.yearly',
      'index',
      [100, 105, 118, 125, 130]
    ),
    // EUR exchange rate - RON per EUR
    'ro.economics.exchange.ron_eur.yearly': createYearlyDataset(
      'ro.economics.exchange.ron_eur.yearly',
      'RON/EUR',
      [4.87, 4.92, 4.93, 4.95, 4.97]
    ),
    // USD exchange rate - RON per USD
    'ro.economics.exchange.ron_usd.yearly': createYearlyDataset(
      'ro.economics.exchange.ron_usd.yearly',
      'RON/USD',
      [4.24, 4.16, 4.69, 4.57, 4.58]
    ),
    // GDP in millions RON
    'ro.economics.gdp.yearly': createYearlyDataset(
      'ro.economics.gdp.yearly',
      'million_ron',
      [1058000, 1182000, 1409000, 1580000, 1700000]
    ),
    // Population
    'ro.demographics.population.yearly': createYearlyDataset(
      'ro.demographics.population.yearly',
      'persons',
      [19328000, 19201000, 19053000, 18968000, 18900000]
    ),
  };
};

interface FakeDatasetRepoOptions {
  /** Custom datasets to include */
  datasets?: Record<string, Dataset>;
  /** If true, includes minimal normalization datasets (default: true) */
  includeNormalizationDatasets?: boolean;
}

/**
 * Creates a fake dataset repository for testing.
 *
 * By default, includes minimal normalization datasets required for the
 * NormalizationService to initialize. Pass `includeNormalizationDatasets: false`
 * to create an empty repo for testing validation errors.
 */
export const makeFakeDatasetRepo = (options: FakeDatasetRepoOptions = {}): DatasetRepo => {
  const { datasets: customDatasets = {}, includeNormalizationDatasets = true } = options;

  // Merge datasets based on options
  const datasets = includeNormalizationDatasets
    ? { ...createMinimalNormalizationDatasets(), ...customDatasets }
    : customDatasets;

  return {
    getById: async (id: string): Promise<Result<Dataset, DatasetRepoError>> => {
      const dataset = datasets[id];
      if (dataset != null) {
        return ok(dataset);
      }
      return err({ type: 'NotFound', message: `Dataset ${id} not found` });
    },
    listAvailable: async (): Promise<Result<DatasetFileEntry[], DatasetRepoError>> => {
      const entries: DatasetFileEntry[] = Object.keys(datasets).map((id) => ({
        id,
        absolutePath: `/fake/${id}.yaml`,
        relativePath: `${id}.yaml`,
      }));
      return ok(entries);
    },
    getByIds: async (ids: string[]): Promise<Result<Dataset[], DatasetRepoError>> => {
      const uniqueIds = [...new Set(ids)];
      const results: Dataset[] = [];
      for (const id of uniqueIds) {
        const dataset = datasets[id];
        if (dataset != null) {
          results.push(dataset);
        }
      }
      return ok(results);
    },
    getAllWithMetadata: async (): Promise<Result<Dataset[], DatasetRepoError>> => {
      return ok(Object.values(datasets));
    },
  };
};

export const makeFakeBudgetDb = (): BudgetDbClient => {
  // This is a very basic fake.
  // If you need to mock query results, you might need a more sophisticated mock
  // using something like 'kysely-mock' or manually mocking the chainable methods.
  // For now, since we just need it to pass dependency injection checks,
  // we can cast an empty object or a partial mock.
  return {} as unknown as BudgetDbClient;
};

// =============================================================================
// Budget Sector Fakes
// =============================================================================

/** Default budget sectors for testing */
const defaultBudgetSectors: BudgetSector[] = [
  { sector_id: 1, sector_description: 'Buget local' },
  { sector_id: 2, sector_description: 'Buget de stat' },
  { sector_id: 3, sector_description: 'Buget asigurari sociale' },
  { sector_id: 4, sector_description: 'Fonduri externe nerambursabile' },
];

interface FakeBudgetSectorRepoOptions {
  /** Custom sectors to use instead of defaults */
  sectors?: BudgetSector[];
}

/**
 * Creates a fake budget sector repository for testing.
 *
 * Uses simple substring matching for search filter (instead of pg_trgm).
 * Sectors are sorted by sector_id for deterministic pagination.
 */
export const makeFakeBudgetSectorRepo = (
  options: FakeBudgetSectorRepoOptions = {}
): BudgetSectorRepository => {
  const sectors = options.sectors ?? defaultBudgetSectors;

  return {
    findById: async (id: number) => {
      const sector = sectors.find((s) => s.sector_id === id);
      return ok(sector ?? null);
    },

    list: async (filter: BudgetSectorFilter | undefined, limit: number, offset: number) => {
      let filtered = [...sectors];

      // Apply search filter (simple substring match for fake)
      if (filter?.search !== undefined && filter.search.trim() !== '') {
        const searchLower = filter.search.toLowerCase();
        filtered = filtered.filter((s) => s.sector_description.toLowerCase().includes(searchLower));
      }

      // Apply sector_ids filter
      if (filter?.sector_ids !== undefined && filter.sector_ids.length > 0) {
        const idsSet = new Set(filter.sector_ids);
        filtered = filtered.filter((s) => idsSet.has(s.sector_id));
      }

      // Sort by ID for consistency
      filtered.sort((a, b) => a.sector_id - b.sector_id);

      const totalCount = filtered.length;
      const nodes = filtered.slice(offset, offset + limit);

      const connection: BudgetSectorConnection = {
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };

      return ok(connection);
    },
  };
};

// =============================================================================
// Funding Source Fakes
// =============================================================================

/** Default funding sources for testing */
const defaultFundingSources: FundingSource[] = [
  { source_id: 1, source_description: 'Buget de stat' },
  { source_id: 2, source_description: 'Fonduri externe nerambursabile' },
  { source_id: 3, source_description: 'Venituri proprii' },
  { source_id: 4, source_description: 'Credite externe' },
];

/** Default execution line items for testing */
const defaultExecutionLineItems: ExecutionLineItem[] = [
  {
    line_item_id: '1',
    report_id: 'report-1',
    year: 2024,
    month: 6,
    entity_cui: '1234567',
    account_category: 'ch',
    functional_code: '51.01',
    economic_code: '10.01',
    ytd_amount: '1000000.00',
    monthly_amount: '100000.00',
  },
  {
    line_item_id: '2',
    report_id: 'report-1',
    year: 2024,
    month: 6,
    entity_cui: '1234567',
    account_category: 'vn',
    functional_code: '00.01',
    economic_code: null,
    ytd_amount: '2000000.00',
    monthly_amount: '200000.00',
  },
];

interface FakeFundingSourceRepoOptions {
  /** Custom funding sources to use instead of defaults */
  sources?: FundingSource[];
}

/**
 * Creates a fake funding source repository for testing.
 *
 * Uses simple substring matching for search filter (instead of pg_trgm).
 * Sources are sorted by source_id for deterministic pagination.
 */
export const makeFakeFundingSourceRepo = (
  options: FakeFundingSourceRepoOptions = {}
): FundingSourceRepository => {
  const sources = options.sources ?? defaultFundingSources;

  return {
    findById: async (id: number) => {
      const source = sources.find((s) => s.source_id === id);
      return ok(source ?? null);
    },

    list: async (filter: FundingSourceFilter | undefined, limit: number, offset: number) => {
      let filtered = [...sources];

      // Apply search filter (simple substring match for fake)
      if (filter?.search !== undefined && filter.search.trim() !== '') {
        const searchLower = filter.search.toLowerCase();
        filtered = filtered.filter((s) => s.source_description.toLowerCase().includes(searchLower));
      }

      // Apply source_ids filter
      if (filter?.source_ids !== undefined && filter.source_ids.length > 0) {
        const idsSet = new Set(filter.source_ids);
        filtered = filtered.filter((s) => idsSet.has(s.source_id));
      }

      // Sort by ID for consistency
      filtered.sort((a, b) => a.source_id - b.source_id);

      const totalCount = filtered.length;
      const nodes = filtered.slice(offset, offset + limit);

      const connection: FundingSourceConnection = {
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };

      return ok(connection);
    },
  };
};

interface FakeExecutionLineItemRepoOptions {
  /** Custom line items to use instead of defaults */
  lineItems?: ExecutionLineItem[];
}

/**
 * Creates a fake execution line item repository for testing.
 *
 * Line items are filtered by funding_source_id from the parent.
 * Additional filters (report_id, account_category) are applied if provided.
 */
export const makeFakeExecutionLineItemRepo = (
  options: FakeExecutionLineItemRepoOptions = {}
): ExecutionLineItemRepository => {
  const lineItems = options.lineItems ?? defaultExecutionLineItems;

  return {
    listByFundingSource: async (filter: ExecutionLineItemFilter, limit: number, offset: number) => {
      // In real implementation, items would be filtered by funding_source_id
      // For fake, we just return all items or empty based on funding_source_id
      let filtered =
        filter.funding_source_id === 1 || filter.funding_source_id === 2 ? [...lineItems] : [];

      // Apply report_id filter
      if (filter.report_id !== undefined) {
        filtered = filtered.filter((item) => item.report_id === filter.report_id);
      }

      // Apply account_category filter
      if (filter.account_category !== undefined) {
        filtered = filtered.filter((item) => item.account_category === filter.account_category);
      }

      const totalCount = filtered.length;
      const nodes = filtered.slice(offset, offset + limit);

      const connection: ExecutionLineItemConnection = {
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };

      return ok(connection);
    },
  };
};
