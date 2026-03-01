import { err, ok, type Result } from 'neverthrow';

import {
  createNotFoundError,
  createProviderError,
  type AdvancedMapAnalyticsError,
} from '../errors.js';

import type { AdvancedMapAnalyticsRepository } from '../ports.js';
import type { AdvancedMapAnalyticsSnapshotDetail } from '../types.js';

export interface GetMapSnapshotDeps {
  repo: AdvancedMapAnalyticsRepository;
}

export interface GetMapSnapshotInput {
  userId: string;
  mapId: string;
  snapshotId: string;
}

export async function getMapSnapshot(
  deps: GetMapSnapshotDeps,
  input: GetMapSnapshotInput
): Promise<Result<AdvancedMapAnalyticsSnapshotDetail, AdvancedMapAnalyticsError>> {
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

  let snapshotResult: Awaited<ReturnType<AdvancedMapAnalyticsRepository['getSnapshotById']>>;
  try {
    snapshotResult = await deps.repo.getSnapshotById(input.mapId, input.snapshotId);
  } catch (error) {
    return err(createProviderError('Failed to load snapshot', error));
  }

  if (snapshotResult.isErr()) {
    return err(snapshotResult.error);
  }

  if (snapshotResult.value === null) {
    return err(createNotFoundError('Snapshot not found'));
  }

  return ok(snapshotResult.value);
}
