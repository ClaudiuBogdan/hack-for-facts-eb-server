/**
 * List INS territories with filtering and pagination.
 */

import { type Result } from 'neverthrow';

import {
  MAX_TERRITORY_LIMIT,
  type InsTerritoryConnection,
  type InsTerritoryFilter,
} from '../types.js';

import type { InsError } from '../errors.js';
import type { InsRepository } from '../ports.js';

export interface ListInsTerritoriesDeps {
  insRepo: InsRepository;
}

export interface ListInsTerritoriesInput {
  filter: InsTerritoryFilter;
  limit: number;
  offset: number;
}

export const listInsTerritories = async (
  deps: ListInsTerritoriesDeps,
  input: ListInsTerritoriesInput
): Promise<Result<InsTerritoryConnection, InsError>> => {
  const clampedLimit = Math.min(Math.max(input.limit, 1), MAX_TERRITORY_LIMIT);
  const clampedOffset = Math.max(input.offset, 0);

  return deps.insRepo.listTerritories(input.filter, clampedLimit, clampedOffset);
};
