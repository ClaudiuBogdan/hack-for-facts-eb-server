import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { deleteMap } from '@/modules/advanced-map-analytics/core/usecases/delete-map.js';

import type {
  AdvancedMapAnalyticsRepository,
  AppendSnapshotParams,
  CreateMapParams,
  UpdateMapParams,
} from '@/modules/advanced-map-analytics/core/ports.js';
import type {
  AdvancedMapAnalyticsMap,
  AdvancedMapAnalyticsPublicView,
  AdvancedMapAnalyticsSnapshotDetail,
  AdvancedMapAnalyticsSnapshotSummary,
} from '@/modules/advanced-map-analytics/core/types.js';

function makeMap(overrides: Partial<AdvancedMapAnalyticsMap> = {}): AdvancedMapAnalyticsMap {
  return {
    mapId: 'map_1',
    userId: 'user_1',
    title: 'Map',
    description: null,
    visibility: 'private',
    publicId: null,
    lastSnapshotId: null,
    lastSnapshot: null,
    snapshotCount: 0,
    viewCount: 0,
    createdAt: new Date('2026-03-01T10:00:00.000Z'),
    updatedAt: new Date('2026-03-01T10:00:00.000Z'),
    ...overrides,
  };
}

function makeRepo(
  overrides: {
    softDeleteMap?: (
      mapId: string,
      userId: string
    ) => ReturnType<AdvancedMapAnalyticsRepository['softDeleteMap']>;
  } = {}
): AdvancedMapAnalyticsRepository {
  return {
    createMap: async (_input: CreateMapParams) => ok(makeMap()),
    getMapForUser: async () => ok(makeMap()),
    listMapsForUser: async () => ok([makeMap()]),
    updateMap: async (_input: UpdateMapParams) => ok(makeMap()),
    softDeleteMap: async (mapId: string, userId: string) => {
      if (overrides.softDeleteMap !== undefined) {
        return overrides.softDeleteMap(mapId, userId);
      }

      return ok(true);
    },
    appendSnapshot: async (_input: AppendSnapshotParams) =>
      ok({
        map: makeMap(),
        snapshot: {
          snapshotId: 'snap_1',
          mapId: 'map_1',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          title: 'Snapshot',
          description: null,
          snapshot: {
            title: 'Snapshot',
            description: null,
            state: {},
            savedAt: '2026-03-01T10:00:00.000Z',
          },
        },
      }),
    listSnapshotsForMap: async () => ok([] as AdvancedMapAnalyticsSnapshotSummary[]),
    getSnapshotById: async (_mapId: string, _snapshotId: string) =>
      ok(null as AdvancedMapAnalyticsSnapshotDetail | null),
    getPublicViewByPublicId: async (_publicId: string) =>
      ok(null as AdvancedMapAnalyticsPublicView | null),
    incrementPublicViewCount: async (_mapId: string) => ok(undefined),
  };
}

describe('deleteMap', () => {
  it('returns ok when repository soft deletes the map', async () => {
    const repo = makeRepo();

    const result = await deleteMap(
      { repo },
      {
        userId: 'user_1',
        mapId: 'map_1',
      }
    );

    expect(result.isOk()).toBe(true);
  });

  it('returns NotFoundError when repository reports map not found', async () => {
    const repo = makeRepo({
      softDeleteMap: async () => ok(false),
    });

    const result = await deleteMap(
      { repo },
      {
        userId: 'user_1',
        mapId: 'map_missing',
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('NotFoundError');
      expect(result.error.message).toBe('Map not found');
    }
  });

  it('returns ProviderError when repository throws', async () => {
    const repo = makeRepo({
      softDeleteMap: async () => {
        throw new Error('db unavailable');
      },
    });

    const result = await deleteMap(
      { repo },
      {
        userId: 'user_1',
        mapId: 'map_1',
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ProviderError');
      expect(result.error.message).toBe('Failed to delete map');
    }
  });
});
