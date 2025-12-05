/**
 * Port interfaces for Execution Line Items module.
 *
 * Defines repository contract that shell layer must implement.
 */

import type { ExecutionLineItemError } from './errors.js';
import type {
  ExecutionLineItem,
  ExecutionLineItemConnection,
  ExecutionLineItemFilter,
  SortInput,
} from './types.js';
import type { Result } from 'neverthrow';

/**
 * Repository interface for execution line item data access.
 */
export interface ExecutionLineItemRepository {
  /**
   * Find a single execution line item by ID.
   *
   * @param id - The line item ID to look up
   * @returns The line item if found, null if not found, or an error
   */
  findById(id: string): Promise<Result<ExecutionLineItem | null, ExecutionLineItemError>>;

  /**
   * List execution line items with filtering, sorting, and pagination.
   *
   * Filter requirements:
   * - report_period: Required - defines period selection (YEAR/QUARTER/MONTH)
   * - report_type: Required - report type string
   *
   * Query optimization:
   * - Period flags (is_yearly/is_quarterly) are applied first to match index prefix
   * - Conditional JOINs on Entities/UATs only when required by filters
   * - Window function COUNT(*) OVER() for total count without extra query
   *
   * Results are ordered by the provided sort or default (year DESC, ytd_amount DESC).
   *
   * @param filter - Filter criteria (report_period and report_type required)
   * @param sort - Sort configuration
   * @param limit - Maximum number of results (clamped to MAX_LIMIT)
   * @param offset - Number of results to skip (clamped to >= 0)
   * @returns Paginated connection with totalCount
   */
  list(
    filter: ExecutionLineItemFilter,
    sort: SortInput,
    limit: number,
    offset: number
  ): Promise<Result<ExecutionLineItemConnection, ExecutionLineItemError>>;
}
