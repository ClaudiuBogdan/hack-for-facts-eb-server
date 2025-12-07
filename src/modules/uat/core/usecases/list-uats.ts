/**
 * List UATs Use Case
 *
 * Lists UATs with filtering and pagination.
 */

import { MAX_UAT_LIMIT, type UATConnection, type UATFilter } from '../types.js';

import type { UATError } from '../errors.js';
import type { UATRepository } from '../ports.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for list UATs use case.
 */
export interface ListUATsDeps {
  uatRepo: UATRepository;
}

/**
 * Input for list UATs use case.
 */
export interface ListUATsInput {
  filter: UATFilter;
  limit: number;
  offset: number;
}

/**
 * Lists UATs with filtering and pagination.
 *
 * The limit is clamped to MAX_UAT_LIMIT to prevent excessive queries.
 *
 * @param deps - Repository dependencies
 * @param input - Filter and pagination options
 * @returns Paginated UAT connection
 */
export async function listUATs(
  deps: ListUATsDeps,
  input: ListUATsInput
): Promise<Result<UATConnection, UATError>> {
  // Clamp limit to maximum allowed
  const clampedLimit = Math.min(Math.max(input.limit, 1), MAX_UAT_LIMIT);

  // Ensure offset is non-negative
  const clampedOffset = Math.max(input.offset, 0);

  return deps.uatRepo.getAll(input.filter, clampedLimit, clampedOffset);
}
