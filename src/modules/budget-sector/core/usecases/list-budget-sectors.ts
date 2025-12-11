/**
 * Use case: List budget sectors with filtering and pagination.
 */

import { type BudgetSectorConnection, type ListBudgetSectorsInput, MAX_LIMIT } from '../types.js';

import type { BudgetSectorError } from '../errors.js';
import type { BudgetSectorRepository } from '../ports.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for the list budget sectors use case.
 */
export interface ListBudgetSectorsDeps {
  budgetSectorRepo: BudgetSectorRepository;
}

/**
 * List budget sectors with optional filtering and pagination.
 *
 * Validation:
 * - Clamps negative offset to 0
 * - Clamps limit to [1, MAX_LIMIT]
 *
 * @param deps - Repository dependency
 * @param input - Filter and pagination options
 * @returns Paginated connection of budget sectors
 */
export const listBudgetSectors = async (
  deps: ListBudgetSectorsDeps,
  input: ListBudgetSectorsInput
): Promise<Result<BudgetSectorConnection, BudgetSectorError>> => {
  // Clamp pagination values
  const limit = Math.min(Math.max(1, input.limit), MAX_LIMIT);
  const offset = Math.max(0, input.offset);

  return deps.budgetSectorRepo.list(input.filter, limit, offset);
};
