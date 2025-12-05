/**
 * List Entities Use Case
 *
 * Lists entities with filtering, sorting, and pagination.
 */

import { type EntityConnection, type EntityFilter, MAX_LIMIT, DEFAULT_LIMIT } from '../types.js';

import type { EntityError } from '../errors.js';
import type { EntityRepository } from '../ports.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for list entities use case.
 */
export interface ListEntitiesDeps {
  entityRepo: EntityRepository;
}

/**
 * Input for list entities use case.
 */
export interface ListEntitiesInput {
  filter: EntityFilter;
  limit?: number;
  offset?: number;
}

/**
 * Lists entities with filtering, sorting, and pagination.
 *
 * - Clamps limit to [1, MAX_LIMIT]
 * - Clamps offset to >= 0
 *
 * @param deps - Repository dependencies
 * @param input - Filter and pagination options
 * @returns Paginated entity connection
 */
export async function listEntities(
  deps: ListEntitiesDeps,
  input: ListEntitiesInput
): Promise<Result<EntityConnection, EntityError>> {
  const rawLimit = input.limit ?? DEFAULT_LIMIT;
  const rawOffset = input.offset ?? 0;

  // Clamp values to valid ranges
  const clampedLimit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
  const clampedOffset = Math.max(rawOffset, 0);

  return deps.entityRepo.getAll(input.filter, clampedLimit, clampedOffset);
}
