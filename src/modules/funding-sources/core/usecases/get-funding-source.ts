/**
 * Use case: Get a single funding source by ID.
 */

import type { FundingSourceError } from '../errors.js';
import type { FundingSourceRepository } from '../ports.js';
import type { FundingSource } from '../types.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for the get funding source use case.
 */
export interface GetFundingSourceDeps {
  fundingSourceRepo: FundingSourceRepository;
}

/**
 * Get a single funding source by ID.
 *
 * Returns null if the source is not found (not an error per spec).
 *
 * @param deps - Repository dependency
 * @param id - The source ID to look up
 * @returns The source if found, null if not found, or an error
 */
export const getFundingSource = async (
  deps: GetFundingSourceDeps,
  id: number
): Promise<Result<FundingSource | null, FundingSourceError>> => {
  return deps.fundingSourceRepo.findById(id);
};
