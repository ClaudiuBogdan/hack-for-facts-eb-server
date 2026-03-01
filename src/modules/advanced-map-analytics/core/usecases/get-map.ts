import { err, ok, type Result } from 'neverthrow';

import {
  createNotFoundError,
  createProviderError,
  type AdvancedMapAnalyticsError,
} from '../errors.js';

import type { AdvancedMapAnalyticsRepository } from '../ports.js';
import type { AdvancedMapAnalyticsMap } from '../types.js';

export interface GetMapDeps {
  repo: AdvancedMapAnalyticsRepository;
}

export interface GetMapInput {
  userId: string;
  mapId: string;
}

export async function getMap(
  deps: GetMapDeps,
  input: GetMapInput
): Promise<Result<AdvancedMapAnalyticsMap, AdvancedMapAnalyticsError>> {
  let mapResult: Awaited<ReturnType<AdvancedMapAnalyticsRepository['getMapForUser']>>;

  try {
    mapResult = await deps.repo.getMapForUser(input.mapId, input.userId);
  } catch (error) {
    return err(createProviderError('Failed to load map', error));
  }

  if (mapResult.isErr()) {
    return err(mapResult.error);
  }

  if (mapResult.value === null) {
    return err(createNotFoundError('Map not found'));
  }

  return ok(mapResult.value);
}
