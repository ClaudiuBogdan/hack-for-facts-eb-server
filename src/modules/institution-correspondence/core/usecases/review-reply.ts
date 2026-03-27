import { err, ok, type Result } from 'neverthrow';

import {
  createConflictError,
  createNotFoundError,
  type InstitutionCorrespondenceError,
} from '../errors.js';
import {
  RESOLUTION_TO_PHASE,
  REVIEWABLE_PHASE,
  type ReviewReplyInput,
  type ReviewReplyOutput,
  type ThreadReview,
} from '../types.js';

import type { InstitutionCorrespondenceRepository } from '../ports.js';

export interface ReviewReplyDeps {
  repo: InstitutionCorrespondenceRepository;
}

export async function reviewReply(
  deps: ReviewReplyDeps,
  input: ReviewReplyInput
): Promise<Result<ReviewReplyOutput, InstitutionCorrespondenceError>> {
  const reviewedAt = input.reviewedAt ?? new Date();
  const result = await deps.repo.mutateThread(input.threadId, (thread) => {
    if (thread.phase !== REVIEWABLE_PHASE) {
      return err(createConflictError('This thread is not awaiting manual review.'));
    }

    const reply = thread.record.correspondence.find((entry) => entry.id === input.basedOnEntryId);
    if (reply === undefined) {
      return err(createNotFoundError(`Reply entry "${input.basedOnEntryId}" was not found.`));
    }

    if (reply.direction !== 'inbound') {
      return err(createConflictError('Only inbound correspondence entries can be reviewed.'));
    }

    if (thread.record.latestReview?.basedOnEntryId === input.basedOnEntryId) {
      return err(createConflictError('This reply has already been reviewed.'));
    }

    const nextPhase = RESOLUTION_TO_PHASE[input.resolutionCode];
    const latestReview: ThreadReview = {
      basedOnEntryId: input.basedOnEntryId,
      resolutionCode: input.resolutionCode,
      notes: input.reviewNotes ?? null,
      reviewedAt: reviewedAt.toISOString(),
    };

    return ok({
      phase: nextPhase,
      nextActionAt: nextPhase === 'manual_follow_up_needed' ? reviewedAt : null,
      closedAt:
        nextPhase === 'resolved_positive' || nextPhase === 'resolved_negative' ? reviewedAt : null,
      record: {
        ...thread.record,
        latestReview,
      },
    });
  });
  if (result.isErr()) {
    return err(result.error);
  }

  const reply = result.value.record.correspondence.find(
    (entry) => entry.id === input.basedOnEntryId
  );
  if (reply === undefined) {
    return err(createNotFoundError(`Reply entry "${input.basedOnEntryId}" was not found.`));
  }

  return ok({
    thread: result.value,
    reply,
  });
}
