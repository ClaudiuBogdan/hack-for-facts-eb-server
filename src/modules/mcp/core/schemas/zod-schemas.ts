/**
 * MCP Module - Zod Schemas
 *
 * Zod schemas required by the MCP SDK for tool input validation.
 * These are equivalent to the TypeBox schemas in tools.ts but use Zod syntax.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Common Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Granularity for time periods */
const GranularitySchema = z.enum(['YEAR', 'MONTH', 'QUARTER']).describe('Time granularity');

/** Period interval with start and end */
const PeriodIntervalSchema = z.object({
  start: z
    .string()
    .describe('Start period (YYYY for YEAR, YYYY-MM for MONTH, YYYY-QN for QUARTER)'),
  end: z.string().describe('End period (YYYY for YEAR, YYYY-MM for MONTH, YYYY-QN for QUARTER)'),
});

/** Period selection: either an interval or explicit dates */
const PeriodSelectionSchema = z.union([
  z.object({ interval: PeriodIntervalSchema }),
  z.object({
    dates: z.array(z.string()).min(1).describe('Explicit list of periods'),
  }),
]);

/** Period input with type and selection - includes validation for date format matching period type */
const PeriodInputSchema = z
  .object({
    type: GranularitySchema,
    selection: PeriodSelectionSchema,
  })
  .refine(
    (period) => {
      const patterns = {
        YEAR: /^\d{4}$/,
        MONTH: /^\d{4}-\d{2}$/,
        QUARTER: /^\d{4}-Q[1-4]$/,
      };
      const pattern = patterns[period.type];

      if ('interval' in period.selection) {
        const { start, end } = period.selection.interval;
        return pattern.test(start) && pattern.test(end);
      }

      if ('dates' in period.selection) {
        return period.selection.dates.every((date) => pattern.test(date));
      }

      return false;
    },
    {
      message:
        'Date format must match period type (YEAR: "2023", MONTH: "2023-01", QUARTER: "2023-Q1")',
    }
  );

/** Account category: expenses or income */
const AccountCategorySchema = z
  .enum(['ch', 'vn'])
  .describe('ch (cheltuieli/expenses) or vn (venituri/income)');

/** Normalization mode for amounts */
const NormalizationModeSchema = z
  .enum(['total', 'per_capita', 'total_euro', 'per_capita_euro'])
  .describe('total, per_capita, total_euro, or per_capita_euro')
  .default('total');

/** Expense type filter */
const ExpenseTypeSchema = z
  .enum(['dezvoltare', 'functionare'])
  .describe('dezvoltare (development) or functionare (operating)');

/** Exclusion filters */
const ExcludeFilterSchema = z.object({
  entity_cuis: z.array(z.string()).optional(),
  uat_ids: z.array(z.string()).optional(),
  county_codes: z.array(z.string()).optional(),
  functional_codes: z.array(z.string()).optional(),
  functional_prefixes: z.array(z.string()).optional(),
  economic_codes: z.array(z.string()).optional(),
  economic_prefixes: z.array(z.string()).optional(),
});

/** Analytics filter for querying budget data */
const AnalyticsFilterSchema = z.object({
  // Required
  accountCategory: AccountCategorySchema,

  // Entity scope
  entityCuis: z.array(z.string()).describe('Filter by entity CUI codes').optional(),
  uatIds: z.array(z.string()).describe('Filter by UAT IDs').optional(),
  countyCodes: z.array(z.string()).describe('Filter by county codes (e.g., "CJ", "B")').optional(),
  regions: z.array(z.string()).describe('Filter by development regions').optional(),
  isUat: z.boolean().describe('Filter to only UAT entities (true) or non-UAT (false)').optional(),

  // Population constraints
  minPopulation: z.number().describe('Minimum population threshold').optional(),
  maxPopulation: z.number().describe('Maximum population threshold').optional(),

  // Classification filters
  functionalCodes: z
    .array(z.string())
    .describe('Filter by exact functional classification codes (COFOG)')
    .optional(),
  functionalPrefixes: z
    .array(z.string())
    .describe('Filter by functional classification prefixes (e.g., "65." for health)')
    .optional(),
  economicCodes: z
    .array(z.string())
    .describe('Filter by exact economic classification codes')
    .optional(),
  economicPrefixes: z
    .array(z.string())
    .describe('Filter by economic classification prefixes')
    .optional(),

  // Other filters
  fundingSourceIds: z.array(z.number()).optional(),
  budgetSectorIds: z.array(z.number()).optional(),
  expenseTypes: z.array(ExpenseTypeSchema).optional(),
  programCodes: z.array(z.string()).optional(),

  // Normalization
  normalization: NormalizationModeSchema.optional(),

  // Report type
  reportType: z
    .string()
    .describe('Report type: PRINCIPAL_AGGREGATED (default), SECONDARY_AGGREGATED, or DETAILED')
    .default('PRINCIPAL_AGGREGATED')
    .optional(),

  // Exclusions
  exclude: ExcludeFilterSchema.optional(),
});

/** Series definition for timeseries queries */
const SeriesDefinitionSchema = z.object({
  label: z.string().describe('Custom label for the series').optional(),
  filter: AnalyticsFilterSchema,
});

/** Sort direction */
const SortDirectionSchema = z.enum(['ASC', 'DESC']).default('DESC');

/** Sort configuration */
const SortSchema = z.object({
  by: z.string().describe('Field to sort by (e.g., amount, per_capita_amount, entity_name)'),
  order: SortDirectionSchema.optional(),
});

/** Classification dimension */
const ClassificationDimensionSchema = z
  .enum(['fn', 'ec'])
  .describe('fn (functional/COFOG) or ec (economic)')
  .default('fn');

/** Hierarchy root depth */
const HierarchyRootDepthSchema = z
  .enum(['chapter', 'subchapter', 'paragraph'])
  .describe('Starting depth for hierarchy exploration')
  .default('chapter');

/** Filter category for discovery */
const FilterCategorySchema = z.enum([
  'entity',
  'uat',
  'functional_classification',
  'economic_classification',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Tool Input Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * get_entity_snapshot - Get financial overview for a single entity
 */
export const GetEntitySnapshotInputZod = z.object({
  entityCui: z
    .string()
    .describe('Entity CUI (fiscal identification code). Preferred over entitySearch.')
    .optional(),
  entitySearch: z
    .string()
    .describe('Entity name search. Used if entityCui is not provided.')
    .optional(),
  year: z.number().min(2016).describe('Year for the snapshot (2016-current)'),
});

export type GetEntitySnapshotInputZodType = z.infer<typeof GetEntitySnapshotInputZod>;

/**
 * discover_filters - Resolve Romanian names to filter values
 */
export const DiscoverFiltersInputZod = z.object({
  category: FilterCategorySchema.describe('Category to search for filter values'),
  query: z.string().min(1).describe('Search query in Romanian'),
  limit: z.number().min(1).max(50).default(3).describe('Maximum number of results').optional(),
});

export type DiscoverFiltersInputZodType = z.infer<typeof DiscoverFiltersInputZod>;

/**
 * query_timeseries_data - Query multi-series time-series data
 */
export const QueryTimeseriesInputZod = z.object({
  title: z.string().describe('Title for the chart').optional(),
  description: z.string().describe('Description for the chart').optional(),
  period: PeriodInputSchema.describe('Time period specification'),
  series: z.array(SeriesDefinitionSchema).min(1).max(10).describe('Data series to query (1-10)'),
});

export type QueryTimeseriesInputZodType = z.infer<typeof QueryTimeseriesInputZod>;

/**
 * rank_entities - Rank entities by budget metrics
 */
export const RankEntitiesInputZod = z.object({
  period: PeriodInputSchema.describe('Time period specification'),
  filter: AnalyticsFilterSchema.describe('Analytics filter'),
  sort: SortSchema.describe('Sort configuration').optional(),
  limit: z.number().min(1).max(500).default(50).describe('Maximum results').optional(),
  offset: z.number().min(0).default(0).describe('Number of results to skip').optional(),
});

export type RankEntitiesInputZodType = z.infer<typeof RankEntitiesInputZod>;

/**
 * analyze_entity_budget - Analyze entity budget by classification
 */
export const AnalyzeEntityBudgetInputZod = z.object({
  entityCui: z.string().describe('Entity CUI').optional(),
  entitySearch: z.string().describe('Entity name search').optional(),
  year: z.number().min(2016).describe('Year for analysis'),
  breakdown_by: z
    .enum(['overview', 'functional', 'economic'])
    .describe('Breakdown level')
    .default('overview')
    .optional(),
  functionalCode: z
    .string()
    .describe('Functional code to drill into (required when breakdown_by=functional)')
    .optional(),
  economicCode: z
    .string()
    .describe('Economic code to drill into (required when breakdown_by=economic)')
    .optional(),
});

export type AnalyzeEntityBudgetInputZodType = z.infer<typeof AnalyzeEntityBudgetInputZod>;

/**
 * explore_budget_breakdown - Explore budget hierarchically
 */
export const ExploreBudgetBreakdownInputZod = z.object({
  period: PeriodInputSchema.describe('Time period specification'),
  filter: AnalyticsFilterSchema.describe('Analytics filter'),
  classification: ClassificationDimensionSchema.optional(),
  path: z.array(z.string()).describe('Drill-down path of classification codes').optional(),
  rootDepth: HierarchyRootDepthSchema.optional(),
  excludeEcCodes: z.array(z.string()).describe('Economic codes to exclude').optional(),
  limit: z.number().min(1).max(100).default(20).optional(),
  offset: z.number().min(0).default(0).optional(),
});

export type ExploreBudgetBreakdownInputZodType = z.infer<typeof ExploreBudgetBreakdownInputZod>;

// ─────────────────────────────────────────────────────────────────────────────
// Output Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Common error output schema
 */
export const ErrorOutputZod = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export type ErrorOutputZodType = z.infer<typeof ErrorOutputZod>;

/**
 * get_entity_snapshot output
 */
export const GetEntitySnapshotOutputZod = z.object({
  ok: z.boolean(),
  kind: z.string().optional(),
  query: z.object({ cui: z.string(), year: z.number() }).optional(),
  link: z.string().optional(),
  item: z
    .object({
      cui: z.string(),
      name: z.string(),
      address: z.string().nullable(),
      totalIncome: z.number(),
      totalExpenses: z.number(),
      totalIncomeFormatted: z.string(),
      totalExpensesFormatted: z.string(),
      summary: z.string(),
    })
    .optional(),
  error: z.string().optional(),
});

export type GetEntitySnapshotOutputZodType = z.infer<typeof GetEntitySnapshotOutputZod>;

/**
 * discover_filters output
 */
export const DiscoverFiltersOutputZod = z.object({
  ok: z.boolean(),
  results: z.array(
    z.object({
      name: z.string(),
      category: z.enum(['entity', 'uat', 'functional_classification', 'economic_classification']),
      context: z.string().optional(),
      score: z.number(),
      filterKey: z.enum([
        'entity_cuis',
        'uat_ids',
        'functional_prefixes',
        'functional_codes',
        'economic_prefixes',
        'economic_codes',
      ]),
      filterValue: z.string(),
      metadata: z.any().optional(),
    })
  ),
  bestMatch: z
    .object({
      name: z.string(),
      category: z.enum(['entity', 'uat', 'functional_classification', 'economic_classification']),
      context: z.string().optional(),
      score: z.number(),
      filterKey: z.enum([
        'entity_cuis',
        'uat_ids',
        'functional_prefixes',
        'functional_codes',
        'economic_prefixes',
        'economic_codes',
      ]),
      filterValue: z.string(),
      metadata: z.any().optional(),
    })
    .optional(),
  totalMatches: z.number().optional(),
  error: z.string().optional(),
});

export type DiscoverFiltersOutputZodType = z.infer<typeof DiscoverFiltersOutputZod>;

/**
 * query_timeseries_data output
 */
export const QueryTimeseriesOutputZod = z.object({
  ok: z.boolean(),
  dataLink: z.string(),
  title: z.string(),
  dataSeries: z.array(
    z.object({
      label: z.string(),
      seriesId: z.string(),
      xAxis: z.object({ name: z.string(), unit: z.enum(['year', 'month', 'quarter']) }),
      yAxis: z.object({
        name: z.string(),
        unit: z.enum(['RON', 'RON/capita', 'EUR', 'EUR/capita']),
      }),
      dataPoints: z.array(z.object({ x: z.string(), y: z.number() })),
      statistics: z.object({
        min: z.number(),
        max: z.number(),
        avg: z.number(),
        sum: z.number(),
        count: z.number(),
      }),
    })
  ),
  error: z.string().optional(),
});

export type QueryTimeseriesOutputZodType = z.infer<typeof QueryTimeseriesOutputZod>;

/**
 * rank_entities output
 */
export const RankEntitiesOutputZod = z.object({
  ok: z.boolean(),
  link: z.string(),
  entities: z.array(
    z.object({
      entity_cui: z.string(),
      entity_name: z.string(),
      entity_type: z.string().nullable(),
      uat_id: z.number().nullable(),
      county_code: z.string().nullable(),
      county_name: z.string().nullable(),
      population: z.number().nullable(),
      amount: z.number(),
      total_amount: z.number(),
      per_capita_amount: z.number(),
    })
  ),
  pageInfo: z.object({
    totalCount: z.number(),
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
  }),
  error: z.string().optional(),
});

export type RankEntitiesOutputZodType = z.infer<typeof RankEntitiesOutputZod>;

/**
 * analyze_entity_budget output
 */
export const AnalyzeEntityBudgetOutputZod = z.object({
  ok: z.boolean(),
  kind: z.string(),
  query: z.object({ cui: z.string(), year: z.number() }),
  link: z.string(),
  item: z.object({
    cui: z.string(),
    name: z.string(),
    expenseGroups: z.array(z.any()),
    incomeGroups: z.array(z.any()),
    expenseGroupSummary: z.string().optional(),
    incomeGroupSummary: z.string().optional(),
  }),
  error: z.string().optional(),
});

export type AnalyzeEntityBudgetOutputZodType = z.infer<typeof AnalyzeEntityBudgetOutputZod>;

/**
 * explore_budget_breakdown output
 */
export const ExploreBudgetBreakdownOutputZod = z.object({
  ok: z.boolean(),
  link: z.string(),
  item: z.object({
    expenseGroups: z
      .array(
        z.object({
          code: z.string(),
          name: z.string(),
          value: z.number(),
          count: z.number(),
          isLeaf: z.boolean(),
          percentage: z.number(),
          humanSummary: z.string().optional(),
          link: z.string().optional(),
        })
      )
      .optional(),
    incomeGroups: z
      .array(
        z.object({
          code: z.string(),
          name: z.string(),
          value: z.number(),
          count: z.number(),
          isLeaf: z.boolean(),
          percentage: z.number(),
          humanSummary: z.string().optional(),
          link: z.string().optional(),
        })
      )
      .optional(),
    expenseGroupSummary: z.string().optional(),
    incomeGroupSummary: z.string().optional(),
  }),
  error: z.string().optional(),
});

export type ExploreBudgetBreakdownOutputZodType = z.infer<typeof ExploreBudgetBreakdownOutputZod>;
