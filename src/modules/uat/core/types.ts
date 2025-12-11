/**
 * Domain types for UAT module.
 *
 * UATs (Unitate Administrativ-Teritoriala) represent Romanian administrative
 * territorial units such as cities, communes, and counties.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default page size for UAT listing */
export const DEFAULT_UAT_LIMIT = 20;

/** Maximum allowed page size for UATs */
export const MAX_UAT_LIMIT = 500;

/** Similarity threshold for UAT pg_trgm search */
export const UAT_SIMILARITY_THRESHOLD = 0.1;

// ─────────────────────────────────────────────────────────────────────────────
// UAT Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Administrative Territorial Unit (UAT).
 */
export interface UAT {
  /** UAT ID */
  id: number;
  /** UAT key */
  uat_key: string;
  /** UAT code */
  uat_code: string;
  /** SIRUTA code */
  siruta_code: string;
  /** UAT name */
  name: string;
  /** County code */
  county_code: string;
  /** County name */
  county_name: string;
  /** Region name */
  region: string;
  /** Population count */
  population: number | null;
}

/**
 * Filter options for UAT queries.
 */
export interface UATFilter {
  /** Exact ID match */
  id?: number;
  /** Match any of these IDs */
  ids?: number[];
  /** Exact uat_key match */
  uat_key?: string;
  /** Exact uat_code match */
  uat_code?: string;
  /** Partial name match (ILIKE when no search) */
  name?: string;
  /** Exact county_code match */
  county_code?: string;
  /** Partial county_name match (ILIKE when no search) */
  county_name?: string;
  /** Exact region match */
  region?: string;
  /** Full-text search using pg_trgm (name + county_name) */
  search?: string;
  /** Filter to county-level UATs only */
  is_county?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pagination Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pagination metadata for UAT listing.
 */
export interface UATPageInfo {
  /** Total number of UATs matching the filter */
  totalCount: number;
  /** Whether there are more pages after current */
  hasNextPage: boolean;
  /** Whether there are pages before current */
  hasPreviousPage: boolean;
}

/**
 * Paginated connection of UATs.
 */
export interface UATConnection {
  /** List of UATs in current page */
  nodes: UAT[];
  /** Pagination metadata */
  pageInfo: UATPageInfo;
}
