/**
 * MCP Module - Core Types
 *
 * Domain types specific to the MCP module.
 * These types are used across use cases, schemas, and the shell layer.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Language Support
// ─────────────────────────────────────────────────────────────────────────────

/** Supported languages for resources and prompts */
export type SupportedLanguage = 'ro' | 'en';

/** Default language */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'ro';

// ─────────────────────────────────────────────────────────────────────────────
// Filter Categories
// ─────────────────────────────────────────────────────────────────────────────

/** Categories for filter discovery */
export type FilterCategory =
  | 'entity'
  | 'uat'
  | 'functional_classification'
  | 'economic_classification';

/** Filter keys that can be used in analytics queries */
export type FilterKey =
  | 'entity_cuis'
  | 'uat_ids'
  | 'functional_prefixes'
  | 'functional_codes'
  | 'economic_prefixes'
  | 'economic_codes';

// ─────────────────────────────────────────────────────────────────────────────
// Period Types
// ─────────────────────────────────────────────────────────────────────────────

/** Granularity for time-series data */
export type Granularity = 'YEAR' | 'MONTH' | 'QUARTER';

/** Axis unit derived from granularity */
export type AxisUnit = 'year' | 'month' | 'quarter';

/** Value unit based on normalization */
export type ValueUnit = 'RON' | 'RON/capita' | 'EUR' | 'EUR/capita';

// ─────────────────────────────────────────────────────────────────────────────
// Normalization
// ─────────────────────────────────────────────────────────────────────────────

/** Normalization modes supported by MCP tools */
export type McpNormalizationMode = 'total' | 'per_capita' | 'total_euro' | 'per_capita_euro';

// ─────────────────────────────────────────────────────────────────────────────
// Budget Analysis
// ─────────────────────────────────────────────────────────────────────────────

/** Budget breakdown level */
export type BudgetBreakdownLevel = 'overview' | 'functional' | 'economic';

/** Classification dimension for hierarchical exploration */
export type ClassificationDimension = 'fn' | 'ec';

/** Root depth for hierarchy exploration */
export type HierarchyRootDepth = 'chapter' | 'subchapter' | 'paragraph';

// ─────────────────────────────────────────────────────────────────────────────
// Tool Output Types
// ─────────────────────────────────────────────────────────────────────────────

/** Base result for all MCP tool responses */
export interface McpToolResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

/** Data point for time series */
export interface DataPoint {
  x: string;
  y: number;
}

/** Statistics for a data series */
export interface SeriesStatistics {
  min: number;
  max: number;
  avg: number;
  sum: number;
  count: number;
}

/** Axis definition for charts */
export interface AxisDefinition {
  name: string;
  unit: AxisUnit | ValueUnit;
}

/** Single series result from timeseries query */
export interface TimeseriesResult {
  label: string;
  seriesId: string;
  xAxis: AxisDefinition;
  yAxis: AxisDefinition;
  dataPoints: DataPoint[];
  statistics: SeriesStatistics;
}

/** Filter search result item */
export interface FilterSearchResult {
  name: string;
  category: FilterCategory;
  context?: string;
  score: number;
  filterKey: FilterKey;
  filterValue: string;
  metadata?: Record<string, unknown>;
}

/** Grouped budget item for hierarchy exploration */
export interface GroupedBudgetItem {
  code: string;
  name: string;
  value: number;
  count: number;
  isLeaf: boolean;
  percentage: number;
  humanSummary?: string;
  link?: string;
}

/** Entity ranking row */
export interface EntityRankingRow {
  entity_cui: string;
  entity_name: string;
  entity_type: string | null;
  uat_id: number | null;
  county_code: string | null;
  county_name: string | null;
  population: number | null;
  amount: number;
  total_amount: number;
  per_capita_amount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

/** Page info for paginated results */
export interface PageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session
// ─────────────────────────────────────────────────────────────────────────────

/** MCP session data stored in Redis */
export interface McpSession {
  id: string;
  createdAt: number;
  lastAccessedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** MCP module configuration */
export interface McpConfig {
  /** Require authentication for MCP endpoints */
  authRequired: boolean;
  /** Static API key for simple authentication */
  apiKey?: string;
  /** Allow JWT tokens from auth module */
  allowJwt: boolean;
  /** Session TTL in seconds */
  sessionTtlSeconds: number;
  /** Rate limit window in milliseconds */
  rateLimitWindowMs: number;
  /** Max requests per rate limit window */
  rateLimitMaxRequests: number;
  /** Base URL for client shareable links */
  clientBaseUrl: string;
}

/** Default MCP configuration */
export const DEFAULT_MCP_CONFIG: McpConfig = {
  authRequired: false,
  allowJwt: true,
  sessionTtlSeconds: 3600,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 60,
  clientBaseUrl: '',
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum series allowed in a single timeseries query */
export const MAX_TIMESERIES_SERIES = 10;

/** Maximum limit for entity ranking */
export const MAX_RANKING_LIMIT = 500;

/** Default limit for entity ranking */
export const DEFAULT_RANKING_LIMIT = 50;

/** Maximum limit for filter discovery */
export const MAX_FILTER_LIMIT = 50;

/** Default limit for filter discovery */
export const DEFAULT_FILTER_LIMIT = 3;

/** Score threshold for best match in filter discovery */
export const BEST_MATCH_THRESHOLD = 0.85;
