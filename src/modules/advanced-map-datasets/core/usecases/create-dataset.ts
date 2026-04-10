import { err, type Result } from 'neverthrow';

import {
  normalizeNullableText,
  normalizeNullableMarkdown,
  validateDatasetRows,
  validateRowCount,
  validateDescription,
  validateMarkdown,
  validateTitle,
  validateUnit,
} from './helpers.js';
import { createInvalidInputError, type AdvancedMapDatasetError } from '../errors.js';

import type { AdvancedMapDatasetRepository } from '../ports.js';
import type {
  AdvancedMapDatasetDetail,
  AdvancedMapDatasetVisibility,
  CreateAdvancedMapDatasetInput,
} from '../types.js';

export interface CreateAdvancedMapDatasetDeps {
  repo: AdvancedMapDatasetRepository;
  generateId: () => string;
  generatePublicId: () => string;
}

export interface CreateAdvancedMapDatasetUseCaseInput {
  request: CreateAdvancedMapDatasetInput;
}

export async function createAdvancedMapDataset(
  deps: CreateAdvancedMapDatasetDeps,
  input: CreateAdvancedMapDatasetUseCaseInput
): Promise<Result<AdvancedMapDatasetDetail, AdvancedMapDatasetError>> {
  const titleResult = validateTitle(input.request.title, 'title');
  if (titleResult.isErr()) {
    return err(titleResult.error);
  }

  const descriptionResult = validateDescription(
    normalizeNullableText(input.request.description) ?? null,
    'description'
  );
  if (descriptionResult.isErr()) {
    return err(descriptionResult.error);
  }

  const markdownResult = validateMarkdown(
    normalizeNullableMarkdown(input.request.markdown) ?? null,
    'markdown'
  );
  if (markdownResult.isErr()) {
    return err(markdownResult.error);
  }

  const unitResult = validateUnit(input.request.unit);
  if (unitResult.isErr()) {
    return err(unitResult.error);
  }

  const rowCountResult = validateRowCount(input.request.rows.length);
  if (rowCountResult.isErr()) {
    return err(rowCountResult.error);
  }

  const rowsResult = validateDatasetRows(input.request.rows);
  if (rowsResult.isErr()) {
    return err(rowsResult.error);
  }

  const visibility: AdvancedMapDatasetVisibility = input.request.visibility ?? 'private';
  const id = deps.generateId().trim();
  const publicId = deps.generatePublicId().trim();

  if (id.length === 0 || publicId.length === 0) {
    return err(createInvalidInputError('Generated dataset identifiers cannot be empty'));
  }

  return deps.repo.createDataset({
    id,
    publicId,
    userId: input.request.userId,
    title: titleResult.value,
    description: descriptionResult.value,
    markdown: markdownResult.value,
    unit: unitResult.value,
    visibility,
    rows: rowsResult.value,
  });
}
