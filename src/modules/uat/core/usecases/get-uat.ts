/**
 * Get UAT Use Case
 *
 * Fetches a single UAT by ID.
 */

import type { UATError } from '../errors.js';
import type { UATRepository } from '../ports.js';
import type { UAT } from '../types.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for get UAT use case.
 */
export interface GetUATDeps {
  uatRepo: UATRepository;
}

/**
 * Input for get UAT use case.
 */
export interface GetUATInput {
  id: number;
}

/**
 * Fetches a single UAT by ID.
 *
 * @param deps - Repository dependencies
 * @param input - UAT ID
 * @returns The UAT if found, null if not found
 */
export async function getUAT(
  deps: GetUATDeps,
  input: GetUATInput
): Promise<Result<UAT | null, UATError>> {
  return deps.uatRepo.getById(input.id);
}
