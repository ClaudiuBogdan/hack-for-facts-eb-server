/**
 * MCP Module - Tool Schemas
 *
 * TypeBox schemas for each MCP tool's input and output.
 */

import { Type, type Static } from '@sinclair/typebox';

import {
  PeriodInputSchema,
  AnalyticsFilterSchema,
  SeriesDefinitionSchema,
  SortSchema,
  PageInfoSchema,
  FilterCategorySchema,
  ClassificationDimensionSchema,
  HierarchyRootDepthSchema,
} from './common.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. get_entity_snapshot
// ─────────────────────────────────────────────────────────────────────────────

export const GetEntitySnapshotInputSchema = Type.Object(
  {
    entityCui: Type.Optional(
      Type.String({
        description: 'Entity CUI (fiscal identification code). Preferred over entitySearch.',
        examples: ['4305857'],
      })
    ),
    entitySearch: Type.Optional(
      Type.String({
        description: 'Entity name search. Used if entityCui is not provided.',
        examples: ['Municipiul Cluj-Napoca'],
      })
    ),
    year: Type.Number({
      description: 'Year for the snapshot (2016-current)',
      minimum: 2016,
      examples: [2023],
    }),
  },
  {
    description: 'Get a point-in-time financial overview for a single public entity.',
  }
);

export type GetEntitySnapshotInput = Static<typeof GetEntitySnapshotInputSchema>;

export const GetEntitySnapshotOutputSchema = Type.Object({
  ok: Type.Boolean(),
  kind: Type.Literal('entities.details'),
  query: Type.Object({
    cui: Type.String(),
    year: Type.Number(),
  }),
  link: Type.String({ description: 'Shareable URL to view details in the web interface' }),
  item: Type.Object({
    cui: Type.String(),
    name: Type.String(),
    address: Type.Union([Type.String(), Type.Null()]),
    totalIncome: Type.Number(),
    totalExpenses: Type.Number(),
    totalIncomeFormatted: Type.String({ description: 'Bilingual formatted income' }),
    totalExpensesFormatted: Type.String({ description: 'Bilingual formatted expenses' }),
    summary: Type.String({ description: 'AI-friendly summary of the financial situation' }),
  }),
});

export type GetEntitySnapshotOutput = Static<typeof GetEntitySnapshotOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 2. discover_filters
// ─────────────────────────────────────────────────────────────────────────────

export const DiscoverFiltersInputSchema = Type.Object(
  {
    category: FilterCategorySchema,
    query: Type.String({
      description: 'Search query in Romanian',
      minLength: 1,
      examples: ['Municipiul București', 'educație', 'salarii'],
    }),
    limit: Type.Optional(
      Type.Number({
        description: 'Maximum number of results',
        minimum: 1,
        maximum: 50,
        default: 3,
      })
    ),
  },
  {
    description:
      'Resolve Romanian names/terms to machine-usable filter values (CUI, UAT ID, classification codes).',
  }
);

export type DiscoverFiltersInput = Static<typeof DiscoverFiltersInputSchema>;

export const FilterResultSchema = Type.Object({
  name: Type.String({ description: 'Display name of the result' }),
  category: Type.String({ description: 'Category of the result' }),
  context: Type.Optional(Type.String({ description: 'Additional context (county, chapter)' })),
  score: Type.Number({ description: 'Relevance score 0-1' }),
  filterKey: Type.String({
    description: 'Filter parameter name to use (e.g., entity_cuis, functional_prefixes)',
  }),
  filterValue: Type.String({ description: 'Value to pass to the filter parameter' }),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'Category-specific metadata',
    })
  ),
});

export type FilterResult = Static<typeof FilterResultSchema>;

export const DiscoverFiltersOutputSchema = Type.Object({
  ok: Type.Boolean(),
  results: Type.Array(FilterResultSchema),
  bestMatch: Type.Optional(FilterResultSchema),
});

export type DiscoverFiltersOutput = Static<typeof DiscoverFiltersOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 3. query_timeseries_data
// ─────────────────────────────────────────────────────────────────────────────

export const QueryTimeseriesInputSchema = Type.Object(
  {
    title: Type.Optional(
      Type.String({
        description: 'Title for the chart',
      })
    ),
    description: Type.Optional(
      Type.String({
        description: 'Description for the chart',
      })
    ),
    period: PeriodInputSchema,
    series: Type.Array(SeriesDefinitionSchema, {
      description: 'Data series to query (1-10)',
      minItems: 1,
      maxItems: 10,
    }),
  },
  {
    description: 'Query multi-series time-series data for comparison and analysis.',
  }
);

export type QueryTimeseriesInput = Static<typeof QueryTimeseriesInputSchema>;

export const DataPointSchema = Type.Object({
  x: Type.String({ description: 'Period label (YYYY, YYYY-MM, or YYYY-QN)' }),
  y: Type.Number({ description: 'Value' }),
});

export const StatisticsSchema = Type.Object({
  min: Type.Number(),
  max: Type.Number(),
  avg: Type.Number(),
  sum: Type.Number(),
  count: Type.Number(),
});

export const AxisSchema = Type.Object({
  name: Type.String(),
  unit: Type.String(),
});

export const TimeseriesResultSchema = Type.Object({
  label: Type.String(),
  seriesId: Type.String(),
  xAxis: AxisSchema,
  yAxis: AxisSchema,
  dataPoints: Type.Array(DataPointSchema),
  statistics: StatisticsSchema,
});

export const QueryTimeseriesOutputSchema = Type.Object({
  ok: Type.Boolean(),
  title: Type.String(),
  dataLink: Type.String({ description: 'Shareable URL to interactive chart' }),
  dataSeries: Type.Array(TimeseriesResultSchema),
});

export type QueryTimeseriesOutput = Static<typeof QueryTimeseriesOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 4. analyze_entity_budget
// ─────────────────────────────────────────────────────────────────────────────

export const AnalyzeEntityBudgetInputSchema = Type.Object(
  {
    entityCui: Type.Optional(
      Type.String({
        description: 'Entity CUI',
      })
    ),
    entitySearch: Type.Optional(
      Type.String({
        description: 'Entity name search',
      })
    ),
    year: Type.Number({
      description: 'Year for analysis',
      minimum: 2016,
    }),
    breakdown_by: Type.Optional(
      Type.Union([Type.Literal('overview'), Type.Literal('functional'), Type.Literal('economic')], {
        description: 'Breakdown level: overview (top-level), functional (COFOG), economic',
        default: 'overview',
      })
    ),
    functionalCode: Type.Optional(
      Type.String({
        description: 'Functional code to drill into (required when breakdown_by=functional)',
      })
    ),
    economicCode: Type.Optional(
      Type.String({
        description: 'Economic code to drill into (required when breakdown_by=economic)',
      })
    ),
  },
  {
    description: 'Analyze a single entity budget with breakdown by classification.',
  }
);

export type AnalyzeEntityBudgetInput = Static<typeof AnalyzeEntityBudgetInputSchema>;

export const BudgetGroupSchema = Type.Object({
  code: Type.String(),
  name: Type.String(),
  amount: Type.Number(),
  percentage: Type.Number(),
  link: Type.Optional(Type.String()),
});

export const AnalyzeEntityBudgetOutputSchema = Type.Object({
  ok: Type.Boolean(),
  kind: Type.String(),
  query: Type.Object({
    cui: Type.String(),
    year: Type.Number(),
  }),
  link: Type.String(),
  item: Type.Object({
    cui: Type.String(),
    name: Type.String(),
    expenseGroups: Type.Array(BudgetGroupSchema),
    incomeGroups: Type.Array(BudgetGroupSchema),
    expenseGroupSummary: Type.Optional(Type.String()),
    incomeGroupSummary: Type.Optional(Type.String()),
  }),
});

export type AnalyzeEntityBudgetOutput = Static<typeof AnalyzeEntityBudgetOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 5. explore_budget_breakdown
// ─────────────────────────────────────────────────────────────────────────────

export const ExploreBudgetBreakdownInputSchema = Type.Object(
  {
    period: PeriodInputSchema,
    filter: AnalyticsFilterSchema,
    classification: Type.Optional(ClassificationDimensionSchema),
    path: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Drill-down path of classification codes',
      })
    ),
    rootDepth: Type.Optional(HierarchyRootDepthSchema),
    excludeEcCodes: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Economic codes to exclude from results',
      })
    ),
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 100,
        default: 20,
      })
    ),
    offset: Type.Optional(
      Type.Number({
        minimum: 0,
        default: 0,
      })
    ),
  },
  {
    description: 'Explore budget hierarchically with progressive drill-down.',
  }
);

export type ExploreBudgetBreakdownInput = Static<typeof ExploreBudgetBreakdownInputSchema>;

export const GroupedItemSchema = Type.Object({
  code: Type.String(),
  name: Type.String(),
  value: Type.Number(),
  count: Type.Number(),
  isLeaf: Type.Boolean(),
  percentage: Type.Number(),
  humanSummary: Type.Optional(Type.String()),
  link: Type.Optional(Type.String()),
});

export const ExploreBudgetBreakdownOutputSchema = Type.Object({
  ok: Type.Boolean(),
  link: Type.String(),
  item: Type.Object({
    expenseGroups: Type.Optional(Type.Array(GroupedItemSchema)),
    incomeGroups: Type.Optional(Type.Array(GroupedItemSchema)),
    expenseGroupSummary: Type.Optional(Type.String()),
    incomeGroupSummary: Type.Optional(Type.String()),
  }),
});

export type ExploreBudgetBreakdownOutput = Static<typeof ExploreBudgetBreakdownOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// 6. rank_entities
// ─────────────────────────────────────────────────────────────────────────────

export const RankEntitiesInputSchema = Type.Object(
  {
    period: PeriodInputSchema,
    filter: AnalyticsFilterSchema,
    sort: Type.Optional(SortSchema),
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 500,
        default: 50,
      })
    ),
    offset: Type.Optional(
      Type.Number({
        minimum: 0,
        default: 0,
      })
    ),
  },
  {
    description: 'Rank entities by budget metrics with filtering and pagination.',
  }
);

export type RankEntitiesInput = Static<typeof RankEntitiesInputSchema>;

export const EntityRankingRowSchema = Type.Object({
  entity_cui: Type.String(),
  entity_name: Type.String(),
  entity_type: Type.Union([Type.String(), Type.Null()]),
  uat_id: Type.Union([Type.Number(), Type.Null()]),
  county_code: Type.Union([Type.String(), Type.Null()]),
  county_name: Type.Union([Type.String(), Type.Null()]),
  population: Type.Union([Type.Number(), Type.Null()]),
  amount: Type.Number({ description: 'Normalized amount based on filter' }),
  total_amount: Type.Number({ description: 'Raw RON amount' }),
  per_capita_amount: Type.Number({ description: 'Per capita amount in RON' }),
});

export const RankEntitiesOutputSchema = Type.Object({
  ok: Type.Boolean(),
  link: Type.String(),
  entities: Type.Array(EntityRankingRowSchema),
  pageInfo: PageInfoSchema,
});

export type RankEntitiesOutput = Static<typeof RankEntitiesOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Error Output Schema
// ─────────────────────────────────────────────────────────────────────────────

export const ErrorOutputSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
});

export type ErrorOutput = Static<typeof ErrorOutputSchema>;
