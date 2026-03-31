/**
 * Sync Events Use Case
 */

import { err, ok, type Result } from 'neverthrow';

import {
  createInvalidEventError,
  createTooManyEventsError,
  type LearningProgressError,
} from '../errors.js';
import {
  MAX_EVENTS_PER_REQUEST,
  isInteractiveUpdatedEvent,
  isProgressResetEvent,
  type InteractiveStateRecord,
  type LearningProgressRecordRow,
  type LearningProgressEvent,
} from '../types.js';

import type { LearningProgressRepository } from '../ports.js';

export interface SyncEventsDeps {
  repo: LearningProgressRepository;
}

export interface SyncEventsInput {
  userId: string;
  clientUpdatedAt: string;
  events: readonly LearningProgressEvent[];
}

export interface SyncEventsOutput {
  newEventsCount: number;
  failedEvents: readonly {
    eventId: string;
    errorType: 'InvalidEventError';
    message: string;
  }[];
  appliedEvents: readonly LearningProgressEvent[];
}

function compareTimestampInstants(leftTimestamp: string, rightTimestamp: string): number {
  const leftMilliseconds = Date.parse(leftTimestamp);
  const rightMilliseconds = Date.parse(rightTimestamp);

  if (!Number.isNaN(leftMilliseconds) && !Number.isNaN(rightMilliseconds)) {
    if (leftMilliseconds < rightMilliseconds) return -1;
    if (leftMilliseconds > rightMilliseconds) return 1;
    return 0;
  }

  return leftTimestamp.localeCompare(rightTimestamp);
}

function hasReviewField(record: Pick<InteractiveStateRecord, 'review'>): boolean {
  return typeof record.review !== 'undefined';
}

function hasReviewValue(record: Pick<InteractiveStateRecord, 'review'>): boolean {
  return typeof record.review !== 'undefined' && record.review !== null;
}

function reviewsAreEqual(
  leftReview: InteractiveStateRecord['review'],
  rightReview: InteractiveStateRecord['review']
): boolean {
  return JSON.stringify(leftReview ?? null) === JSON.stringify(rightReview ?? null);
}

function stripReview(record: InteractiveStateRecord): InteractiveStateRecord {
  if (!hasReviewField(record)) {
    return record;
  }

  const { review, ...recordWithoutReview } = record;
  void review;
  return recordWithoutReview;
}

function sanitizeSourceUrl(sourceUrl: string | undefined): string | undefined {
  if (typeof sourceUrl !== 'string') {
    return undefined;
  }

  const trimmedSourceUrl = sourceUrl.trim();
  if (trimmedSourceUrl.length === 0) {
    return undefined;
  }

  try {
    const parsedUrl = new URL(trimmedSourceUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return undefined;
    }

    return parsedUrl.toString();
  } catch {
    return undefined;
  }
}

function stripSourceUrl(record: InteractiveStateRecord): InteractiveStateRecord {
  if (record.sourceUrl === undefined) {
    return record;
  }

  const { sourceUrl, ...recordWithoutSourceUrl } = record;
  void sourceUrl;
  return recordWithoutSourceUrl;
}

function withSourceUrl(
  record: InteractiveStateRecord,
  sourceUrl: string | undefined
): InteractiveStateRecord {
  if (sourceUrl === undefined) {
    return stripSourceUrl(record);
  }

  return {
    ...record,
    sourceUrl,
  };
}

function shouldClearStoredReview(params: {
  incomingRecord: InteractiveStateRecord;
  storedRow: LearningProgressRecordRow | null;
}): boolean {
  const { incomingRecord, storedRow } = params;

  if (
    storedRow === null ||
    !hasReviewField(storedRow.record) ||
    incomingRecord.phase !== 'pending' ||
    incomingRecord.submittedAt === undefined ||
    incomingRecord.submittedAt === null
  ) {
    return false;
  }

  return compareTimestampInstants(incomingRecord.updatedAt, storedRow.record.updatedAt) > 0;
}

export function normalizePublicInteractiveRecord(params: {
  incomingRecord: InteractiveStateRecord;
  storedRow: LearningProgressRecordRow | null;
  eventId: string;
}): Result<InteractiveStateRecord, LearningProgressError> {
  const { incomingRecord, storedRow, eventId } = params;
  const sanitizedIncomingSourceUrl = sanitizeSourceUrl(incomingRecord.sourceUrl);
  const storedSourceUrl =
    storedRow === null ? undefined : sanitizeSourceUrl(storedRow.record.sourceUrl);

  if (incomingRecord.sourceUrl !== undefined && sanitizedIncomingSourceUrl === undefined) {
    return err(
      createInvalidEventError(
        `Interactive record "${incomingRecord.key}" must include a valid absolute sourceUrl when provided.`,
        eventId
      )
    );
  }

  if (hasReviewField(incomingRecord)) {
    if (storedRow === null || !hasReviewField(storedRow.record)) {
      return err(
        createInvalidEventError('Public progress sync cannot set record.review.', eventId)
      );
    }

    if (!reviewsAreEqual(incomingRecord.review, storedRow.record.review)) {
      return err(
        createInvalidEventError('Public progress sync cannot set record.review.', eventId)
      );
    }
  }

  const normalizedRecord = withSourceUrl(
    stripReview(incomingRecord),
    sanitizedIncomingSourceUrl ?? storedSourceUrl
  );
  if (storedRow === null || !hasReviewField(storedRow.record)) {
    return ok(normalizedRecord);
  }

  const storedReview = storedRow.record.review;
  if (typeof storedReview === 'undefined') {
    return ok(normalizedRecord);
  }

  if (shouldClearStoredReview({ incomingRecord: normalizedRecord, storedRow })) {
    return ok(normalizedRecord);
  }

  if (storedReview === null) {
    return ok({
      ...normalizedRecord,
      review: null,
    });
  }

  return ok({
    ...normalizedRecord,
    review: storedReview,
  });
}

function validatePublicInteractiveRecord(
  record: InteractiveStateRecord,
  eventId: string
): Result<void, LearningProgressError> {
  if (record.phase === 'idle' || record.phase === 'draft') {
    if (record.result !== null) {
      return err(
        createInvalidEventError(
          `Interactive record "${record.key}" cannot include result data while phase is "${record.phase}".`,
          eventId
        )
      );
    }

    if (hasReviewValue(record)) {
      return err(
        createInvalidEventError(
          `Interactive record "${record.key}" cannot include review data while phase is "${record.phase}".`,
          eventId
        )
      );
    }
  }

  if (record.phase === 'pending') {
    if (record.result !== null) {
      return err(
        createInvalidEventError(
          `Interactive record "${record.key}" cannot include result data while phase is "pending".`,
          eventId
        )
      );
    }

    if (hasReviewValue(record)) {
      return err(
        createInvalidEventError(
          `Interactive record "${record.key}" cannot include review data while phase is "pending".`,
          eventId
        )
      );
    }

    if (record.submittedAt === undefined || record.submittedAt === null) {
      return err(
        createInvalidEventError(
          `Interactive record "${record.key}" must include submittedAt while phase is "pending".`,
          eventId
        )
      );
    }
  }

  return ok(undefined);
}

export async function syncEvents(
  deps: SyncEventsDeps,
  input: SyncEventsInput
): Promise<Result<SyncEventsOutput, LearningProgressError>> {
  const { repo } = deps;
  const { userId, events } = input;

  if (events.length > MAX_EVENTS_PER_REQUEST) {
    return err(createTooManyEventsError(MAX_EVENTS_PER_REQUEST, events.length));
  }

  if (events.length === 0) {
    return ok({ newEventsCount: 0, failedEvents: [], appliedEvents: [] });
  }

  return repo.withTransaction(async (transactionalRepo) => {
    let appliedCount = 0;
    const failedEvents: {
      eventId: string;
      errorType: 'InvalidEventError';
      message: string;
    }[] = [];
    const appliedEvents: LearningProgressEvent[] = [];

    for (const event of events) {
      if (isProgressResetEvent(event)) {
        const resetResult = await transactionalRepo.resetProgress(userId);
        if (resetResult.isErr()) {
          return err(resetResult.error);
        }
        appliedCount += 1;
        appliedEvents.push(event);
        continue;
      }

      if (isInteractiveUpdatedEvent(event)) {
        const existingRowResult = await transactionalRepo.getRecordForUpdate(
          userId,
          event.payload.record.key
        );
        if (existingRowResult.isErr()) {
          return err(existingRowResult.error);
        }

        const normalizedRecordResult = normalizePublicInteractiveRecord({
          incomingRecord: event.payload.record,
          storedRow: existingRowResult.value,
          eventId: event.eventId,
        });
        if (normalizedRecordResult.isErr()) {
          if (normalizedRecordResult.error.type === 'InvalidEventError') {
            failedEvents.push({
              eventId: event.eventId,
              errorType: normalizedRecordResult.error.type,
              message: normalizedRecordResult.error.message,
            });
            continue;
          }

          return err(normalizedRecordResult.error);
        }

        const validationResult = validatePublicInteractiveRecord(
          normalizedRecordResult.value,
          event.eventId
        );
        if (validationResult.isErr()) {
          if (validationResult.error.type === 'InvalidEventError') {
            failedEvents.push({
              eventId: event.eventId,
              errorType: validationResult.error.type,
              message: validationResult.error.message,
            });
            continue;
          }

          return err(validationResult.error);
        }

        const upsertResult = await transactionalRepo.upsertInteractiveRecord({
          userId,
          eventId: event.eventId,
          clientId: event.clientId,
          occurredAt: event.occurredAt,
          record: normalizedRecordResult.value,
          auditEvents: event.payload.auditEvents ?? [],
        });

        if (upsertResult.isErr()) {
          return err(upsertResult.error);
        }

        if (upsertResult.value.applied) {
          appliedCount += 1;
          appliedEvents.push(event);
        }
      }
    }

    return ok({
      newEventsCount: appliedCount,
      failedEvents,
      appliedEvents,
    });
  });
}
