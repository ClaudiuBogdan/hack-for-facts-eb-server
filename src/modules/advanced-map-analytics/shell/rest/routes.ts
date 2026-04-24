/**
 * Advanced Map Analytics REST Routes
 */

import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { type AdvancedMapDatasetRepository } from '@/modules/advanced-map-datasets/index.js';
import { isAuthenticated } from '@/modules/auth/index.js';
import { requireAuthHandler } from '@/modules/auth/shell/middleware/fastify-auth.js';

import {
  CreateMapBodySchema,
  DeleteMapResponseSchema,
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
import {
  createInvalidInputError,
  createProviderError,
  getHttpStatusForError,
} from '../../core/errors.js';
import { createMap, type CreateMapDeps } from '../../core/usecases/create-map.js';
import { deleteMap } from '../../core/usecases/delete-map.js';
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
import {
  getGroupedSeriesData,
  validateGroupedSeriesRequestSeries,
} from '../../grouped-series/core/usecases/get-grouped-series-data.js';
import { validateUploadedDatasetSeriesCompatibility } from '../../grouped-series/shell/providers/extract-uploaded-dataset-series.js';
import { mapGroupedSeriesBodyToRequest } from '../../grouped-series/shell/rest/map-request-mapper.js';
import {
  GroupedSeriesDataBodyInputSchema,
  type GroupedSeriesData,
  type GroupedSeriesDataBodyInput,
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

interface AdvancedMapPublicWritePermissionChecker {
  canWrite(userId: string): Promise<boolean>;
}

export interface MakeAdvancedMapAnalyticsRoutesDeps {
  repo: AdvancedMapAnalyticsRepository;
  datasetRepo?: AdvancedMapDatasetRepository;
  groupedSeriesProvider: GroupedSeriesProvider;
  idGenerator: AdvancedMapAnalyticsIdGenerator;
  publicWritePermissionChecker: AdvancedMapPublicWritePermissionChecker;
  now?: () => Date;
}

const REMOTE_GROUPED_SERIES_TYPES = new Set<string>([
  'line-items-aggregated-yearly',
  'commitments-analytics',
  'ins-series',
  'uploaded-map-dataset',
]);

const GROUPED_SERIES_EMPTY_PAYLOAD = {
  format: 'csv_wide_matrix_v1',
  compression: 'none',
} as const;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!FormatRegistry.Has('uuid')) {
  FormatRegistry.Set('uuid', (value) => UUID_V4_REGEX.test(value));
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.status(401).send({
    ok: false,
    error: 'Unauthorized',
    message: 'Authentication required',
  });
}

async function ensurePublicWriteAccess(
  reply: FastifyReply,
  checker: AdvancedMapPublicWritePermissionChecker,
  userId: string,
  options: {
    requiresPublicVisibilityPermission: boolean;
  }
): Promise<boolean> {
  // Public map visibility is the privileged boundary for advanced-map writes.
  // See: docs/specs/specs-202604101330-advanced-map-public-write-permissions.md
  if (!options.requiresPublicVisibilityPermission) {
    return true;
  }

  const allowed = await checker.canWrite(userId);
  if (allowed) {
    return true;
  }

  await reply.status(403).send({
    ok: false,
    error: 'ForbiddenError',
    message: 'You do not have permission to manage public advanced maps',
  });
  return false;
}

function incrementPublicViewCountFireAndForget(
  repo: AdvancedMapAnalyticsRepository,
  mapId: string
): void {
  void repo.incrementPublicViewCount(mapId).catch(() => {
    // Silently ignore view counter failures - not critical for public reads
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
    viewCount: map.viewCount,
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

function normalizeRemoteGroupedSeries(series: unknown): Record<string, unknown> | null {
  if (!isRecord(series)) {
    return null;
  }

  const type = series['type'];
  if (typeof type !== 'string') {
    return null;
  }

  const id = readSeriesId(series);
  const unit = readTrimmedString(series, 'unit');

  if (type === 'line-items-aggregated-yearly') {
    return {
      ...(id !== '' ? { id } : {}),
      type,
      ...(unit !== undefined ? { unit } : {}),
      ...(series['filter'] !== undefined ? { filter: series['filter'] } : {}),
    };
  }

  if (type === 'commitments-analytics') {
    return {
      ...(id !== '' ? { id } : {}),
      type,
      ...(unit !== undefined ? { unit } : {}),
      ...(series['metric'] !== undefined ? { metric: series['metric'] } : {}),
      ...(series['filter'] !== undefined ? { filter: series['filter'] } : {}),
    };
  }

  if (type === 'ins-series') {
    return {
      ...(id !== '' ? { id } : {}),
      type,
      ...(unit !== undefined ? { unit } : {}),
      ...(series['datasetCode'] !== undefined ? { datasetCode: series['datasetCode'] } : {}),
      ...(series['period'] !== undefined ? { period: series['period'] } : {}),
      ...(series['aggregation'] !== undefined ? { aggregation: series['aggregation'] } : {}),
      ...(series['territoryCodes'] !== undefined
        ? { territoryCodes: series['territoryCodes'] }
        : {}),
      ...(series['sirutaCodes'] !== undefined ? { sirutaCodes: series['sirutaCodes'] } : {}),
      ...(series['unitCodes'] !== undefined ? { unitCodes: series['unitCodes'] } : {}),
      ...(series['classificationSelections'] !== undefined
        ? { classificationSelections: series['classificationSelections'] }
        : {}),
      ...(series['hasValue'] !== undefined ? { hasValue: series['hasValue'] } : {}),
    };
  }

  if (type === 'uploaded-map-dataset') {
    const datasetId = readTrimmedString(series, 'datasetId');
    const datasetPublicId = readTrimmedString(series, 'datasetPublicId');

    return {
      ...(id !== '' ? { id } : {}),
      type,
      ...(unit !== undefined ? { unit } : {}),
      ...(datasetId !== undefined ? { datasetId } : {}),
      ...(datasetPublicId !== undefined ? { datasetPublicId } : {}),
    };
  }

  return {
    ...(id !== '' ? { id } : {}),
    type,
    ...(unit !== undefined ? { unit } : {}),
  };
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
): { body: GroupedSeriesDataBodyInput } | { error: GroupedSeriesError } {
  const rawSeries = state['series'];

  if (rawSeries === undefined) {
    return {
      body: {
        granularity: 'UAT',
        series: [],
        payload: GROUPED_SERIES_EMPTY_PAYLOAD,
      },
    };
  }

  if (!Array.isArray(rawSeries)) {
    return {
      error: createGroupedSeriesInvalidInputError(
        'Stored map snapshot state.series must be an array'
      ),
    };
  }

  const remoteSeries = rawSeries
    .filter((series) => isRemoteGroupedSeriesCandidate(series))
    .map((series) => normalizeRemoteGroupedSeries(series))
    .filter((series): series is Record<string, unknown> => series !== null);

  if (remoteSeries.length === 0) {
    return {
      body: {
        granularity: 'UAT',
        series: [],
        payload: GROUPED_SERIES_EMPTY_PAYLOAD,
      },
    };
  }

  const candidateBody: unknown = {
    granularity: 'UAT',
    series: remoteSeries,
    payload: GROUPED_SERIES_EMPTY_PAYLOAD,
  };

  if (!Value.Check(GroupedSeriesDataBodyInputSchema, candidateBody)) {
    return {
      error: createGroupedSeriesInvalidInputError(
        'Stored map snapshot contains invalid grouped-series configuration'
      ),
    };
  }

  const typedBody = Value.Cast(GroupedSeriesDataBodyInputSchema, candidateBody);
  return {
    body: typedBody,
  };
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function canonicalizeUploadedDatasetSeries(
  deps: MakeAdvancedMapAnalyticsRoutesDeps,
  state: Record<string, unknown>,
  requestUserId: string,
  requireShareable: boolean
): Promise<
  | { state: Record<string, unknown> }
  | {
      error: ReturnType<typeof createInvalidInputError> | ReturnType<typeof createProviderError>;
    }
> {
  const rawSeries = state['series'];

  if (rawSeries === undefined) {
    return { state };
  }

  if (!Array.isArray(rawSeries)) {
    return {
      error: createInvalidInputError('snapshot state.series must be an array'),
    };
  }

  const nextSeries: unknown[] = [];

  for (const series of rawSeries) {
    if (!isRecord(series) || series['type'] !== 'uploaded-map-dataset') {
      nextSeries.push(series);
      continue;
    }

    const datasetId = readTrimmedString(series, 'datasetId');
    const datasetPublicId = readTrimmedString(series, 'datasetPublicId');
    const hasDatasetId = datasetId !== undefined;
    const hasDatasetPublicId = datasetPublicId !== undefined;

    if (hasDatasetId === hasDatasetPublicId) {
      return {
        error: createInvalidInputError(
          'uploaded-map-dataset series requires exactly one of datasetId or datasetPublicId'
        ),
      };
    }

    if (deps.datasetRepo === undefined) {
      return {
        error: createProviderError('Advanced map dataset repository is not configured'),
      };
    }

    const datasetLookupResult = await deps.datasetRepo.getAccessibleDataset({
      ...(datasetId !== undefined ? { datasetId } : {}),
      ...(datasetPublicId !== undefined ? { datasetPublicId } : {}),
      requestUserId,
    });

    if (datasetLookupResult.isErr()) {
      return {
        error: createProviderError(datasetLookupResult.error.message),
      };
    }

    if (datasetLookupResult.value === null) {
      return {
        error: createInvalidInputError('Uploaded map dataset not found or not accessible'),
      };
    }

    if (requireShareable && datasetLookupResult.value.visibility === 'private') {
      return {
        error: createInvalidInputError(
          'Public maps can reference only unlisted or public uploaded datasets'
        ),
      };
    }

    const compatibilityResult = validateUploadedDatasetSeriesCompatibility(
      datasetLookupResult.value
    );
    if (compatibilityResult.isErr()) {
      return {
        error: createInvalidInputError(compatibilityResult.error.message),
      };
    }

    const rest = { ...series };
    if (datasetPublicId !== undefined) {
      delete rest['datasetId'];
      nextSeries.push({
        ...rest,
        datasetPublicId: datasetLookupResult.value.publicId,
      });
      continue;
    }

    delete rest['datasetPublicId'];
    nextSeries.push({
      ...rest,
      datasetId: datasetLookupResult.value.id,
    });
  }

  return {
    state: {
      ...state,
      series: nextSeries,
    },
  };
}

async function rewriteUploadedDatasetSeriesForPublicRead(
  deps: MakeAdvancedMapAnalyticsRoutesDeps,
  state: Record<string, unknown>
): Promise<
  | { state: Record<string, unknown> }
  | {
      error:
        | ReturnType<typeof createGroupedSeriesInvalidInputError>
        | ReturnType<typeof createProviderError>;
    }
> {
  const rawSeries = state['series'];
  if (rawSeries === undefined) {
    return { state };
  }

  if (!Array.isArray(rawSeries)) {
    return {
      error: createGroupedSeriesInvalidInputError(
        'Stored map snapshot state.series must be an array'
      ),
    };
  }

  const nextSeries: unknown[] = [];

  for (const series of rawSeries) {
    if (!isRecord(series) || series['type'] !== 'uploaded-map-dataset') {
      nextSeries.push(series);
      continue;
    }

    if (deps.datasetRepo === undefined) {
      return {
        error: createProviderError('Advanced map dataset repository is not configured'),
      };
    }

    const datasetId = readTrimmedString(series, 'datasetId');
    const datasetPublicId = readTrimmedString(series, 'datasetPublicId');
    const hasDatasetId = datasetId !== undefined;
    const hasDatasetPublicId = datasetPublicId !== undefined;

    if (hasDatasetId === hasDatasetPublicId) {
      return {
        error: createGroupedSeriesInvalidInputError(
          'uploaded-map-dataset series requires exactly one of datasetId or datasetPublicId'
        ),
      };
    }

    if (datasetPublicId !== undefined) {
      nextSeries.push(series);
      continue;
    }

    const headResult = await deps.datasetRepo.getShareableDatasetHeadById(datasetId ?? '');
    if (headResult.isErr()) {
      return {
        error: createProviderError(headResult.error.message),
      };
    }

    if (headResult.value === null) {
      return {
        error: createGroupedSeriesInvalidInputError(
          'Stored public map references an uploaded dataset that is not shareable'
        ),
      };
    }

    const rest = { ...series };
    delete rest['datasetId'];
    nextSeries.push({
      ...rest,
      datasetPublicId: headResult.value.publicId,
    });
  }

  return {
    state: {
      ...state,
      series: nextSeries,
    },
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
  snapshot: AdvancedMapAnalyticsSnapshotDocument | null,
  requestUserId?: string
): Promise<{ data: GroupedSeriesData } | { error: GroupedSeriesError }> {
  const now = deps.now ?? (() => new Date());

  if (snapshot === null) {
    return {
      data: toEmptyGroupedSeriesData(now),
    };
  }

  let resolvedState = snapshot.state;
  if (requestUserId === undefined) {
    const publicStateResult = await rewriteUploadedDatasetSeriesForPublicRead(deps, snapshot.state);
    if ('error' in publicStateResult) {
      return {
        error: publicStateResult.error,
      };
    }

    resolvedState = publicStateResult.state;
  }

  const bodyResult = buildGroupedSeriesDataBody(resolvedState);
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
      request: {
        ...mapGroupedSeriesBodyToRequest(bodyResult.body),
        ...(requestUserId !== undefined ? { requestUserId } : {}),
      },
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

async function toPublicSnapshotDocument(
  deps: MakeAdvancedMapAnalyticsRoutesDeps,
  snapshot: AdvancedMapAnalyticsSnapshotDocument
): Promise<
  | { snapshot: AdvancedMapAnalyticsSnapshotDocument }
  | {
      error:
        | ReturnType<typeof createGroupedSeriesInvalidInputError>
        | ReturnType<typeof createProviderError>;
    }
> {
  const publicStateResult = await rewriteUploadedDatasetSeriesForPublicRead(deps, snapshot.state);
  if ('error' in publicStateResult) {
    return {
      error: publicStateResult.error,
    };
  }

  return {
    snapshot: {
      ...snapshot,
      state: publicStateResult.state,
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
            403: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const requiresPublicVisibilityPermission = request.body.visibility === 'public';
        const canWritePublic = await ensurePublicWriteAccess(
          reply,
          deps.publicWritePermissionChecker,
          request.auth.userId,
          {
            requiresPublicVisibilityPermission,
          }
        );
        if (!canWritePublic) {
          return;
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
          result.value.lastSnapshot,
          request.auth.userId
        );

        if ('error' in groupedSeriesDataResult) {
          const status = getGroupedSeriesHttpStatusForError(groupedSeriesDataResult.error);
          return reply.status(status as 400 | 404 | 500).send({
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

        const currentMapResult = await getMap(
          { repo: deps.repo },
          {
            userId: request.auth.userId,
            mapId: request.params.mapId,
          }
        );

        if (currentMapResult.isErr()) {
          const status = getHttpStatusForError(currentMapResult.error);
          return reply.status(status as 404 | 500).send({
            ok: false,
            error: currentMapResult.error.type,
            message: currentMapResult.error.message,
          });
        }

        const requiresPublicVisibilityPermission =
          currentMapResult.value.visibility === 'public' || request.body.visibility === 'public';
        const canWritePublic = await ensurePublicWriteAccess(
          reply,
          deps.publicWritePermissionChecker,
          request.auth.userId,
          {
            requiresPublicVisibilityPermission,
          }
        );
        if (!canWritePublic) {
          return;
        }

        const updateRequest = {
          userId: request.auth.userId,
          mapId: request.params.mapId,
          ...(request.body.title !== undefined ? { title: request.body.title } : {}),
          ...(request.body.description !== undefined
            ? { description: request.body.description }
            : {}),
          ...(request.body.visibility !== undefined ? { visibility: request.body.visibility } : {}),
          allowPublicWrite: requiresPublicVisibilityPermission,
        };

        if (
          request.body.visibility === 'public' &&
          currentMapResult.value.lastSnapshot !== null &&
          isRecord(currentMapResult.value.lastSnapshot.state)
        ) {
          const canonicalizedStateResult = await canonicalizeUploadedDatasetSeries(
            deps,
            currentMapResult.value.lastSnapshot.state,
            request.auth.userId,
            true
          );

          if ('error' in canonicalizedStateResult) {
            const status = getHttpStatusForError(canonicalizedStateResult.error);
            return reply.status(status as 400 | 500).send({
              ok: false,
              error: canonicalizedStateResult.error.type,
              message: canonicalizedStateResult.error.message,
            });
          }

          const groupedSeriesBodyResult = buildGroupedSeriesDataBody(
            canonicalizedStateResult.state
          );
          if ('error' in groupedSeriesBodyResult) {
            const status = getGroupedSeriesHttpStatusForError(groupedSeriesBodyResult.error);
            return reply.status(status as 400 | 404 | 500).send({
              ok: false,
              error: groupedSeriesBodyResult.error.type,
              message: groupedSeriesBodyResult.error.message,
            });
          }

          const groupedSeriesValidationResult = validateGroupedSeriesRequestSeries(
            mapGroupedSeriesBodyToRequest(groupedSeriesBodyResult.body).series
          );
          if (groupedSeriesValidationResult.isErr()) {
            const status = getGroupedSeriesHttpStatusForError(groupedSeriesValidationResult.error);
            return reply.status(status as 400 | 404 | 500).send({
              ok: false,
              error: groupedSeriesValidationResult.error.type,
              message: groupedSeriesValidationResult.error.message,
            });
          }
        }

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

    fastify.delete<{ Params: MapIdParams }>(
      '/api/v1/advanced-map-analytics/maps/:mapId',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: MapIdParamsSchema,
          response: {
            200: DeleteMapResponseSchema,
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

        const currentMapResult = await getMap(
          { repo: deps.repo },
          {
            userId: request.auth.userId,
            mapId: request.params.mapId,
          }
        );

        if (currentMapResult.isErr()) {
          const status = getHttpStatusForError(currentMapResult.error);
          return reply.status(status as 404 | 500).send({
            ok: false,
            error: currentMapResult.error.type,
            message: currentMapResult.error.message,
          });
        }

        const requiresPublicVisibilityPermission = currentMapResult.value.visibility === 'public';
        const canWritePublic = await ensurePublicWriteAccess(
          reply,
          deps.publicWritePermissionChecker,
          request.auth.userId,
          {
            requiresPublicVisibilityPermission,
          }
        );
        if (!canWritePublic) {
          return;
        }

        const result = await deleteMap(
          { repo: deps.repo },
          {
            userId: request.auth.userId,
            mapId: request.params.mapId,
            allowPublicWrite: requiresPublicVisibilityPermission,
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
            403: ErrorResponseSchema,
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

        // Snapshot save validates grouped-series config before the write. The
        // repository re-checks dataset visibility/existence inside the
        // transaction-scoped dataset lock boundary documented in:
        // docs/specs/specs-202604091600-advanced-map-dataset-consistency-boundary.md
        const currentMapResult = await getMap(
          { repo: deps.repo },
          {
            userId: request.auth.userId,
            mapId: request.params.mapId,
          }
        );

        if (currentMapResult.isErr()) {
          const status = getHttpStatusForError(currentMapResult.error);
          return reply.status(status as 404 | 500).send({
            ok: false,
            error: currentMapResult.error.type,
            message: currentMapResult.error.message,
          });
        }

        const nextVisibility =
          request.body.mapPatch?.visibility ?? currentMapResult.value.visibility;
        const requiresPublicVisibilityPermission =
          currentMapResult.value.visibility === 'public' || nextVisibility === 'public';
        const canWritePublic = await ensurePublicWriteAccess(
          reply,
          deps.publicWritePermissionChecker,
          request.auth.userId,
          {
            requiresPublicVisibilityPermission,
          }
        );
        if (!canWritePublic) {
          return;
        }

        const saveRequest = {
          userId: request.auth.userId,
          mapId: request.params.mapId,
          state: request.body.state,
          ...(request.body.title !== undefined ? { title: request.body.title } : {}),
          ...(request.body.description !== undefined
            ? { description: request.body.description }
            : {}),
          allowPublicWrite: requiresPublicVisibilityPermission,
          ...(request.body.mapPatch !== undefined ? { mapPatch: request.body.mapPatch } : {}),
        };

        const canonicalizedStateResult = await canonicalizeUploadedDatasetSeries(
          deps,
          request.body.state,
          request.auth.userId,
          nextVisibility === 'public'
        );

        if ('error' in canonicalizedStateResult) {
          const status = getHttpStatusForError(canonicalizedStateResult.error);
          return reply.status(status as 400 | 500).send({
            ok: false,
            error: canonicalizedStateResult.error.type,
            message: canonicalizedStateResult.error.message,
          });
        }

        const groupedSeriesBodyResult = buildGroupedSeriesDataBody(canonicalizedStateResult.state);
        if ('error' in groupedSeriesBodyResult) {
          const status = getGroupedSeriesHttpStatusForError(groupedSeriesBodyResult.error);
          return reply.status(status as 400 | 404 | 500).send({
            ok: false,
            error: groupedSeriesBodyResult.error.type,
            message: groupedSeriesBodyResult.error.message,
          });
        }

        const groupedSeriesValidationResult = validateGroupedSeriesRequestSeries(
          mapGroupedSeriesBodyToRequest(groupedSeriesBodyResult.body).series
        );
        if (groupedSeriesValidationResult.isErr()) {
          const status = getGroupedSeriesHttpStatusForError(groupedSeriesValidationResult.error);
          return reply.status(status as 400 | 404 | 500).send({
            ok: false,
            error: groupedSeriesValidationResult.error.type,
            message: groupedSeriesValidationResult.error.message,
          });
        }

        saveRequest.state = canonicalizedStateResult.state;

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
          return reply.status(status as 400 | 404 | 500).send({
            ok: false,
            error: groupedSeriesDataResult.error.type,
            message: groupedSeriesDataResult.error.message,
          });
        }

        if (request.method === 'GET') {
          incrementPublicViewCountFireAndForget(deps.repo, result.value.mapId);
        }

        const publicSnapshotResult = await toPublicSnapshotDocument(deps, result.value.snapshot);
        if ('error' in publicSnapshotResult) {
          const status = getGroupedSeriesHttpStatusForError(publicSnapshotResult.error);
          return reply.status(status as 400 | 404 | 500).send({
            ok: false,
            error: publicSnapshotResult.error.type,
            message: publicSnapshotResult.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: toPublicView(
            {
              ...result.value,
              snapshot: publicSnapshotResult.snapshot,
            },
            groupedSeriesDataResult.data
          ),
        });
      }
    );
  };
};
