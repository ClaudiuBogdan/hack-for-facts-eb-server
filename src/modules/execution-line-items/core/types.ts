/**
 * Domain types for Execution Line Items module.
 *
 * Execution line items represent individual budget execution entries
 * from financial reports.
 */

import type { AnalyticsFilter, AccountCategory, ExpenseType } from '@/common/types/analytics.js';
import type { Decimal } from 'decimal.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default page size for execution line item listing */
export const DEFAULT_LIMIT = 100;

/** Maximum allowed page size */
export const MAX_LIMIT = 1000;

/** Query timeout in milliseconds */
export const QUERY_TIMEOUT_MS = 30_000;

/** Sortable fields for execution line items */
export const SORTABLE_FIELDS = [
  'line_item_id',
  'report_id',
  'entity_cui',
  'funding_source_id',
  'functional_code',
  'economic_code',
  'account_category',
  'ytd_amount',
  'monthly_amount',
  'quarterly_amount',
  'amount', // Virtual field - maps to ytd_amount/monthly_amount/quarterly_amount based on frequency
  'program_code',
  'year',
] as const;

/** Default sort configuration */
export const DEFAULT_SORT: SortInput = { field: 'year', order: 'DESC' };

/** Secondary sort for tie-breaking */
export const DEFAULT_SECONDARY_SORT: SortInput = { field: 'ytd_amount', order: 'DESC' };

// ─────────────────────────────────────────────────────────────────────────────
// Domain Types
// ─────────────────────────────────────────────────────────────────────────────

/** Sortable field type */
export type SortableField = (typeof SORTABLE_FIELDS)[number];

/** Sort order direction */
export type SortOrder = 'ASC' | 'DESC';

/**
 * Sort input for execution line item queries.
 */
export interface SortInput {
  field: SortableField;
  order: SortOrder;
}

/** Anomaly type from database (forward-declared for domain type) */
type DomainAnomalyType = 'YTD_ANOMALY' | 'MISSING_LINE_ITEM';

/**
 * Execution line item entity.
 * Represents a single budget execution entry from a financial report.
 *
 * Note: Amounts use Decimal.js internally for precision.
 * GraphQL outputs convert to Float.
 */
export interface ExecutionLineItem {
  line_item_id: string;
  report_id: string;
  entity_cui: string;
  funding_source_id: number;
  budget_sector_id: number;
  functional_code: string;
  economic_code: string | null;
  account_category: AccountCategory;
  expense_type: ExpenseType | null;
  program_code: string | null;
  year: number;
  month: number;
  quarter: number | null;
  ytd_amount: Decimal;
  monthly_amount: Decimal;
  quarterly_amount: Decimal | null;
  anomaly: DomainAnomalyType | null;
}

/** Anomaly type for execution line items */
export type AnomalyType = 'YTD_ANOMALY' | 'MISSING_LINE_ITEM';

/**
 * Execution line item for GraphQL output.
 * Amounts are kept as strings to preserve NUMERIC precision.
 */
export interface ExecutionLineItemOutput {
  line_item_id: string;
  report_id: string;
  entity_cui: string;
  funding_source_id: number;
  budget_sector_id: number;
  functional_code: string;
  economic_code: string | null;
  account_category: AccountCategory;
  expense_type: string | null;
  program_code: string | null;
  year: number;
  month: number;
  quarter: number | null;
  ytd_amount: string;
  monthly_amount: string;
  quarterly_amount: string | null;
  anomaly: AnomalyType | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pagination metadata for execution line item listing.
 */
export interface ExecutionLineItemPageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Paginated connection of execution line items.
 */
export interface ExecutionLineItemConnection {
  nodes: ExecutionLineItem[];
  pageInfo: ExecutionLineItemPageInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter options for execution line item listing.
 * Alias for AnalyticsFilter (all filters apply).
 *
 * Required fields:
 * - report_period: Period selection (YEAR, QUARTER, MONTH)
 * - report_type: Report type string
 *
 * Note: Empty arrays are treated as no filter (not empty result).
 */
export type ExecutionLineItemFilter = AnalyticsFilter;

// ─────────────────────────────────────────────────────────────────────────────
// Use Case Input Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for list execution line items use case.
 */
export interface ListExecutionLineItemsInput {
  filter: ExecutionLineItemFilter;
  sort?: SortInput | undefined;
  limit: number;
  offset: number;
}
