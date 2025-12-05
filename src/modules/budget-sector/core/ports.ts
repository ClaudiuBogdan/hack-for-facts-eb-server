/**
 * Port interfaces for Budget Sector module.
 *
 * Defines repository contract that shell layer must implement.
 */

import type { BudgetSectorError } from './errors.js';
import type { BudgetSector, BudgetSectorFilter, BudgetSectorConnection } from './types.js';
import type { Result } from 'neverthrow';

/**
 * Repository interface for budget sector data access.
 */
export interface BudgetSectorRepository {
  /**
   * Find a single budget sector by ID.
   *
   * @param id - The sector ID to look up
   * @returns The sector if found, null if not found, or an error
   */
  findById(id: number): Promise<Result<BudgetSector | null, BudgetSectorError>>;

  /**
   * List budget sectors with optional filtering and pagination.
   *
   * Filtering:
   * - search: ILIKE %search% OR pg_trgm similarity > 0.1
   * - sector_ids: WHERE sector_id = ANY($ids::int[])
   *
   * Results are ordered by sector_id ASC for deterministic pagination.
   *
   * @param filter - Optional filter criteria
   * @param limit - Maximum number of results (clamped to MAX_LIMIT)
   * @param offset - Number of results to skip
   * @returns Paginated connection with totalCount
   */
  list(
    filter: BudgetSectorFilter | undefined,
    limit: number,
    offset: number
  ): Promise<Result<BudgetSectorConnection, BudgetSectorError>>;
}
