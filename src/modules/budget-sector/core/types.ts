/**
 * Domain types for Budget Sector module.
 *
 * BudgetSectors categorize budget sources (e.g., local budget, state budget).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default page size for budget sector listing */
export const DEFAULT_LIMIT = 20;

/** Maximum allowed page size */
export const MAX_LIMIT = 200;

/** Similarity threshold for pg_trgm fuzzy matching */
export const SIMILARITY_THRESHOLD = 0.1;

// ─────────────────────────────────────────────────────────────────────────────
// Domain Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Budget sector entity.
 * Represents a category of budget sources (e.g., local budget, state budget).
 */
export interface BudgetSector {
  sector_id: number;
  sector_description: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pagination metadata for budget sector listing.
 */
export interface BudgetSectorPageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Paginated connection of budget sectors.
 */
export interface BudgetSectorConnection {
  nodes: BudgetSector[];
  pageInfo: BudgetSectorPageInfo;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter options for budget sector listing.
 *
 * - search: Fuzzy match against sector_description (ILIKE + pg_trgm similarity)
 * - sector_ids: Filter to specific sector IDs
 */
export interface BudgetSectorFilter {
  search?: string | undefined;
  sector_ids?: number[] | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case Input Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for list budget sectors use case.
 */
export interface ListBudgetSectorsInput {
  filter?: BudgetSectorFilter | undefined;
  limit: number;
  offset: number;
}
