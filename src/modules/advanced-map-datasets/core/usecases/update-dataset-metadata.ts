import { err, ok, type Result } from 'neverthrow';

import {
  normalizeNullableMarkdown,
  normalizeNullableText,
  normalizeOptionalText,
  validateDescription,
  validateMarkdown,
  validateTitle,
  validateUnit,
} from './helpers.js';
import {
  createDatasetInUseError,
  createInvalidInputError,
  createNotFoundError,
  type AdvancedMapDatasetError,
} from '../errors.js';

import type { AdvancedMapDatasetRepository } from '../ports.js';
import type { AdvancedMapDatasetDetail, AdvancedMapDatasetVisibility } from '../types.js';

export interface UpdateAdvancedMapDatasetMetadataDeps {
  repo: AdvancedMapDatasetRepository;
}

export interface UpdateAdvancedMapDatasetMetadataUseCaseInput {
  request: import('../types.js').UpdateAdvancedMapDatasetInput;
}

export async function updateAdvancedMapDatasetMetadata(
  deps: UpdateAdvancedMapDatasetMetadataDeps,
  input: UpdateAdvancedMapDatasetMetadataUseCaseInput
): Promise<Result<AdvancedMapDatasetDetail, AdvancedMapDatasetError>> {
  const { request } = input;
  const hasPatchField =
    request.title !== undefined ||
    request.description !== undefined ||
    request.markdown !== undefined ||
    request.unit !== undefined ||
    request.visibility !== undefined;

  if (!hasPatchField) {
    return err(createInvalidInputError('At least one patch field is required'));
  }

  const currentResult = await deps.repo.getDatasetForUser(request.datasetId, request.userId);
  if (currentResult.isErr()) {
    return err(currentResult.error);
  }

  if (currentResult.value === null) {
    return err(createNotFoundError());
  }

  const current = currentResult.value;
  const normalizedTitle = normalizeOptionalText(request.title);
  if (request.title !== undefined && normalizedTitle === undefined) {
    return err(createInvalidInputError('title cannot be empty'));
  }

  const titleResult = validateTitle(normalizedTitle ?? current.title, 'title');
  if (titleResult.isErr()) {
    return err(titleResult.error);
  }

  const normalizedDescription =
    request.description !== undefined ? normalizeNullableText(request.description) : undefined;
  const descriptionResult = validateDescription(
    normalizedDescription !== undefined ? normalizedDescription : current.description,
    'description'
  );
  if (descriptionResult.isErr()) {
    return err(descriptionResult.error);
  }

  const normalizedMarkdown =
    request.markdown !== undefined ? normalizeNullableMarkdown(request.markdown) : undefined;
  const markdownResult = validateMarkdown(
    normalizedMarkdown !== undefined ? normalizedMarkdown : current.markdown,
    'markdown'
  );
  if (markdownResult.isErr()) {
    return err(markdownResult.error);
  }

  const unitResult = validateUnit(request.unit !== undefined ? request.unit : current.unit);
  if (unitResult.isErr()) {
    return err(unitResult.error);
  }

  const visibility: AdvancedMapDatasetVisibility = request.visibility ?? current.visibility;
  if (current.visibility !== 'private' && visibility === 'private') {
    const publicReferencesResult = await deps.repo.listPublicReferencingMaps(request.datasetId);
    if (publicReferencesResult.isErr()) {
      return err(publicReferencesResult.error);
    }

    if (publicReferencesResult.value.length > 0) {
      return err(
        createDatasetInUseError(
          publicReferencesResult.value,
          'Dataset is referenced by public maps and cannot be made private'
        )
      );
    }
  }

  // The repository re-checks private-downgrade safety under a transaction-
  // scoped dataset advisory lock. See:
  // docs/specs/specs-202604091600-advanced-map-dataset-consistency-boundary.md
  const updateResult = await deps.repo.updateDatasetMetadata({
    datasetId: request.datasetId,
    userId: request.userId,
    title: titleResult.value,
    description: descriptionResult.value,
    markdown: markdownResult.value,
    unit: unitResult.value,
    visibility,
    allowPublicWrite: request.allowPublicWrite === true,
  });

  if (updateResult.isErr()) {
    return err(updateResult.error);
  }

  if (updateResult.value === null) {
    return err(createNotFoundError());
  }

  return ok(updateResult.value);
}
