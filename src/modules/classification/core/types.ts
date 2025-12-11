/**
 * Classification Module Types
 *
 * Domain types for functional and economic classifications.
 */

// ============================================================================
// Domain Types
// ============================================================================

/**
 * Functional classification (budget function category).
 */
export interface FunctionalClassification {
  functional_code: string;
  functional_name: string;
}

/**
 * Economic classification (budget economic category).
 */
export interface EconomicClassification {
  economic_code: string;
  economic_name: string;
}

// ============================================================================
// Filter Types
// ============================================================================

/**
 * Filter for functional classifications.
 */
export interface FunctionalClassificationFilter {
  /** Search by code or name */
  search?: string;
  /** Filter by specific codes */
  functional_codes?: string[];
}

/**
 * Filter for economic classifications.
 */
export interface EconomicClassificationFilter {
  /** Search by code or name */
  search?: string;
  /** Filter by specific codes */
  economic_codes?: string[];
}

// ============================================================================
// Pagination Types
// ============================================================================

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  totalCount: number;
}

export interface FunctionalClassificationConnection {
  nodes: FunctionalClassification[];
  pageInfo: PageInfo;
}

export interface EconomicClassificationConnection {
  nodes: EconomicClassification[];
  pageInfo: PageInfo;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
