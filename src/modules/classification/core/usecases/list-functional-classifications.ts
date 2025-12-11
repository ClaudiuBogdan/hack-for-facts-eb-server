/**
 * List Functional Classifications Use Case
 */

import {
  MAX_LIMIT,
  type FunctionalClassificationConnection,
  type FunctionalClassificationFilter,
} from '../types.js';

import type { ClassificationError } from '../errors.js';
import type { FunctionalClassificationRepository } from '../ports.js';
import type { Result } from 'neverthrow';

export interface ListFunctionalClassificationsDeps {
  functionalClassificationRepo: FunctionalClassificationRepository;
}

export interface ListFunctionalClassificationsInput {
  filter: FunctionalClassificationFilter;
  limit: number;
  offset: number;
}

export const listFunctionalClassifications = async (
  deps: ListFunctionalClassificationsDeps,
  input: ListFunctionalClassificationsInput
): Promise<Result<FunctionalClassificationConnection, ClassificationError>> => {
  // Clamp pagination values
  const limit = Math.min(Math.max(1, input.limit), MAX_LIMIT);
  const offset = Math.max(0, input.offset);

  return deps.functionalClassificationRepo.list(input.filter, limit, offset);
};
