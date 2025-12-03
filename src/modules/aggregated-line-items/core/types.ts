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
// Input Types
// -----------------------------------------

/**
 * Internal input for the use case.
 * Uses Frequency for report_period (internal domain type).
 */
export interface AggregatedLineItemsInput {
  filter: AnalyticsFilter & NormalizationOptions;
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
export interface GqlAggregatedLineItemsInput {
  filter: GqlAnalyticsFilterInput & InputNormalizationOptions;
  limit?: number;
  offset?: number;
}

// -----------------------------------------
// Repository Types (Intermediate)
// -----------------------------------------

/**
 * Raw line item data grouped by classification AND period.
 *
 * This is the intermediate format returned by the repository.
 * We need per-period data to apply year-specific normalization factors.
 *
 * The use case will:
 * 1. Normalize each row using the year for factor lookup
 * 2. Re-aggregate by classification (summing across periods)
 * 3. Sort by amount DESC
 * 4. Apply pagination
 */
export interface ClassificationPeriodData {
  /** Functional classification code (e.g., "01.01.01") */
  functional_code: string;
  /** Functional classification name (e.g., "Legislative bodies") */
  functional_name: string;
  /** Economic classification code (e.g., "20.05.01" or "00.00.00" for unknown) */
  economic_code: string;
  /** Economic classification name (e.g., "Administrative services") */
  economic_name: string;

  /** Year for normalization factor lookup */
  year: number;

  /** Raw amount in nominal RON */
  amount: Decimal;

  /** Count of line items for this classification+period */
  count: number;
}

/**
 * Repository result containing all classification-period combinations.
 */
export interface ClassificationPeriodResult {
  /** All classification-period rows (not paginated) */
  rows: ClassificationPeriodData[];

  /**
   * Count of distinct classifications (for pagination info).
   * This is the number of unique (functional_code, economic_code) pairs.
   */
  distinctClassificationCount: number;
}

// -----------------------------------------
// Aggregated Types (After Normalization)
// -----------------------------------------

/**
 * Intermediate type during aggregation (uses Decimal for precision).
 */
export interface AggregatedClassification {
  functional_code: string;
  functional_name: string;
  economic_code: string;
  economic_name: string;
  /** Normalized and aggregated amount (Decimal for precision) */
  amount: Decimal;
  /** Total count of line items */
  count: number;
}

// -----------------------------------------
// Output Types
// -----------------------------------------

/**
 * Final output item for GraphQL response.
 * Amounts are converted to number for GraphQL Float type.
 */
export interface AggregatedLineItem {
  functional_code: string;
  functional_name: string;
  economic_code: string;
  economic_name: string;
  /** Normalized and aggregated amount */
  amount: number;
  /** Number of line items in this classification group */
  count: number;
}

/**
 * Pagination info for the connection.
 */
export interface PageInfo {
  /** Total number of classification groups (after filters) */
  totalCount: number;
  /** Whether there are more items after the current page */
  hasNextPage: boolean;
  /** Whether there are items before the current page */
  hasPreviousPage: boolean;
}

/**
 * Paginated connection result for GraphQL.
 */
export interface AggregatedLineItemConnection {
  nodes: AggregatedLineItem[];
  pageInfo: PageInfo;
}

// -----------------------------------------
// Constants
// -----------------------------------------

/** Default economic code for NULL values */
export const UNKNOWN_ECONOMIC_CODE = '00.00.00';

/** Default economic name for NULL values */
export const UNKNOWN_ECONOMIC_NAME = 'Unknown economic classification';

/** Maximum items per page */
export const MAX_LIMIT = 1000;

/** Default items per page */
export const DEFAULT_LIMIT = 50;

/** Maximum rows to fetch from database (safety limit) */
export const MAX_DB_ROWS = 100_000;
