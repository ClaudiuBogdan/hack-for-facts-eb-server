import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';
import { describe, it, expect, vi } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { makeEntityResolvers } from '@/modules/entity/shell/graphql/resolvers.js';

import type { AnalyticsFilter, PeriodSelection } from '@/common/types/analytics.js';
import type { BudgetSectorRepository, BudgetSector } from '@/modules/budget-sector/index.js';
import type {
  EntityRepository,
  UATRepository,
  ReportRepository,
  EntityAnalyticsSummaryRepository,
} from '@/modules/entity/core/ports.js';
import type { Entity, UAT, DataSeries } from '@/modules/entity/core/types.js';
import type {
  ExecutionLineItemRepository,
  ExecutionLineItem,
} from '@/modules/execution-line-items/index.js';
import type {
  NormalizationService,
  NormalizationFactors,
  DataPoint,
  TransformationOptions,
} from '@/modules/normalization/index.js';
import type { MercuriusContext } from 'mercurius';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a test entity with customizable properties.
 */
function createTestEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    cui: '12345',
    name: 'Test Entity',
    entity_type: 'uat',
    default_report_type: 'Executie bugetara detaliata',
    uat_id: 100,
    is_uat: true,
    address: '123 Test St',
    last_updated: new Date('2023-01-01'),
    main_creditor_1_cui: null,
    main_creditor_2_cui: null,
    ...overrides,
  };
}

/**
 * Creates a test UAT.
 */
function createTestUAT(id: number, population: number): UAT {
  return {
    id,
    uat_key: `UAT-${String(id)}`,
    uat_code: `${String(id)}00`,
    siruta_code: `${String(id)}0000`,
    name: `UAT ${String(id)}`,
    county_code: 'CJ',
    county_name: 'Cluj',
    region: 'Nord-Vest',
    population,
  };
}

/**
 * Creates a test execution line item.
 */
function createTestLineItem(
  year: number,
  ytdAmount: number,
  monthlyAmount = 100
): ExecutionLineItem {
  return {
    line_item_id: `line-${String(year)}-${String(ytdAmount)}`,
    report_id: 'report-1',
    entity_cui: '12345',
    funding_source_id: 1,
    budget_sector_id: 1,
    functional_code: '510104',
    economic_code: '10',
    account_category: 'ch',
    expense_type: 'functionare',
    program_code: null,
    year,
    month: 12,
    quarter: 4,
    ytd_amount: new Decimal(ytdAmount),
    monthly_amount: new Decimal(monthlyAmount),
    quarterly_amount: new Decimal(ytdAmount / 4),
    anomaly: null,
  };
}

/**
 * Creates identity normalization factors.
 */
function createIdentityFactors(): NormalizationFactors {
  return {
    cpi: new Map([['2023', new Decimal(1)]]),
    eur: new Map([['2023', new Decimal(5)]]),
    usd: new Map([['2023', new Decimal(4.5)]]),
    gdp: new Map([['2023', new Decimal(1000000)]]),
    population: new Map([['2023', new Decimal(19000000)]]),
  };
}

/**
 * Creates a fake entity repository.
 */
function createFakeEntityRepo(entity: Entity | null = createTestEntity()): EntityRepository {
  return {
    getById: async () => ok(entity),
    getChildren: async () => ok([]),
    getParents: async () => ok([]),
    getAll: async () =>
      ok({
        nodes: entity !== null ? [entity] : [],
        pageInfo: {
          totalCount: entity !== null ? 1 : 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      }),
    getCountyEntity: async () => ok(null),
  };
}

/**
 * Creates a fake UAT repository.
 */
function createFakeUATRepo(
  uat: UAT = createTestUAT(100, 10000),
  countyPopulation = 100000
): UATRepository {
  return {
    getById: async () => ok(uat),
    getAll: async () =>
      ok({
        nodes: [uat],
        pageInfo: { totalCount: 1, hasNextPage: false, hasPreviousPage: false },
      }),
    count: async () => ok(1),
    getCountyPopulation: async () => ok(countyPopulation),
  };
}

/**
 * Creates a fake report repository.
 */
function createFakeReportRepo(): ReportRepository {
  return {
    getById: async () => ok(null),
    getByEntityAndDate: async () => ok(null),
    list: async () =>
      ok({
        nodes: [],
        pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
      }),
    count: async () => ok(0),
  };
}

/**
 * Creates a fake execution line item repository.
 */
function createFakeLineItemRepo(items: ExecutionLineItem[] = []): ExecutionLineItemRepository {
  return {
    list: async () =>
      ok({
        nodes: items,
        pageInfo: {
          totalCount: items.length,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      }),
    findById: async () => ok(null),
  };
}

/**
 * Creates a fake entity analytics summary repository.
 */
function createFakeAnalyticsSummaryRepo(): EntityAnalyticsSummaryRepository {
  const dataSeries: DataSeries = { frequency: Frequency.YEAR, data: [] };
  return {
    getTotals: async () => ok({ totalIncome: 0, totalExpenses: 0, budgetBalance: 0 }),
    getTrend: async () => ok(dataSeries),
  };
}

/**
 * Creates a fake budget sector repository.
 */
function createFakeBudgetSectorRepo(): BudgetSectorRepository {
  const sector: BudgetSector = { sector_id: 1, sector_description: 'Test Sector' };
  return {
    findById: async () => ok(sector),
    list: async () =>
      ok({ nodes: [], pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false } }),
  };
}

/**
 * Creates a fake normalization service.
 */
function createFakeNormalizationService(
  factors: NormalizationFactors = createIdentityFactors()
): NormalizationService {
  return {
    generateFactors: async () => factors,
    normalize: async (dataPoints: DataPoint[], options: TransformationOptions) => {
      // Apply currency conversion if EUR
      let converted = dataPoints;
      if (options.currency === 'EUR') {
        converted = dataPoints.map((p) => ({
          ...p,
          y: p.y.div(5), // 5 RON per EUR
        }));
      }
      return ok(converted);
    },
  } as unknown as NormalizationService;
}

/**
 * Creates a fake Mercurius context.
 */
function createFakeContext(): MercuriusContext {
  return {
    reply: {
      log: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    },
  } as unknown as MercuriusContext;
}

/**
 * Creates the base filter for executionLineItems.
 */
function createBaseFilter(): Partial<AnalyticsFilter> {
  return {
    account_category: 'ch',
    report_period: {
      type: Frequency.YEAR,
      selection: { interval: { start: '2023', end: '2023' } } as PeriodSelection,
    },
    report_type: 'Executie bugetara detaliata',
  };
}

/**
 * Resolver result type for executionLineItems.
 */
interface ExecutionLineItemResult {
  nodes: {
    line_item_id: string;
    ytd_amount: number;
    monthly_amount: number;
    quarterly_amount: number | null;
  }[];
  pageInfo: {
    totalCount: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

/**
 * Calls the Entity.executionLineItems resolver.
 */
async function callExecutionLineItemsResolver(
  resolvers: ReturnType<typeof makeEntityResolvers>,
  parent: Entity,
  args: {
    filter?: Partial<AnalyticsFilter> & { normalization?: string };
    normalization?: string;
    limit?: number;
    offset?: number;
    sort?: { field?: string; by?: string; order?: string };
  }
): Promise<ExecutionLineItemResult> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- Test helper needs dynamic access to resolver
  return (resolvers as any).Entity.executionLineItems(
    parent,
    args,
    createFakeContext()
  ) as Promise<ExecutionLineItemResult>;
}

// =============================================================================
// Tests
// =============================================================================

describe('Entity executionLineItems Normalization', () => {
  describe('Basic Functionality', () => {
    it('should return raw amounts when no normalization is specified', async () => {
      const items = [createTestLineItem(2023, 1000)];

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const result = await callExecutionLineItemsResolver(resolvers, createTestEntity(), {
        filter: createBaseFilter(),
      });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.ytd_amount).toBe(1000);
    });

    it('should return raw amounts when normalization is "total"', async () => {
      const items = [createTestLineItem(2023, 1000)];

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const result = await callExecutionLineItemsResolver(resolvers, createTestEntity(), {
        filter: createBaseFilter(),
        normalization: 'total',
      });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.ytd_amount).toBe(1000);
    });

    it('should return empty result when no items', async () => {
      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo([]),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const result = await callExecutionLineItemsResolver(resolvers, createTestEntity(), {
        filter: createBaseFilter(),
      });

      expect(result.nodes).toHaveLength(0);
    });
  });

  describe('Per Capita Normalization', () => {
    it('should divide amounts by entity population for per_capita', async () => {
      const items = [createTestLineItem(2023, 10000, 1000)];
      const uat = createTestUAT(100, 1000); // Population of 1000

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(uat),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const entity = createTestEntity({ is_uat: true, uat_id: 100 });

      const result = await callExecutionLineItemsResolver(resolvers, entity, {
        filter: createBaseFilter(),
        normalization: 'per_capita',
      });

      expect(result.nodes).toHaveLength(1);
      // 10000 / 1000 = 10 per capita
      expect(result.nodes[0]!.ytd_amount).toBe(10);
      // 1000 / 1000 = 1 per capita
      expect(result.nodes[0]!.monthly_amount).toBe(1);
    });

    it('should handle per_capita for county council entities', async () => {
      const items = [createTestLineItem(2023, 100000, 10000)];
      const uat = createTestUAT(100, 5000);
      const countyPopulation = 50000;

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(uat, countyPopulation),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const entity = createTestEntity({
        is_uat: false,
        entity_type: 'admin_county_council',
        uat_id: 100,
      });

      const result = await callExecutionLineItemsResolver(resolvers, entity, {
        filter: createBaseFilter(),
        normalization: 'per_capita',
      });

      expect(result.nodes).toHaveLength(1);
      // 100000 / 50000 = 2 per capita
      expect(result.nodes[0]!.ytd_amount).toBe(2);
    });

    it('should return raw amounts for entities without population', async () => {
      const items = [createTestLineItem(2023, 1000)];

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      // Ministry - no UAT, so no population
      const entity = createTestEntity({
        is_uat: false,
        entity_type: 'ministry',
        uat_id: null,
      });

      const result = await callExecutionLineItemsResolver(resolvers, entity, {
        filter: createBaseFilter(),
        normalization: 'per_capita',
      });

      expect(result.nodes).toHaveLength(1);
      // Without population, amounts are not divided
      expect(result.nodes[0]!.ytd_amount).toBe(1000);
    });
  });

  describe('Currency Conversion', () => {
    it('should convert to EUR for total_euro normalization', async () => {
      const items = [createTestLineItem(2023, 500, 100)];

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const result = await callExecutionLineItemsResolver(resolvers, createTestEntity(), {
        filter: createBaseFilter(),
        normalization: 'total_euro',
      });

      expect(result.nodes).toHaveLength(1);
      // 500 RON / 5 = 100 EUR
      expect(result.nodes[0]!.ytd_amount).toBe(100);
      // 100 RON / 5 = 20 EUR
      expect(result.nodes[0]!.monthly_amount).toBe(20);
    });

    it('should convert to EUR and divide by population for per_capita_euro', async () => {
      const items = [createTestLineItem(2023, 500, 100)];
      const uat = createTestUAT(100, 100); // Population of 100

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(uat),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const entity = createTestEntity({ is_uat: true, uat_id: 100 });

      const result = await callExecutionLineItemsResolver(resolvers, entity, {
        filter: createBaseFilter(),
        normalization: 'per_capita_euro',
      });

      expect(result.nodes).toHaveLength(1);
      // 500 RON / 5 = 100 EUR, 100 EUR / 100 population = 1 EUR per capita
      expect(result.nodes[0]!.ytd_amount).toBe(1);
      // 100 RON / 5 = 20 EUR, 20 EUR / 100 population = 0.2 EUR per capita
      expect(result.nodes[0]!.monthly_amount).toBe(0.2);
    });
  });

  describe('Backwards Compatibility - Normalization in Filter', () => {
    it('should read normalization from filter when not at root level', async () => {
      const items = [createTestLineItem(2023, 500, 100)];

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const result = await callExecutionLineItemsResolver(resolvers, createTestEntity(), {
        filter: {
          ...createBaseFilter(),
          normalization: 'total_euro', // Inside filter
        },
        // No normalization at root level
      });

      expect(result.nodes).toHaveLength(1);
      // 500 RON / 5 = 100 EUR
      expect(result.nodes[0]!.ytd_amount).toBe(100);
    });

    it('should prefer root level normalization over filter', async () => {
      const items = [createTestLineItem(2023, 500, 100)];

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const result = await callExecutionLineItemsResolver(resolvers, createTestEntity(), {
        filter: {
          ...createBaseFilter(),
          normalization: 'total_euro', // Inside filter - would be EUR
        },
        normalization: 'total', // Root level - should take precedence, RON
      });

      expect(result.nodes).toHaveLength(1);
      // Root level 'total' takes precedence, so RON total
      expect(result.nodes[0]!.ytd_amount).toBe(500);
    });
  });

  describe('Multiple Line Items', () => {
    it('should normalize all line items in the result', async () => {
      const items = [
        createTestLineItem(2023, 1000, 100),
        createTestLineItem(2023, 2000, 200),
        createTestLineItem(2023, 3000, 300),
      ];

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const result = await callExecutionLineItemsResolver(resolvers, createTestEntity(), {
        filter: createBaseFilter(),
        normalization: 'total_euro',
      });

      expect(result.nodes).toHaveLength(3);
      // Each item should be converted: RON / 5 = EUR
      expect(result.nodes[0]!.ytd_amount).toBe(200); // 1000 / 5
      expect(result.nodes[1]!.ytd_amount).toBe(400); // 2000 / 5
      expect(result.nodes[2]!.ytd_amount).toBe(600); // 3000 / 5
    });
  });

  describe('Quarterly Amount Normalization', () => {
    it('should normalize quarterly_amount when present', async () => {
      const items = [createTestLineItem(2023, 1000, 100)];
      // quarterly_amount is 1000 / 4 = 250

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const result = await callExecutionLineItemsResolver(resolvers, createTestEntity(), {
        filter: createBaseFilter(),
        normalization: 'total_euro',
      });

      expect(result.nodes).toHaveLength(1);
      // quarterly_amount = 250 RON / 5 = 50 EUR
      expect(result.nodes[0]!.quarterly_amount).toBe(50);
    });

    it('should handle null quarterly_amount', async () => {
      const item = createTestLineItem(2023, 1000, 100);
      item.quarterly_amount = null;

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo([item]),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const result = await callExecutionLineItemsResolver(resolvers, createTestEntity(), {
        filter: createBaseFilter(),
        normalization: 'total_euro',
      });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.quarterly_amount).toBeNull();
    });
  });

  describe('Error Handling', () => {
    it('should return empty result when report_period is missing', async () => {
      const items = [createTestLineItem(2023, 1000)];

      const resolvers = makeEntityResolvers({
        entityRepo: createFakeEntityRepo(),
        uatRepo: createFakeUATRepo(),
        reportRepo: createFakeReportRepo(),
        executionLineItemRepo: createFakeLineItemRepo(items),
        entityAnalyticsSummaryRepo: createFakeAnalyticsSummaryRepo(),
        normalizationService: createFakeNormalizationService(),
        budgetSectorRepo: createFakeBudgetSectorRepo(),
      });

      const result = await callExecutionLineItemsResolver(resolvers, createTestEntity(), {
        filter: {
          account_category: 'ch',
          // Missing report_period
        },
      });

      expect(result.nodes).toHaveLength(0);
      expect(result.pageInfo.totalCount).toBe(0);
    });
  });
});
