import multipart from '@fastify/multipart';
import { sql } from 'kysely';

import { isAuthenticated } from '@/modules/auth/index.js';
import { requireAuthHandler } from '@/modules/auth/shell/middleware/fastify-auth.js';

import {
  CreateDatasetJsonBodySchema,
  DatasetDeleteResponseSchema,
  DatasetIdParamsSchema,
  DatasetListQuerySchema,
  DatasetListResponseSchema,
  DatasetPublicIdParamsSchema,
  PublicDatasetListResponseSchema,
  PublicDatasetResponseSchema,
  ReplaceDatasetRowsBodySchema,
  DatasetResponseSchema,
  ErrorResponseSchema,
  UpdateDatasetBodySchema,
  type CreateDatasetJsonBody,
  type DatasetIdParams,
  type DatasetListQuery,
  type DatasetPublicIdParams,
  type ReplaceDatasetRowsBody,
  type UpdateDatasetBody,
} from './schemas.js';
import { getHttpStatusForError, type AdvancedMapDatasetError } from '../../core/errors.js';
import {
  ADVANCED_MAP_DATASET_MAX_ROW_COUNT,
  ADVANCED_MAP_DATASET_MAX_UPLOAD_BYTES,
} from '../../core/types.js';
import { createAdvancedMapDataset } from '../../core/usecases/create-dataset.js';
import { deleteAdvancedMapDataset } from '../../core/usecases/delete-dataset.js';
import { getAdvancedMapDataset } from '../../core/usecases/get-dataset.js';
import { getPublicAdvancedMapDataset } from '../../core/usecases/get-public-dataset.js';
import { listAdvancedMapDatasets } from '../../core/usecases/list-datasets.js';
import { listPublicAdvancedMapDatasets } from '../../core/usecases/list-public-datasets.js';
import { replaceAdvancedMapDatasetRows } from '../../core/usecases/replace-dataset-rows.js';
import { updateAdvancedMapDatasetMetadata } from '../../core/usecases/update-dataset-metadata.js';
import { parseUploadedDatasetCsv } from '../utils/parse-uploaded-dataset-csv.js';

import type {
  AdvancedMapDatasetRepository,
  AdvancedMapDatasetWritePermissionChecker,
} from '../../core/ports.js';
import type { AdvancedMapDatasetIdGenerator } from '../utils/id-generator.js';
import type { BudgetDbClient } from '@/infra/database/client.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

interface MultipartFieldPart {
  type?: string;
  fieldname?: string;
  value?: unknown;
}

interface MultipartFilePart {
  type?: string;
  fieldname?: string;
  filename?: string;
  mimetype?: string;
  file?: NodeJS.ReadableStream;
  truncated?: boolean;
  toBuffer?: () => Promise<Buffer>;
}

interface DatasetMultipartPayload {
  title?: string;
  description?: string;
  markdown?: string;
  unit?: string;
  visibility?: 'private' | 'unlisted' | 'public';
  csvText: string;
}

interface SirutaRow {
  siruta_code: string;
}

export interface MakeAdvancedMapDatasetRoutesDeps {
  repo: AdvancedMapDatasetRepository;
  budgetDb: BudgetDbClient;
  idGenerator: AdvancedMapDatasetIdGenerator;
  writePermissionChecker: AdvancedMapDatasetWritePermissionChecker;
}

function sendUnauthorized(reply: FastifyReply) {
  return reply.status(401).send({
    ok: false,
    error: 'Unauthorized',
    message: 'Authentication required',
  });
}

function formatDatasetRow(row: import('../../core/types.js').AdvancedMapDatasetRow) {
  return {
    sirutaCode: row.sirutaCode,
    valueNumber: row.valueNumber,
    valueJson: row.valueJson,
  };
}

function formatDataset(dataset: import('../../core/types.js').AdvancedMapDatasetDetail) {
  return {
    id: dataset.id,
    publicId: dataset.publicId,
    userId: dataset.userId,
    title: dataset.title,
    description: dataset.description,
    markdown: dataset.markdown,
    unit: dataset.unit,
    visibility: dataset.visibility,
    rowCount: dataset.rowCount,
    replacedAt: dataset.replacedAt?.toISOString() ?? null,
    createdAt: dataset.createdAt.toISOString(),
    updatedAt: dataset.updatedAt.toISOString(),
    rows: dataset.rows.map((row) => formatDatasetRow(row)),
  };
}

function formatConnection(connection: import('../../core/types.js').AdvancedMapDatasetConnection) {
  return {
    nodes: connection.nodes.map((dataset) => ({
      id: dataset.id,
      publicId: dataset.publicId,
      userId: dataset.userId,
      title: dataset.title,
      description: dataset.description,
      markdown: dataset.markdown,
      unit: dataset.unit,
      visibility: dataset.visibility,
      rowCount: dataset.rowCount,
      replacedAt: dataset.replacedAt?.toISOString() ?? null,
      createdAt: dataset.createdAt.toISOString(),
      updatedAt: dataset.updatedAt.toISOString(),
    })),
    pageInfo: connection.pageInfo,
  };
}

function formatPublicDataset(dataset: import('../../core/types.js').AdvancedMapDatasetDetail) {
  return {
    publicId: dataset.publicId,
    title: dataset.title,
    description: dataset.description,
    markdown: dataset.markdown,
    unit: dataset.unit,
    visibility: dataset.visibility,
    rowCount: dataset.rowCount,
    replacedAt: dataset.replacedAt?.toISOString() ?? null,
    createdAt: dataset.createdAt.toISOString(),
    updatedAt: dataset.updatedAt.toISOString(),
    rows: dataset.rows.map((row) => formatDatasetRow(row)),
  };
}

function formatPublicConnection(
  connection: import('../../core/types.js').AdvancedMapDatasetConnection
) {
  return {
    nodes: connection.nodes.map((dataset) => ({
      publicId: dataset.publicId,
      title: dataset.title,
      description: dataset.description,
      markdown: dataset.markdown,
      unit: dataset.unit,
      visibility: dataset.visibility,
      rowCount: dataset.rowCount,
      replacedAt: dataset.replacedAt?.toISOString() ?? null,
      createdAt: dataset.createdAt.toISOString(),
      updatedAt: dataset.updatedAt.toISOString(),
    })),
    pageInfo: connection.pageInfo,
  };
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'number') {
    return undefined;
  }

  return Number.isFinite(value) ? value : undefined;
}

async function loadNonCountySirutaCodes(budgetDb: BudgetDbClient): Promise<Set<string>> {
  const nonCountyCondition = sql<boolean>`NOT (
    u.siruta_code = u.county_code
    OR (u.county_code = 'B' AND u.siruta_code = '179132')
  )`;

  const rows: SirutaRow[] = await budgetDb
    .selectFrom('uats as u')
    .select(['u.siruta_code'])
    .where(nonCountyCondition)
    .orderBy('u.siruta_code', 'asc')
    .execute();

  return new Set(rows.map((row) => row.siruta_code.trim()).filter((value) => value !== ''));
}

async function validateDatasetRowsAgainstSirutaUniverse(
  budgetDb: BudgetDbClient,
  rows: readonly import('../../core/types.js').AdvancedMapDatasetRow[]
): Promise<{ rowNumber: number; message: string }[]> {
  const validSirutas = await loadNonCountySirutaCodes(budgetDb);
  const errors: { rowNumber: number; message: string }[] = [];

  rows.forEach((row, index) => {
    const sirutaCode = row.sirutaCode.trim();
    if (sirutaCode !== '' && !validSirutas.has(sirutaCode)) {
      errors.push({
        rowNumber: index + 1,
        message: `Unknown or unsupported UAT siruta_code: ${sirutaCode}`,
      });
    }
  });

  return errors;
}

async function ensureWriteAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  checker: AdvancedMapDatasetWritePermissionChecker,
  options: {
    requiresPublicVisibilityPermission: boolean;
  }
): Promise<string | null> {
  if (!isAuthenticated(request.auth)) {
    sendUnauthorized(reply);
    return null;
  }

  const userId = request.auth.userId as string;
  if (!options.requiresPublicVisibilityPermission) {
    return userId;
  }

  const allowed = await checker.canWrite(userId);
  if (!allowed) {
    await reply.status(403).send({
      ok: false,
      error: 'ForbiddenError',
      message: 'You do not have permission to manage public advanced map datasets',
    });
    return null;
  }

  return userId;
}

// Public dataset visibility is the privileged boundary for dataset writes.
// See: docs/specs/specs-202604101200-advanced-map-dataset-public-write-permissions.md
async function getOwnedDatasetForWrite(
  request: FastifyRequest,
  reply: FastifyReply,
  repo: AdvancedMapDatasetRepository,
  datasetId: string
): Promise<import('../../core/types.js').AdvancedMapDatasetDetail | null> {
  if (!isAuthenticated(request.auth)) {
    sendUnauthorized(reply);
    return null;
  }

  const datasetResult = await getAdvancedMapDataset(
    { repo },
    {
      userId: request.auth.userId,
      datasetId,
    }
  );

  if (datasetResult.isErr()) {
    sendError(reply, datasetResult.error);
    return null;
  }

  return datasetResult.value;
}

async function readMultipartPayload(
  request: FastifyRequest,
  options: { requireMetadata: boolean }
): Promise<DatasetMultipartPayload> {
  const multipartRequest = request as FastifyRequest & {
    isMultipart?: () => boolean;
    parts: () => AsyncIterable<MultipartFieldPart | MultipartFilePart>;
  };

  if (typeof multipartRequest.isMultipart === 'function' && !multipartRequest.isMultipart()) {
    throw new Error('Expected multipart/form-data request');
  }

  let title: string | undefined;
  let description: string | undefined;
  let markdown: string | undefined;
  let unit: string | undefined;
  let visibility: 'private' | 'unlisted' | 'public' | undefined;
  let sawVisibilityField = false;
  let csvText: string | undefined;
  let fileCount = 0;

  for await (const part of multipartRequest.parts()) {
    if (part.type === 'file') {
      fileCount += 1;
      if (part.fieldname !== 'file') {
        throw new Error('Multipart file field must be named file');
      }

      if (typeof part.toBuffer !== 'function') {
        throw new Error('Unable to read uploaded file');
      }

      const buffer = await part.toBuffer();
      csvText = buffer.toString('utf-8');
      continue;
    }

    const value = typeof part.value === 'string' ? part.value : '';

    if (part.fieldname === 'title') {
      title = value;
    } else if (part.fieldname === 'description') {
      description = value;
    } else if (part.fieldname === 'markdown') {
      markdown = value;
    } else if (part.fieldname === 'unit') {
      unit = value;
    } else if (part.fieldname === 'valueType') {
      throw new Error('valueType is no longer supported; CSV uploads populate numeric values only');
    } else if (part.fieldname === 'visibility') {
      sawVisibilityField = true;
      if (value === 'private' || value === 'unlisted' || value === 'public') {
        visibility = value;
      } else {
        throw new Error('visibility must be one of: private, unlisted, public');
      }
    }
  }

  if (fileCount !== 1 || csvText === undefined) {
    throw new Error('Exactly one CSV file upload is required');
  }

  if (options.requireMetadata && title === undefined) {
    throw new Error('Multipart field title is required');
  }

  if (sawVisibilityField && visibility === undefined) {
    throw new Error('visibility must be one of: private, unlisted, public');
  }

  return {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(markdown !== undefined ? { markdown } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    csvText,
  };
}

function sendError(reply: FastifyReply, error: AdvancedMapDatasetError, details?: unknown) {
  const status = getHttpStatusForError(error);
  return reply.status(status as 400 | 403 | 404 | 500).send({
    ok: false,
    error: error.type,
    message: error.message,
    ...(details !== undefined ? { details } : {}),
  });
}

function mergeCsvRowsIntoDatasetRows(
  currentRows: readonly import('../../core/types.js').AdvancedMapDatasetRow[],
  csvRows: readonly import('../../core/types.js').AdvancedMapDatasetRow[]
): import('../../core/types.js').AdvancedMapDatasetRow[] {
  const rowsBySirutaCode = new Map<string, import('../../core/types.js').AdvancedMapDatasetRow>();

  for (const row of currentRows) {
    rowsBySirutaCode.set(row.sirutaCode, {
      sirutaCode: row.sirutaCode,
      valueNumber: row.valueNumber,
      valueJson: row.valueJson,
    });
  }

  for (const row of rowsBySirutaCode.values()) {
    row.valueNumber = null;
  }

  for (const row of csvRows) {
    const current = rowsBySirutaCode.get(row.sirutaCode);
    rowsBySirutaCode.set(row.sirutaCode, {
      sirutaCode: row.sirutaCode,
      valueNumber: row.valueNumber,
      valueJson: current?.valueJson ?? null,
    });
  }

  return Array.from(rowsBySirutaCode.values())
    .filter((row) => row.valueNumber !== null || row.valueJson !== null)
    .sort((left, right) => left.sirutaCode.localeCompare(right.sirutaCode));
}

export const makeAdvancedMapDatasetRoutes = (
  deps: MakeAdvancedMapDatasetRoutesDeps
): FastifyPluginAsync => {
  return async (fastify) => {
    await fastify.register(multipart, {
      limits: {
        fileSize: ADVANCED_MAP_DATASET_MAX_UPLOAD_BYTES,
        files: 1,
      },
    });

    fastify.post(
      '/api/v1/advanced-map-datasets',
      {
        preHandler: requireAuthHandler,
        schema: {
          response: {
            201: DatasetResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        let payload: DatasetMultipartPayload;
        try {
          payload = await readMultipartPayload(request, { requireMetadata: true });
        } catch (error) {
          return reply.status(400).send({
            ok: false,
            error: 'InvalidInputError',
            message: error instanceof Error ? error.message : 'Invalid multipart payload',
          });
        }

        const userId = await ensureWriteAccess(request, reply, deps.writePermissionChecker, {
          requiresPublicVisibilityPermission: payload.visibility === 'public',
        });
        if (userId === null) {
          return;
        }

        const rowsResult = await parseUploadedDatasetCsv(deps.budgetDb, payload.csvText);
        if (rowsResult.isErr()) {
          return reply.status(400).send({
            ok: false,
            error: 'InvalidInputError',
            message: rowsResult.error.message,
            details: {
              rows: rowsResult.error.rows,
            },
          });
        }

        if (rowsResult.value.rows.length > ADVANCED_MAP_DATASET_MAX_ROW_COUNT) {
          return reply.status(400).send({
            ok: false,
            error: 'InvalidInputError',
            message: `CSV exceeds maximum row count of ${String(ADVANCED_MAP_DATASET_MAX_ROW_COUNT)}`,
          });
        }

        const result = await createAdvancedMapDataset(
          {
            repo: deps.repo,
            generateId: () => deps.idGenerator.generateId(),
            generatePublicId: () => deps.idGenerator.generatePublicId(),
          },
          {
            request: {
              userId,
              title: payload.title ?? '',
              ...(payload.description !== undefined ? { description: payload.description } : {}),
              ...(payload.markdown !== undefined ? { markdown: payload.markdown } : {}),
              ...(payload.unit !== undefined ? { unit: payload.unit } : {}),
              ...(payload.visibility !== undefined ? { visibility: payload.visibility } : {}),
              rows: rowsResult.value.rows,
            },
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(201).send({
          ok: true,
          data: formatDataset(result.value),
        });
      }
    );

    fastify.post<{ Body: CreateDatasetJsonBody }>(
      '/api/v1/advanced-map-datasets/json',
      {
        preHandler: requireAuthHandler,
        schema: {
          body: CreateDatasetJsonBodySchema,
          response: {
            201: DatasetResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const userId = await ensureWriteAccess(request, reply, deps.writePermissionChecker, {
          requiresPublicVisibilityPermission: request.body.visibility === 'public',
        });
        if (userId === null) {
          return;
        }

        const rowErrors = await validateDatasetRowsAgainstSirutaUniverse(
          deps.budgetDb,
          request.body.rows
        );
        if (rowErrors.length > 0) {
          return reply.status(400).send({
            ok: false,
            error: 'InvalidInputError',
            message: 'Dataset row validation failed',
            details: {
              rows: rowErrors,
            },
          });
        }

        const result = await createAdvancedMapDataset(
          {
            repo: deps.repo,
            generateId: () => deps.idGenerator.generateId(),
            generatePublicId: () => deps.idGenerator.generatePublicId(),
          },
          {
            request: {
              userId,
              title: request.body.title,
              ...(request.body.description !== undefined
                ? { description: request.body.description }
                : {}),
              ...(request.body.markdown !== undefined ? { markdown: request.body.markdown } : {}),
              ...(request.body.unit !== undefined ? { unit: request.body.unit } : {}),
              ...(request.body.visibility !== undefined
                ? { visibility: request.body.visibility }
                : {}),
              rows: request.body.rows,
            },
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(201).send({
          ok: true,
          data: formatDataset(result.value),
        });
      }
    );

    fastify.get<{ Querystring: DatasetListQuery }>(
      '/api/v1/advanced-map-datasets',
      {
        preHandler: requireAuthHandler,
        schema: {
          querystring: DatasetListQuerySchema,
          response: {
            200: DatasetListResponseSchema,
            401: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return sendUnauthorized(reply);
        }

        const limit = parseOptionalNumber(request.query.limit);
        const offset = parseOptionalNumber(request.query.offset);
        const result = await listAdvancedMapDatasets(
          { repo: deps.repo },
          {
            userId: request.auth.userId,
            ...(limit !== undefined ? { limit } : {}),
            ...(offset !== undefined ? { offset } : {}),
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: formatConnection(result.value),
        });
      }
    );

    fastify.get<{ Params: DatasetIdParams }>(
      '/api/v1/advanced-map-datasets/:id',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: DatasetIdParamsSchema,
          response: {
            200: DatasetResponseSchema,
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

        const result = await getAdvancedMapDataset(
          { repo: deps.repo },
          {
            userId: request.auth.userId,
            datasetId: request.params.id,
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: formatDataset(result.value),
        });
      }
    );

    fastify.patch<{ Params: DatasetIdParams; Body: UpdateDatasetBody }>(
      '/api/v1/advanced-map-datasets/:id',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: DatasetIdParamsSchema,
          body: UpdateDatasetBodySchema,
          response: {
            200: DatasetResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const dataset = await getOwnedDatasetForWrite(request, reply, deps.repo, request.params.id);
        if (dataset === null) {
          return;
        }

        const requiresPublicVisibilityPermission =
          dataset.visibility === 'public' || request.body.visibility === 'public';
        const userId = await ensureWriteAccess(request, reply, deps.writePermissionChecker, {
          requiresPublicVisibilityPermission,
        });
        if (userId === null) {
          return;
        }

        const result = await updateAdvancedMapDatasetMetadata(
          { repo: deps.repo },
          {
            request: {
              userId,
              datasetId: request.params.id,
              ...(request.body.title !== undefined ? { title: request.body.title } : {}),
              ...(request.body.description !== undefined
                ? { description: request.body.description }
                : {}),
              ...(request.body.markdown !== undefined ? { markdown: request.body.markdown } : {}),
              ...(request.body.unit !== undefined ? { unit: request.body.unit } : {}),
              ...(request.body.visibility !== undefined
                ? { visibility: request.body.visibility }
                : {}),
              allowPublicWrite: requiresPublicVisibilityPermission,
            },
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: formatDataset(result.value),
        });
      }
    );

    fastify.post<{ Params: DatasetIdParams }>(
      '/api/v1/advanced-map-datasets/:id/file',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: DatasetIdParamsSchema,
          response: {
            200: DatasetResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const dataset = await getOwnedDatasetForWrite(request, reply, deps.repo, request.params.id);
        if (dataset === null) {
          return;
        }

        const requiresPublicVisibilityPermission = dataset.visibility === 'public';
        const userId = await ensureWriteAccess(request, reply, deps.writePermissionChecker, {
          requiresPublicVisibilityPermission,
        });
        if (userId === null) {
          return;
        }

        let payload: DatasetMultipartPayload;
        try {
          payload = await readMultipartPayload(request, { requireMetadata: false });
        } catch (error) {
          return reply.status(400).send({
            ok: false,
            error: 'InvalidInputError',
            message: error instanceof Error ? error.message : 'Invalid multipart payload',
          });
        }

        const rowsResult = await parseUploadedDatasetCsv(deps.budgetDb, payload.csvText);
        if (rowsResult.isErr()) {
          return reply.status(400).send({
            ok: false,
            error: 'InvalidInputError',
            message: rowsResult.error.message,
            details: {
              rows: rowsResult.error.rows,
            },
          });
        }

        const mergedRows = mergeCsvRowsIntoDatasetRows(dataset.rows, rowsResult.value.rows);
        const result = await replaceAdvancedMapDatasetRows(
          { repo: deps.repo },
          {
            userId,
            datasetId: request.params.id,
            rows: mergedRows,
            allowPublicWrite: requiresPublicVisibilityPermission,
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: formatDataset(result.value),
        });
      }
    );

    fastify.put<{ Params: DatasetIdParams; Body: ReplaceDatasetRowsBody }>(
      '/api/v1/advanced-map-datasets/:id/rows',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: DatasetIdParamsSchema,
          body: ReplaceDatasetRowsBodySchema,
          response: {
            200: DatasetResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const dataset = await getOwnedDatasetForWrite(request, reply, deps.repo, request.params.id);
        if (dataset === null) {
          return;
        }

        const requiresPublicVisibilityPermission = dataset.visibility === 'public';
        const userId = await ensureWriteAccess(request, reply, deps.writePermissionChecker, {
          requiresPublicVisibilityPermission,
        });
        if (userId === null) {
          return;
        }

        const rowErrors = await validateDatasetRowsAgainstSirutaUniverse(
          deps.budgetDb,
          request.body.rows
        );
        if (rowErrors.length > 0) {
          return reply.status(400).send({
            ok: false,
            error: 'InvalidInputError',
            message: 'Dataset row validation failed',
            details: {
              rows: rowErrors,
            },
          });
        }

        const result = await replaceAdvancedMapDatasetRows(
          { repo: deps.repo },
          {
            userId,
            datasetId: request.params.id,
            rows: request.body.rows,
            allowPublicWrite: requiresPublicVisibilityPermission,
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: formatDataset(result.value),
        });
      }
    );

    fastify.delete<{ Params: DatasetIdParams }>(
      '/api/v1/advanced-map-datasets/:id',
      {
        preHandler: requireAuthHandler,
        schema: {
          params: DatasetIdParamsSchema,
          response: {
            200: DatasetDeleteResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const dataset = await getOwnedDatasetForWrite(request, reply, deps.repo, request.params.id);
        if (dataset === null) {
          return;
        }

        const requiresPublicVisibilityPermission = dataset.visibility === 'public';
        const userId = await ensureWriteAccess(request, reply, deps.writePermissionChecker, {
          requiresPublicVisibilityPermission,
        });
        if (userId === null) {
          return;
        }

        const result = await deleteAdvancedMapDataset(
          { repo: deps.repo },
          {
            userId,
            datasetId: request.params.id,
            allowPublicWrite: requiresPublicVisibilityPermission,
          }
        );

        if (result.isErr()) {
          const details =
            result.error.type === 'DatasetInUseError'
              ? { referencingMaps: result.error.referencingMaps }
              : undefined;
          return sendError(reply, result.error, details);
        }

        return reply.status(200).send({ ok: true });
      }
    );

    fastify.get<{ Querystring: DatasetListQuery }>(
      '/api/v1/advanced-map-datasets/public',
      {
        schema: {
          querystring: DatasetListQuerySchema,
          response: {
            200: PublicDatasetListResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const limit = parseOptionalNumber(request.query.limit);
        const offset = parseOptionalNumber(request.query.offset);
        const result = await listPublicAdvancedMapDatasets(
          { repo: deps.repo },
          {
            ...(limit !== undefined ? { limit } : {}),
            ...(offset !== undefined ? { offset } : {}),
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: formatPublicConnection(result.value),
        });
      }
    );

    fastify.get<{ Params: DatasetPublicIdParams }>(
      '/api/v1/advanced-map-datasets/public/:publicId',
      {
        schema: {
          params: DatasetPublicIdParamsSchema,
          response: {
            200: PublicDatasetResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await getPublicAdvancedMapDataset(
          { repo: deps.repo },
          {
            publicId: request.params.publicId,
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: formatPublicDataset(result.value),
        });
      }
    );
  };
};
