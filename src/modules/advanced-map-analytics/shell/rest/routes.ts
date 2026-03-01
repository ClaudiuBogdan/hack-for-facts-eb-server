/**
 * Advanced Map Analytics REST Routes
 */

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

import type { AdvancedMapAnalyticsRepository } from '../../core/ports.js';
import type {
  AdvancedMapAnalyticsMap,
  AdvancedMapAnalyticsPublicView,
  AdvancedMapAnalyticsSnapshotDetail,
  AdvancedMapAnalyticsSnapshotSummary,
} from '../../core/types.js';
import type { AdvancedMapAnalyticsIdGenerator } from '../utils/id-generator.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

export interface MakeAdvancedMapAnalyticsRoutesDeps {
  repo: AdvancedMapAnalyticsRepository;
  idGenerator: AdvancedMapAnalyticsIdGenerator;
  now?: () => Date;
}

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

function toMapDetail(map: AdvancedMapAnalyticsMap) {
  return {
    ...toMapSummary(map),
    lastSnapshot: map.lastSnapshot,
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

function toPublicView(view: AdvancedMapAnalyticsPublicView) {
  return {
    mapId: view.mapId,
    publicId: view.publicId,
    title: view.title,
    description: view.description,
    snapshotId: view.snapshotId,
    snapshot: view.snapshot,
    updatedAt: view.updatedAt.toISOString(),
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

        return reply.status(200).send({
          ok: true,
          data: toMapDetail(result.value),
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

        return reply.status(200).send({
          ok: true,
          data: toPublicView(result.value),
        });
      }
    );
  };
};
