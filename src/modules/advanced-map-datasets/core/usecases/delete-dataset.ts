import { err, ok, type Result } from 'neverthrow';

import {
  createDatasetInUseError,
  createNotFoundError,
  type AdvancedMapDatasetError,
} from '../errors.js';

import type { AdvancedMapDatasetRepository } from '../ports.js';

export interface DeleteAdvancedMapDatasetDeps {
  repo: AdvancedMapDatasetRepository;
}

export interface DeleteAdvancedMapDatasetInput {
  userId: string;
  datasetId: string;
  allowPublicWrite?: boolean;
}

export async function deleteAdvancedMapDataset(
  deps: DeleteAdvancedMapDatasetDeps,
  input: DeleteAdvancedMapDatasetInput
): Promise<Result<void, AdvancedMapDatasetError>> {
  const datasetResult = await deps.repo.getDatasetForUser(input.datasetId, input.userId);
  if (datasetResult.isErr()) {
    return err(datasetResult.error);
  }

  if (datasetResult.value === null) {
    return err(createNotFoundError());
  }

  const referencesResult = await deps.repo.listReferencingMaps(input.datasetId);
  if (referencesResult.isErr()) {
    return err(referencesResult.error);
  }

  if (referencesResult.value.length > 0) {
    return err(createDatasetInUseError(referencesResult.value));
  }

  // The repository re-checks this invariant under a transaction-scoped dataset
  // advisory lock. See:
  // docs/specs/specs-202604091600-advanced-map-dataset-consistency-boundary.md
  const deleteResult = await deps.repo.softDeleteDataset(
    input.datasetId,
    input.userId,
    input.allowPublicWrite === true
  );
  if (deleteResult.isErr()) {
    return err(deleteResult.error);
  }

  if (!deleteResult.value) {
    return err(createNotFoundError());
  }

  return ok(undefined);
}
