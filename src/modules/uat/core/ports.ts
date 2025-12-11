/**
 * Port interfaces for UAT module.
 *
 * Defines repository contracts that shell layer must implement.
 */

import type { UATError } from './errors.js';
import type { UAT, UATConnection, UATFilter } from './types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// UAT Repository
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repository interface for UAT data access.
 */
export interface UATRepository {
  /**
   * Find a UAT by ID.
   *
   * @param id - UAT ID
   * @returns The UAT if found, null if not found
   */
  getById(id: number): Promise<Result<UAT | null, UATError>>;

  /**
   * Batch load UATs by IDs.
   * Used by Mercurius loaders for N+1 prevention.
   *
   * @param ids - Array of UAT IDs
   * @returns Map of UAT ID to UAT (missing IDs won't have entries)
   */
  getByIds(ids: number[]): Promise<Result<Map<number, UAT>, UATError>>;

  /**
   * List UATs with filtering and pagination.
   *
   * Filtering:
   * - id: exact match
   * - ids: match any of these IDs
   * - uat_key: exact match
   * - uat_code: exact match
   * - name: ILIKE (when no search), or similarity (with search)
   * - county_code: exact match
   * - county_name: ILIKE (when no search), or similarity (with search)
   * - region: exact match
   * - search: pg_trgm similarity on name + county_name
   * - is_county: filter to county-level UATs (siruta_code = county_code OR Bucharest special case)
   *
   * Sorting:
   * - With search: ORDER BY similarity DESC, name ASC, id ASC
   * - Without search: ORDER BY name ASC, id ASC
   *
   * @param filter - Filter criteria
   * @param limit - Maximum number of results
   * @param offset - Number of results to skip
   * @returns Paginated UAT connection
   */
  getAll(
    filter: UATFilter,
    limit: number,
    offset: number
  ): Promise<Result<UATConnection, UATError>>;

  /**
   * Count UATs matching filter.
   *
   * @param filter - Filter criteria
   * @returns Total count of matching UATs
   */
  count(filter: UATFilter): Promise<Result<number, UATError>>;

  /**
   * Get total population for a county (sum of all UAT populations).
   *
   * @param countyCode - County code
   * @returns Sum of populations for all UATs in the county
   */
  getCountyPopulation(countyCode: string): Promise<Result<number | null, UATError>>;
}
