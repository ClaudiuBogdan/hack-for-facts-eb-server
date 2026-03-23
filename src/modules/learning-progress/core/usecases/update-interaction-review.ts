import { err, ok, type Result } from 'neverthrow';

import {
  createConflictError,
  createInvalidEventError,
  createNotFoundError,
  type LearningProgressError,
} from '../errors.js';

import type { LearningProgressRepository } from '../ports.js';
import type {
  InteractiveAuditEvent,
  InteractionPhase,
  InteractionResult,
  LearningProgressRecordRow,
  ReviewDecisionStatus,
} from '../types.js';

export interface UpdateInteractionReviewDeps {
  repo: LearningProgressRepository;
}

export interface UpdateInteractionReviewInput {
  userId: string;
  recordKey: string;
  expectedUpdatedAt: string;
  status: ReviewDecisionStatus;
  feedbackText?: string;
}

export interface UpdateInteractionReviewOutput {
  applied: boolean;
  row: LearningProgressRecordRow;
}

function getTimestampMilliseconds(timestamp: string): number | null {
  const parsedTimestamp = Date.parse(timestamp);
  return Number.isNaN(parsedTimestamp) ? null : parsedTimestamp;
}

function compareTimestampInstants(leftTimestamp: string, rightTimestamp: string): number {
  const leftMilliseconds = getTimestampMilliseconds(leftTimestamp);
  const rightMilliseconds = getTimestampMilliseconds(rightTimestamp);

  if (leftMilliseconds !== null && rightMilliseconds !== null) {
    if (leftMilliseconds < rightMilliseconds) return -1;
    if (leftMilliseconds > rightMilliseconds) return 1;
    return 0;
  }

  return leftTimestamp.localeCompare(rightTimestamp);
}

function getNextTimestamp(previousTimestamp?: string | null): string {
  const currentTime = Date.now();
  const previousTime =
    previousTimestamp !== undefined && previousTimestamp !== null && previousTimestamp !== ''
      ? getTimestampMilliseconds(previousTimestamp)
      : null;
  const nextTime = previousTime !== null ? Math.max(currentTime, previousTime + 1) : currentTime;
  return new Date(nextTime).toISOString();
}

function createEventId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `server-review-${String(Date.now())}-${Math.random().toString(16).slice(2)}`;
}

function sanitizeLegacyReviewResponse(result: InteractionResult | null): InteractionResult | null {
  const response = result?.response;
  if (
    result === null ||
    response === null ||
    response === undefined ||
    typeof response !== 'object' ||
    !('reviewStatus' in response)
  ) {
    return result;
  }

  const remainingResponse = { ...response };
  delete remainingResponse['reviewStatus'];
  return {
    ...result,
    response: Object.keys(remainingResponse).length > 0 ? remainingResponse : null,
  };
}

function buildReviewAuditResult(params: {
  existingResult: InteractionResult | null;
  feedbackText: string | null;
  evaluatedAt: string;
}): InteractionResult {
  return {
    outcome: params.existingResult?.outcome ?? null,
    ...(typeof params.existingResult?.score === 'number'
      ? { score: params.existingResult.score }
      : {}),
    feedbackText: params.feedbackText,
    evaluatedAt: params.evaluatedAt,
  };
}

export async function updateInteractionReview(
  deps: UpdateInteractionReviewDeps,
  input: UpdateInteractionReviewInput
): Promise<Result<UpdateInteractionReviewOutput, LearningProgressError>> {
  const trimmedFeedbackText = input.feedbackText?.trim();

  if (
    input.status === 'rejected' &&
    (trimmedFeedbackText === undefined || trimmedFeedbackText === '')
  ) {
    return err(createInvalidEventError('Rejected reviews require non-empty feedback.'));
  }

  return deps.repo.withTransaction(async (transactionalRepo) => {
    const recordResult = await transactionalRepo.getRecordForUpdate(input.userId, input.recordKey);
    if (recordResult.isErr()) {
      return err(recordResult.error);
    }

    const existingRow = recordResult.value;
    if (existingRow === null) {
      return err(createNotFoundError(`Interaction record "${input.recordKey}" was not found.`));
    }

    if (existingRow.record.phase !== 'pending') {
      return err(
        createConflictError(
          `Interaction record "${input.recordKey}" is no longer reviewable because it is not pending.`
        )
      );
    }

    if (compareTimestampInstants(existingRow.record.updatedAt, input.expectedUpdatedAt) !== 0) {
      return err(
        createConflictError(
          `Interaction record "${input.recordKey}" changed since it was loaded for review.`
        )
      );
    }

    const nextUpdatedAt = getNextTimestamp(existingRow.record.updatedAt);
    const feedbackText = trimmedFeedbackText ?? null;
    const nextPhase: InteractionPhase = input.status === 'approved' ? 'resolved' : 'error';
    const nextRecord = {
      ...existingRow.record,
      phase: nextPhase,
      result: sanitizeLegacyReviewResponse(existingRow.record.result),
      review: {
        status: input.status,
        reviewedAt: nextUpdatedAt,
        ...(feedbackText !== null ? { feedbackText } : {}),
      },
      updatedAt: nextUpdatedAt,
    };

    const auditResult = buildReviewAuditResult({
      existingResult: nextRecord.result,
      feedbackText,
      evaluatedAt: nextUpdatedAt,
    });
    const auditEvent: InteractiveAuditEvent = {
      id: createEventId(),
      recordKey: existingRow.recordKey,
      lessonId: existingRow.record.lessonId,
      interactionId: existingRow.record.interactionId,
      type: 'evaluated',
      at: nextUpdatedAt,
      actor: 'system',
      phase: nextPhase,
      result: auditResult,
    };

    const upsertResult = await transactionalRepo.upsertInteractiveRecord({
      userId: input.userId,
      eventId: `server-review:${existingRow.recordKey}:${nextUpdatedAt}`,
      clientId: 'server-review',
      occurredAt: nextUpdatedAt,
      record: nextRecord,
      auditEvents: [auditEvent],
    });

    if (upsertResult.isErr()) {
      return err(upsertResult.error);
    }

    return ok({
      applied: upsertResult.value.applied,
      row: upsertResult.value.row,
    });
  });
}
