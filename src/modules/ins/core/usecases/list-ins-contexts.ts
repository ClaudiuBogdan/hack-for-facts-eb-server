/**
 * List INS contexts with filtering and pagination.
 */

import { type Result } from 'neverthrow';

import { MAX_DATASET_LIMIT, type InsContextConnection, type InsContextFilter } from '../types.js';

import type { InsError } from '../errors.js';
import type { InsRepository } from '../ports.js';

export interface ListInsContextsDeps {
  insRepo: InsRepository;
}

export interface ListInsContextsInput {
  filter: InsContextFilter;
  limit: number;
  offset: number;
}

export const listInsContexts = async (
  deps: ListInsContextsDeps,
  input: ListInsContextsInput
): Promise<Result<InsContextConnection, InsError>> => {
  const clampedLimit = Math.min(Math.max(input.limit, 1), MAX_DATASET_LIMIT);
  const clampedOffset = Math.max(input.offset, 0);

  return deps.insRepo.listContexts(input.filter, clampedLimit, clampedOffset);
};
