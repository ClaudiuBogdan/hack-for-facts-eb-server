import { Decimal } from 'decimal.js';

import type {
  AnalyticsFilter,
  NormalizationOptions,
  GqlReportPeriodInput,
  NormalizationMode,
  Currency,
} from '@/common/types/analytics.js';

// Re-export common types for convenience
export type {
  AnalyticsFilter,
  NormalizationOptions,
  Currency,
  NormalizationMode,
  GqlReportPeriodInput,
} from '@/common/types/analytics.js';
export { Frequency } from '@/common/types/temporal.js';

// -----------------------------------------
// Legacy Normalization Handling
// -----------------------------------------

/** Legacy normalization modes allowed in GraphQL input */
export type LegacyNormalizationMode = NormalizationMode | 'total_euro' | 'per_capita_euro';

/** Input normalization options with legacy mode support (GraphQL optional fields) */
export interface InputNormalizationOptions {
  normalization?: LegacyNormalizationMode;
  currency?: Currency;
  inflation_adjusted?: boolean;
  show_period_growth?: boolean;
}

// -----------------------------------------
// Sort Types
// -----------------------------------------

/**
 * Fields available for sorting entity analytics results.
 *
 * - AMOUNT: Normalized display amount (same as TOTAL_AMOUNT)
 * - TOTAL_AMOUNT: Aggregated total after normalization
 * - PER_CAPITA_AMOUNT: total_amount / population
 * - ENTITY_NAME: Alphabetical by entity name
 * - ENTITY_TYPE: Alphabetical by entity type
 * - POPULATION: By population size
 * - COUNTY_NAME: Alphabetical by county name
 * - COUNTY_CODE: By county code
 */
export type EntityAnalyticsSortField =
  | 'AMOUNT'
  | 'TOTAL_AMOUNT'
  | 'PER_CAPITA_AMOUNT'
  | 'ENTITY_NAME'
  | 'ENTITY_TYPE'
  | 'POPULATION'
  | 'COUNTY_NAME'
  | 'COUNTY_CODE';

export type SortDirection = 'ASC' | 'DESC';

export interface EntityAnalyticsSort {
  by: EntityAnalyticsSortField;
  order: SortDirection;
}

// -----------------------------------------
// Input Types
// -----------------------------------------

/**
 * Internal input for the use case.
 * Uses Frequency for report_period (internal domain type).
 */
export interface EntityAnalyticsInput {
  filter: AnalyticsFilter & NormalizationOptions;
  sort?: EntityAnalyticsSort;
  limit?: number;
  offset?: number;
}

/**
 * GraphQL filter input - uses GqlReportPeriodInput with type field
 */
export interface GqlAnalyticsFilterInput extends Omit<AnalyticsFilter, 'report_period'> {
  report_period: GqlReportPeriodInput;
}

/**
 * GraphQL input type.
 * Uses PeriodType (MONTH/QUARTER/YEAR) in report_period.
 */
export interface GqlEntityAnalyticsInput {
  filter: GqlAnalyticsFilterInput & InputNormalizationOptions;
  sort?: EntityAnalyticsSort;
  limit?: number;
  offset?: number;
}

// -----------------------------------------
// SQL Normalization Types
// -----------------------------------------

/**
 * Map of period keys to combined normalization multipliers.
 *
 * Key format depends on frequency:
 * - YEAR: "2024"
 * - QUARTER: "2024-Q1"
 * - MONTH: "2024-01"
 *
 * Value: Pre-computed combined multiplier (Decimal for precision).
 *
 * NOTE: Unlike aggregatedLineItems, population is NOT included in the factor map
 * for entity-analytics because population varies by entity type (computed in SQL).
 */
export type PeriodFactorMap = Map<string, Decimal>;

/**
 * Pagination parameters for SQL queries.
 */
export interface PaginationParams {
  limit: number;
  offset: number;
}

/**
 * Aggregate filters applied as SQL HAVING clause.
 */
export interface AggregateFilters {
  /** Minimum normalized amount (inclusive) */
  minAmount?: Decimal;
  /** Maximum normalized amount (inclusive) */
  maxAmount?: Decimal;
}

// -----------------------------------------
// Repository Types
// -----------------------------------------

/**
 * Raw entity analytics data from the repository (with Decimal for precision).
 *
 * Population handling varies by entity type:
 * - UAT (is_uat = true): UAT's own population
 * - County Council (entity_type = 'admin_county_council'): County aggregate population
 * - Other entities: NULL population, per_capita_amount = 0
 */
export interface EntityAnalyticsRow {
  /** Unique entity identifier (CUI - Cod Unic de Identificare) */
  entity_cui: string;
  /** Entity display name */
  entity_name: string;
  /** Entity type (e.g., 'uat', 'admin_county_council', 'public_institution') */
  entity_type: string | null;
  /** Associated UAT ID (if applicable) */
  uat_id: number | null;
  /** County code (e.g., 'AB', 'B') */
  county_code: string | null;
  /** County name (e.g., 'Alba', 'Bucuresti') */
  county_name: string | null;
  /** Population for this entity (varies by entity type) */
  population: number | null;
  /** Normalized total amount (Decimal for precision) */
  total_amount: Decimal;
  /** Pre-computed per_capita_amount (total_amount / population, 0 if no population) */
  per_capita_amount: Decimal;
}

/**
 * Result from repository query.
 */
export interface EntityAnalyticsResult {
  /** Entity analytics rows (normalized, sorted, paginated by SQL) */
  items: EntityAnalyticsRow[];
  /** Total count of entities matching the filter (for pagination info) */
  totalCount: number;
}

// -----------------------------------------
// Output Types
// -----------------------------------------

/**
 * Final output item for GraphQL response.
 * Amounts are converted to number for GraphQL Float type.
 */
export interface EntityAnalyticsDataPoint {
  /** Unique entity identifier (CUI) */
  entity_cui: string;
  /** Entity display name */
  entity_name: string;
  /** Entity type (e.g., 'uat', 'admin_county_council', 'public_institution') */
  entity_type: string | null;
  /** Associated UAT ID (as string for GraphQL ID type) */
  uat_id: string | null;
  /** County code (e.g., 'AB', 'B') */
  county_code: string | null;
  /** County name (e.g., 'Alba', 'Bucuresti') */
  county_name: string | null;
  /** Population for this entity (varies by entity type) */
  population: number | null;
  /** Display amount (same as total_amount; may differ with future display modes) */
  amount: number;
  /** Normalized total amount */
  total_amount: number;
  /** Per-capita amount (total_amount / population, 0 if no population) */
  per_capita_amount: number;
}

/**
 * Pagination info for the connection.
 */
export interface PageInfo {
  /** Total number of entities (after filters) */
  totalCount: number;
  /** Whether there are more items after the current page */
  hasNextPage: boolean;
  /** Whether there are items before the current page */
  hasPreviousPage: boolean;
}

/**
 * Paginated connection result for GraphQL.
 */
export interface EntityAnalyticsConnection {
  nodes: EntityAnalyticsDataPoint[];
  pageInfo: PageInfo;
}

// -----------------------------------------
// Constants
// -----------------------------------------

/** Maximum items per page */
export const MAX_LIMIT = 100_000;

/** Default items per page */
export const DEFAULT_LIMIT = 50;

/** Maximum rows to fetch from database (safety limit) */
export const MAX_DB_ROWS = 100_000;

/** Default sort configuration */
export const DEFAULT_SORT: EntityAnalyticsSort = {
  by: 'TOTAL_AMOUNT',
  order: 'DESC',
};

/** Valid sort fields for validation */
export const VALID_SORT_FIELDS: readonly EntityAnalyticsSortField[] = [
  'AMOUNT',
  'TOTAL_AMOUNT',
  'PER_CAPITA_AMOUNT',
  'ENTITY_NAME',
  'ENTITY_TYPE',
  'POPULATION',
  'COUNTY_NAME',
  'COUNTY_CODE',
] as const;
