import { isAuthenticated, requireAuthHandler } from '@/modules/auth/index.js';

import { sendPlatformRouteError } from './route-errors.js';
import {
  CreateSubscriptionBodySchema,
  ErrorResponseSchema,
  OkResponseSchema,
  SubscriptionIdParamsSchema,
  SubscriptionListQuerySchema,
  SubscriptionListResponseSchema,
  SubscriptionResponseSchema,
  type CreateSubscriptionBody,
  type SubscriptionIdParams,
  type SubscriptionListQuery,
} from './schemas.js';
import {
  createSubscription,
  type CreateSubscriptionDeps,
} from '../../core/subscriptions/usecases/create-subscription.js';
import {
  listSubscriptions,
  type ListSubscriptionsDeps,
} from '../../core/subscriptions/usecases/list-subscriptions.js';
import {
  setSubscriptionState,
  type SetSubscriptionStateDeps,
} from '../../core/subscriptions/usecases/set-subscription-state.js';

import type { SubscriptionState } from '../../core/subscriptions/types.js';
import type { FastifyPluginAsync } from 'fastify';

export type MakeSubscriptionRoutesDeps = CreateSubscriptionDeps &
  ListSubscriptionsDeps &
  SetSubscriptionStateDeps;

const ERROR_RESPONSES = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  500: ErrorResponseSchema,
} as const;

export const makeSubscriptionRoutes = (deps: MakeSubscriptionRoutesDeps): FastifyPluginAsync => {
  return (fastify) => {
    fastify.addHook('preHandler', requireAuthHandler);

    fastify.get<{ Querystring: SubscriptionListQuery }>(
      '/api/notifications/subscriptions',
      {
        schema: {
          querystring: SubscriptionListQuerySchema,
          response: { 200: SubscriptionListResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return;
        }
        const result = await listSubscriptions(deps, {
          userId: request.auth.userId,
          ...(request.query.kindId === undefined ? {} : { kindId: request.query.kindId }),
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    fastify.post<{ Body: CreateSubscriptionBody }>(
      '/api/notifications/subscriptions',
      {
        schema: {
          body: CreateSubscriptionBodySchema,
          response: { 201: SubscriptionResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return;
        }
        const result = await createSubscription(deps, {
          userId: request.auth.userId,
          kindId: request.body.kindId,
          subjectType: request.body.subjectType,
          subjectId: request.body.subjectId,
          config: request.body.config,
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(201).send({ ok: true, data: result.value });
      }
    );

    const registerStateRoute = (path: string, state: SubscriptionState): void => {
      fastify.post<{ Params: SubscriptionIdParams }>(
        path,
        {
          schema: {
            params: SubscriptionIdParamsSchema,
            response: { 200: SubscriptionResponseSchema, ...ERROR_RESPONSES },
          },
        },
        async (request, reply) => {
          if (!isAuthenticated(request.auth)) {
            return;
          }
          const result = await setSubscriptionState(deps, {
            userId: request.auth.userId,
            subscriptionId: request.params.id,
            state,
          });
          if (result.isErr()) {
            return sendPlatformRouteError(reply, result.error);
          }
          return reply.status(200).send({ ok: true, data: result.value });
        }
      );
    };

    registerStateRoute('/api/notifications/subscriptions/:id/pause', 'paused');
    registerStateRoute('/api/notifications/subscriptions/:id/resume', 'active');

    fastify.delete<{ Params: SubscriptionIdParams }>(
      '/api/notifications/subscriptions/:id',
      {
        schema: {
          params: SubscriptionIdParamsSchema,
          response: { 200: OkResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return;
        }
        const result = await setSubscriptionState(deps, {
          userId: request.auth.userId,
          subscriptionId: request.params.id,
          state: 'removed',
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true });
      }
    );
    return Promise.resolve();
  };
};
