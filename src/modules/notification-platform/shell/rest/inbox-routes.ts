import { isAuthenticated, requireAuthHandler } from '@/modules/auth/index.js';

import { sendPlatformNotFound, sendPlatformRouteError } from './route-errors.js';
import {
  ErrorResponseSchema,
  InboxIdParamsSchema,
  InboxListQuerySchema,
  InboxListResponseSchema,
  MarkAllReadResponseSchema,
  OkResponseSchema,
  UnreadCountResponseSchema,
  type InboxIdParams,
  type InboxListQuery,
} from './schemas.js';
import {
  getUnreadCount,
  type GetUnreadCountDeps,
} from '../../core/inbox/usecases/get-unread-count.js';
import { listInbox, type ListInboxDeps } from '../../core/inbox/usecases/list-inbox.js';
import { markAllRead, type MarkAllReadDeps } from '../../core/inbox/usecases/mark-all-read.js';
import {
  setArchivedState,
  type SetArchivedStateDeps,
} from '../../core/inbox/usecases/set-archived-state.js';
import { setReadState, type SetReadStateDeps } from '../../core/inbox/usecases/set-read-state.js';

import type { FastifyPluginAsync } from 'fastify';

export type MakeInboxRoutesDeps = ListInboxDeps &
  GetUnreadCountDeps &
  SetReadStateDeps &
  MarkAllReadDeps &
  SetArchivedStateDeps;

const ERROR_RESPONSES = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  404: ErrorResponseSchema,
  500: ErrorResponseSchema,
} as const;

export const makeInboxRoutes = (deps: MakeInboxRoutesDeps): FastifyPluginAsync => {
  return (fastify) => {
    fastify.addHook('preHandler', requireAuthHandler);

    fastify.get<{ Querystring: InboxListQuery }>(
      '/api/notifications/inbox',
      {
        schema: {
          querystring: InboxListQuerySchema,
          response: { 200: InboxListResponseSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return;
        }
        const result = await listInbox(deps, {
          userId: request.auth.userId,
          ...(request.query.view === undefined ? {} : { view: request.query.view }),
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    fastify.get(
      '/api/notifications/inbox/unread-count',
      { schema: { response: { 200: UnreadCountResponseSchema, ...ERROR_RESPONSES } } },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return;
        }
        const result = await getUnreadCount(deps, { userId: request.auth.userId });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    const registerReadStateRoute = (path: string, read: boolean): void => {
      fastify.post<{ Params: InboxIdParams }>(
        path,
        {
          schema: {
            params: InboxIdParamsSchema,
            response: { 200: OkResponseSchema, ...ERROR_RESPONSES },
          },
        },
        async (request, reply) => {
          if (!isAuthenticated(request.auth)) {
            return;
          }
          const result = await setReadState(deps, {
            userId: request.auth.userId,
            notificationId: request.params.id,
            read,
          });
          if (result.isErr()) {
            return sendPlatformRouteError(reply, result.error);
          }
          if (!result.value.updated) {
            return sendPlatformNotFound(reply, 'notification', request.params.id);
          }
          return reply.status(200).send({ ok: true });
        }
      );
    };

    registerReadStateRoute('/api/notifications/inbox/:id/read', true);
    registerReadStateRoute('/api/notifications/inbox/:id/unread', false);

    fastify.post(
      '/api/notifications/inbox/read-all',
      { schema: { response: { 200: MarkAllReadResponseSchema, ...ERROR_RESPONSES } } },
      async (request, reply) => {
        if (!isAuthenticated(request.auth)) {
          return;
        }
        const result = await markAllRead(deps, { userId: request.auth.userId });
        if (result.isErr()) {
          return sendPlatformRouteError(reply, result.error);
        }
        return reply.status(200).send({ ok: true, data: result.value });
      }
    );

    const registerArchivedStateRoute = (path: string, archived: boolean): void => {
      fastify.post<{ Params: InboxIdParams }>(
        path,
        {
          schema: {
            params: InboxIdParamsSchema,
            response: { 200: OkResponseSchema, ...ERROR_RESPONSES },
          },
        },
        async (request, reply) => {
          if (!isAuthenticated(request.auth)) {
            return;
          }
          const result = await setArchivedState(deps, {
            userId: request.auth.userId,
            notificationId: request.params.id,
            archived,
          });
          if (result.isErr()) {
            return sendPlatformRouteError(reply, result.error);
          }
          if (!result.value.updated) {
            return sendPlatformNotFound(reply, 'notification', request.params.id);
          }
          return reply.status(200).send({ ok: true });
        }
      );
    };

    registerArchivedStateRoute('/api/notifications/inbox/:id/archive', true);
    registerArchivedStateRoute('/api/notifications/inbox/:id/unarchive', false);
    return Promise.resolve();
  };
};
