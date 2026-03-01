import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { updateMap } from '@/modules/advanced-map-analytics/core/usecases/update-map.js';

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
    title: 'Current map title',
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

function makeRepo(
  overrides: { updateMap?: (input: UpdateMapParams) => AdvancedMapAnalyticsMap | null } = {}
): {
  repo: AdvancedMapAnalyticsRepository;
  getUpdateCalls: () => number;
} {
  let updateCalls = 0;

  const repo: AdvancedMapAnalyticsRepository = {
    createMap: async (_input: CreateMapParams) => ok(makeMap()),
    getMapForUser: async () => ok(makeMap()),
    listMapsForUser: async () => ok([makeMap()]),
    updateMap: async (input: UpdateMapParams) => {
      updateCalls += 1;
      if (overrides.updateMap !== undefined) {
        return ok(overrides.updateMap(input));
      }

      return ok(
        makeMap({
          title: input.title,
          description: input.description,
          visibility: input.visibility,
          publicId: input.publicId,
        })
      );
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

  return {
    repo,
    getUpdateCalls: () => updateCalls,
  };
}

describe('updateMap', () => {
  it('returns InvalidInputError for whitespace-only title and does not persist update', async () => {
    const { repo, getUpdateCalls } = makeRepo();

    const result = await updateMap(
      {
        repo,
        generatePublicId: () => 'public_1',
      },
      {
        request: {
          userId: 'user_1',
          mapId: 'map_1',
          title: '   ',
        },
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('InvalidInputError');
      expect(result.error.message).toBe('title cannot be empty');
    }

    expect(getUpdateCalls()).toBe(0);
  });
});
