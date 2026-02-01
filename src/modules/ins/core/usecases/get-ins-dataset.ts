/**
 * Get a single INS dataset by code.
 */

import type { InsError } from '../errors.js';
import type { InsRepository } from '../ports.js';
import type { InsDataset } from '../types.js';
import type { Result } from 'neverthrow';

export interface GetInsDatasetDeps {
  insRepo: InsRepository;
}

export const getInsDataset = async (
  deps: GetInsDatasetDeps,
  code: string
): Promise<Result<InsDataset | null, InsError>> => {
  return deps.insRepo.getDatasetByCode(code);
};
