/**
 * Use case: Get a single execution line item by ID.
 */

import type { ExecutionLineItemError } from '../errors.js';
import type { ExecutionLineItemRepository } from '../ports.js';
import type { ExecutionLineItem } from '../types.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for the get execution line item use case.
 */
export interface GetExecutionLineItemDeps {
  executionLineItemRepo: ExecutionLineItemRepository;
}

/**
 * Get a single execution line item by ID.
 *
 * Returns null if the line item is not found (not an error per spec).
 *
 * @param deps - Repository dependency
 * @param id - The line item ID to look up
 * @returns The line item if found, null if not found, or an error
 */
export const getExecutionLineItem = async (
  deps: GetExecutionLineItemDeps,
  id: string
): Promise<Result<ExecutionLineItem | null, ExecutionLineItemError>> => {
  return deps.executionLineItemRepo.findById(id);
};
