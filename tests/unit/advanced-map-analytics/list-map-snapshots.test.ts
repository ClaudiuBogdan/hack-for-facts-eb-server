import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { listMapSnapshots } from '@/modules/advanced-map-analytics/core/usecases/list-map-snapshots.js';

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

function makeMap(): AdvancedMapAnalyticsMap {
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
  };
}

function makeRepo(
  summaries: AdvancedMapAnalyticsSnapshotSummary[]
): AdvancedMapAnalyticsRepository {
  return {
    createMap: async (_input: CreateMapParams) => ok(makeMap()),
    getMapForUser: async () => ok(makeMap()),
    listMapsForUser: async () => ok([]),
    updateMap: async (_input: UpdateMapParams) => ok(makeMap()),
    softDeleteMap: async (_mapId: string, _userId: string, _allowPublicWrite: boolean) => ok(true),
    appendSnapshot: async (_input: AppendSnapshotParams) =>
      ok({
        map: makeMap(),
        snapshot: {
          snapshotId: 'snap_1',
          mapId: 'map_1',
          createdAt: new Date('2026-03-01T10:00:00.000Z'),
          title: 'T',
          description: null,
          snapshot: {
            title: 'T',
            description: null,
            state: {},
            savedAt: '2026-03-01T10:00:00.000Z',
          },
        },
      }),
    listSnapshotsForMap: async () => ok(summaries),
    getSnapshotById: async (_mapId: string, _snapshotId: string) =>
      ok(null as AdvancedMapAnalyticsSnapshotDetail | null),
    getPublicViewByPublicId: async (_publicId: string) =>
      ok(null as AdvancedMapAnalyticsPublicView | null),
    incrementPublicViewCount: async (_mapId: string) => ok(undefined),
  };
}

describe('listMapSnapshots', () => {
  it('returns snapshot summaries including description field from repository metadata', async () => {
    const summaries: AdvancedMapAnalyticsSnapshotSummary[] = [
      {
        snapshotId: 's1',
        mapId: 'map_1',
        createdAt: new Date('2026-03-01T12:00:00.000Z'),
        title: 'Snapshot 1',
        description: 'Fast listing description',
      },
    ];

    const result = await listMapSnapshots(
      { repo: makeRepo(summaries) },
      {
        userId: 'user_1',
        mapId: 'map_1',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.description).toBe('Fast listing description');
      expect(result.value[0]?.title).toBe('Snapshot 1');
    }
  });
});
