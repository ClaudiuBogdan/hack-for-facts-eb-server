import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { fromThrowable } from 'neverthrow';

import { isAuthenticated, requireAuthHandler } from '@/modules/auth/index.js';

import { sendUserDataRouteError } from './route-errors.js';
import {
  AdminHistoryParamsSchema,
  AdminListQuerySchema,
  CategoryParamsSchema,
  ErrorResponseSchema,
  EventPageResponseSchema,
  HistoryQuerySchema,
  PageResponseSchema,
  type AdminHistoryParams,
  type AdminListQuery,
  type CategoryParams,
  type HistoryQuery,
} from './schemas.js';
import {
  createAdminAccessNotConfigured,
  createForbidden,
  createInvalidPayload,
} from '../../core/errors.js';
import { adminGetRecordHistory } from '../../core/usecases/admin-get-record-history.js';
import { adminListRecords } from '../../core/usecases/admin-list-records.js';

import type { AdminRecordFilters } from '../../core/types.js';
import type { AdminReadDeps } from '../../core/usecases/read-shared.js';
import type { CampaignAdminPermissionAuthorizer } from '@/modules/campaign-admin/index.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export type MakeUserDataAdminRoutesDeps = AdminReadDeps & {
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
};

const ERRORS = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  500: ErrorResponseSchema,
} as const;

const FilterObjectSchema = Type.Object({}, { additionalProperties: true });
const parseJson = fromThrowable(JSON.parse);

const authorizeCategory = async (
  deps: MakeUserDataAdminRoutesDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  category: string
): Promise<string | null> => {
  if (!isAuthenticated(request.auth)) return null;
  const definition = deps.registry.get(category);
  if (definition === undefined) {
    void sendUserDataRouteError(reply, createAdminAccessNotConfigured(category));
    return null;
  }
  if (definition.adminPermission === null) {
    void sendUserDataRouteError(reply, createAdminAccessNotConfigured(category));
    return null;
  }
  const allowed = await deps.permissionAuthorizer.hasPermission({
    userId: request.auth.userId,
    permissionName: definition.adminPermission,
  });
  if (!allowed) {
    void sendUserDataRouteError(reply, createForbidden('required category permission was denied'));
    return null;
  }
  return definition.adminPermission;
};

const parseFilters = (query: AdminListQuery): AdminRecordFilters | null => {
  if ((query.targetType === undefined) !== (query.targetId === undefined)) return null;
  let registered: Record<string, unknown> | undefined;
  if (query.filters !== undefined) {
    const parsed = parseJson(query.filters);
    if (parsed.isErr() || !Value.Check(FilterObjectSchema, parsed.value)) return null;
    registered = parsed.value;
  }
  return {
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.targetType === undefined || query.targetId === undefined
      ? {}
      : { target: { targetType: query.targetType, targetId: query.targetId } }),
    ...(query.createdFrom === undefined ? {} : { createdAtFrom: new Date(query.createdFrom) }),
    ...(query.createdTo === undefined ? {} : { createdAtTo: new Date(query.createdTo) }),
    ...(registered === undefined ? {} : { query: registered }),
  };
};

export const makeUserDataAdminRoutes = (deps: MakeUserDataAdminRoutesDeps): FastifyPluginAsync => {
  return (fastify) => {
    fastify.addHook('preHandler', requireAuthHandler);

    fastify.get<{ Params: CategoryParams; Querystring: AdminListQuery }>(
      '/api/admin/user-data/:category/records',
      {
        schema: {
          params: CategoryParamsSchema,
          querystring: AdminListQuerySchema,
          response: { 200: PageResponseSchema, ...ERRORS },
        },
      },
      async (request, reply) => {
        const permission = await authorizeCategory(deps, request, reply, request.params.category);
        if (permission === null) return;
        const filters = parseFilters(request.query);
        if (filters === null)
          return sendUserDataRouteError(reply, createInvalidPayload(['/filters:invalid']));
        const result = await adminListRecords(deps, {
          category: request.params.category,
          grantedPermission: permission,
          filters,
          limit: request.query.limit ?? 100,
          cursor: request.query.cursor ?? null,
        });
        return result.isErr()
          ? sendUserDataRouteError(reply, result.error)
          : reply.status(200).send(result.value);
      }
    );

    fastify.get<{ Params: AdminHistoryParams; Querystring: HistoryQuery }>(
      '/api/admin/user-data/:category/records/:recordId/history',
      {
        schema: {
          params: AdminHistoryParamsSchema,
          querystring: HistoryQuerySchema,
          response: { 200: EventPageResponseSchema, ...ERRORS },
        },
      },
      async (request, reply) => {
        const permission = await authorizeCategory(deps, request, reply, request.params.category);
        if (permission === null) return;
        const result = await adminGetRecordHistory(deps, {
          category: request.params.category,
          grantedPermission: permission,
          recordId: request.params.recordId,
          limit: request.query.limit ?? 100,
          beforeRevision: request.query.beforeRevision ?? null,
        });
        return result.isErr()
          ? sendUserDataRouteError(reply, result.error)
          : reply.status(200).send(result.value);
      }
    );

    return Promise.resolve();
  };
};
