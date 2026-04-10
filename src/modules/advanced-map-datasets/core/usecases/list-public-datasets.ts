import { normalizePagination } from '@/common/constants/pagination.js';

import type { AdvancedMapDatasetError } from '../errors.js';
import type { AdvancedMapDatasetRepository } from '../ports.js';
import type { AdvancedMapDatasetConnection } from '../types.js';
import type { Result } from 'neverthrow';

export interface ListPublicAdvancedMapDatasetsDeps {
  repo: AdvancedMapDatasetRepository;
}

export interface ListPublicAdvancedMapDatasetsInput {
  limit?: number;
  offset?: number;
}

export async function listPublicAdvancedMapDatasets(
  deps: ListPublicAdvancedMapDatasetsDeps,
  input: ListPublicAdvancedMapDatasetsInput
): Promise<Result<AdvancedMapDatasetConnection, AdvancedMapDatasetError>> {
  const pagination = normalizePagination({
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  });

  return deps.repo.listPublicDatasets(pagination.limit, pagination.offset);
}
