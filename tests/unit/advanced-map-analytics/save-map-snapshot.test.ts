import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { saveMapSnapshot } from '@/modules/advanced-map-analytics/core/usecases/save-map-snapshot.js';

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
    title: 'Current Map Title',
    description: 'Current description',
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

function makeSnapshot(
  overrides: Partial<AdvancedMapAnalyticsSnapshotDetail> = {}
): AdvancedMapAnalyticsSnapshotDetail {
  return {
    snapshotId: 'snap_1',
    mapId: 'map_1',
    createdAt: new Date('2026-03-01T11:00:00.000Z'),
    title: 'Snapshot Title',
    description: 'Snapshot Description',
    snapshot: {
      title: 'Snapshot Title',
      description: 'Snapshot Description',
      state: { key: 'value' },
      savedAt: '2026-03-01T11:00:00.000Z',
    },
    ...overrides,
  };
}

function makeRepo(
  overrides: {
    map?: AdvancedMapAnalyticsMap | null;
    appendSnapshot?: (input: AppendSnapshotParams) => {
      map: AdvancedMapAnalyticsMap;
      snapshot: AdvancedMapAnalyticsSnapshotDetail;
    };
  } = {}
): AdvancedMapAnalyticsRepository {
  const map = overrides.map ?? makeMap();

  return {
    createMap: async (_input: CreateMapParams) => ok(makeMap()),
    getMapForUser: async () => ok(map),
    listMapsForUser: async () => ok(map !== null ? [map] : []),
    updateMap: async (_input: UpdateMapParams) => ok(map),
    softDeleteMap: async (_mapId: string, _userId: string) => ok(true),
    appendSnapshot: async (input: AppendSnapshotParams) => {
      if (overrides.appendSnapshot !== undefined) {
        return ok(overrides.appendSnapshot(input));
      }

      return ok({
        map: makeMap({
          lastSnapshotId: input.snapshotId,
          lastSnapshot: input.snapshotDocument,
          snapshotCount: (map?.snapshotCount ?? 0) + 1,
        }),
        snapshot: makeSnapshot({
          snapshotId: input.snapshotId,
          title: input.snapshotTitle,
          description: input.snapshotDescription,
          snapshot: input.snapshotDocument,
        }),
      });
    },
    listSnapshotsForMap: async (_mapId: string) => ok([] as AdvancedMapAnalyticsSnapshotSummary[]),
    getSnapshotById: async (_mapId: string, _snapshotId: string) => ok(null),
    getPublicViewByPublicId: async (_publicId: string) =>
      ok(null as AdvancedMapAnalyticsPublicView | null),
    incrementPublicViewCount: async (_mapId: string) => ok(undefined),
  };
}

describe('saveMapSnapshot', () => {
  it('falls back to current map description when request description is omitted', async () => {
    let receivedDescription: string | null | undefined;

    const repo = makeRepo({
      appendSnapshot: (input) => {
        receivedDescription = input.snapshotDescription;
        return {
          map: makeMap({
            lastSnapshotId: input.snapshotId,
            lastSnapshot: input.snapshotDocument,
            snapshotCount: 1,
          }),
          snapshot: makeSnapshot({
            snapshotId: input.snapshotId,
            description: input.snapshotDescription,
            snapshot: input.snapshotDocument,
          }),
        };
      },
    });

    const result = await saveMapSnapshot(
      {
        repo,
        now: () => new Date('2026-03-01T11:00:00.000Z'),
        generateSnapshotId: () => 'snap_123',
        generatePublicId: () => 'pub_123',
      },
      {
        request: {
          userId: 'user_1',
          mapId: 'map_1',
          state: { bins: [] },
          title: 'Snapshot A',
        },
      }
    );

    expect(result.isOk()).toBe(true);
    expect(receivedDescription).toBe('Current description');

    if (result.isOk()) {
      expect(result.value.snapshot.description).toBe('Current description');
    }
  });

  it('stores provided description when request description exists', async () => {
    const repo = makeRepo();

    const result = await saveMapSnapshot(
      {
        repo,
        now: () => new Date('2026-03-01T11:00:00.000Z'),
        generateSnapshotId: () => 'snap_124',
        generatePublicId: () => 'pub_123',
      },
      {
        request: {
          userId: 'user_1',
          mapId: 'map_1',
          state: { bins: [] },
          title: 'Snapshot B',
          description: 'Snapshot override description',
        },
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.snapshot.description).toBe('Snapshot override description');
    }
  });

  it('returns SnapshotLimitReachedError when map has reached cap', async () => {
    const repo = makeRepo({
      map: makeMap({ snapshotCount: 200 }),
    });

    const result = await saveMapSnapshot(
      {
        repo,
        now: () => new Date('2026-03-01T11:00:00.000Z'),
        generateSnapshotId: () => 'snap_125',
        generatePublicId: () => 'pub_123',
      },
      {
        request: {
          userId: 'user_1',
          mapId: 'map_1',
          state: { bins: [] },
        },
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('SnapshotLimitReachedError');
      if (result.error.type === 'SnapshotLimitReachedError') {
        expect(result.error.limit).toBe(200);
      }
    }
  });
});
