import { normalizePagination } from '@/common/constants/pagination.js';

import type { AdvancedMapDatasetError } from '../errors.js';
import type { AdvancedMapDatasetRepository } from '../ports.js';
import type { AdvancedMapDatasetConnection } from '../types.js';
import type { Result } from 'neverthrow';

export interface ListAdvancedMapDatasetsDeps {
  repo: AdvancedMapDatasetRepository;
}

export interface ListAdvancedMapDatasetsInput {
  userId: string;
  limit?: number;
  offset?: number;
}

export async function listAdvancedMapDatasets(
  deps: ListAdvancedMapDatasetsDeps,
  input: ListAdvancedMapDatasetsInput
): Promise<Result<AdvancedMapDatasetConnection, AdvancedMapDatasetError>> {
  const pagination = normalizePagination({
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  });

  return deps.repo.listDatasetsForUser(input.userId, pagination.limit, pagination.offset);
}
