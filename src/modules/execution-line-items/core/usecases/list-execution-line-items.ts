/**
 * Use case: List execution line items with filtering, sorting, and pagination.
 */

import {
  type ExecutionLineItemConnection,
  type ListExecutionLineItemsInput,
  type SortInput,
  DEFAULT_SORT,
  MAX_LIMIT,
  SORTABLE_FIELDS,
} from '../types.js';

import type { ExecutionLineItemError } from '../errors.js';
import type { ExecutionLineItemRepository } from '../ports.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for the list execution line items use case.
 */
export interface ListExecutionLineItemsDeps {
  executionLineItemRepo: ExecutionLineItemRepository;
}

/**
 * Validates and normalizes sort input.
 * Returns default sort if input is invalid.
 */
const normalizeSort = (sort: SortInput | undefined): SortInput => {
  if (sort === undefined) {
    return DEFAULT_SORT;
  }

  // Validate field is in allowed list
  const isValidField = SORTABLE_FIELDS.includes(sort.field);
  if (!isValidField) {
    return DEFAULT_SORT;
  }

  // Validate order
  const order = sort.order === 'ASC' ? 'ASC' : 'DESC';

  return { field: sort.field, order };
};

/**
 * List execution line items with optional filtering, sorting, and pagination.
 *
 * Validation:
 * - Clamps negative offset to 0
 * - Clamps limit to [1, MAX_LIMIT]
 * - Validates sort field against SORTABLE_FIELDS (falls back to default)
 *
 * Note: Validation of required fields (report_period, report_type) is done
 * at the resolver layer before calling this use case.
 *
 * @param deps - Repository dependency
 * @param input - Filter, sort, and pagination options
 * @returns Paginated connection of execution line items
 */
export const listExecutionLineItems = async (
  deps: ListExecutionLineItemsDeps,
  input: ListExecutionLineItemsInput
): Promise<Result<ExecutionLineItemConnection, ExecutionLineItemError>> => {
  // Clamp pagination values
  const limit = Math.min(Math.max(1, input.limit), MAX_LIMIT);
  const offset = Math.max(0, input.offset);

  // Normalize sort
  const sort = normalizeSort(input.sort);

  return deps.executionLineItemRepo.list(input.filter, sort, limit, offset);
};
