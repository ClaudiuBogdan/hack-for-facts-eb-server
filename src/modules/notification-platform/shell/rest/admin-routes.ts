import { requireAuth } from '@/modules/auth/index.js';

import { sendPlatformRouteError } from './route-errors.js';
import {
  AdminDeliveryIdParamsSchema,
  AdminDigestBatchIdParamsSchema,
  AdminEventIdParamsSchema,
  CancelDigestBatchBodySchema,
  CancelDigestBatchResponseSchema,
  DeadLetterSearchQuerySchema,
  DeadLetterSearchResponseSchema,
  ErrorResponseSchema,
  EventTraceResponseSchema,
  RequeueDeadLetterBodySchema,
  RequeueDeadLetterResponseSchema,
  RevealDeliveryContentBodySchema,
  RevealDeliveryContentResponseSchema,
  ShadowComparisonParamsSchema,
  ShadowComparisonQuerySchema,
  ShadowComparisonResponseSchema,
  SuppressionListQuerySchema,
  SuppressionListResponseSchema,
  type AdminDeliveryIdParams,
  type AdminDigestBatchIdParams,
  type AdminEventIdParams,
  type CancelDigestBatchBody,
  type DeadLetterSearchQuery,
  type RequeueDeadLetterBody,
  type RevealDeliveryContentBody,
  type ShadowComparisonParams,
  type ShadowComparisonQuery,
  type SuppressionListQuery,
} from './schemas.js';
import { NOTIFICATION_PLATFORM_ADMIN_PERMISSION } from '../../core/admin/policies.js';
import {
  getShadowComparison,
  type GetShadowComparisonDeps,
} from '../../core/admin/usecases/get-shadow-comparison.js';
import {
  listSuppressions,
  type ListSuppressionsDeps,
} from '../../core/admin/usecases/list-suppressions.js';
import {
  revealDeliveryContent,
  type RevealDeliveryContentDeps,
} from '../../core/admin/usecases/reveal-delivery-content.js';
import {
  searchDeadLetters,
  type SearchDeadLettersDeps,
} from '../../core/admin/usecases/search-dead-letters.js';
import { traceEvent, type TraceEventDeps } from '../../core/admin/usecases/trace-event.js';
import {
  requeueDeadLetter,
  type RequeueDeadLetterDeps,
} from '../../core/delivery/usecases/requeue-dead-letter.js';
import {
  cancelDigestBatch,
  type CancelDigestBatchDeps,
} from '../../core/digest/usecases/cancel-digest-batch.js';

import type { CampaignAdminPermissionAuthorizer } from '@/modules/campaign-admin/index.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export type MakePlatformAdminRoutesDeps = TraceEventDeps &
  SearchDeadLettersDeps &
  RequeueDeadLetterDeps &
  RevealDeliveryContentDeps &
  ListSuppressionsDeps &
  GetShadowComparisonDeps &
  CancelDigestBatchDeps & {
    permissionAuthorizer: CampaignAdminPermissionAuthorizer;
  };

export type PlatformAdminRoutesFactory = (deps: MakePlatformAdminRoutesDeps) => FastifyPluginAsync;

const ERROR_RESPONSES = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  500: ErrorResponseSchema,
} as const;

const sendAuthorizationError = (
  reply: FastifyReply,
  statusCode: 401 | 403,
  error: string,
  message: string
): ReturnType<FastifyReply['send']> =>
  reply.status(statusCode).send({ ok: false, error, message, retryable: false });

const makePlatformAdminAuthorizationHook = (
  permissionAuthorizer: CampaignAdminPermissionAuthorizer
) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authResult = requireAuth(request.auth);
    if (authResult.isErr()) {
      void sendAuthorizationError(reply, 401, authResult.error.type, authResult.error.message);
      return;
    }
    const userId = authResult.value as string;
    const allowed = await permissionAuthorizer.hasPermission({
      userId,
      permissionName: NOTIFICATION_PLATFORM_ADMIN_PERMISSION,
    });
    if (!allowed) {
      void sendAuthorizationError(
        reply,
        403,
        'Forbidden',
        'You do not have permission to access notification platform administration'
      );
    }
  };
};

const getAdminUserId = (request: FastifyRequest): string => {
  const result = requireAuth(request.auth);
  if (result.isErr()) {
    return '';
  }
  return result.value;
};

export const makePlatformAdminRoutes: PlatformAdminRoutesFactory = (deps) => {
  if (typeof deps.permissionAuthorizer.hasPermission !== 'function') {
    throw new Error('Notification platform admin routes require a permission authorizer.');
  }

  return (fastify) => {
    fastify.addHook('preHandler', makePlatformAdminAuthorizationHook(deps.permissionAuthorizer));

    fastify.get<{ Params: AdminEventIdParams }>(
      '/api/admin/notifications/events/:id/trace',
      {
        schema: {
          params: AdminEventIdParamsSchema,
          response: { 200: EventTraceResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await traceEvent(deps, { eventId: request.params.id });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Querystring: DeadLetterSearchQuery }>(
      '/api/admin/notifications/dead-letters',
      {
        schema: {
          querystring: DeadLetterSearchQuerySchema,
          response: { 200: DeadLetterSearchResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await searchDeadLetters(deps, {
          ...(request.query.kindId === undefined ? {} : { kindId: request.query.kindId }),
          ...(request.query.channel === undefined ? {} : { channel: request.query.channel }),
          ...(request.query.status === undefined ? {} : { status: request.query.status }),
          ...(request.query.eventId === undefined ? {} : { eventId: request.query.eventId }),
          ...(request.query.userId === undefined ? {} : { userId: request.query.userId }),
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    fastify.post<{ Params: AdminDeliveryIdParams; Body: RequeueDeadLetterBody }>(
      '/api/admin/notifications/deliveries/:id/requeue',
      {
        schema: {
          params: AdminDeliveryIdParamsSchema,
          body: RequeueDeadLetterBodySchema,
          response: { 200: RequeueDeadLetterResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await requeueDeadLetter(deps, {
          deliveryId: request.params.id,
          adminUserId: getAdminUserId(request),
          reason: request.body.reason,
          acknowledgeDuplicateRisk: request.body.acknowledgeDuplicateRisk,
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    fastify.post<{ Params: AdminDeliveryIdParams; Body: RevealDeliveryContentBody }>(
      '/api/admin/notifications/deliveries/:id/reveal',
      {
        schema: {
          params: AdminDeliveryIdParamsSchema,
          body: RevealDeliveryContentBodySchema,
          response: { 200: RevealDeliveryContentResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await revealDeliveryContent(deps, {
          deliveryId: request.params.id,
          adminUserId: getAdminUserId(request),
          reason: request.body.reason,
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Querystring: SuppressionListQuery }>(
      '/api/admin/notifications/suppressions',
      {
        schema: {
          querystring: SuppressionListQuerySchema,
          response: { 200: SuppressionListResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await listSuppressions(deps, {
          ...(request.query.userId === undefined ? {} : { userId: request.query.userId }),
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    fastify.get<{ Params: ShadowComparisonParams; Querystring: ShadowComparisonQuery }>(
      '/api/admin/notifications/shadow-comparison/:kindId',
      {
        schema: {
          params: ShadowComparisonParamsSchema,
          querystring: ShadowComparisonQuerySchema,
          response: { 200: ShadowComparisonResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await getShadowComparison(deps, {
          kindId: request.params.kindId,
          ...(request.query.periodKey === undefined ? {} : { periodKey: request.query.periodKey }),
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    fastify.post<{ Params: AdminDigestBatchIdParams; Body: CancelDigestBatchBody }>(
      '/api/admin/notifications/digest-batches/:id/cancel',
      {
        schema: {
          params: AdminDigestBatchIdParamsSchema,
          body: CancelDigestBatchBodySchema,
          response: { 200: CancelDigestBatchResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const result = await cancelDigestBatch(deps, {
          batchId: request.params.id,
          adminUserId: getAdminUserId(request),
          reason: request.body.reason,
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );
    return Promise.resolve();
  };
};
