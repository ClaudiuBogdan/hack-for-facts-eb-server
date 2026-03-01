import { err, ok, type Result } from 'neverthrow';

import {
  createNotFoundError,
  createProviderError,
  type AdvancedMapAnalyticsError,
} from '../errors.js';

import type { AdvancedMapAnalyticsRepository } from '../ports.js';
import type { AdvancedMapAnalyticsPublicView } from '../types.js';

export interface GetPublicMapDeps {
  repo: AdvancedMapAnalyticsRepository;
}

export interface GetPublicMapInput {
  publicId: string;
}

export async function getPublicMap(
  deps: GetPublicMapDeps,
  input: GetPublicMapInput
): Promise<Result<AdvancedMapAnalyticsPublicView, AdvancedMapAnalyticsError>> {
  let result: Awaited<ReturnType<AdvancedMapAnalyticsRepository['getPublicViewByPublicId']>>;

  try {
    result = await deps.repo.getPublicViewByPublicId(input.publicId);
  } catch (error) {
    return err(createProviderError('Failed to load public map', error));
  }

  if (result.isErr()) {
    return err(result.error);
  }

  if (result.value === null) {
    return err(createNotFoundError('Public map not found'));
  }

  return ok(result.value);
}
