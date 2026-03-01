import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import { describe, expect, it, afterAll, beforeEach } from 'vitest';

import { createNotFoundError } from '@/modules/advanced-map-analytics/core/errors.js';
import { makeAdvancedMapAnalyticsRoutes } from '@/modules/advanced-map-analytics/shell/rest/routes.js';
import { createTestAuthProvider, makeAuthMiddleware } from '@/modules/auth/index.js';

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
import type { GroupedSeriesProvider } from '@/modules/advanced-map-analytics/grouped-series/core/ports.js';

type InMemoryMapRecord = AdvancedMapAnalyticsMap;
type InMemorySnapshotRecord = AdvancedMapAnalyticsSnapshotDetail;

class InMemoryAdvancedMapAnalyticsRepo implements AdvancedMapAnalyticsRepository {
  private maps = new Map<string, InMemoryMapRecord>();
  private snapshots = new Map<string, InMemorySnapshotRecord[]>();
  private deletedMapIds = new Set<string>();
  private failIncrementPublicViewCount = false;

  setFailIncrementPublicViewCount(value: boolean) {
    this.failIncrementPublicViewCount = value;
  }

  async createMap(input: CreateMapParams) {
    const now = new Date('2026-03-01T10:00:00.000Z');
    const record: InMemoryMapRecord = {
      mapId: input.mapId,
      userId: input.userId,
      title: input.title,
      description: input.description,
      visibility: input.visibility,
      publicId: input.publicId,
      lastSnapshotId: null,
      lastSnapshot: null,
      snapshotCount: 0,
      viewCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.maps.set(record.mapId, record);
    this.snapshots.set(record.mapId, []);
    this.deletedMapIds.delete(record.mapId);

    return ok(record);
  }

  async getMapForUser(mapId: string, userId: string) {
    if (this.deletedMapIds.has(mapId)) {
      return ok(null);
    }

    const map = this.maps.get(mapId);
    if (map?.userId !== userId) {
      return ok(null);
    }

    return ok(map);
  }

  async listMapsForUser(userId: string) {
    return ok(
      Array.from(this.maps.values()).filter(
        (map) => map.userId === userId && !this.deletedMapIds.has(map.mapId)
      )
    );
  }

  async updateMap(input: UpdateMapParams) {
    if (this.deletedMapIds.has(input.mapId)) {
      return ok(null);
    }

    const map = this.maps.get(input.mapId);
    if (map === undefined || map.userId !== input.userId) {
      return ok(null);
    }

    const updated: InMemoryMapRecord = {
      ...map,
      title: input.title,
      description: input.description,
      visibility: input.visibility,
      publicId: input.publicId,
      updatedAt: new Date('2026-03-01T10:00:00.000Z'),
    };

    this.maps.set(updated.mapId, updated);
    return ok(updated);
  }

  async appendSnapshot(input: AppendSnapshotParams) {
    if (this.deletedMapIds.has(input.mapId)) {
      return err(createNotFoundError('Map not found'));
    }

    const map = this.maps.get(input.mapId);

    if (map === undefined || map.userId !== input.userId) {
      return err(createNotFoundError('Map not found'));
    }

    const snapshot: InMemorySnapshotRecord = {
      snapshotId: input.snapshotId,
      mapId: input.mapId,
      createdAt: new Date('2026-03-01T11:00:00.000Z'),
      title: input.snapshotTitle,
      description: input.snapshotDescription,
      snapshot: input.snapshotDocument,
    };

    const current = this.snapshots.get(input.mapId) ?? [];
    const nextSnapshots = [snapshot, ...current];
    this.snapshots.set(input.mapId, nextSnapshots);

    const updatedMap: InMemoryMapRecord = {
      ...map,
      title: input.nextMapTitle,
      description: input.nextMapDescription,
      visibility: input.nextVisibility,
      publicId: input.nextPublicId,
      lastSnapshotId: input.snapshotId,
      lastSnapshot: input.snapshotDocument,
      snapshotCount: map.snapshotCount + 1,
      updatedAt: new Date('2026-03-01T11:00:00.000Z'),
    };

    this.maps.set(input.mapId, updatedMap);

    return ok({
      map: updatedMap,
      snapshot,
    });
  }

  async listSnapshotsForMap(mapId: string) {
    const snapshots = this.snapshots.get(mapId) ?? [];

    const list: AdvancedMapAnalyticsSnapshotSummary[] = snapshots.map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      mapId: snapshot.mapId,
      createdAt: snapshot.createdAt,
      title: snapshot.title,
      description: snapshot.description,
    }));

    return ok(list);
  }

  async getSnapshotById(mapId: string, snapshotId: string) {
    const snapshots = this.snapshots.get(mapId) ?? [];
    const snapshot = snapshots.find((item) => item.snapshotId === snapshotId) ?? null;
    return ok(snapshot);
  }

  async getPublicViewByPublicId(publicId: string) {
    const map = Array.from(this.maps.values()).find(
      (item) =>
        item.publicId === publicId &&
        item.visibility === 'public' &&
        item.lastSnapshot !== null &&
        !this.deletedMapIds.has(item.mapId)
    );

    if (map?.publicId == null || map?.lastSnapshotId == null || map?.lastSnapshot == null) {
      return ok(null);
    }

    const view: AdvancedMapAnalyticsPublicView = {
      mapId: map.mapId,
      publicId: map.publicId,
      title: map.title,
      description: map.description,
      snapshotId: map.lastSnapshotId,
      snapshot: map.lastSnapshot,
      updatedAt: map.updatedAt,
    };

    return ok(view);
  }

  async softDeleteMap(mapId: string, userId: string) {
    const map = this.maps.get(mapId);
    if (map?.userId !== userId || this.deletedMapIds.has(mapId)) {
      return ok(false);
    }

    this.deletedMapIds.add(mapId);
    this.maps.set(mapId, {
      ...map,
      updatedAt: new Date('2026-03-01T12:00:00.000Z'),
    });
    return ok(true);
  }

  async incrementPublicViewCount(mapId: string) {
    if (this.failIncrementPublicViewCount) {
      throw new Error('Failed to increment public view count');
    }

    if (this.deletedMapIds.has(mapId)) {
      return ok(undefined);
    }

    const map = this.maps.get(mapId);
    if (map?.visibility !== 'public') {
      return ok(undefined);
    }

    const updatedMap: InMemoryMapRecord = {
      ...map,
      viewCount: map.viewCount + 1,
    };

    this.maps.set(mapId, updatedMap);
    return ok(undefined);
  }
}

function makeGroupedSeriesProvider(): GroupedSeriesProvider {
  return {
    fetchGroupedSeriesVectors: async (request) =>
      ok({
        sirutaUniverse: ['1001', '1002'],
        vectors: request.series.map((series, index) => ({
          seriesId: series.id,
          unit: 'RON',
          valuesBySirutaCode: new Map<string, number | undefined>([
            ['1001', index + 1],
            ['1002', (index + 1) * 2],
          ]),
        })),
        warnings: [],
      }),
  };
}

interface CreateTestAppOptions {
  failIncrementPublicViewCount?: boolean;
}

const createTestApp = async (options: CreateTestAppOptions = {}) => {
  const testAuth = createTestAuthProvider();
  const app = fastifyLib({ logger: false });

  app.setErrorHandler((err, _request, reply) => {
    const error = err as { statusCode?: number; name?: string; message?: string };
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    void reply.status(statusCode).send({
      ok: false,
      error: error.name ?? 'Error',
      message: error.message ?? 'An error occurred',
    });
  });

  app.addHook('preHandler', makeAuthMiddleware({ authProvider: testAuth.provider }));

  const repo = new InMemoryAdvancedMapAnalyticsRepo();
  repo.setFailIncrementPublicViewCount(options.failIncrementPublicViewCount ?? false);
  let mapIdCounter = 0;
  let snapshotIdCounter = 0;

  await app.register(
    makeAdvancedMapAnalyticsRoutes({
      repo,
      groupedSeriesProvider: makeGroupedSeriesProvider(),
      idGenerator: {
        generateMapId: () => {
          mapIdCounter += 1;
          return `map_${String(mapIdCounter)}`;
        },
        generateSnapshotId: () => {
          snapshotIdCounter += 1;
          return `snap_${String(snapshotIdCounter)}`;
        },
        generatePublicId: () => 'public_1',
      },
      now: () => new Date('2026-03-01T11:00:00.000Z'),
    })
  );

  await app.ready();

  return {
    app,
    testAuth,
    repo,
  };
};

describe('Advanced Map Analytics REST API', () => {
  let app: FastifyInstance;
  let testAuth: ReturnType<typeof createTestAuthProvider>;
  let repo: InMemoryAdvancedMapAnalyticsRepo;

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  beforeEach(async () => {
    if (app !== undefined) {
      await app.close();
    }

    const setup = await createTestApp();
    app = setup.app;
    testAuth = setup.testAuth;
    repo = setup.repo;
  });

  it('returns 401 when unauthenticated', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        'content-type': 'application/json',
      },
      payload: {
        title: 'No auth',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('creates snapshot with description and lists it from metadata fields', async () => {
    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Economic map',
        description: 'Map description',
      },
    });

    expect(createMapResponse.statusCode).toBe(201);
    const mapId = createMapResponse.json<{ data: { mapId: string } }>().data.mapId;

    const saveSnapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}/snapshots`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Snapshot 1',
        description: 'Snapshot description',
        state: {
          series: ['s1'],
        },
      },
    });

    expect(saveSnapshotResponse.statusCode).toBe(201);

    const listResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}/snapshots`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json<{ data: { description: string | null; title: string }[] }>();
    expect(listBody.data[0]?.description).toBe('Snapshot description');
    expect(listBody.data[0]?.title).toBe('Snapshot 1');
  });

  it('falls back to map description when snapshot description is omitted', async () => {
    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Map with fallback',
        description: 'Parent description fallback',
      },
    });

    const mapId = createMapResponse.json<{ data: { mapId: string } }>().data.mapId;

    const saveSnapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}/snapshots`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Snapshot fallback',
        state: {
          filters: {},
        },
      },
    });

    expect(saveSnapshotResponse.statusCode).toBe(201);

    const body = saveSnapshotResponse.json<{
      data: {
        snapshot: { description: string | null };
      };
    }>();

    expect(body.data.snapshot.description).toBe('Parent description fallback');
  });

  it('returns map detail with grouped series data in one request', async () => {
    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Bundled map',
      },
    });

    expect(createMapResponse.statusCode).toBe(201);
    const mapId = createMapResponse.json<{ data: { mapId: string } }>().data.mapId;

    const saveSnapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}/snapshots`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Snapshot with remote series',
        state: {
          series: [
            {
              id: 's_exec',
              type: 'line-items-aggregated-yearly',
              filter: {
                account_category: 'ch',
                report_type: 'Executie bugetara agregata la nivel de ordonator principal',
                report_period: {
                  type: 'YEAR',
                  selection: {
                    interval: {
                      start: '2025',
                      end: '2025',
                    },
                  },
                },
              },
            },
          ],
        },
      },
    });

    expect(saveSnapshotResponse.statusCode).toBe(201);

    const mapResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(mapResponse.statusCode).toBe(200);
    const mapBody = mapResponse.json<{
      ok: boolean;
      data: {
        groupedSeriesData: {
          manifest: { format: string; series: { series_id: string }[] };
          payload: { data: string };
          warnings: unknown[];
        };
      };
    }>();

    expect(mapBody.ok).toBe(true);
    expect(mapBody.data.groupedSeriesData.manifest.format).toBe('wide_matrix_v1');
    expect(mapBody.data.groupedSeriesData.manifest.series[0]?.series_id).toBe('s_exec');
    expect(mapBody.data.groupedSeriesData.payload.data.startsWith('siruta_code,s_exec\n')).toBe(
      true
    );
    expect(Array.isArray(mapBody.data.groupedSeriesData.warnings)).toBe(true);
  });

  it('returns empty grouped series payload when snapshot has no remote series', async () => {
    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Local only map',
      },
    });

    expect(createMapResponse.statusCode).toBe(201);
    const mapId = createMapResponse.json<{ data: { mapId: string } }>().data.mapId;

    const saveSnapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}/snapshots`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Local snapshot',
        state: {
          series: [
            {
              id: 'geo_1',
              type: 'geojson-dataset-series',
              datasetKey: 'insPop2021',
            },
          ],
        },
      },
    });

    expect(saveSnapshotResponse.statusCode).toBe(201);

    const mapResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(mapResponse.statusCode).toBe(200);
    const mapBody = mapResponse.json<{
      data: {
        groupedSeriesData: {
          manifest: { series: unknown[] };
          payload: { data: string };
        };
      };
    }>();

    expect(mapBody.data.groupedSeriesData.manifest.series).toHaveLength(0);
    expect(mapBody.data.groupedSeriesData.payload.data).toBe('siruta_code');
  });

  it('fails map detail request when stored remote series config is invalid', async () => {
    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Invalid bundled config map',
      },
    });

    expect(createMapResponse.statusCode).toBe(201);
    const mapId = createMapResponse.json<{ data: { mapId: string } }>().data.mapId;

    const saveSnapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}/snapshots`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Invalid remote snapshot',
        state: {
          series: [
            {
              id: 'broken_exec',
              type: 'line-items-aggregated-yearly',
            },
          ],
        },
      },
    });

    expect(saveSnapshotResponse.statusCode).toBe(201);

    const mapResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(mapResponse.statusCode).toBe(400);
    const mapBody = mapResponse.json<{ ok: boolean; error: string }>();
    expect(mapBody.ok).toBe(false);
    expect(mapBody.error).toBe('InvalidInputError');
  });

  it('soft deletes map for owner and makes it inaccessible', async () => {
    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Delete candidate',
      },
    });

    expect(createMapResponse.statusCode).toBe(201);
    const mapId = createMapResponse.json<{ data: { mapId: string } }>().data.mapId;

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json<{ ok: boolean }>().ok).toBe(true);

    const getResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(getResponse.statusCode).toBe(404);
    expect(getResponse.json<{ error: string }>().error).toBe('NotFoundError');

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json<{ data: { mapId: string }[] }>().data).toEqual([]);
  });

  it('returns 404 when deleting the same map twice', async () => {
    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Delete twice candidate',
      },
    });

    expect(createMapResponse.statusCode).toBe(201);
    const mapId = createMapResponse.json<{ data: { mapId: string } }>().data.mapId;

    const firstDeleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });
    expect(firstDeleteResponse.statusCode).toBe(200);

    const secondDeleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });
    expect(secondDeleteResponse.statusCode).toBe(404);
    expect(secondDeleteResponse.json<{ error: string }>().error).toBe('NotFoundError');
  });

  it('returns 404 for public endpoint after map soft delete', async () => {
    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Public delete candidate',
      },
    });

    expect(createMapResponse.statusCode).toBe(201);
    const mapId = createMapResponse.json<{ data: { mapId: string } }>().data.mapId;

    const saveSnapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}/snapshots`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Published snapshot',
        state: { bins: [1] },
        mapPatch: { visibility: 'public' },
      },
    });

    expect(saveSnapshotResponse.statusCode).toBe(201);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(deleteResponse.statusCode).toBe(200);

    const publicResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/advanced-map-analytics/public/public_1',
    });

    expect(publicResponse.statusCode).toBe(404);
    expect(publicResponse.json<{ error: string }>().error).toBe('NotFoundError');
  });

  it('returns latest snapshot from public endpoint when map is public', async () => {
    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Public candidate',
      },
    });

    const mapBody = createMapResponse.json<{ data: { mapId: string } }>();
    const mapId = mapBody.data.mapId;

    const saveSnapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}/snapshots`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Published snapshot',
        state: {
          bins: [1, 2, 3],
          series: [
            {
              id: 's_public_exec',
              type: 'line-items-aggregated-yearly',
              filter: {
                account_category: 'ch',
                report_type: 'Executie bugetara agregata la nivel de ordonator principal',
                report_period: {
                  type: 'YEAR',
                  selection: {
                    interval: {
                      start: '2025',
                      end: '2025',
                    },
                  },
                },
              },
            },
          ],
        },
        mapPatch: {
          visibility: 'public',
        },
      },
    });

    expect(saveSnapshotResponse.statusCode).toBe(201);

    const snapshotBody = saveSnapshotResponse.json<{
      data: { map: { publicId: string | null } };
    }>();
    expect(snapshotBody.data.map.publicId).toBe('public_1');

    const publicResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/advanced-map-analytics/public/public_1',
    });

    expect(publicResponse.statusCode).toBe(200);
    const publicBody = publicResponse.json<{
      ok: boolean;
      data: {
        mapId: string;
        publicId: string;
        snapshotId: string;
        groupedSeriesData: {
          manifest: { format: string; series: { series_id: string }[] };
          payload: { data: string };
        };
      };
    }>();

    expect(publicBody.ok).toBe(true);
    expect(publicBody.data.mapId).toBe(mapId);
    expect(publicBody.data.publicId).toBe('public_1');
    expect(typeof publicBody.data.snapshotId).toBe('string');
    expect(publicBody.data.groupedSeriesData.manifest.format).toBe('wide_matrix_v1');
    expect(publicBody.data.groupedSeriesData.manifest.series[0]?.series_id).toBe('s_public_exec');
    expect(
      publicBody.data.groupedSeriesData.payload.data.startsWith('siruta_code,s_public_exec\n')
    ).toBe(true);

    const ownerMapResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(ownerMapResponse.statusCode).toBe(200);
    const ownerMapBody = ownerMapResponse.json<{
      data: {
        viewCount: number;
      };
    }>();
    expect(ownerMapBody.data.viewCount).toBe(1);
  });

  it('still returns 200 from public endpoint when view counter increment fails', async () => {
    repo.setFailIncrementPublicViewCount(true);

    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Public counter failure',
      },
    });

    const mapBody = createMapResponse.json<{ data: { mapId: string } }>();
    const mapId = mapBody.data.mapId;

    const saveSnapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}/snapshots`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Published snapshot',
        state: { bins: [1] },
        mapPatch: { visibility: 'public' },
      },
    });

    expect(saveSnapshotResponse.statusCode).toBe(201);

    const publicResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/advanced-map-analytics/public/public_1',
    });

    expect(publicResponse.statusCode).toBe(200);
    const publicBody = publicResponse.json<{ ok: boolean }>();
    expect(publicBody.ok).toBe(true);

    const ownerMapResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(ownerMapResponse.statusCode).toBe(200);
    const ownerMapBody = ownerMapResponse.json<{
      data: {
        viewCount: number;
      };
    }>();
    expect(ownerMapBody.data.viewCount).toBe(0);
  });

  it('does not increment view counter for HEAD public endpoint requests', async () => {
    const createMapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/advanced-map-analytics/maps',
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Public HEAD candidate',
      },
    });

    const mapBody = createMapResponse.json<{ data: { mapId: string } }>();
    const mapId = mapBody.data.mapId;

    const saveSnapshotResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}/snapshots`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
        'content-type': 'application/json',
      },
      payload: {
        title: 'Published snapshot',
        state: { bins: [1] },
        mapPatch: { visibility: 'public' },
      },
    });

    expect(saveSnapshotResponse.statusCode).toBe(201);

    const headResponse = await app.inject({
      method: 'HEAD',
      url: '/api/v1/advanced-map-analytics/public/public_1',
    });

    expect(headResponse.statusCode).toBe(200);

    const ownerMapResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/advanced-map-analytics/maps/${mapId}`,
      headers: {
        authorization: `Bearer ${testAuth.tokens.user1}`,
      },
    });

    expect(ownerMapResponse.statusCode).toBe(200);
    const ownerMapBody = ownerMapResponse.json<{
      data: {
        viewCount: number;
      };
    }>();
    expect(ownerMapBody.data.viewCount).toBe(0);
  });
});
