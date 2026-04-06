import { Type, type Static } from '@sinclair/typebox';
import { err, ok } from 'neverthrow';

import { buildBullmqJobId } from '@/infra/queue/job-id.js';
import {
  REVIEWABLE_PHASE,
  reviewReply,
  type CorrespondenceEntry,
  type InstitutionCorrespondenceError,
  type InstitutionCorrespondenceRepository,
  type ResolutionCode,
  type ThreadRecord,
} from '@/modules/institution-correspondence/index.js';

import {
  createQueueError,
  createValidationError,
  type AdminEventError,
} from '../../core/errors.js';

import type { AdminEventDefinition } from '../../core/types.js';

/**
 * Queued when an institution correspondence thread receives an inbound reply
 * and moves into `reply_received_unreviewed`. The operator reviews the thread
 * and applies a resolution code for the latest inbound entry.
 */
export const INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE =
  'institution_correspondence.reply_review_pending' as const;

export const InstitutionCorrespondenceReplyReviewPendingPayloadSchema = Type.Object(
  {
    threadId: Type.String({ minLength: 1 }),
    basedOnEntryId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const InstitutionCorrespondenceReplyReviewPendingOutcomeSchema = Type.Object(
  {
    resolutionCode: Type.Union([
      Type.Literal('debate_announced'),
      Type.Literal('already_scheduled'),
      Type.Literal('request_refused'),
      Type.Literal('wrong_contact'),
      Type.Literal('auto_reply'),
      Type.Literal('not_actionable'),
      Type.Literal('other'),
    ]),
    reviewNotes: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  },
  { additionalProperties: false }
);

export type InstitutionCorrespondenceReplyReviewPendingPayload = Static<
  typeof InstitutionCorrespondenceReplyReviewPendingPayloadSchema
>;
export type InstitutionCorrespondenceReplyReviewPendingOutcome = Static<
  typeof InstitutionCorrespondenceReplyReviewPendingOutcomeSchema
>;

export interface InstitutionCorrespondenceReplyReviewPendingContext {
  thread: ThreadRecord;
  reply: CorrespondenceEntry;
  latestInboundReplyId: string | null;
}

export interface InstitutionCorrespondenceReplyReviewPendingEventDefinitionDeps {
  repo: InstitutionCorrespondenceRepository;
}

const toAdminEventError = (error: InstitutionCorrespondenceError): AdminEventError => {
  return 'retryable' in error && error.retryable
    ? createQueueError(error.message, true)
    : createValidationError(error.message);
};

const normalizeOptionalNotes = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const getLatestInboundReplyId = (thread: ThreadRecord): string | null => {
  const latestInboundReply =
    [...thread.record.correspondence]
      .filter((entry) => entry.direction === 'inbound')
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0] ?? null;

  return latestInboundReply?.id ?? null;
};

export const makeInstitutionCorrespondenceReplyReviewPendingEventDefinition = (
  deps: InstitutionCorrespondenceReplyReviewPendingEventDefinitionDeps
): AdminEventDefinition<
  InstitutionCorrespondenceReplyReviewPendingPayload,
  InstitutionCorrespondenceReplyReviewPendingContext,
  InstitutionCorrespondenceReplyReviewPendingOutcome
> => {
  return {
    eventType: INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
    schemaVersion: 1,
    payloadSchema: InstitutionCorrespondenceReplyReviewPendingPayloadSchema,
    outcomeSchema: InstitutionCorrespondenceReplyReviewPendingOutcomeSchema,
    getJobId(payload) {
      return buildBullmqJobId(
        INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
        payload.threadId,
        payload.basedOnEntryId
      );
    },
    async scanPending() {
      const payloads: InstitutionCorrespondenceReplyReviewPendingPayload[] = [];
      let offset = 0;
      const limit = 100;

      for (;;) {
        const result = await deps.repo.listPendingReplies({ limit, offset });
        if (result.isErr()) {
          return err(toAdminEventError(result.error));
        }

        payloads.push(
          ...result.value.items.map((item) => ({
            threadId: item.thread.id,
            basedOnEntryId: item.reply.id,
          }))
        );

        if (!result.value.hasMore) {
          break;
        }

        offset += limit;
      }

      return ok(payloads);
    },
    async loadContext(payload) {
      const result = await deps.repo.findThreadById(payload.threadId);
      if (result.isErr()) {
        return err(toAdminEventError(result.error));
      }

      if (result.value === null) {
        return ok(null);
      }

      const reply =
        result.value.record.correspondence.find((entry) => entry.id === payload.basedOnEntryId) ??
        null;
      if (reply === null) {
        return ok(null);
      }

      return ok({
        thread: result.value,
        reply,
        latestInboundReplyId: getLatestInboundReplyId(result.value),
      });
    },
    buildExportBundle(input) {
      return {
        jobId: input.jobId,
        eventType: INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
        schemaVersion: 1,
        payload: input.payload,
        context: input.context,
        freshness: {
          updatedAt: input.context.thread.updatedAt.toISOString(),
          phase: input.context.thread.phase,
          latestReviewBasedOnEntryId:
            input.context.thread.record.latestReview?.basedOnEntryId ?? null,
        },
        instructions: [
          'Review the inbound institution reply and determine the correct resolutionCode.',
          'Use reviewNotes only when additional context is useful for auditability.',
        ],
      };
    },
    classifyState(input) {
      if (input.context === null) {
        return 'not_actionable';
      }

      const latestReview = input.context.thread.record.latestReview;
      const exportedUpdatedAt = input.exportBundle?.freshness['updatedAt'];

      if (
        input.outcome !== undefined &&
        latestReview?.basedOnEntryId === input.payload.basedOnEntryId
      ) {
        const normalizedLiveNotes = normalizeOptionalNotes(latestReview.notes);
        const normalizedOutcomeNotes = normalizeOptionalNotes(input.outcome.reviewNotes);
        if (
          latestReview.resolutionCode === input.outcome.resolutionCode &&
          normalizedLiveNotes === normalizedOutcomeNotes
        ) {
          return 'already_applied';
        }
      }

      if (
        exportedUpdatedAt !== undefined &&
        typeof exportedUpdatedAt === 'string' &&
        exportedUpdatedAt !== input.context.thread.updatedAt.toISOString()
      ) {
        return 'stale';
      }

      if (
        input.context.thread.phase === REVIEWABLE_PHASE &&
        input.context.reply.direction === 'inbound' &&
        input.context.latestInboundReplyId === input.payload.basedOnEntryId
      ) {
        return 'actionable';
      }

      return input.exportBundle !== undefined ? 'stale' : 'not_actionable';
    },
    async applyOutcome(input) {
      const result = await reviewReply(
        { repo: deps.repo },
        {
          threadId: input.payload.threadId,
          basedOnEntryId: input.payload.basedOnEntryId,
          resolutionCode: input.outcome.resolutionCode as ResolutionCode,
          reviewNotes: input.outcome.reviewNotes ?? null,
        }
      );

      if (result.isErr()) {
        return err(toAdminEventError(result.error));
      }

      return ok(undefined);
    },
  };
};
