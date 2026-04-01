import { type Result } from 'neverthrow';

import {
  getHttpStatusForError as getCorrespondenceHttpStatusForError,
  type InstitutionCorrespondenceError,
} from '@/modules/institution-correspondence/index.js';

import { makeLearningProgressAdminReviewAuthHook } from './admin-auth.js';
import {
  ErrorResponseSchema,
  ReviewQueueQuerySchema,
  ReviewQueueResponseSchema,
  SubmitInteractionReviewsBodySchema,
  SubmitInteractionReviewsResponseSchema,
  type ReviewQueueQuery,
  type SubmitInteractionReviewsBody,
} from './admin-schemas.js';
import { getHttpStatusForError, type LearningProgressError } from '../../core/errors.js';
import { listInteractionReviews } from '../../core/usecases/list-interaction-reviews.js';
import { submitInteractionReviews } from '../../core/usecases/submit-interaction-reviews.js';

import type { LearningProgressRepository } from '../../core/ports.js';
import type { ReviewDecision } from '../../core/types.js';
import type { FastifyPluginAsync } from 'fastify';

export interface ApprovedReviewSideEffectPlan {
  afterCommit(): Promise<void>;
}

export interface MakeLearningProgressAdminReviewRoutesDeps {
  learningProgressRepo: LearningProgressRepository;
  apiKey: string;
  prepareApproveReviews?: (input: {
    items: readonly ReviewDecision[];
  }) => Promise<
    Result<
      ApprovedReviewSideEffectPlan | null,
      LearningProgressError | InstitutionCorrespondenceError
    >
  >;
}

function isInstitutionCorrespondenceError(
  error: LearningProgressError | InstitutionCorrespondenceError
): error is InstitutionCorrespondenceError {
  return error.type.startsWith('Correspondence');
}

export const makeLearningProgressAdminReviewRoutes = (
  deps: MakeLearningProgressAdminReviewRoutesDeps
): FastifyPluginAsync => {
  const { learningProgressRepo, apiKey, prepareApproveReviews } = deps;

  // eslint-disable-next-line @typescript-eslint/require-await -- FastifyPluginAsync uses async plugin factories
  return async (fastify) => {
    fastify.addHook('preHandler', makeLearningProgressAdminReviewAuthHook({ apiKey }));

    fastify.get<{ Querystring: ReviewQueueQuery }>(
      '/api/v1/admin/learning-progress/reviews',
      {
        schema: {
          querystring: ReviewQueueQuerySchema,
          response: {
            200: ReviewQueueResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            500: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const status = request.query.status ?? 'pending';
        const limit = request.query.limit ?? 50;
        const offset = request.query.offset ?? 0;

        const result = await listInteractionReviews(
          { repo: learningProgressRepo },
          {
            status,
            limit,
            offset,
            ...(request.query.userId !== undefined ? { userId: request.query.userId } : {}),
            ...(request.query.recordKey !== undefined
              ? { recordKey: request.query.recordKey }
              : {}),
            ...(request.query.recordKeyPrefix !== undefined
              ? { recordKeyPrefix: request.query.recordKeyPrefix }
              : {}),
            ...(request.query.interactionId !== undefined
              ? { interactionId: request.query.interactionId }
              : {}),
            ...(request.query.lessonId !== undefined ? { lessonId: request.query.lessonId } : {}),
          }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode as 400 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        return reply.status(200).send({
          ok: true,
          data: {
            items: result.value.rows,
            page: {
              offset,
              limit,
              hasMore: result.value.hasMore,
            },
          },
        });
      }
    );

    fastify.post<{ Body: SubmitInteractionReviewsBody }>(
      '/api/v1/admin/learning-progress/reviews',
      {
        schema: {
          body: SubmitInteractionReviewsBodySchema,
          response: {
            200: SubmitInteractionReviewsResponseSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            404: ErrorResponseSchema,
            409: ErrorResponseSchema,
            500: ErrorResponseSchema,
            502: ErrorResponseSchema,
          },
        },
      },
      async (request, reply) => {
        let approvedReviewSideEffectPlan: ApprovedReviewSideEffectPlan | null = null;
        if (prepareApproveReviews !== undefined) {
          const sideEffectResult = await prepareApproveReviews({
            items: request.body.items,
          });

          if (sideEffectResult.isErr()) {
            const statusCode = isInstitutionCorrespondenceError(sideEffectResult.error)
              ? getCorrespondenceHttpStatusForError(sideEffectResult.error)
              : getHttpStatusForError(sideEffectResult.error);

            return reply.status(statusCode as 400 | 404 | 409 | 500 | 502).send({
              ok: false,
              error: sideEffectResult.error.type,
              message: sideEffectResult.error.message,
              retryable:
                'retryable' in sideEffectResult.error ? sideEffectResult.error.retryable : false,
            });
          }

          approvedReviewSideEffectPlan = sideEffectResult.value;
        }

        const result = await submitInteractionReviews(
          { repo: learningProgressRepo },
          { items: request.body.items }
        );

        if (result.isErr()) {
          const statusCode = getHttpStatusForError(result.error);
          return reply.status(statusCode as 400 | 404 | 409 | 500).send({
            ok: false,
            error: result.error.type,
            message: result.error.message,
            retryable: 'retryable' in result.error ? result.error.retryable : false,
          });
        }

        if (approvedReviewSideEffectPlan !== null) {
          try {
            await approvedReviewSideEffectPlan.afterCommit();
          } catch (error) {
            request.log.error(
              {
                error,
                itemCount: request.body.items.length,
                recordKeys: request.body.items.map((item) => item.recordKey),
              },
              'Learning progress approval side effects failed after commit'
            );
          }
        }

        return reply.status(200).send({
          ok: true,
          data: {
            items: result.value.rows,
          },
        });
      }
    );
  };
};
