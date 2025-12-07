/**
 * Get Functional Classification Use Case
 */

import type { ClassificationError } from '../errors.js';
import type { FunctionalClassificationRepository } from '../ports.js';
import type { FunctionalClassification } from '../types.js';
import type { Result } from 'neverthrow';

export interface GetFunctionalClassificationDeps {
  functionalClassificationRepo: FunctionalClassificationRepository;
}

export const getFunctionalClassification = async (
  deps: GetFunctionalClassificationDeps,
  code: string
): Promise<Result<FunctionalClassification | null, ClassificationError>> => {
  return deps.functionalClassificationRepo.getByCode(code);
};
