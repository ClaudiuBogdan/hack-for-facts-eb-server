import { err, ok, type Result } from 'neverthrow';

import {
  createNotFoundError,
  createProviderError,
  type AdvancedMapAnalyticsError,
} from '../errors.js';

import type { AdvancedMapAnalyticsRepository } from '../ports.js';

export interface DeleteMapDeps {
  repo: AdvancedMapAnalyticsRepository;
}

export interface DeleteMapInput {
  userId: string;
  mapId: string;
  allowPublicWrite?: boolean;
}

export async function deleteMap(
  deps: DeleteMapDeps,
  input: DeleteMapInput
): Promise<Result<void, AdvancedMapAnalyticsError>> {
  let deleteResult: Awaited<ReturnType<AdvancedMapAnalyticsRepository['softDeleteMap']>>;

  try {
    deleteResult = await deps.repo.softDeleteMap(
      input.mapId,
      input.userId,
      input.allowPublicWrite === true
    );
  } catch (error) {
    return err(createProviderError('Failed to delete map', error));
  }

  if (deleteResult.isErr()) {
    return err(deleteResult.error);
  }

  if (!deleteResult.value) {
    return err(createNotFoundError('Map not found'));
  }

  return ok(undefined);
}
