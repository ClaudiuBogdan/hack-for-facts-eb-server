import { err, type Result } from 'neverthrow';

import {
  createInvalidInputError,
  createProviderError,
  type AdvancedMapAnalyticsError,
} from '../errors.js';
import {
  buildDefaultTitle,
  normalizeNullableText,
  normalizeOptionalText,
  validateDescription,
  validateTitle,
} from './helpers.js';

import type { AdvancedMapAnalyticsRepository } from '../ports.js';
import type {
  AdvancedMapAnalyticsMap,
  CreateAdvancedMapAnalyticsMapInput,
  AdvancedMapAnalyticsVisibility,
} from '../types.js';

export interface CreateMapDeps {
  repo: AdvancedMapAnalyticsRepository;
  now?: () => Date;
  generateMapId: () => string;
  generatePublicId: () => string;
}

export interface CreateMapInput {
  request: CreateAdvancedMapAnalyticsMapInput;
}

export async function createMap(
  deps: CreateMapDeps,
  input: CreateMapInput
): Promise<Result<AdvancedMapAnalyticsMap, AdvancedMapAnalyticsError>> {
  const now = (deps.now ?? (() => new Date()))();
  const requestedTitle = normalizeOptionalText(input.request.title);
  const effectiveTitleRaw = requestedTitle ?? buildDefaultTitle(now);

  const titleResult = validateTitle(effectiveTitleRaw, 'title');
  if (titleResult.isErr()) {
    return err(titleResult.error);
  }

  const normalizedDescription = normalizeNullableText(input.request.description);
  const descriptionResult = validateDescription(normalizedDescription ?? null, 'description');
  if (descriptionResult.isErr()) {
    return err(descriptionResult.error);
  }

  const visibility: AdvancedMapAnalyticsVisibility = input.request.visibility ?? 'private';

  const mapId = deps.generateMapId();
  if (mapId.trim().length === 0) {
    return err(createInvalidInputError('Generated map id cannot be empty'));
  }

  const publicId = visibility === 'public' ? deps.generatePublicId() : null;

  try {
    return await deps.repo.createMap({
      mapId,
      userId: input.request.userId,
      title: titleResult.value,
      description: descriptionResult.value,
      visibility,
      publicId,
    });
  } catch (error) {
    return err(createProviderError('Failed to create map', error));
  }
}
