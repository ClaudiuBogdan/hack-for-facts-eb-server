/**
 * Use case: Get a single budget sector by ID.
 */

import type { BudgetSectorError } from '../errors.js';
import type { BudgetSectorRepository } from '../ports.js';
import type { BudgetSector } from '../types.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for the get budget sector use case.
 */
export interface GetBudgetSectorDeps {
  budgetSectorRepo: BudgetSectorRepository;
}

/**
 * Get a single budget sector by ID.
 *
 * Returns null if the sector is not found (not an error per spec).
 *
 * @param deps - Repository dependency
 * @param id - The sector ID to look up
 * @returns The sector if found, null if not found, or an error
 */
export const getBudgetSector = async (
  deps: GetBudgetSectorDeps,
  id: number
): Promise<Result<BudgetSector | null, BudgetSectorError>> => {
  return deps.budgetSectorRepo.findById(id);
};
