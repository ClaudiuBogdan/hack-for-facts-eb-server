/**
 * List INS datasets with filtering and pagination.
 */

import { type Result } from 'neverthrow';

import { MAX_DATASET_LIMIT, type InsDatasetConnection, type InsDatasetFilter } from '../types.js';

import type { InsError } from '../errors.js';
import type { InsRepository } from '../ports.js';

export interface ListInsDatasetsDeps {
  insRepo: InsRepository;
}

export interface ListInsDatasetsInput {
  filter: InsDatasetFilter;
  limit: number;
  offset: number;
}

export const listInsDatasets = async (
  deps: ListInsDatasetsDeps,
  input: ListInsDatasetsInput
): Promise<Result<InsDatasetConnection, InsError>> => {
  const clampedLimit = Math.min(Math.max(input.limit, 1), MAX_DATASET_LIMIT);
  const clampedOffset = Math.max(input.offset, 0);

  return deps.insRepo.listDatasets(input.filter, clampedLimit, clampedOffset);
};
