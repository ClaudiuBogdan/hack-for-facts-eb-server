/**
 * MCP Module - Public API
 *
 * Provides Model Context Protocol integration for AI-powered budget analysis.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  SupportedLanguage,
  FilterCategory,
  FilterKey,
  Granularity,
  AxisUnit,
  ValueUnit,
  McpNormalizationMode,
  BudgetBreakdownLevel,
  ClassificationDimension,
  HierarchyRootDepth,
  McpToolResult,
  DataPoint,
  SeriesStatistics,
  AxisDefinition,
  TimeseriesResult,
  FilterSearchResult,
  GroupedBudgetItem,
  EntityRankingRow,
  PageInfo,
  McpSession,
  McpConfig,
} from './core/types.js';

export {
  DEFAULT_LANGUAGE,
  MAX_TIMESERIES_SERIES,
  MAX_RANKING_LIMIT,
  DEFAULT_RANKING_LIMIT,
  MAX_FILTER_LIMIT,
  DEFAULT_FILTER_LIMIT,
  BEST_MATCH_THRESHOLD,
  DEFAULT_MCP_CONFIG,
} from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Errors
// ─────────────────────────────────────────────────────────────────────────────

export type { McpError, McpErrorCode, DomainError, DomainErrorType } from './core/errors.js';

export {
  MCP_ERROR_CODES,
  createMcpError,
  entityNotFoundError,
  entitySearchNotFoundError,
  uatNotFoundError,
  classificationNotFoundError,
  invalidPeriodError,
  invalidFilterError,
  invalidCategoryError,
  invalidInputError,
  databaseError,
  timeoutError,
  shareLinkError,
  unauthorizedError,
  rateLimitExceededError,
  sessionNotFoundError,
  sessionExpiredError,
  internalError,
  toMcpError,
  failedResult,
  successResult,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Ports
// ─────────────────────────────────────────────────────────────────────────────

export type {
  McpSessionStore,
  McpRateLimiter,
  McpLinkBuilder,
  McpToolDeps,
  McpInfraDeps,
  McpLogger,
  YearlySnapshotTotals,
  McpExecutionRepo,
} from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Adapter
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

  // Common schemas
  LanguageSchema,
  GranularitySchema,
  PeriodIntervalSchema,
  PeriodSelectionSchema,
  PeriodInputSchema,
  AccountCategorySchema,
  NormalizationModeSchema,
  ExpenseTypeSchema,
  ExcludeFilterSchema,
  AnalyticsFilterSchema,
  SeriesDefinitionSchema,
  SortDirectionSchema,
  SortSchema,
  PaginationSchema,
  PageInfoSchema,
  ClassificationDimensionSchema,
  HierarchyRootDepthSchema,
  FilterCategorySchema,

  // Tool schemas
  GetEntitySnapshotInputSchema,
  GetEntitySnapshotOutputSchema,
  DiscoverFiltersInputSchema,
  DiscoverFiltersOutputSchema,
  FilterResultSchema,
  RankEntitiesInputSchema,
  RankEntitiesOutputSchema,
  EntityRankingRowSchema,
  QueryTimeseriesInputSchema,
  QueryTimeseriesOutputSchema,
  AnalyzeEntityBudgetInputSchema,
  AnalyzeEntityBudgetOutputSchema,
  ExploreBudgetBreakdownInputSchema,
  ExploreBudgetBreakdownOutputSchema,
  ErrorOutputSchema,
} from './core/schemas/index.js';

// Schema types
export type {
  Language,
  PeriodInterval,
  PeriodSelection,
  PeriodInput,
  AccountCategory,
  NormalizationMode,
  ExpenseType,
  ExcludeFilter,
  AnalyticsFilter,
  SeriesDefinition,
  SortDirection,
  Sort,
  Pagination,
  PageInfoOutput,
  GetEntitySnapshotInput,
  GetEntitySnapshotOutput,
  DiscoverFiltersInput,
  DiscoverFiltersOutput,
  FilterResult,
  RankEntitiesInput,
  RankEntitiesOutput,
  QueryTimeseriesInput,
  QueryTimeseriesOutput,
  AnalyzeEntityBudgetInput,
  AnalyzeEntityBudgetOutput,
  ExploreBudgetBreakdownInput,
  ExploreBudgetBreakdownOutput,
  ErrorOutput,
} from './core/schemas/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export {
  getEntitySnapshot,
  type GetEntitySnapshotDeps,
} from './core/usecases/get-entity-snapshot.js';

export { discoverFilters, type DiscoverFiltersDeps } from './core/usecases/discover-filters.js';

export { rankEntities, type RankEntitiesDeps } from './core/usecases/rank-entities.js';

export { queryTimeseries, type QueryTimeseriesDeps } from './core/usecases/query-timeseries.js';

export {
  analyzeEntityBudget,
  type AnalyzeEntityBudgetDeps,
} from './core/usecases/analyze-entity-budget.js';

export {
  exploreBudgetBreakdown,
  type ExploreBudgetBreakdownDeps,
} from './core/usecases/explore-budget-breakdown.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Utilities
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Classification code normalization
  normalizeClassificationCode,
  normalizeClassificationCodes,
  normalizeFilterClassificationCodes,

  // Period validation
  validatePeriodFormat,
  validatePeriods,
  validatePeriodInterval,
  validatePeriodSelection,

  // Number formatting
  formatCompact,
  formatStandard,
  formatAmountBilingual,

  // General utilities
  clamp,
  generatePeriodRange,
  synthesizeLabelFromFilter,
} from './core/utils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Session Store
// ─────────────────────────────────────────────────────────────────────────────

export {
  makeRedisSessionStore,
  makeInMemorySessionStore,
  type RedisSessionStoreOptions,
  type RedisClient,
} from './shell/session/redis-session-store.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - MCP Server
// ─────────────────────────────────────────────────────────────────────────────

export {
  createMcpServer,
  runMcpServerStdio,
  type CreateMcpServerDeps,
} from './shell/server/mcp-server.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Prompts
// ─────────────────────────────────────────────────────────────────────────────

export {
  ALL_PROMPTS,
  ENTITY_HEALTH_CHECK_PROMPT,
  PEER_COMPARISON_PROMPT,
  OUTLIER_DETECTION_PROMPT,
  TREND_TRACKING_PROMPT,
  DEEP_DIVE_PROMPT,
  EntityHealthCheckArgsSchema,
  PeerComparisonArgsSchema,
  OutlierDetectionArgsSchema,
  TrendTrackingArgsSchema,
  DeepDiveArgsSchema,
} from './shell/prompts/prompt-templates.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Repositories & Adapters
// ─────────────────────────────────────────────────────────────────────────────

export { makeMcpExecutionRepo } from './shell/repo/mcp-execution-repo.js';
export { makeMcpAnalyticsService } from './shell/service/mcp-analytics-service.js';
export {
  makeEntityAdapter,
  makeUatAdapter,
  makeFunctionalClassificationAdapter,
  makeEconomicClassificationAdapter,
  makeShareLinkAdapter,
  makeEntityAnalyticsAdapter,
  makeAggregatedLineItemsAdapter,
  type MakeShareLinkAdapterDeps,
} from './shell/adapters/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - HTTP Routes
// ─────────────────────────────────────────────────────────────────────────────

export { makeMcpRoutes, type MakeMcpRoutesDeps } from './shell/rest/routes.js';
