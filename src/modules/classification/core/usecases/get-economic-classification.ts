/**
 * Get Economic Classification Use Case
 */

import type { ClassificationError } from '../errors.js';
import type { EconomicClassificationRepository } from '../ports.js';
import type { EconomicClassification } from '../types.js';
import type { Result } from 'neverthrow';

export interface GetEconomicClassificationDeps {
  economicClassificationRepo: EconomicClassificationRepository;
}

export const getEconomicClassification = async (
  deps: GetEconomicClassificationDeps,
  code: string
): Promise<Result<EconomicClassification | null, ClassificationError>> => {
  return deps.economicClassificationRepo.getByCode(code);
};
