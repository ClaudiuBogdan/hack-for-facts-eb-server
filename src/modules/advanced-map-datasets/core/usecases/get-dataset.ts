import { err, ok, type Result } from 'neverthrow';

import { createNotFoundError, type AdvancedMapDatasetError } from '../errors.js';

import type { AdvancedMapDatasetRepository } from '../ports.js';
import type { AdvancedMapDatasetDetail } from '../types.js';

export interface GetAdvancedMapDatasetDeps {
  repo: AdvancedMapDatasetRepository;
}

export interface GetAdvancedMapDatasetInput {
  userId: string;
  datasetId: string;
}

export async function getAdvancedMapDataset(
  deps: GetAdvancedMapDatasetDeps,
  input: GetAdvancedMapDatasetInput
): Promise<Result<AdvancedMapDatasetDetail, AdvancedMapDatasetError>> {
  const result = await deps.repo.getDatasetForUser(input.datasetId, input.userId);
  if (result.isErr()) {
    return err(result.error);
  }

  if (result.value === null) {
    return err(createNotFoundError());
  }

  return ok(result.value);
}
