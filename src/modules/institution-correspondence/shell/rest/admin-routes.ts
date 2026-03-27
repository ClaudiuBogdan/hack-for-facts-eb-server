import { Type } from '@sinclair/typebox';

import { makeInstitutionCorrespondenceAdminAuthHook } from './admin-auth.js';
import { formatPendingReplyItem, formatThread, formatCorrespondenceEntry } from './formatters.js';
import {
  ErrorResponseSchema,
  PendingRepliesQuerySchema,
  PendingRepliesResponseSchema,
  ReviewReplyBodySchema,
  ReviewedReplyResponseSchema,
  ThreadDataSchema,
  ThreadIdParamsSchema,
  type PendingRepliesQuery,
  type ReviewReplyBody,
  type ThreadIdParams,
} from './schemas.js';
import { getHttpStatusForError } from '../../core/errors.js';
import { getThread } from '../../core/usecases/get-thread.js';
import { listPendingReplies } from '../../core/usecases/list-pending-replies.js';
import { reviewReply } from '../../core/usecases/review-reply.js';

import type { InstitutionCorrespondenceRepository } from '../../core/ports.js';
import type { FastifyPluginAsync } from 'fastify';

export interface InstitutionCorrespondenceAdminRoutesDeps {
  repo: InstitutionCorrespondenceRepository;
  apiKey: string;
}

export const makeInstitutionCorrespondenceAdminRoutes = (
  deps: InstitutionCorrespondenceAdminRoutesDeps
): FastifyPluginAsync => {
  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync uses async plugin factories
  return async (fastify) => {
    fastify.addHook(
      'preHandler',
      makeInstitutionCorrespondenceAdminAuthHook({
        apiKey: deps.apiKey,
      })
    );

    fastify.get<{ Querystring: PendingRepliesQuery }>(
      '/api/v1/admin/institution-correspondence/replies',
      {
        schema: {
          querystring: PendingRepliesQuerySchema,
          response: {
            200: PendingRepliesResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const limit = request.query.limit ?? 50;
        const offset = request.query.offset ?? 0;
        const result = await listPendingReplies({ repo: deps.repo }, { limit, offset });

        if (result.isErr()) {
          const status = getHttpStatusForError(result.error);
          return reply.status(status as 400 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: {
            items: result.value.items.map(formatPendingReplyItem),
            page: {
              limit: result.value.limit,
              offset: result.value.offset,
              hasMore: result.value.hasMore,
            },
          },
        });
      }
    );

    fastify.post<{ Params: ThreadIdParams; Body: ReviewReplyBody }>(
      '/api/v1/admin/institution-correspondence/threads/:threadId/review',
      {
        schema: {
          params: ThreadIdParamsSchema,
          body: ReviewReplyBodySchema,
          response: {
            200: ReviewedReplyResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await reviewReply(
          { repo: deps.repo },
          {
            threadId: request.params.threadId,
            basedOnEntryId: request.body.basedOnEntryId,
            resolutionCode: request.body.resolutionCode,
            reviewNotes: request.body.reviewNotes ?? null,
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

        return reply.status(200).send({
          ok: true,
          data: {
            thread: formatThread(result.value.thread),
            reply: formatCorrespondenceEntry(result.value.reply),
          },
        });
      }
    );

    fastify.get<{ Params: ThreadIdParams }>(
      '/api/v1/admin/institution-correspondence/threads/:threadId',
      {
        schema: {
          params: ThreadIdParamsSchema,
          response: {
            200: Type.Object({
              ok: Type.Literal(true),
              data: ThreadDataSchema,
            }),
            401: ErrorResponseSchema,
            404: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const result = await getThread({ repo: deps.repo }, request.params.threadId);

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
          data: formatThread(result.value),
        });
      }
    );
  };
};
