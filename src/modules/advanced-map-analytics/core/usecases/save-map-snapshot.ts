import { err, ok, type Result } from 'neverthrow';

import {
  createInvalidInputError,
  createNotFoundError,
  createProviderError,
  createSnapshotLimitReachedError,
  type AdvancedMapAnalyticsError,
} from '../errors.js';
import {
  ADVANCED_MAP_ANALYTICS_SNAPSHOT_CAP,
  type AdvancedMapAnalyticsMap,
  type AdvancedMapAnalyticsSnapshotDetail,
  type AdvancedMapAnalyticsVisibility,
  type SaveAdvancedMapAnalyticsSnapshotInput,
} from '../types.js';
import {
  normalizeNullableText,
  normalizeOptionalText,
  validateDescription,
  validateTitle,
} from './helpers.js';

import type { AdvancedMapAnalyticsRepository } from '../ports.js';

export interface SaveMapSnapshotDeps {
  repo: AdvancedMapAnalyticsRepository;
  now?: () => Date;
  generateSnapshotId: () => string;
  generatePublicId: () => string;
  snapshotCap?: number;
}

export interface SaveMapSnapshotInput {
  request: SaveAdvancedMapAnalyticsSnapshotInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function loadOwnedMap(
  repo: AdvancedMapAnalyticsRepository,
  userId: string,
  mapId: string
): Promise<Result<AdvancedMapAnalyticsMap, AdvancedMapAnalyticsError>> {
  let mapResult: Awaited<ReturnType<AdvancedMapAnalyticsRepository['getMapForUser']>>;

  try {
    mapResult = await repo.getMapForUser(mapId, userId);
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

export async function saveMapSnapshot(
  deps: SaveMapSnapshotDeps,
  input: SaveMapSnapshotInput
): Promise<
  Result<
    { map: AdvancedMapAnalyticsMap; snapshot: AdvancedMapAnalyticsSnapshotDetail },
    AdvancedMapAnalyticsError
  >
> {
  const { request } = input;
  const now = (deps.now ?? (() => new Date()))();
  const snapshotCap = deps.snapshotCap ?? ADVANCED_MAP_ANALYTICS_SNAPSHOT_CAP;

  if (!isRecord(request.state)) {
    return err(createInvalidInputError('snapshot state must be a JSON object'));
  }

  const mapResult = await loadOwnedMap(deps.repo, request.userId, request.mapId);
  if (mapResult.isErr()) {
    return err(mapResult.error);
  }

  const map = mapResult.value;

  if (map.snapshotCount >= snapshotCap) {
    return err(createSnapshotLimitReachedError(snapshotCap));
  }

  const normalizedSnapshotTitle = normalizeOptionalText(request.title);
  const snapshotTitleResult = validateTitle(normalizedSnapshotTitle ?? map.title, 'snapshot title');
  if (snapshotTitleResult.isErr()) {
    return err(snapshotTitleResult.error);
  }

  const normalizedSnapshotDescription =
    request.description !== undefined ? normalizeNullableText(request.description) : undefined;
  const snapshotDescriptionResult = validateDescription(
    normalizedSnapshotDescription !== undefined ? normalizedSnapshotDescription : map.description,
    'snapshot description'
  );
  if (snapshotDescriptionResult.isErr()) {
    return err(snapshotDescriptionResult.error);
  }

  const mapPatch = request.mapPatch;
  const normalizedMapPatchTitle = normalizeOptionalText(mapPatch?.title);
  if (mapPatch?.title !== undefined && normalizedMapPatchTitle === undefined) {
    return err(createInvalidInputError('mapPatch.title cannot be empty'));
  }

  const mapTitleResult = validateTitle(normalizedMapPatchTitle ?? map.title, 'map title');
  if (mapTitleResult.isErr()) {
    return err(mapTitleResult.error);
  }

  const normalizedMapPatchDescription =
    mapPatch?.description !== undefined ? normalizeNullableText(mapPatch.description) : undefined;
  const mapDescriptionResult = validateDescription(
    normalizedMapPatchDescription !== undefined ? normalizedMapPatchDescription : map.description,
    'map description'
  );
  if (mapDescriptionResult.isErr()) {
    return err(mapDescriptionResult.error);
  }

  const nextVisibility: AdvancedMapAnalyticsVisibility = mapPatch?.visibility ?? map.visibility;
  const nextPublicId =
    nextVisibility === 'public' ? (map.publicId ?? deps.generatePublicId()) : map.publicId;

  const snapshotId = deps.generateSnapshotId();
  if (snapshotId.trim().length === 0) {
    return err(createInvalidInputError('Generated snapshot id cannot be empty'));
  }

  const snapshotDocument = {
    title: snapshotTitleResult.value,
    description: snapshotDescriptionResult.value,
    state: request.state,
    savedAt: now.toISOString(),
  };

  let appendResult: Awaited<ReturnType<AdvancedMapAnalyticsRepository['appendSnapshot']>>;
  try {
    appendResult = await deps.repo.appendSnapshot({
      mapId: request.mapId,
      userId: request.userId,
      snapshotId,
      snapshotTitle: snapshotTitleResult.value,
      snapshotDescription: snapshotDescriptionResult.value,
      snapshotDocument,
      nextMapTitle: mapTitleResult.value,
      nextMapDescription: mapDescriptionResult.value,
      nextVisibility,
      nextPublicId,
      snapshotCap,
    });
  } catch (error) {
    return err(createProviderError('Failed to save snapshot', error));
  }

  if (appendResult.isErr()) {
    return err(appendResult.error);
  }

  return ok(appendResult.value);
}
