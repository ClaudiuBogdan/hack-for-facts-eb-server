/**
 * MCP Module - Schemas Index
 *
 * Barrel export for all TypeBox schemas and the JSON Schema adapter.
 */

// Adapter
export {
  toJsonSchema,
  createToolDefinition,
  createResourceDefinition,
  createPromptDefinition,
  type McpToolDefinition,
  type McpToolAnnotations,
  type McpResourceDefinition,
  type McpPromptDefinition,
  type McpPromptArgument,
  type InferInput,
} from './adapter.js';

// Common schemas
export {
  // Language
  LanguageSchema,
  type Language,

  // Period
  GranularitySchema,
  type Granularity,
  PeriodIntervalSchema,
  type PeriodInterval,
  PeriodSelectionSchema,
  type PeriodSelection,
  PeriodInputSchema,
  type PeriodInput,

  // Account category
  AccountCategorySchema,
  type AccountCategory,

  // Normalization
  NormalizationModeSchema,
  type NormalizationMode,

  // Expense type
  ExpenseTypeSchema,
  type ExpenseType,

  // Filters
  ExcludeFilterSchema,
  type ExcludeFilter,
  AnalyticsFilterSchema,
  type AnalyticsFilter,

  // Series
  SeriesDefinitionSchema,
  type SeriesDefinition,

  // Sort
  SortDirectionSchema,
  type SortDirection,
  SortSchema,
  type Sort,

  // Pagination
  PaginationSchema,
  type Pagination,
  PageInfoSchema,
  type PageInfoOutput,

  // Classification
  ClassificationDimensionSchema,
  type ClassificationDimension,
  HierarchyRootDepthSchema,
  type HierarchyRootDepth,
  FilterCategorySchema,
  type FilterCategory,
} from './common.js';

// Tool schemas
export {
  // get_entity_snapshot
  GetEntitySnapshotInputSchema,
  GetEntitySnapshotOutputSchema,
  type GetEntitySnapshotInput,
  type GetEntitySnapshotOutput,

  // discover_filters
  DiscoverFiltersInputSchema,
  DiscoverFiltersOutputSchema,
  FilterResultSchema,
  type DiscoverFiltersInput,
  type DiscoverFiltersOutput,
  type FilterResult,

  // query_timeseries_data
  QueryTimeseriesInputSchema,
  QueryTimeseriesOutputSchema,
  DataPointSchema,
  StatisticsSchema,
  AxisSchema,
  TimeseriesResultSchema,
  type QueryTimeseriesInput,
  type QueryTimeseriesOutput,

  // analyze_entity_budget
  AnalyzeEntityBudgetInputSchema,
  AnalyzeEntityBudgetOutputSchema,
  BudgetGroupSchema,
  type AnalyzeEntityBudgetInput,
  type AnalyzeEntityBudgetOutput,

  // explore_budget_breakdown
  ExploreBudgetBreakdownInputSchema,
  ExploreBudgetBreakdownOutputSchema,
  GroupedItemSchema,
  type ExploreBudgetBreakdownInput,
  type ExploreBudgetBreakdownOutput,

  // rank_entities
  RankEntitiesInputSchema,
  RankEntitiesOutputSchema,
  EntityRankingRowSchema,
  type RankEntitiesInput,
  type RankEntitiesOutput,

  // Error
  ErrorOutputSchema,
  type ErrorOutput,
} from './tools.js';
