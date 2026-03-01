import { err, ok, type Result } from 'neverthrow';

import {
  createInvalidInputError,
  createNotFoundError,
  createProviderError,
  type AdvancedMapAnalyticsError,
} from '../errors.js';
import {
  normalizeNullableText,
  normalizeOptionalText,
  validateDescription,
  validateTitle,
} from './helpers.js';

import type { AdvancedMapAnalyticsRepository } from '../ports.js';
import type {
  AdvancedMapAnalyticsMap,
  AdvancedMapAnalyticsVisibility,
  UpdateAdvancedMapAnalyticsMapInput,
} from '../types.js';

export interface UpdateMapDeps {
  repo: AdvancedMapAnalyticsRepository;
  generatePublicId: () => string;
}

export interface UpdateMapInput {
  request: UpdateAdvancedMapAnalyticsMapInput;
}

export async function updateMap(
  deps: UpdateMapDeps,
  input: UpdateMapInput
): Promise<Result<AdvancedMapAnalyticsMap, AdvancedMapAnalyticsError>> {
  const { request } = input;

  const hasPatchField =
    request.title !== undefined ||
    request.description !== undefined ||
    request.visibility !== undefined;
  if (!hasPatchField) {
    return err(createInvalidInputError('At least one patch field is required'));
  }

  let currentMapResult: Awaited<ReturnType<AdvancedMapAnalyticsRepository['getMapForUser']>>;
  try {
    currentMapResult = await deps.repo.getMapForUser(request.mapId, request.userId);
  } catch (error) {
    return err(createProviderError('Failed to load map', error));
  }

  if (currentMapResult.isErr()) {
    return err(currentMapResult.error);
  }

  const currentMap = currentMapResult.value;
  if (currentMap === null) {
    return err(createNotFoundError('Map not found'));
  }

  const normalizedTitle = normalizeOptionalText(request.title);
  if (request.title !== undefined && normalizedTitle === undefined) {
    return err(createInvalidInputError('title cannot be empty'));
  }

  const titleToSave = normalizedTitle ?? currentMap.title;
  const titleResult = validateTitle(titleToSave, 'title');
  if (titleResult.isErr()) {
    return err(titleResult.error);
  }

  const normalizedDescription = normalizeNullableText(request.description);
  const descriptionToSave =
    normalizedDescription !== undefined ? normalizedDescription : currentMap.description;
  const descriptionResult = validateDescription(descriptionToSave, 'description');
  if (descriptionResult.isErr()) {
    return err(descriptionResult.error);
  }

  const visibility: AdvancedMapAnalyticsVisibility = request.visibility ?? currentMap.visibility;
  const publicId =
    visibility === 'public'
      ? (currentMap.publicId ?? deps.generatePublicId())
      : currentMap.publicId;

  let updatedResult: Awaited<ReturnType<AdvancedMapAnalyticsRepository['updateMap']>>;
  try {
    updatedResult = await deps.repo.updateMap({
      mapId: request.mapId,
      userId: request.userId,
      title: titleResult.value,
      description: descriptionResult.value,
      visibility,
      publicId,
    });
  } catch (error) {
    return err(createProviderError('Failed to update map', error));
  }

  if (updatedResult.isErr()) {
    return err(updatedResult.error);
  }

  if (updatedResult.value === null) {
    return err(createNotFoundError('Map not found'));
  }

  return ok(updatedResult.value);
}
