import { Value } from '@sinclair/typebox/value';

import { deserialize } from '@/infra/cache/serialization.js';
import {
  makeCampaignAdminAuthorizationHook,
  resolveCampaignAdminPermissionAccess,
  type CampaignAdminPermissionAuthorizer,
} from '@/modules/campaign-admin/index.js';
import {
  buildCampaignInteractionFilters,
  getCampaignAdminReviewConfig,
  listCampaignAdminAvailableInteractionTypes,
  type CampaignAdminInteractionFilter,
} from '@/modules/learning-progress/index.js';

import {
  CampaignAdminEntityDetailQuerySchema,
  CampaignAdminEntityResponseSchema,
  CampaignAdminEntityParamsSchema,
  CampaignAdminEntitiesCursorSchema,
  CampaignAdminEntitiesListQuerySchema,
  CampaignAdminEntitiesListResponseSchema,
  CampaignAdminEntitiesMetaResponseSchema,
  CampaignKeyParamsSchema,
  ErrorResponseSchema,
  type CampaignAdminEntityDetailQuery,
  type CampaignAdminEntityParams,
  type CampaignAdminEntitiesListQuery,
  type CampaignKeyParams,
} from './schemas.js';
import { getHttpStatusForError, type CampaignAdminEntitiesError } from '../../core/errors.js';
import {
  type CampaignAdminAvailableInteractionType,
  type CampaignAdminEntitiesCampaignKey,
  type CampaignAdminEntityListCursor,
  type CampaignAdminEntitySortBy,
  type CampaignAdminEntitySortOrder,
} from '../../core/types.js';
import { getCampaignAdminEntitiesMeta } from '../../core/usecases/get-campaign-admin-entities-meta.js';
import { getCampaignAdminEntity } from '../../core/usecases/get-campaign-admin-entity.js';
import { listCampaignAdminEntities } from '../../core/usecases/list-campaign-admin-entities.js';

import type { CampaignAdminEntitiesRepository } from '../../core/ports.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SORT_BY: CampaignAdminEntitySortBy = 'latestInteractionAt';
const ALLOWED_QUERY_KEYS = new Set<string>([
  'query',
  'interactionId',
  'hasPendingReviews',
  'hasSubscribers',
  'hasNotificationActivity',
  'hasFailedNotifications',
  'updatedAtFrom',
  'updatedAtTo',
  'latestNotificationType',
  'latestNotificationStatus',
  'sortBy',
  'sortOrder',
  'cursor',
  'limit',
]);

interface CampaignAdminEntitiesRouteConfig {
  readonly campaignKey: CampaignAdminEntitiesCampaignKey;
  readonly permissionName: string;
  readonly interactions: readonly CampaignAdminInteractionFilter[];
  readonly reviewableInteractions: readonly CampaignAdminInteractionFilter[];
  readonly availableInteractionTypes: readonly CampaignAdminAvailableInteractionType[];
}

interface CampaignAdminEntitiesAccessContext {
  readonly userId: string;
  readonly config: CampaignAdminEntitiesRouteConfig;
}

declare module 'fastify' {
  interface FastifyRequest {
    campaignAdminEntitiesAccess: CampaignAdminEntitiesAccessContext | null;
  }
}

function createCampaignAdminEntitiesRouteConfig(
  campaignKey: CampaignAdminEntitiesCampaignKey
): CampaignAdminEntitiesRouteConfig | null {
  const reviewConfig = getCampaignAdminReviewConfig(campaignKey);
  if (reviewConfig === null) {
    return null;
  }

  return {
    campaignKey,
    permissionName: reviewConfig.permissionName,
    interactions: buildCampaignInteractionFilters({
      interactions: reviewConfig.interactions,
      kind: 'visible',
    }),
    reviewableInteractions: buildCampaignInteractionFilters({
      interactions: reviewConfig.interactions,
      kind: 'reviewable',
    }),
    availableInteractionTypes: listCampaignAdminAvailableInteractionTypes(
      reviewConfig
    ) satisfies readonly CampaignAdminAvailableInteractionType[],
  };
}

const funkyRouteConfig = createCampaignAdminEntitiesRouteConfig('funky');
if (funkyRouteConfig === null) {
  throw new Error('Campaign admin entity routes require a shared review config for funky.');
}

const CAMPAIGN_ADMIN_ENTITIES_ROUTE_CONFIGS: Readonly<
  Record<CampaignAdminEntitiesCampaignKey, CampaignAdminEntitiesRouteConfig>
> = {
  funky: funkyRouteConfig,
};

function getCampaignAdminEntitiesRouteConfig(
  campaignKey: string
): CampaignAdminEntitiesRouteConfig | null {
  if (Object.hasOwn(CAMPAIGN_ADMIN_ENTITIES_ROUTE_CONFIGS, campaignKey)) {
    return CAMPAIGN_ADMIN_ENTITIES_ROUTE_CONFIGS[campaignKey as CampaignAdminEntitiesCampaignKey];
  }

  return null;
}

function getCampaignAdminEntitiesAccess(
  request: FastifyRequest
): CampaignAdminEntitiesAccessContext {
  const access = request.campaignAdminEntitiesAccess;
  if (access === null) {
    throw new Error('Campaign admin entities access context missing from request');
  }

  return access;
}

function makeCampaignAdminEntitiesAuthHook(input: {
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  enabledCampaignKeys: ReadonlySet<string>;
}) {
  return makeCampaignAdminAuthorizationHook<CampaignAdminEntitiesAccessContext>({
    setAccessContext(request, accessContext) {
      request.campaignAdminEntitiesAccess = accessContext;
    },
    authorize: async ({ campaignKey, userId }) => {
      return resolveCampaignAdminPermissionAccess({
        campaignKey,
        userId,
        permissionAuthorizer: input.permissionAuthorizer,
        enabledCampaignKeys: input.enabledCampaignKeys,
        getConfig: getCampaignAdminEntitiesRouteConfig,
        getPermissionName(config) {
          return config.permissionName;
        },
        buildAccessContext({ userId: accessUserId, config }) {
          return {
            userId: accessUserId,
            config,
          };
        },
        notFoundMessage: 'Campaign entity admin not found',
        forbiddenMessage: 'You do not have permission to access this campaign entity admin',
      });
    },
  });
}

function encodeCursor(cursor: CampaignAdminEntityListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function isValidCursorValue(cursor: CampaignAdminEntityListCursor): boolean {
  if (cursor.sortBy === 'entityCui') {
    return typeof cursor.value === 'string' && cursor.value.length > 0;
  }

  if (
    cursor.sortBy === 'userCount' ||
    cursor.sortBy === 'interactionCount' ||
    cursor.sortBy === 'pendingReviewCount' ||
    cursor.sortBy === 'notificationSubscriberCount' ||
    cursor.sortBy === 'notificationOutboxCount'
  ) {
    return typeof cursor.value === 'number' && Number.isFinite(cursor.value);
  }

  if (cursor.value === null) {
    return true;
  }

  return typeof cursor.value === 'string' && !Number.isNaN(Date.parse(cursor.value));
}

function decodeCursor(encodedCursor: string): CampaignAdminEntityListCursor | null {
  try {
    const decodedCursor = Buffer.from(encodedCursor, 'base64url').toString('utf-8');
    const parseResult = deserialize(decodedCursor);
    if (!parseResult.ok) {
      return null;
    }

    if (!Value.Check(CampaignAdminEntitiesCursorSchema, parseResult.value)) {
      return null;
    }

    const cursor = parseResult.value as CampaignAdminEntityListCursor;
    return isValidCursorValue(cursor) ? cursor : null;
  } catch {
    return null;
  }
}

function getDefaultSortOrder(sortBy: CampaignAdminEntitySortBy): CampaignAdminEntitySortOrder {
  return sortBy === 'entityCui' ? 'asc' : 'desc';
}

function normalizeRequestedSort(
  query: Pick<CampaignAdminEntitiesListQuery, 'sortBy' | 'sortOrder'>
): {
  readonly sortBy: CampaignAdminEntitySortBy;
  readonly sortOrder: CampaignAdminEntitySortOrder;
} {
  const sortBy = query.sortBy ?? DEFAULT_SORT_BY;

  return {
    sortBy,
    sortOrder: query.sortOrder ?? getDefaultSortOrder(sortBy),
  };
}

function normalizeQuery(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue === '' ? undefined : trimmedValue;
}

function getUnknownQueryKeys(request: FastifyRequest): readonly string[] {
  const requestUrl = request.raw.url;
  if (requestUrl === undefined) {
    return [];
  }

  const searchParams = new URL(requestUrl, 'http://localhost').searchParams;
  const unknownKeys = new Set<string>();

  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      unknownKeys.add(key);
    }
  }

  return [...unknownKeys];
}

function sendError(reply: FastifyReply, error: CampaignAdminEntitiesError) {
  const statusCode = getHttpStatusForError(error);
  return reply.status(statusCode).send({
    ok: false,
    error: error.type,
    message: error.message,
    retryable: 'retryable' in error ? error.retryable : false,
  });
}

export interface MakeCampaignAdminEntitiesRoutesDeps {
  readonly enabledCampaignKeys: readonly CampaignAdminEntitiesCampaignKey[];
  readonly permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  readonly entitiesRepository: CampaignAdminEntitiesRepository;
}

export const makeCampaignAdminEntitiesRoutes = (
  deps: MakeCampaignAdminEntitiesRoutesDeps
): FastifyPluginAsync => {
  if (typeof deps.permissionAuthorizer.hasPermission !== 'function') {
    throw new Error('Campaign admin entity routes require a permission authorizer');
  }

  if (deps.enabledCampaignKeys.length === 0) {
    throw new Error('Campaign admin entity routes require at least one enabled campaign key.');
  }

  const missingConfigs = deps.enabledCampaignKeys.filter(
    (campaignKey) => getCampaignAdminEntitiesRouteConfig(campaignKey) === null
  );
  if (missingConfigs.length > 0) {
    throw new Error(
      `Campaign admin entity routes require supported route configs for: ${missingConfigs.join(', ')}.`
    );
  }

  return async (fastify) => {
    const enabledCampaignKeys = new Set<string>(deps.enabledCampaignKeys);
    fastify.decorateRequest('campaignAdminEntitiesAccess', null);
    fastify.addHook(
      'preHandler',
      makeCampaignAdminEntitiesAuthHook({
        permissionAuthorizer: deps.permissionAuthorizer,
        enabledCampaignKeys,
      })
    );

    fastify.get<{ Params: CampaignKeyParams }>(
      '/api/v1/admin/campaigns/:campaignKey/entities/meta',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          response: {
            200: CampaignAdminEntitiesMetaResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminEntitiesAccess(request);
        const result = await getCampaignAdminEntitiesMeta(
          {
            entitiesRepository: deps.entitiesRepository,
          },
          {
            campaignKey: access.config.campaignKey,
            interactions: access.config.interactions,
            reviewableInteractions: access.config.reviewableInteractions,
            availableInteractionTypes: access.config.availableInteractionTypes,
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: result.value,
        });
      }
    );

    fastify.get<{ Params: CampaignAdminEntityParams; Querystring: CampaignAdminEntityDetailQuery }>(
      '/api/v1/admin/campaigns/:campaignKey/entities/:entityCui',
      {
        schema: {
          params: CampaignAdminEntityParamsSchema,
          querystring: CampaignAdminEntityDetailQuerySchema,
          response: {
            200: CampaignAdminEntityResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminEntitiesAccess(request);
        const result = await getCampaignAdminEntity(
          {
            entitiesRepository: deps.entitiesRepository,
          },
          {
            campaignKey: access.config.campaignKey,
            interactions: access.config.interactions,
            reviewableInteractions: access.config.reviewableInteractions,
            entityCui: request.params.entityCui,
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: result.value,
        });
      }
    );

    fastify.get<{ Params: CampaignKeyParams; Querystring: CampaignAdminEntitiesListQuery }>(
      '/api/v1/admin/campaigns/:campaignKey/entities',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          querystring: CampaignAdminEntitiesListQuerySchema,
          response: {
            200: CampaignAdminEntitiesListResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminEntitiesAccess(request);
        const unknownQueryKeys = getUnknownQueryKeys(request);
        if (unknownQueryKeys.length > 0) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: `Unknown campaign entity filters: ${unknownQueryKeys.join(', ')}`,
            retryable: false,
          });
        }

        const requestedSort = normalizeRequestedSort(request.query);
        const decodedCursor =
          request.query.cursor !== undefined ? decodeCursor(request.query.cursor) : undefined;
        const cursor = decodedCursor ?? undefined;

        if (request.query.cursor !== undefined && cursor === undefined) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: 'Invalid campaign entity cursor',
            retryable: false,
          });
        }

        if (
          cursor !== undefined &&
          (cursor.sortBy !== requestedSort.sortBy || cursor.sortOrder !== requestedSort.sortOrder)
        ) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: 'Invalid campaign entity cursor',
            retryable: false,
          });
        }

        const normalizedQuery = normalizeQuery(request.query.query);
        const result = await listCampaignAdminEntities(
          {
            entitiesRepository: deps.entitiesRepository,
          },
          {
            campaignKey: access.config.campaignKey,
            interactions: access.config.interactions,
            reviewableInteractions: access.config.reviewableInteractions,
            ...(normalizedQuery !== undefined ? { query: normalizedQuery } : {}),
            ...(request.query.interactionId !== undefined
              ? { interactionId: request.query.interactionId }
              : {}),
            ...(request.query.hasPendingReviews !== undefined
              ? { hasPendingReviews: request.query.hasPendingReviews }
              : {}),
            ...(request.query.hasSubscribers !== undefined
              ? { hasSubscribers: request.query.hasSubscribers }
              : {}),
            ...(request.query.hasNotificationActivity !== undefined
              ? { hasNotificationActivity: request.query.hasNotificationActivity }
              : {}),
            ...(request.query.hasFailedNotifications !== undefined
              ? { hasFailedNotifications: request.query.hasFailedNotifications }
              : {}),
            ...(request.query.updatedAtFrom !== undefined
              ? { updatedAtFrom: request.query.updatedAtFrom }
              : {}),
            ...(request.query.updatedAtTo !== undefined
              ? { updatedAtTo: request.query.updatedAtTo }
              : {}),
            ...(request.query.latestNotificationType !== undefined
              ? { latestNotificationType: request.query.latestNotificationType }
              : {}),
            ...(request.query.latestNotificationStatus !== undefined
              ? { latestNotificationStatus: request.query.latestNotificationStatus }
              : {}),
            sortBy: requestedSort.sortBy,
            sortOrder: requestedSort.sortOrder,
            ...(cursor !== undefined ? { cursor } : {}),
            limit: request.query.limit ?? DEFAULT_LIST_LIMIT,
          }
        );

        if (result.isErr()) {
          return sendError(reply, result.error);
        }

        return reply.status(200).send({
          ok: true,
          data: {
            items: result.value.items,
            page: {
              totalCount: result.value.totalCount,
              hasMore: result.value.hasMore,
              nextCursor:
                result.value.nextCursor !== null ? encodeCursor(result.value.nextCursor) : null,
              sortBy: requestedSort.sortBy,
              sortOrder: requestedSort.sortOrder,
            },
          },
        });
      }
    );
  };
};
