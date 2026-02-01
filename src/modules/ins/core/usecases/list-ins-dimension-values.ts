/**
 * List INS dimension values with pagination.
 */

import { type Result } from 'neverthrow';

import {
  MAX_DIMENSION_VALUES_LIMIT,
  type InsDimensionValueConnection,
  type InsDimensionValueFilter,
} from '../types.js';

import type { InsError } from '../errors.js';
import type { InsRepository } from '../ports.js';

export interface ListInsDimensionValuesDeps {
  insRepo: InsRepository;
}

export interface ListInsDimensionValuesInput {
  matrix_id: number;
  dim_index: number;
  filter: InsDimensionValueFilter;
  limit: number;
  offset: number;
}

export const listInsDimensionValues = async (
  deps: ListInsDimensionValuesDeps,
  input: ListInsDimensionValuesInput
): Promise<Result<InsDimensionValueConnection, InsError>> => {
  const clampedLimit = Math.min(Math.max(input.limit, 1), MAX_DIMENSION_VALUES_LIMIT);
  const clampedOffset = Math.max(input.offset, 0);

  return deps.insRepo.listDimensionValues(
    input.matrix_id,
    input.dim_index,
    input.filter,
    clampedLimit,
    clampedOffset
  );
};
