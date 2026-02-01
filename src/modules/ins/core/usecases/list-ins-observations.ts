/**
 * List INS observations with filtering and pagination.
 */

import { ok, type Result } from 'neverthrow';

import {
  MAX_OBSERVATION_LIMIT,
  type InsObservationConnection,
  type ListInsObservationsInput,
} from '../types.js';

import type { InsError } from '../errors.js';
import type { InsRepository } from '../ports.js';

export interface ListInsObservationsDeps {
  insRepo: InsRepository;
}

export const listInsObservations = async (
  deps: ListInsObservationsDeps,
  input: ListInsObservationsInput
): Promise<Result<InsObservationConnection, InsError>> => {
  const clampedLimit = Math.min(Math.max(input.limit, 1), MAX_OBSERVATION_LIMIT);
  const clampedOffset = Math.max(input.offset, 0);

  if (input.dataset_codes.length === 0) {
    return ok({
      nodes: [],
      pageInfo: {
        totalCount: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
  }

  return deps.insRepo.listObservations({
    ...input,
    limit: clampedLimit,
    offset: clampedOffset,
  });
};
