/**
 * Use case: List funding sources with filtering and pagination.
 */

import { type FundingSourceConnection, type ListFundingSourcesInput, MAX_LIMIT } from '../types.js';

import type { FundingSourceError } from '../errors.js';
import type { FundingSourceRepository } from '../ports.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for the list funding sources use case.
 */
export interface ListFundingSourcesDeps {
  fundingSourceRepo: FundingSourceRepository;
}

/**
 * List funding sources with optional filtering and pagination.
 *
 * Validation:
 * - Clamps negative offset to 0
 * - Clamps limit to [1, MAX_LIMIT]
 *
 * @param deps - Repository dependency
 * @param input - Filter and pagination options
 * @returns Paginated connection of funding sources
 */
export const listFundingSources = async (
  deps: ListFundingSourcesDeps,
  input: ListFundingSourcesInput
): Promise<Result<FundingSourceConnection, FundingSourceError>> => {
  // Clamp pagination values
  const limit = Math.min(Math.max(1, input.limit), MAX_LIMIT);
  const offset = Math.max(0, input.offset);

  return deps.fundingSourceRepo.list(input.filter, limit, offset);
};
