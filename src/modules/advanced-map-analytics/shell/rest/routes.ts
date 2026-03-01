/**
 * Advanced Map Analytics REST Routes
 */

import { Value } from '@sinclair/typebox/value';

import { isAuthenticated } from '@/modules/auth/index.js';
import { requireAuthHandler } from '@/modules/auth/shell/middleware/fastify-auth.js';

import {
  CreateMapBodySchema,
  ErrorResponseSchema,
  MapIdParamsSchema,
  MapListResponseSchema,
  MapResponseSchema,
  PublicMapParamsSchema,
  PublicMapResponseSchema,
  SaveSnapshotBodySchema,
  SaveSnapshotResponseSchema,
  SnapshotListResponseSchema,
  SnapshotParamsSchema,
  SnapshotResponseSchema,
  UpdateMapBodySchema,
  type CreateMapBody,
  type MapIdParams,
  type PublicMapParams,
  type SaveSnapshotBody,
  type SnapshotParams,
  type UpdateMapBody,
} from './schemas.js';
import { getHttpStatusForError } from '../../core/errors.js';
import { createMap, type CreateMapDeps } from '../../core/usecases/create-map.js';
import { getMapSnapshot } from '../../core/usecases/get-map-snapshot.js';
import { getMap } from '../../core/usecases/get-map.js';
import { getPublicMap } from '../../core/usecases/get-public-map.js';
import { listMapSnapshots } from '../../core/usecases/list-map-snapshots.js';
import { listMaps } from '../../core/usecases/list-maps.js';
import { saveMapSnapshot } from '../../core/usecases/save-map-snapshot.js';
import { updateMap } from '../../core/usecases/update-map.js';
import {
  createInvalidInputError as createGroupedSeriesInvalidInputError,
  getHttpStatusForError as getGroupedSeriesHttpStatusForError,
  type GroupedSeriesError,
} from '../../grouped-series/core/errors.js';
import { getGroupedSeriesData } from '../../grouped-series/core/usecases/get-grouped-series-data.js';
import { mapGroupedSeriesBodyToRequest } from '../../grouped-series/shell/rest/map-request-mapper.js';
import {
  GroupedSeriesDataBodySchema,
  type GroupedSeriesData,
  type GroupedSeriesDataBody,
} from '../../grouped-series/shell/rest/schemas.js';
import { serializeWideMatrixCsv } from '../../grouped-series/shell/rest/wide-csv.js';

import type { AdvancedMapAnalyticsRepository } from '../../core/ports.js';
import type {
  AdvancedMapAnalyticsMap,
  AdvancedMapAnalyticsPublicView,
  AdvancedMapAnalyticsSnapshotDocument,
  AdvancedMapAnalyticsSnapshotDetail,
  AdvancedMapAnalyticsSnapshotSummary,
} from '../../core/types.js';
import type { GroupedSeriesProvider } from '../../grouped-series/core/ports.js';
import type { AdvancedMapAnalyticsIdGenerator } from '../utils/id-generator.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

export interface MakeAdvancedMapAnalyticsRoutesDeps {
  repo: AdvancedMapAnalyticsRepository;
  groupedSeriesProvider: GroupedSeriesProvider;
  idGenerator: AdvancedMapAnalyticsIdGenerator;
  now?: () => Date;
}

const REMOTE_GROUPED_SERIES_TYPES = new Set<string>([
  'line-items-aggregated-yearly',
  'commitments-analytics',
  'ins-series',
]);

const GROUPED_SERIES_EMPTY_PAYLOAD = {
  format: 'csv_wide_matrix_v1',
  compression: 'none',
} as const;

function sendUnauthorized(reply: FastifyReply) {
  return reply.status(401).send({
    ok: false,
    error: 'Unauthorized',
    message: 'Authentication required',
  });
}

function toMapSummary(map: AdvancedMapAnalyticsMap) {
  return {
    mapId: map.mapId,
    title: map.title,
    description: map.description,
    visibility: map.visibility,
    publicId: map.publicId,
    snapshotCount: map.snapshotCount,
    lastSnapshotId: map.lastSnapshotId,
    createdAt: map.createdAt.toISOString(),
    updatedAt: map.updatedAt.toISOString(),
  };
}

function toMapDetail(map: AdvancedMapAnalyticsMap, groupedSeriesData?: GroupedSeriesData) {
  return {
    ...toMapSummary(map),
    lastSnapshot: map.lastSnapshot,
    ...(groupedSeriesData !== undefined ? { groupedSeriesData } : {}),
  };
}

function toSnapshotSummary(snapshot: AdvancedMapAnalyticsSnapshotSummary) {
  return {
    snapshotId: snapshot.snapshotId,
    createdAt: snapshot.createdAt.toISOString(),
    title: snapshot.title,
    description: snapshot.description,
  };
}

function toSnapshotDetail(snapshot: AdvancedMapAnalyticsSnapshotDetail) {
  return {
    ...toSnapshotSummary(snapshot),
    mapId: snapshot.mapId,
    snapshot: snapshot.snapshot,
  };
}

function toPublicView(view: AdvancedMapAnalyticsPublicView, groupedSeriesData?: GroupedSeriesData) {
  return {
    mapId: view.mapId,
    publicId: view.publicId,
    title: view.title,
    description: view.description,
    snapshotId: view.snapshotId,
    snapshot: view.snapshot,
    ...(groupedSeriesData !== undefined ? { groupedSeriesData } : {}),
    updatedAt: view.updatedAt.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSeriesId(series: unknown): string {
  if (!isRecord(series)) {
    return '';
  }

  const id = series['id'];
  return typeof id === 'string' ? id.trim() : '';
}

function isRemoteGroupedSeriesCandidate(series: unknown): boolean {
  if (!isRecord(series)) {
    return false;
  }

  const type = series['type'];
  return typeof type === 'string' && REMOTE_GROUPED_SERIES_TYPES.has(type);
}

function buildGroupedSeriesDataBody(
  state: Record<string, unknown>
): { body: GroupedSeriesDataBody } | { error: GroupedSeriesError } {
  const rawSeries = state['series'];

  if (rawSeries === undefined) {
    return {
      body: {
        granularity: 'UAT',
        series: [],
        payload: GROUPED_SERIES_EMPTY_PAYLOAD,
      } as GroupedSeriesDataBody,
    };
  }

  if (!Array.isArray(rawSeries)) {
    return {
      error: createGroupedSeriesInvalidInputError(
        'Stored map snapshot state.series must be an array'
      ),
    };
  }

  const remoteSeries = rawSeries.filter((series) => isRemoteGroupedSeriesCandidate(series));
  remoteSeries.sort((left, right) => readSeriesId(left).localeCompare(readSeriesId(right)));

  if (remoteSeries.length === 0) {
    return {
      body: {
        granularity: 'UAT',
        series: [],
        payload: GROUPED_SERIES_EMPTY_PAYLOAD,
      } as GroupedSeriesDataBody,
    };
  }

  const candidateBody: unknown = {
    granularity: 'UAT',
    series: remoteSeries,
    payload: GROUPED_SERIES_EMPTY_PAYLOAD,
  };

  if (!Value.Check(GroupedSeriesDataBodySchema, candidateBody)) {
    return {
      error: createGroupedSeriesInvalidInputError(
        'Stored map snapshot contains invalid grouped-series configuration'
      ),
    };
  }

  return {
    body: candidateBody,
  };
}

function toEmptyGroupedSeriesData(now: () => Date): GroupedSeriesData {
  return {
    manifest: {
      generated_at: now().toISOString(),
      format: 'wide_matrix_v1',
      granularity: 'UAT',
      series: [],
    },
    payload: {
      mime: 'text/csv',
      compression: 'none',
      data: 'siruta_code',
    },
    warnings: [],
  };
}

async function resolveBundledGroupedSeriesData(
  deps: MakeAdvancedMapAnalyticsRoutesDeps,
  snapshot: AdvancedMapAnalyticsSnapshotDocument | null
): Promise<{ data: GroupedSeriesData } | { error: GroupedSeriesError }> {
  const now = deps.now ?? (() => new Date());

  if (snapshot === null) {
    return {
      data: toEmptyGroupedSeriesData(now),
    };
  }

  const bodyResult = buildGroupedSeriesDataBody(snapshot.state);
  if ('error' in bodyResult) {
    return {
      error: bodyResult.error,
    };
  }

  if (bodyResult.body.series.length === 0) {
    return {
      data: toEmptyGroupedSeriesData(now),
    };
  }

  const groupedSeriesResult = await getGroupedSeriesData(
    {
      provider: deps.groupedSeriesProvider,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    },
    {
      request: mapGroupedSeriesBodyToRequest(bodyResult.body),
    }
  );

  if (groupedSeriesResult.isErr()) {
    return {
      error: groupedSeriesResult.error,
    };
  }

  const csvData = serializeWideMatrixCsv(
    groupedSeriesResult.value.seriesOrder,
    groupedSeriesResult.value.rows
  );

  return {
    data: {
      manifest: groupedSeriesResult.value.manifest,
      payload: {
        mime: 'text/csv',
        compression: 'none',
        data: csvData,
      },
      warnings: groupedSeriesResult.value.warnings,
    },
  };
}

export const makeAdvancedMapAnalyticsRoutes = (
  deps: MakeAdvancedMapAnalyticsRoutesDeps
): FastifyPluginAsync => {
  const createMapDeps: CreateMapDeps = {
    repo: deps.repo,
    generateMapId: deps.idGenerator.generateMapId,
    generatePublicId: deps.idGenerator.generatePublicId,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };

  return async (fastify) => {
    fastify.post<{ Body: CreateMapBody }>(
      '/api/v1/advanced-map-analytics/maps',
      {
        preHandler: requireAuthHandler,
        schema: {
          body: CreateMapBodySchema,
          response: {
            201: MapResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const createRequest = {
          userId: request.auth.userId,
          ...(request.body.title !== undefined ? { title: request.body.title } : {}),
          ...(request.body.description !== undefined
            ? { description: request.body.description }
            : {}),
          ...(request.body.visibility !== undefined ? { visibility: request.body.visibility } : {}),
        };

        const result = await createMap(createMapDeps, { request: createRequest });

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(201).send({
          ok: true,
          data: toMapDetail(result.value),
        });
      }
    );

    fastify.get(
      '/api/v1/advanced-map-analytics/maps',
      {
        preHandler: requireAuthHandler,
        schema: {
          response: {
            200: MapListResponseSchema,
            401: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const result = await listMaps({ repo: deps.repo }, { userId: request.auth.userId });

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: result.value.map(toMapSummary),
        });
      }
    );

    fastify.get<{ Params: MapIdParams }>(
      '/api/v1/advanced-map-analytics/maps/:mapId',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: MapIdParamsSchema,
          response: {
            200: MapResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const result = await getMap(
          { repo: deps.repo },
          {
            userId: request.auth.userId,
            mapId: request.params.mapId,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 404 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        const groupedSeriesDataResult = await resolveBundledGroupedSeriesData(
          deps,
          result.value.lastSnapshot
        );

        if ('error' in groupedSeriesDataResult) {
          const status = getGroupedSeriesHttpStatusForError(groupedSeriesDataResult.error);
          return reply.status(status as 400 | 401 | 403 | 500).send({
            ok: false,
            error: groupedSeriesDataResult.error.type,
            message: groupedSeriesDataResult.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: toMapDetail(result.value, groupedSeriesDataResult.data),
        });
      }
    );

    fastify.patch<{ Params: MapIdParams; Body: UpdateMapBody }>(
      '/api/v1/advanced-map-analytics/maps/:mapId',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: MapIdParamsSchema,
          body: UpdateMapBodySchema,
          response: {
            200: MapResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const updateRequest = {
          userId: request.auth.userId,
          mapId: request.params.mapId,
          ...(request.body.title !== undefined ? { title: request.body.title } : {}),
          ...(request.body.description !== undefined
            ? { description: request.body.description }
            : {}),
          ...(request.body.visibility !== undefined ? { visibility: request.body.visibility } : {}),
        };

        const result = await updateMap(
          {
            repo: deps.repo,
            generatePublicId: deps.idGenerator.generatePublicId,
          },
          {
            request: updateRequest,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 404 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: toMapDetail(result.value),
        });
      }
    );

    fastify.post<{ Params: MapIdParams; Body: SaveSnapshotBody }>(
      '/api/v1/advanced-map-analytics/maps/:mapId/snapshots',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: MapIdParamsSchema,
          body: SaveSnapshotBodySchema,
          response: {
            201: SaveSnapshotResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const saveSnapshotDeps = {
          repo: deps.repo,
          generateSnapshotId: deps.idGenerator.generateSnapshotId,
          generatePublicId: deps.idGenerator.generatePublicId,
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        };

        const saveRequest = {
          userId: request.auth.userId,
          mapId: request.params.mapId,
          state: request.body.state,
          ...(request.body.title !== undefined ? { title: request.body.title } : {}),
          ...(request.body.description !== undefined
            ? { description: request.body.description }
            : {}),
          ...(request.body.mapPatch !== undefined ? { mapPatch: request.body.mapPatch } : {}),
        };

        const result = await saveMapSnapshot(
          {
            ...saveSnapshotDeps,
          },
          {
            request: saveRequest,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 404 | 409 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(201).send({
          ok: true,
          data: {
            map: toMapDetail(result.value.map),
            snapshot: toSnapshotDetail(result.value.snapshot),
          },
        });
      }
    );

    fastify.get<{ Params: MapIdParams }>(
      '/api/v1/advanced-map-analytics/maps/:mapId/snapshots',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: MapIdParamsSchema,
          response: {
            200: SnapshotListResponseSchema,
            401: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const result = await listMapSnapshots(
          { repo: deps.repo },
          {
            userId: request.auth.userId,
            mapId: request.params.mapId,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 404 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: result.value.map(toSnapshotSummary),
        });
      }
    );

    fastify.get<{ Params: SnapshotParams }>(
      '/api/v1/advanced-map-analytics/maps/:mapId/snapshots/:snapshotId',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: SnapshotParamsSchema,
          response: {
            200: SnapshotResponseSchema,
            401: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const result = await getMapSnapshot(
          { repo: deps.repo },
          {
            userId: request.auth.userId,
            mapId: request.params.mapId,
            snapshotId: request.params.snapshotId,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 404 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: toSnapshotDetail(result.value),
        });
      }
    );

    fastify.get<{ Params: PublicMapParams }>(
      '/api/v1/advanced-map-analytics/public/:publicId',
      {
        schema: {
          params: PublicMapParamsSchema,
          response: {
            200: PublicMapResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await getPublicMap(
          { repo: deps.repo },
          {
            publicId: request.params.publicId,
          }
        );

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 404 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        const groupedSeriesDataResult = await resolveBundledGroupedSeriesData(
          deps,
          result.value.snapshot
        );

        if ('error' in groupedSeriesDataResult) {
          const status = getGroupedSeriesHttpStatusForError(groupedSeriesDataResult.error);
          return reply.status(status as 400 | 401 | 403 | 500).send({
            ok: false,
            error: groupedSeriesDataResult.error.type,
            message: groupedSeriesDataResult.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: toPublicView(result.value, groupedSeriesDataResult.data),
        });
      }
    );
  };
};
