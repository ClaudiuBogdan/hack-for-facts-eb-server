/**
 * Sync Events Use Case
 */

import { err, ok, type Result } from 'neverthrow';

import { FUNKY_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

import { getCampaignAutoReviewReuseInteractionConfig } from '../campaign-admin-config.js';
import {
  createInvalidEventError,
  createTooManyEventsError,
  type LearningProgressError,
} from '../errors.js';
import { isInternalInteractionId, isInternalRecordKey } from '../internal-records.js';
import { jsonValuesAreEqual } from '../json-equality.js';
import {
  MAX_EVENTS_PER_REQUEST,
  type InteractiveAuditEvent,
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

function stripHiddenReviewMetadata(
  review: InteractiveStateRecord['review']
): InteractiveStateRecord['review'] {
  if (review === undefined || review === null) {
    return review;
  }

  const { reviewedByUserId, reviewSource, ...publicReview } = review;
  void reviewedByUserId;
  void reviewSource;
  return publicReview;
}

function hasHiddenReviewMetadata(review: InteractiveStateRecord['review']): boolean {
  if (review === undefined || review === null) {
    return false;
  }

  return (
    ('reviewedByUserId' in review && typeof review.reviewedByUserId === 'string') ||
    ('reviewSource' in review && typeof review.reviewSource === 'string')
  );
}

function reviewsAreEqual(
  leftReview: InteractiveStateRecord['review'],
  rightReview: InteractiveStateRecord['review']
): boolean {
  const resolvedLeftReview = stripHiddenReviewMetadata(leftReview);
  const resolvedRightReview = stripHiddenReviewMetadata(rightReview);

  if (resolvedLeftReview === undefined || resolvedLeftReview === null) {
    return resolvedRightReview === undefined || resolvedRightReview === null;
  }

  if (resolvedRightReview === undefined || resolvedRightReview === null) {
    return false;
  }

  return (
    resolvedLeftReview.status === resolvedRightReview.status &&
    resolvedLeftReview.reviewedAt === resolvedRightReview.reviewedAt &&
    (resolvedLeftReview.feedbackText ?? null) === (resolvedRightReview.feedbackText ?? null)
  );
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

function retryToPendingPreservesReviewedIdentity(params: {
  incomingRecord: InteractiveStateRecord;
  storedRow: LearningProgressRecordRow;
}): boolean {
  const { incomingRecord, storedRow } = params;
  const storedRecord = storedRow.record;

  if (
    incomingRecord.interactionId !== storedRecord.interactionId ||
    incomingRecord.scope.type !== storedRecord.scope.type
  ) {
    return false;
  }

  if (incomingRecord.scope.type === 'entity') {
    return (
      storedRecord.scope.type === 'entity' &&
      incomingRecord.scope.entityCui === storedRecord.scope.entityCui
    );
  }

  return true;
}

function reviewedRecordClientFieldsMatch(params: {
  incomingRecord: InteractiveStateRecord;
  storedRow: LearningProgressRecordRow;
  storedSourceUrl: string | undefined;
}): boolean {
  const { incomingRecord, storedRow, storedSourceUrl } = params;

  return jsonValuesAreEqual(
    incomingRecord,
    withSourceUrl(stripReview(storedRow.record), storedSourceUrl)
  );
}

function shouldAcquireAutoReviewReuseTransactionLock(
  record: InteractiveStateRecord
): record is InteractiveStateRecord & {
  phase: 'pending';
  scope: { type: 'entity'; entityCui: string };
} {
  if (record.phase !== 'pending' || record.scope.type !== 'entity') {
    return false;
  }

  return (
    getCampaignAutoReviewReuseInteractionConfig(FUNKY_CAMPAIGN_KEY, record.interactionId) !== null
  );
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

    if (hasHiddenReviewMetadata(incomingRecord.review)) {
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
    if (!retryToPendingPreservesReviewedIdentity({ incomingRecord: normalizedRecord, storedRow })) {
      return err(
        createInvalidEventError(
          'Public progress sync cannot change reviewed interaction identity when retrying to pending.',
          eventId
        )
      );
    }

    return ok(normalizedRecord);
  }

  if (storedReview === null) {
    return ok({
      ...normalizedRecord,
      review: null,
    });
  }

  if (
    !reviewedRecordClientFieldsMatch({
      incomingRecord: normalizedRecord,
      storedRow,
      storedSourceUrl,
    })
  ) {
    return err(
      createInvalidEventError(
        'Public progress sync cannot modify reviewed records unless they re-enter pending.',
        eventId
      )
    );
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
  if (isInternalRecordKey(record.key) || isInternalInteractionId(record.interactionId)) {
    return err(
      createInvalidEventError('Public progress sync cannot set internal records.', eventId)
    );
  }

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

function filterPublicInteractiveAuditEvents(
  auditEvents: readonly InteractiveAuditEvent[]
): readonly Extract<InteractiveAuditEvent, { type: 'submitted' }>[] {
  return auditEvents.filter(
    (auditEvent): auditEvent is Extract<InteractiveAuditEvent, { type: 'submitted' }> =>
      auditEvent.type === 'submitted'
  );
}

function buildPublicAppliedEvent(params: {
  event: Extract<LearningProgressEvent, { type: 'interactive.updated' }>;
  record: InteractiveStateRecord;
  auditEvents: readonly InteractiveAuditEvent[];
}): LearningProgressEvent {
  const { auditEvents: omittedAuditEvents, ...payloadWithoutAuditEvents } = params.event.payload;
  void omittedAuditEvents;

  return {
    ...params.event,
    payload:
      params.auditEvents.length > 0
        ? {
            ...payloadWithoutAuditEvents,
            record: params.record,
            auditEvents: params.auditEvents,
          }
        : {
            ...payloadWithoutAuditEvents,
            record: params.record,
          },
  };
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
        if (shouldAcquireAutoReviewReuseTransactionLock(event.payload.record)) {
          const lockResult = await transactionalRepo.acquireAutoReviewReuseTransactionLock({
            recordKey: event.payload.record.key,
          });
          if (lockResult.isErr()) {
            return err(lockResult.error);
          }
        }

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

        const publicAuditEvents = filterPublicInteractiveAuditEvents(
          event.payload.auditEvents ?? []
        );

        const upsertResult = await transactionalRepo.upsertInteractiveRecord({
          userId,
          eventId: event.eventId,
          clientId: event.clientId,
          occurredAt: event.occurredAt,
          record: normalizedRecordResult.value,
          auditEvents: publicAuditEvents,
        });

        if (upsertResult.isErr()) {
          return err(upsertResult.error);
        }

        if (upsertResult.value.applied) {
          appliedCount += 1;
          appliedEvents.push(
            buildPublicAppliedEvent({
              event,
              record: normalizedRecordResult.value,
              auditEvents: publicAuditEvents,
            })
          );
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
