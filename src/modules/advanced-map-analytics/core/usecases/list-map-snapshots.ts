import { err, type Result } from 'neverthrow';

import {
  createNotFoundError,
  createProviderError,
  type AdvancedMapAnalyticsError,
} from '../errors.js';

import type { AdvancedMapAnalyticsRepository } from '../ports.js';
import type { AdvancedMapAnalyticsSnapshotSummary } from '../types.js';

export interface ListMapSnapshotsDeps {
  repo: AdvancedMapAnalyticsRepository;
}

export interface ListMapSnapshotsInput {
  userId: string;
  mapId: string;
}

export async function listMapSnapshots(
  deps: ListMapSnapshotsDeps,
  input: ListMapSnapshotsInput
): Promise<Result<AdvancedMapAnalyticsSnapshotSummary[], AdvancedMapAnalyticsError>> {
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

  try {
    return await deps.repo.listSnapshotsForMap(input.mapId);
  } catch (error) {
    return err(createProviderError('Failed to list snapshots', error));
  }
}
