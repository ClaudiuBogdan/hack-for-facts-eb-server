import { err, ok, type Result } from 'neverthrow';

import { createNotFoundError, type AdvancedMapDatasetError } from '../errors.js';

import type { AdvancedMapDatasetRepository } from '../ports.js';
import type { AdvancedMapDatasetDetail } from '../types.js';

export interface GetPublicAdvancedMapDatasetDeps {
  repo: AdvancedMapDatasetRepository;
}

export interface GetPublicAdvancedMapDatasetInput {
  publicId: string;
}

export async function getPublicAdvancedMapDataset(
  deps: GetPublicAdvancedMapDatasetDeps,
  input: GetPublicAdvancedMapDatasetInput
): Promise<Result<AdvancedMapDatasetDetail, AdvancedMapDatasetError>> {
  const result = await deps.repo.getPublicDatasetByPublicId(input.publicId);
  if (result.isErr()) {
    return err(result.error);
  }

  if (result.value === null) {
    return err(createNotFoundError());
  }

  return ok(result.value);
}
