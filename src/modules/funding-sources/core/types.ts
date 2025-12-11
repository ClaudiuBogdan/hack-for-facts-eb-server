/**
 * Domain types for Funding Source module.
 *
 * FundingSources represent sources of budget funding (e.g., State Budget, EU Funds, Own Revenues).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default page size for funding source listing */
export const DEFAULT_LIMIT = 10;

/** Maximum allowed page size */
export const MAX_LIMIT = 200;

/** Similarity threshold for pg_trgm fuzzy matching */
export const SIMILARITY_THRESHOLD = 0.1;

/** Default page size for execution line items listing */
export const DEFAULT_LINE_ITEMS_LIMIT = 100;

/** Maximum allowed page size for execution line items */
export const MAX_LINE_ITEMS_LIMIT = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Domain Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Funding source entity.
 * Represents a source of budget funding (e.g., State Budget, EU Funds, Own Revenues).
 */
export interface FundingSource {
  source_id: number;
  source_description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pagination metadata for funding source listing.
 */
export interface FundingSourcePageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Paginated connection of funding sources.
 */
export interface FundingSourceConnection {
  nodes: FundingSource[];
  pageInfo: FundingSourcePageInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter options for funding source listing.
 *
 * - search: Fuzzy match against source_description (ILIKE + pg_trgm similarity)
 * - source_ids: Filter to specific source IDs
 */
export interface FundingSourceFilter {
  search?: string | undefined;
  source_ids?: number[] | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case Input Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for list funding sources use case.
 */
export interface ListFundingSourcesInput {
  filter?: FundingSourceFilter | undefined;
  limit: number;
  offset: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution Line Items Types (for nested resolver)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execution line item entity.
 * Represents a single budget execution line item.
 */
export interface ExecutionLineItem {
  line_item_id: string;
  report_id: string;
  year: number;
  month: number;
  entity_cui: string;
  account_category: 'vn' | 'ch';
  functional_code: string;
  economic_code: string | null;
  ytd_amount: string;
  monthly_amount: string;
}

/**
 * Pagination metadata for execution line items listing.
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

/**
 * Filter options for execution line items listing.
 *
 * - funding_source_id: Required filter by funding source (from parent)
 * - report_id: Optional filter by report ID
 * - account_category: Optional filter by account category ('vn' or 'ch')
 */
export interface ExecutionLineItemFilter {
  funding_source_id: number;
  report_id?: string | undefined;
  account_category?: 'vn' | 'ch' | undefined;
}

/**
 * Input for list execution line items use case.
 */
export interface ListExecutionLineItemsInput {
  filter: ExecutionLineItemFilter;
  limit: number;
  offset: number;
}
