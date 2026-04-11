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
  ReviewActorMetadata,
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
  actor?: ReviewActorMetadata;
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

function normalizeReviewActorMetadata(actor: ReviewActorMetadata | undefined): Result<
  {
    actor: 'system' | 'admin';
    actorUserId?: string;
    actorPermission?: string;
    actorSource?: ReviewActorMetadata['actorSource'];
  },
  LearningProgressError
> {
  const resolvedActor = actor?.actor ?? 'system';
  const actorUserId = actor?.actorUserId?.trim();
  const actorPermission = actor?.actorPermission?.trim();

  if (resolvedActor === 'admin') {
    if (actorUserId === undefined || actorUserId === '') {
      return err(createInvalidEventError('Admin reviews require a reviewer user id.'));
    }

    return ok({
      actor: resolvedActor,
      actorUserId,
      ...(actorPermission !== undefined && actorPermission !== '' ? { actorPermission } : {}),
      ...(actor?.actorSource !== undefined ? { actorSource: actor.actorSource } : {}),
    });
  }

  if (actorUserId !== undefined && actorUserId !== '') {
    return err(createInvalidEventError('System reviews must not include a reviewer user id.'));
  }

  if (actorPermission !== undefined && actorPermission !== '') {
    return err(createInvalidEventError('System reviews must not include actor permissions.'));
  }

  return ok({
    actor: resolvedActor,
    ...(actor?.actorSource !== undefined ? { actorSource: actor.actorSource } : {}),
  });
}

function normalizeOptionalFeedbackText(feedbackText: string | null | undefined): string | null {
  if (feedbackText === undefined || feedbackText === null) {
    return null;
  }

  const trimmedFeedbackText = feedbackText.trim();
  return trimmedFeedbackText === '' ? null : trimmedFeedbackText;
}

function matchesExistingReview(input: {
  row: LearningProgressRecordRow;
  status: ReviewDecisionStatus;
  feedbackText: string | null;
  actor: {
    actor: 'system' | 'admin';
    actorUserId?: string;
    actorSource?: ReviewActorMetadata['actorSource'];
  };
}): boolean {
  const expectedPhase: InteractionPhase = input.status === 'approved' ? 'resolved' : 'failed';
  const existingReview = input.row.record.review;

  if (existingReview === undefined || existingReview === null) {
    return false;
  }

  if (
    input.row.record.phase !== expectedPhase ||
    existingReview.status !== input.status ||
    normalizeOptionalFeedbackText(existingReview.feedbackText) !== input.feedbackText ||
    existingReview.reviewSource !== input.actor.actorSource
  ) {
    return false;
  }

  if (input.actor.actor === 'admin') {
    return existingReview.reviewedByUserId === input.actor.actorUserId;
  }

  return existingReview.reviewedByUserId === undefined;
}

export async function updateInteractionReview(
  deps: UpdateInteractionReviewDeps,
  input: UpdateInteractionReviewInput
): Promise<Result<UpdateInteractionReviewOutput, LearningProgressError>> {
  const trimmedFeedbackText = input.feedbackText?.trim();
  const actorResult = normalizeReviewActorMetadata(input.actor);

  if (actorResult.isErr()) {
    return err(actorResult.error);
  }

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

    const feedbackText = normalizeOptionalFeedbackText(trimmedFeedbackText);
    const reviewActor = actorResult.value;
    const nextPhase: InteractionPhase = input.status === 'approved' ? 'resolved' : 'failed';

    if (existingRow.record.phase !== 'pending') {
      if (
        matchesExistingReview({
          row: existingRow,
          status: input.status,
          feedbackText,
          actor: reviewActor,
        })
      ) {
        return ok({
          applied: false,
          row: existingRow,
        });
      }

      return err(
        createConflictError(
          `Interaction record "${input.recordKey}" is no longer reviewable because it is not pending.`
        )
      );
    }

    if (compareTimestampInstants(existingRow.updatedAt, input.expectedUpdatedAt) !== 0) {
      return err(
        createConflictError(
          `Interaction record "${input.recordKey}" changed since it was loaded for review.`
        )
      );
    }

    const nextUpdatedAt = getNextTimestamp(existingRow.record.updatedAt);
    const nextRecord = {
      ...existingRow.record,
      phase: nextPhase,
      result: sanitizeLegacyReviewResponse(existingRow.record.result),
      review: {
        status: input.status,
        reviewedAt: nextUpdatedAt,
        ...(feedbackText !== null ? { feedbackText } : {}),
        ...(reviewActor.actor === 'admin' ? { reviewedByUserId: reviewActor.actorUserId } : {}),
        ...(reviewActor.actorSource !== undefined ? { reviewSource: reviewActor.actorSource } : {}),
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
      actor: reviewActor.actor,
      ...(reviewActor.actorUserId !== undefined ? { actorUserId: reviewActor.actorUserId } : {}),
      ...(reviewActor.actorPermission !== undefined
        ? { actorPermission: reviewActor.actorPermission }
        : {}),
      ...(reviewActor.actorSource !== undefined ? { actorSource: reviewActor.actorSource } : {}),
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
