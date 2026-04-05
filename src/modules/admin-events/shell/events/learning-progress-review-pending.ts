import { Type, type Static } from '@sinclair/typebox';
import { err, ok, type Result } from 'neverthrow';

import {
  updateInteractionReview,
  type ApprovedReviewSideEffectPlan,
  type LearningProgressError,
  type LearningProgressRecordRow,
  type LearningProgressRepository,
  type ReviewDecision,
} from '@/modules/learning-progress/index.js';

import {
  createQueueError,
  createValidationError,
  type AdminEventError,
} from '../../core/errors.js';

import type { AdminEventDefinition } from '../../core/types.js';
import type { InstitutionCorrespondenceError } from '@/modules/institution-correspondence/index.js';

/**
 * Queued when a learning-progress interactive record exists in `pending` phase
 * and requires an admin decision. The operator reviews the exported record and
 * submits an `approve` or `reject` outcome.
 */
export const LEARNING_PROGRESS_REVIEW_PENDING_EVENT_TYPE =
  'learning_progress.review_pending' as const;

export const LearningProgressReviewPendingPayloadSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

const ApproveOutcomeSchema = Type.Object(
  {
    decision: Type.Literal('approve'),
    feedbackText: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

const RejectOutcomeSchema = Type.Object(
  {
    decision: Type.Literal('reject'),
    feedbackText: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const LearningProgressReviewPendingOutcomeSchema = Type.Union([
  ApproveOutcomeSchema,
  RejectOutcomeSchema,
]);

export type LearningProgressReviewPendingPayload = Static<
  typeof LearningProgressReviewPendingPayloadSchema
>;
export type LearningProgressReviewPendingOutcome = Static<
  typeof LearningProgressReviewPendingOutcomeSchema
>;

export interface LearningProgressReviewPendingContext {
  row: LearningProgressRecordRow;
}

export interface LearningProgressReviewPendingEventDefinitionDeps {
  learningProgressRepo: LearningProgressRepository;
  prepareApproveReviews?: (input: {
    items: readonly ReviewDecision[];
  }) => Promise<
    Result<
      ApprovedReviewSideEffectPlan | null,
      LearningProgressError | InstitutionCorrespondenceError
    >
  >;
}

const toAdminEventError = (
  error: { message: string } & Partial<{ retryable: boolean }>
): AdminEventError => {
  return 'retryable' in error && error.retryable
    ? createQueueError(error.message, true)
    : createValidationError(error.message);
};

export const makeLearningProgressReviewPendingEventDefinition = (
  deps: LearningProgressReviewPendingEventDefinitionDeps
): AdminEventDefinition<
  LearningProgressReviewPendingPayload,
  LearningProgressReviewPendingContext,
  LearningProgressReviewPendingOutcome
> => {
  return {
    eventType: LEARNING_PROGRESS_REVIEW_PENDING_EVENT_TYPE,
    schemaVersion: 1,
    payloadSchema: LearningProgressReviewPendingPayloadSchema,
    outcomeSchema: LearningProgressReviewPendingOutcomeSchema,
    getJobId(payload) {
      return `${LEARNING_PROGRESS_REVIEW_PENDING_EVENT_TYPE}:${payload.userId}:${payload.recordKey}`;
    },
    async scanPending() {
      const rows: LearningProgressReviewPendingPayload[] = [];
      let offset = 0;
      const limit = 100;

      for (;;) {
        const result = await deps.learningProgressRepo.listReviewRows({
          status: 'pending',
          limit,
          offset,
        });
        if (result.isErr()) {
          return err(toAdminEventError(result.error));
        }

        rows.push(
          ...result.value.rows.map((row) => ({
            userId: row.userId,
            recordKey: row.recordKey,
          }))
        );

        if (!result.value.hasMore) {
          break;
        }

        offset += limit;
      }

      return ok(rows);
    },
    async loadContext(payload) {
      const result = await deps.learningProgressRepo.getRecord(payload.userId, payload.recordKey);
      if (result.isErr()) {
        return err(toAdminEventError(result.error));
      }

      if (result.value === null) {
        return ok(null);
      }

      return ok({ row: result.value });
    },
    buildExportBundle(input) {
      return {
        jobId: input.jobId,
        eventType: LEARNING_PROGRESS_REVIEW_PENDING_EVENT_TYPE,
        schemaVersion: 1,
        payload: input.payload,
        context: input.context,
        freshness: {
          updatedAt: input.context.row.updatedAt,
          phase: input.context.row.record.phase,
          reviewStatus: input.context.row.record.review?.status ?? null,
        },
        instructions: [
          'Review the pending interactive record and decide whether it should be approved or rejected.',
          'If you reject it, provide a concise non-empty feedbackText.',
        ],
      };
    },
    classifyState(input) {
      if (input.context === null) {
        return 'not_actionable';
      }

      const reviewStatus = input.context.row.record.review?.status;
      const currentPhase = input.context.row.record.phase;
      const exportedUpdatedAt = input.exportBundle?.freshness['updatedAt'];

      if (input.outcome !== undefined) {
        const expectedReviewStatus = input.outcome.decision === 'approve' ? 'approved' : 'rejected';
        if (reviewStatus === expectedReviewStatus && currentPhase !== 'pending') {
          return 'already_applied';
        }
      }

      if (
        exportedUpdatedAt !== undefined &&
        typeof exportedUpdatedAt === 'string' &&
        exportedUpdatedAt !== input.context.row.updatedAt
      ) {
        return 'stale';
      }

      if (currentPhase === 'pending') {
        return 'actionable';
      }

      return input.exportBundle !== undefined ? 'stale' : 'not_actionable';
    },
    async applyOutcome(input) {
      let approvedReviewSideEffectPlan: ApprovedReviewSideEffectPlan | null = null;

      if (input.outcome.decision === 'approve' && deps.prepareApproveReviews !== undefined) {
        const prepareResult = await deps.prepareApproveReviews({
          items: [
            {
              userId: input.payload.userId,
              recordKey: input.payload.recordKey,
              expectedUpdatedAt: input.context.row.updatedAt,
              status: 'approved',
            },
          ],
        });

        if (prepareResult.isErr()) {
          return err(toAdminEventError(prepareResult.error));
        }

        approvedReviewSideEffectPlan = prepareResult.value;
      }

      const updateResult = await updateInteractionReview(
        { repo: deps.learningProgressRepo },
        {
          userId: input.payload.userId,
          recordKey: input.payload.recordKey,
          expectedUpdatedAt: input.context.row.updatedAt,
          status: input.outcome.decision === 'approve' ? 'approved' : 'rejected',
          ...(input.outcome.feedbackText !== undefined
            ? { feedbackText: input.outcome.feedbackText }
            : {}),
        }
      );

      if (updateResult.isErr()) {
        return err(toAdminEventError(updateResult.error));
      }

      if (approvedReviewSideEffectPlan !== null) {
        try {
          await approvedReviewSideEffectPlan.afterCommit();
        } catch {
          // Mirrors existing admin review route semantics: the review stays
          // committed even if post-commit side effects fail.
        }
      }

      return ok(undefined);
    },
  };
};
