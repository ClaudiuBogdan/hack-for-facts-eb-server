import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { fromThrowable } from 'neverthrow';

import {
  FUNKY_CAMPAIGN_ADMIN_PERMISSION,
  makeCampaignAdminAuthorizationHook,
  resolveCampaignAdminPermissionAccess,
  type CampaignAdminPermissionAuthorizer,
} from '@/modules/campaign-admin/index.js';

import {
  CampaignKeyParamsSchema,
  CampaignNotificationListQuerySchema,
  CampaignNotificationListResponseSchema,
  CampaignNotificationMetaResponseSchema,
  CampaignNotificationPlanIdParamsSchema,
  CampaignNotificationRunnableIdParamsSchema,
  CampaignNotificationRunnablePlanReadQuerySchema,
  CampaignNotificationRunnablePlanResponseSchema,
  CampaignNotificationRunnablePlanSendResponseSchema,
  CampaignNotificationRunnableTemplateListResponseSchema,
  CampaignNotificationSortBySchema,
  CampaignNotificationSortOrderSchema,
  CampaignNotificationTemplateIdParamsSchema,
  CampaignNotificationTemplateListResponseSchema,
  CampaignNotificationTemplatePreviewResponseSchema,
  CampaignNotificationTriggerBulkExecutionResponseSchema,
  CampaignNotificationTriggerExecutionResponseSchema,
  CampaignNotificationTriggerListResponseSchema,
  ErrorResponseSchema,
  type CampaignKeyParams,
  type CampaignNotificationListQuery,
  type CampaignNotificationPlanIdParams,
  type CampaignNotificationRunnableIdParams,
  type CampaignNotificationRunnablePlanReadQuery,
  type CampaignNotificationTemplateIdParams,
} from './schemas.js';
import { getHttpStatusForError } from '../../core/errors.js';
import { createCampaignNotificationRunnablePlan } from '../../core/usecases/create-campaign-notification-runnable-plan.js';
import { executeCampaignNotificationTriggerBulk } from '../../core/usecases/execute-campaign-notification-trigger-bulk.js';
import { executeCampaignNotificationTrigger } from '../../core/usecases/execute-campaign-notification-trigger.js';
import { getCampaignNotificationRunnablePlan } from '../../core/usecases/get-campaign-notification-runnable-plan.js';
import { getCampaignNotificationTemplatePreview } from '../../core/usecases/get-campaign-notification-template-preview.js';
import { listCampaignNotificationAudit } from '../../core/usecases/list-campaign-notification-audit.js';
import { listCampaignNotificationRunnableTemplates } from '../../core/usecases/list-campaign-notification-runnable-templates.js';
import { listCampaignNotificationTemplates } from '../../core/usecases/list-campaign-notification-templates.js';
import { sendCampaignNotificationRunnablePlan } from '../../core/usecases/send-campaign-notification-runnable-plan.js';

import type {
  CampaignNotificationAuditRepository,
  CampaignNotificationRunnablePlanRepository,
  CampaignNotificationRunnableTemplateRegistry,
  CampaignNotificationTemplatePreviewService,
  CampaignNotificationTriggerRegistry,
} from '../../core/ports.js';
import type {
  CampaignNotificationAdminCampaignKey,
  CampaignNotificationAuditCursor,
} from '../../core/types.js';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

const parseJson = fromThrowable(JSON.parse);
interface CampaignNotificationRouteConfig {
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly permissionName: string;
}

interface CampaignAdminNotificationAccessContext {
  readonly userId: string;
  readonly config: CampaignNotificationRouteConfig;
}

declare module 'fastify' {
  interface FastifyRequest {
    campaignAdminNotificationAccess: CampaignAdminNotificationAccessContext | null;
  }
}

const CAMPAIGN_NOTIFICATION_ROUTE_CONFIGS: Readonly<
  Record<CampaignNotificationAdminCampaignKey, CampaignNotificationRouteConfig>
> = {
  funky: {
    campaignKey: 'funky',
    permissionName: FUNKY_CAMPAIGN_ADMIN_PERMISSION,
  },
};

const DEFAULT_LIST_LIMIT = 50;
const ALLOWED_CAMPAIGN_NOTIFICATION_QUERY_KEYS = new Set<string>([
  'notificationType',
  'templateId',
  'userId',
  'status',
  'eventType',
  'entityCui',
  'threadId',
  'source',
  'sortBy',
  'sortOrder',
  'cursor',
  'limit',
]);

const CampaignNotificationCursorSchema = Type.Object(
  {
    sortBy: CampaignNotificationSortBySchema,
    sortOrder: CampaignNotificationSortOrderSchema,
    id: Type.String({ minLength: 1 }),
    value: Type.Union([Type.String({ minLength: 1 }), Type.Number(), Type.Null()]),
  },
  { additionalProperties: false }
);

const TriggerParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
    triggerId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

type TriggerParams = CampaignKeyParams & { triggerId: string };

function getCampaignNotificationRouteConfig(
  campaignKey: string
): CampaignNotificationRouteConfig | null {
  if (Object.hasOwn(CAMPAIGN_NOTIFICATION_ROUTE_CONFIGS, campaignKey)) {
    return CAMPAIGN_NOTIFICATION_ROUTE_CONFIGS[campaignKey as CampaignNotificationAdminCampaignKey];
  }

  return null;
}

function getCampaignAdminNotificationAccess(
  request: FastifyRequest
): CampaignAdminNotificationAccessContext {
  const access = request.campaignAdminNotificationAccess;
  if (access === null) {
    throw new Error('Campaign admin notification access context missing from request');
  }

  return access;
}

function makeCampaignNotificationAuthHook(input: {
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  enabledCampaignKeys: ReadonlySet<string>;
}) {
  return makeCampaignAdminAuthorizationHook<CampaignAdminNotificationAccessContext>({
    setAccessContext(request, accessContext) {
      request.campaignAdminNotificationAccess = accessContext;
    },
    authorize: async ({ campaignKey, userId }) => {
      return resolveCampaignAdminPermissionAccess({
        campaignKey,
        userId,
        permissionAuthorizer: input.permissionAuthorizer,
        enabledCampaignKeys: input.enabledCampaignKeys,
        getConfig: getCampaignNotificationRouteConfig,
        getPermissionName(config) {
          return config.permissionName;
        },
        buildAccessContext({ userId: accessUserId, config }) {
          return {
            userId: accessUserId,
            config,
          };
        },
        notFoundMessage: 'Campaign notification admin not found',
        forbiddenMessage: 'You do not have permission to access this campaign notification admin',
      });
    },
  });
}

function encodeCursor(cursor: CampaignNotificationAuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64url');
}

function decodeCursor(encodedCursor: string): CampaignNotificationAuditCursor | null {
  const parseResult = parseJson(Buffer.from(encodedCursor, 'base64url').toString('utf-8'));
  if (parseResult.isErr()) {
    return null;
  }

  return Value.Check(CampaignNotificationCursorSchema, parseResult.value)
    ? (parseResult.value as CampaignNotificationAuditCursor)
    : null;
}

function getUnknownQueryKeys(
  request: FastifyRequest,
  allowedKeys: ReadonlySet<string>
): readonly string[] {
  const requestUrl = request.raw.url;
  if (requestUrl === undefined) {
    return [];
  }

  const searchParams = new URL(requestUrl, 'http://localhost').searchParams;
  const unknownKeys = new Set<string>();

  for (const key of searchParams.keys()) {
    if (!allowedKeys.has(key)) {
      unknownKeys.add(key);
    }
  }

  return [...unknownKeys];
}

export interface MakeCampaignAdminNotificationRoutesDeps {
  enabledCampaignKeys: readonly CampaignNotificationAdminCampaignKey[];
  permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  auditRepository: CampaignNotificationAuditRepository;
  triggerRegistry: CampaignNotificationTriggerRegistry;
  runnableTemplateRegistry: CampaignNotificationRunnableTemplateRegistry;
  planRepository: CampaignNotificationRunnablePlanRepository;
  templatePreviewService: CampaignNotificationTemplatePreviewService;
}

export const makeCampaignAdminNotificationRoutes = (
  deps: MakeCampaignAdminNotificationRoutesDeps
): FastifyPluginAsync => {
  if (deps.enabledCampaignKeys.length === 0) {
    throw new Error(
      'Campaign admin notification routes require at least one enabled campaign key.'
    );
  }

  return async (fastify) => {
    const enabledCampaignKeys = new Set<string>(deps.enabledCampaignKeys);
    fastify.decorateRequest('campaignAdminNotificationAccess', null);
    fastify.addHook(
      'preHandler',
      makeCampaignNotificationAuthHook({
        permissionAuthorizer: deps.permissionAuthorizer,
        enabledCampaignKeys,
      })
    );

    fastify.get<{ Params: CampaignKeyParams; Querystring: CampaignNotificationListQuery }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          querystring: CampaignNotificationListQuerySchema,
          response: {
            200: CampaignNotificationListResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminNotificationAccess(request);
        const unknownQueryKeys = getUnknownQueryKeys(
          request,
          ALLOWED_CAMPAIGN_NOTIFICATION_QUERY_KEYS
        );
        if (unknownQueryKeys.length > 0) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: `Unknown campaign notification filters: ${unknownQueryKeys.join(', ')}`,
            retryable: false,
          });
        }

        const decodedCursor =
          request.query.cursor !== undefined ? decodeCursor(request.query.cursor) : undefined;
        const requestedSortBy = request.query.sortBy ?? 'createdAt';
        const requestedSortOrder = request.query.sortOrder ?? 'desc';
        if (request.query.cursor !== undefined && decodedCursor === null) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: 'Invalid campaign notification cursor',
            retryable: false,
          });
        }
        const cursor = decodedCursor ?? undefined;
        if (
          cursor !== undefined &&
          (cursor.sortBy !== requestedSortBy || cursor.sortOrder !== requestedSortOrder)
        ) {
          return reply.status(400).send({
            ok: false,
            error: 'ValidationError',
            message: 'Invalid campaign notification cursor',
            retryable: false,
          });
        }

        const result = await listCampaignNotificationAudit(
          {
            auditRepository: deps.auditRepository,
          },
          {
            campaignKey: access.config.campaignKey,
            ...(request.query.notificationType !== undefined
              ? { notificationType: request.query.notificationType }
              : {}),
            ...(request.query.templateId !== undefined
              ? { templateId: request.query.templateId }
              : {}),
            ...(request.query.userId !== undefined ? { userId: request.query.userId } : {}),
            ...(request.query.status !== undefined ? { status: request.query.status } : {}),
            ...(request.query.eventType !== undefined
              ? { eventType: request.query.eventType }
              : {}),
            ...(request.query.entityCui !== undefined
              ? { entityCui: request.query.entityCui }
              : {}),
            ...(request.query.threadId !== undefined ? { threadId: request.query.threadId } : {}),
            ...(request.query.source !== undefined ? { source: request.query.source } : {}),
            sortBy: requestedSortBy,
            sortOrder: requestedSortOrder,
            ...(cursor !== undefined ? { cursor } : {}),
            limit: request.query.limit ?? DEFAULT_LIST_LIMIT,
          }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: {
            items: result.value.items,
            page: {
              nextCursor:
                result.value.nextCursor === null ? null : encodeCursor(result.value.nextCursor),
              hasMore: result.value.hasMore,
            },
          },
        });
      }
    );

    fastify.get<{ Params: CampaignKeyParams }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications/meta',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          response: {
            200: CampaignNotificationMetaResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminNotificationAccess(request);
        const result = await deps.auditRepository.getCampaignNotificationMetaCounts({
          campaignKey: access.config.campaignKey,
        });

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: result.value,
        });
      }
    );

    fastify.get<{ Params: CampaignKeyParams }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications/triggers',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          response: {
            200: CampaignNotificationTriggerListResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminNotificationAccess(request);
        return reply.status(200).send({
          ok: true,
          data: {
            items: deps.triggerRegistry.list(access.config.campaignKey),
          },
        });
      }
    );

    fastify.post<{ Params: TriggerParams; Body: unknown }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications/triggers/:triggerId',
      {
        schema: {
          params: TriggerParamsSchema,
          body: Type.Unknown(),
          response: {
            200: CampaignNotificationTriggerExecutionResponseSchema,
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
        const access = getCampaignAdminNotificationAccess(request);
        const result = await executeCampaignNotificationTrigger(
          {
            triggerRegistry: deps.triggerRegistry,
          },
          {
            campaignKey: access.config.campaignKey,
            triggerId: request.params.triggerId,
            actorUserId: access.userId,
            payload: request.body,
          }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        const definition = deps.triggerRegistry.get(
          access.config.campaignKey,
          request.params.triggerId
        );
        if (definition === null) {
          return reply.status(404).send({
            ok: false,
            error: 'NotFoundError',
            message: `Campaign notification trigger "${request.params.triggerId}" was not found.`,
            retryable: false,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: {
            triggerId: definition.triggerId,
            campaignKey: definition.campaignKey,
            templateId: definition.templateId,
            result: result.value,
          },
        });
      }
    );

    fastify.post<{ Params: TriggerParams; Body: unknown }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications/triggers/:triggerId/bulk',
      {
        schema: {
          params: TriggerParamsSchema,
          body: Type.Unknown(),
          response: {
            200: CampaignNotificationTriggerBulkExecutionResponseSchema,
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
        const access = getCampaignAdminNotificationAccess(request);
        const result = await executeCampaignNotificationTriggerBulk(
          {
            triggerRegistry: deps.triggerRegistry,
          },
          {
            campaignKey: access.config.campaignKey,
            triggerId: request.params.triggerId,
            actorUserId: access.userId,
            payload: request.body,
          }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        const definition = deps.triggerRegistry.get(
          access.config.campaignKey,
          request.params.triggerId
        );
        if (definition === null) {
          return reply.status(404).send({
            ok: false,
            error: 'NotFoundError',
            message: `Campaign notification trigger "${request.params.triggerId}" was not found.`,
            retryable: false,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: {
            triggerId: definition.triggerId,
            campaignKey: definition.campaignKey,
            templateId: definition.templateId,
            result: result.value,
          },
        });
      }
    );

    fastify.get<{ Params: CampaignKeyParams }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications/templates',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          response: {
            200: CampaignNotificationTemplateListResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminNotificationAccess(request);
        const result = await listCampaignNotificationTemplates(
          {
            templatePreviewService: deps.templatePreviewService,
          },
          access.config.campaignKey
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: {
            items: result.value,
          },
        });
      }
    );

    fastify.get<{ Params: CampaignKeyParams }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications/runnable-templates',
      {
        schema: {
          params: CampaignKeyParamsSchema,
          response: {
            200: CampaignNotificationRunnableTemplateListResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminNotificationAccess(request);

        return reply.status(200).send({
          ok: true,
          data: {
            items: listCampaignNotificationRunnableTemplates(
              {
                runnableTemplateRegistry: deps.runnableTemplateRegistry,
              },
              access.config.campaignKey
            ),
          },
        });
      }
    );

    fastify.post<{ Params: CampaignNotificationRunnableIdParams; Body: unknown }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications/runnable-templates/:runnableId/dry-run',
      {
        schema: {
          params: CampaignNotificationRunnableIdParamsSchema,
          body: Type.Unknown(),
          response: {
            200: CampaignNotificationRunnablePlanResponseSchema,
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
        const access = getCampaignAdminNotificationAccess(request);
        const result = await createCampaignNotificationRunnablePlan(
          {
            runnableTemplateRegistry: deps.runnableTemplateRegistry,
            planRepository: deps.planRepository,
          },
          {
            campaignKey: access.config.campaignKey,
            runnableId: request.params.runnableId,
            actorUserId: access.userId,
            payload: request.body,
          }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: result.value,
        });
      }
    );

    fastify.get<{ Params: CampaignNotificationTemplateIdParams }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications/templates/:templateId/preview',
      {
        schema: {
          params: CampaignNotificationTemplateIdParamsSchema,
          response: {
            200: CampaignNotificationTemplatePreviewResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const access = getCampaignAdminNotificationAccess(request);
        const result = await getCampaignNotificationTemplatePreview(
          {
            templatePreviewService: deps.templatePreviewService,
          },
          {
            campaignKey: access.config.campaignKey,
            templateId: request.params.templateId,
          }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: result.value,
        });
      }
    );

    fastify.get<{
      Params: CampaignNotificationPlanIdParams;
      Querystring: CampaignNotificationRunnablePlanReadQuery;
    }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications/plans/:planId',
      {
        schema: {
          params: CampaignNotificationPlanIdParamsSchema,
          querystring: CampaignNotificationRunnablePlanReadQuerySchema,
          response: {
            200: CampaignNotificationRunnablePlanResponseSchema,
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
        const access = getCampaignAdminNotificationAccess(request);
        const result = await getCampaignNotificationRunnablePlan(
          {
            planRepository: deps.planRepository,
          },
          {
            campaignKey: access.config.campaignKey,
            planId: request.params.planId,
            actorUserId: access.userId,
            ...(request.query.cursor !== undefined ? { cursor: request.query.cursor } : {}),
            ...(request.query.limit !== undefined ? { limit: request.query.limit } : {}),
          }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: result.value,
        });
      }
    );

    fastify.post<{ Params: CampaignNotificationPlanIdParams }>(
      '/api/v1/admin/campaigns/:campaignKey/notifications/plans/:planId/send',
      {
        schema: {
          params: CampaignNotificationPlanIdParamsSchema,
          response: {
            200: CampaignNotificationRunnablePlanSendResponseSchema,
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
        const access = getCampaignAdminNotificationAccess(request);
        const result = await sendCampaignNotificationRunnablePlan(
          {
            planRepository: deps.planRepository,
            runnableTemplateRegistry: deps.runnableTemplateRegistry,
          },
          {
            campaignKey: access.config.campaignKey,
            planId: request.params.planId,
            actorUserId: access.userId,
          }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: result.value,
        });
      }
    );
  };
};
