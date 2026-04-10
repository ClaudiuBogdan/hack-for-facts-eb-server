import { err, ok, type Result } from 'neverthrow';

import { validateDatasetRows, validateRowCount } from './helpers.js';
import { createNotFoundError, type AdvancedMapDatasetError } from '../errors.js';

import type { AdvancedMapDatasetRepository } from '../ports.js';
import type { AdvancedMapDatasetDetail } from '../types.js';

export interface ReplaceAdvancedMapDatasetRowsDeps {
  repo: AdvancedMapDatasetRepository;
}

export interface ReplaceAdvancedMapDatasetRowsUseCaseInput {
  userId: string;
  datasetId: string;
  rows: readonly import('../types.js').AdvancedMapDatasetRow[];
  allowPublicWrite?: boolean;
}

export async function replaceAdvancedMapDatasetRows(
  deps: ReplaceAdvancedMapDatasetRowsDeps,
  input: ReplaceAdvancedMapDatasetRowsUseCaseInput
): Promise<Result<AdvancedMapDatasetDetail, AdvancedMapDatasetError>> {
  const rowCountResult = validateRowCount(input.rows.length);
  if (rowCountResult.isErr()) {
    return err(rowCountResult.error);
  }

  const currentResult = await deps.repo.getDatasetForUser(input.datasetId, input.userId);
  if (currentResult.isErr()) {
    return err(currentResult.error);
  }

  if (currentResult.value === null) {
    return err(createNotFoundError());
  }

  const rowsResult = validateDatasetRows(input.rows);
  if (rowsResult.isErr()) {
    return err(rowsResult.error);
  }

  const result = await deps.repo.replaceDatasetRows({
    datasetId: input.datasetId,
    userId: input.userId,
    rows: rowsResult.value,
    allowPublicWrite: input.allowPublicWrite === true,
  });

  if (result.isErr()) {
    return err(result.error);
  }

  if (result.value === null) {
    return err(createNotFoundError());
  }

  return ok(result.value);
}
