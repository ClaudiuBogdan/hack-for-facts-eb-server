/**
 * Get Entity Use Case
 *
 * Retrieves a single entity by CUI.
 */

import type { EntityError } from '../errors.js';
import type { EntityRepository } from '../ports.js';
import type { Entity } from '../types.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for get entity use case.
 */
export interface GetEntityDeps {
  entityRepo: EntityRepository;
}

/**
 * Input for get entity use case.
 */
export interface GetEntityInput {
  cui: string;
}

/**
 * Retrieves a single entity by CUI.
 *
 * @param deps - Repository dependencies
 * @param input - CUI to look up
 * @returns The entity if found, null if not found
 */
export async function getEntity(
  deps: GetEntityDeps,
  input: GetEntityInput
): Promise<Result<Entity | null, EntityError>> {
  return deps.entityRepo.getById(input.cui);
}
