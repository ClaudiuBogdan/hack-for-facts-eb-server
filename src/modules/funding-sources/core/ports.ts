/**
 * Port interfaces for Funding Source module.
 *
 * Defines repository contracts that shell layer must implement.
 */

import type { FundingSourceError } from './errors.js';
import type {
  ExecutionLineItemConnection,
  ExecutionLineItemFilter,
  FundingSource,
  FundingSourceConnection,
  FundingSourceFilter,
} from './types.js';
import type { Result } from 'neverthrow';

/**
 * Repository interface for funding source data access.
 */
export interface FundingSourceRepository {
  /**
   * Find a single funding source by ID.
   *
   * @param id - The source ID to look up
   * @returns The source if found, null if not found, or an error
   */
  findById(id: number): Promise<Result<FundingSource | null, FundingSourceError>>;

  /**
   * List funding sources with optional filtering and pagination.
   *
   * Filtering:
   * - search: ILIKE %search% OR pg_trgm similarity > 0.1
   * - source_ids: WHERE source_id = ANY($ids::int[])
   *
   * Results are ordered by source_id ASC for deterministic pagination.
   *
   * @param filter - Optional filter criteria
   * @param limit - Maximum number of results (clamped to MAX_LIMIT)
   * @param offset - Number of results to skip
   * @returns Paginated connection with totalCount
   */
  list(
    filter: FundingSourceFilter | undefined,
    limit: number,
    offset: number
  ): Promise<Result<FundingSourceConnection, FundingSourceError>>;
}

/**
 * Repository interface for execution line items data access.
 * Used by the nested resolver on FundingSource.
 */
export interface ExecutionLineItemRepository {
  /**
   * List execution line items for a funding source with optional filtering and pagination.
   *
   * @param filter - Filter criteria (funding_source_id is required)
   * @param limit - Maximum number of results
   * @param offset - Number of results to skip
   * @returns Paginated connection with totalCount
   */
  listByFundingSource(
    filter: ExecutionLineItemFilter,
    limit: number,
    offset: number
  ): Promise<Result<ExecutionLineItemConnection, FundingSourceError>>;
}
