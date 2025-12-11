/**
 * List Economic Classifications Use Case
 */

import {
  MAX_LIMIT,
  type EconomicClassificationConnection,
  type EconomicClassificationFilter,
} from '../types.js';

import type { ClassificationError } from '../errors.js';
import type { EconomicClassificationRepository } from '../ports.js';
import type { Result } from 'neverthrow';

export interface ListEconomicClassificationsDeps {
  economicClassificationRepo: EconomicClassificationRepository;
}

export interface ListEconomicClassificationsInput {
  filter: EconomicClassificationFilter;
  limit: number;
  offset: number;
}

export const listEconomicClassifications = async (
  deps: ListEconomicClassificationsDeps,
  input: ListEconomicClassificationsInput
): Promise<Result<EconomicClassificationConnection, ClassificationError>> => {
  // Clamp pagination values
  const limit = Math.min(Math.max(1, input.limit), MAX_LIMIT);
  const offset = Math.max(0, input.offset);

  return deps.economicClassificationRepo.list(input.filter, limit, offset);
};
