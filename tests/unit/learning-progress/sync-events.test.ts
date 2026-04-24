import { describe, expect, it } from 'vitest';

import {
  MAX_EVENTS_PER_REQUEST,
  type LearningProgressEvent,
  type LearningProgressRecordRow,
} from '@/modules/learning-progress/core/types.js';
import {
  normalizePublicInteractiveRecord,
  syncEvents,
} from '@/modules/learning-progress/core/usecases/sync-events.js';

import {
  createTestInteractiveRecord,
  createTestInteractiveUpdatedEvent,
  createTestProgressResetEvent,
  createTestSubmittedAuditEvent,
  makeFakeLearningProgressRepo,
} from '../../fixtures/fakes.js';

function makeRow(userId: string, record: LearningProgressRecordRow['record'], updatedSeq: string) {
  return {
    userId,
    recordKey: record.key,
    record,
    auditEvents: [],
    updatedSeq,
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  } satisfies LearningProgressRecordRow;
}

function stripHiddenReviewMetadata(
  record: LearningProgressRecordRow['record']
): LearningProgressRecordRow['record'] {
  if (record.review === undefined || record.review === null) {
    return record;
  }

  const { reviewedByUserId, reviewSource, ...publicReview } = record.review;
  void reviewedByUserId;
  void reviewSource;

  return {
    ...record,
    review: publicReview,
  };
}

function expectSyncEventsSuccess(
  result: {
    newEventsCount: number;
    failedEvents: readonly { eventId: string; errorType: 'InvalidEventError'; message: string }[];
    appliedEvents: readonly LearningProgressEvent[];
  },
  expected: {
    newEventsCount: number;
    failedEvents?: readonly { eventId: string; errorType: 'InvalidEventError'; message: string }[];
    appliedEvents?: readonly LearningProgressEvent[];
  }
) {
  expect(result).toEqual(
    expect.objectContaining({
      newEventsCount: expected.newEventsCount,
      ...(expected.failedEvents !== undefined ? { failedEvents: expected.failedEvents } : {}),
      ...(expected.appliedEvents !== undefined ? { appliedEvents: expected.appliedEvents } : {}),
    })
  );
}

describe('normalizePublicInteractiveRecord', () => {
  it('accepts public round-trips when stored review contains hidden metadata', () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
        reviewedByUserId: 'admin-user-1',
        reviewSource: 'campaign_admin_api',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });

    const result = normalizePublicInteractiveRecord({
      incomingRecord: stripHiddenReviewMetadata(reviewedRecord),
      storedRow: makeRow('user-1', reviewedRecord, '1'),
      eventId: 'event-roundtrip',
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(reviewedRecord);
  });

  it('accepts public round-trips when review fields arrive in a different property order', () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
        reviewedByUserId: 'admin-user-1',
        reviewSource: 'campaign_admin_api',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });

    const result = normalizePublicInteractiveRecord({
      incomingRecord: {
        ...stripHiddenReviewMetadata(reviewedRecord),
        review: {
          feedbackText: 'Approved by review.',
          reviewedAt: '2026-03-23T19:30:00.000Z',
          status: 'approved',
        },
      },
      storedRow: makeRow('user-1', reviewedRecord, '1'),
      eventId: 'event-roundtrip-property-order',
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(reviewedRecord);
  });

  it('rejects client-supplied hidden review metadata even when public review fields match', () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
        reviewedByUserId: 'admin-user-1',
        reviewSource: 'campaign_admin_api',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });

    const result = normalizePublicInteractiveRecord({
      incomingRecord: {
        ...stripHiddenReviewMetadata(reviewedRecord),
        review: {
          status: 'approved',
          reviewedAt: '2026-03-23T19:30:00.000Z',
          feedbackText: 'Approved by review.',
          reviewedByUserId: 'admin-user-1',
        },
      },
      storedRow: makeRow('user-1', reviewedRecord, '1'),
      eventId: 'event-hidden-review-metadata',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      expect.objectContaining({
        type: 'InvalidEventError',
        eventId: 'event-hidden-review-metadata',
        message: 'Public progress sync cannot set record.review.',
      })
    );
  });

  it('rejects client-authored changes to reviewed rows unless they retry back to pending', () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://old.example.com',
          },
        },
      },
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
        reviewedByUserId: 'admin-user-1',
        reviewSource: 'campaign_admin_api',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });
    const updatedRecord = createTestInteractiveRecord({
      key: reviewedRecord.key,
      interactionId: reviewedRecord.interactionId,
      lessonId: reviewedRecord.lessonId,
      kind: reviewedRecord.kind,
      scope: reviewedRecord.scope,
      completionRule: reviewedRecord.completionRule,
      phase: reviewedRecord.phase,
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://new.example.com',
          },
        },
      },
      result: reviewedRecord.result,
      updatedAt: '2026-03-23T19:45:00.000Z',
    });

    const result = normalizePublicInteractiveRecord({
      incomingRecord: updatedRecord,
      storedRow: makeRow('user-1', reviewedRecord, '1'),
      eventId: 'event-preserve',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      expect.objectContaining({
        type: 'InvalidEventError',
        eventId: 'event-preserve',
        message:
          'Public progress sync cannot modify reviewed records unless they re-enter pending.',
      })
    );
  });

  it('clears stored review metadata on newer retries back to pending', () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });
    const retryRecord = createTestInteractiveRecord({
      key: reviewedRecord.key,
      interactionId: reviewedRecord.interactionId,
      lessonId: reviewedRecord.lessonId,
      kind: reviewedRecord.kind,
      scope: reviewedRecord.scope,
      completionRule: reviewedRecord.completionRule,
      phase: 'pending',
      value: reviewedRecord.value,
      result: reviewedRecord.result,
      updatedAt: '2026-03-23T19:45:00.000Z',
      submittedAt: '2026-03-23T19:45:00.000Z',
    });

    const result = normalizePublicInteractiveRecord({
      incomingRecord: retryRecord,
      storedRow: makeRow('user-1', reviewedRecord, '1'),
      eventId: 'event-retry',
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().review).toBeUndefined();
  });

  it('rejects identity-changing retries back to pending for reviewed rows', () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      interactionId: 'funky:interaction:city_hall_website',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      scope: { type: 'entity', entityCui: '4305857' },
      phase: 'resolved',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });
    const retryRecord = createTestInteractiveRecord({
      key: reviewedRecord.key,
      interactionId: 'funky:interaction:budget_document',
      lessonId: reviewedRecord.lessonId,
      kind: reviewedRecord.kind,
      scope: { type: 'entity', entityCui: '9999999' },
      completionRule: reviewedRecord.completionRule,
      phase: 'pending',
      value: reviewedRecord.value,
      result: reviewedRecord.result,
      updatedAt: '2026-03-23T19:45:00.000Z',
      submittedAt: '2026-03-23T19:45:00.000Z',
    });

    const result = normalizePublicInteractiveRecord({
      incomingRecord: retryRecord,
      storedRow: makeRow('user-1', reviewedRecord, '1'),
      eventId: 'event-retry-identity-change',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      expect.objectContaining({
        type: 'InvalidEventError',
        eventId: 'event-retry-identity-change',
        message:
          'Public progress sync cannot change reviewed interaction identity when retrying to pending.',
      })
    );
  });

  it('rejects attempts to modify stored review metadata', () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
        reviewedByUserId: 'admin-user-1',
        reviewSource: 'campaign_admin_api',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });
    const modifiedReviewRecord = createTestInteractiveRecord({
      key: reviewedRecord.key,
      interactionId: reviewedRecord.interactionId,
      lessonId: reviewedRecord.lessonId,
      kind: reviewedRecord.kind,
      scope: reviewedRecord.scope,
      completionRule: reviewedRecord.completionRule,
      phase: reviewedRecord.phase,
      value: reviewedRecord.value,
      result: reviewedRecord.result,
      review: {
        status: 'approved',
        reviewedAt: reviewedRecord.review?.reviewedAt ?? null,
        feedbackText: 'Client changed this feedback.',
      },
      updatedAt: reviewedRecord.updatedAt,
    });

    const result = normalizePublicInteractiveRecord({
      incomingRecord: modifiedReviewRecord,
      storedRow: makeRow('user-1', reviewedRecord, '1'),
      eventId: 'event-modified-review',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      expect.objectContaining({
        type: 'InvalidEventError',
        eventId: 'event-modified-review',
        message: 'Public progress sync cannot set record.review.',
      })
    );
  });
});

describe('syncEvents', () => {
  it('returns success for empty requests', async () => {
    const repo = makeFakeLearningProgressRepo();

    const result = await syncEvents(
      { repo },
      { userId: 'user-1', clientUpdatedAt: '2024-01-15T10:00:00.000Z', events: [] }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 0,
      failedEvents: [],
      appliedEvents: [],
    });
  });

  it('acquires the auto-review reuse lock before reading allowlisted entity pending retries', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      interactionId: 'funky:interaction:city_hall_website',
      lessonId: 'civic-monitor-and-request',
      kind: 'custom',
      scope: { type: 'entity', entityCui: '4305857' },
      completionRule: { type: 'resolved' },
      phase: 'pending',
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://example.com',
            submittedAt: '2026-03-23T19:27:40.526Z',
          },
        },
      },
      updatedAt: '2026-03-23T19:27:40.527Z',
      submittedAt: '2026-03-23T19:27:40.527Z',
    });
    const callOrder: string[] = [];
    const lockInputs: { recordKey: string }[] = [];
    const repo = makeFakeLearningProgressRepo({
      onAcquireAutoReviewReuseTransactionLock(input) {
        callOrder.push('lock');
        lockInputs.push(input);
      },
      onGetRecordForUpdate() {
        callOrder.push('get_record_for_update');
      },
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-lock-before-read',
            payload: { record },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expect(callOrder.slice(0, 2)).toEqual(['lock', 'get_record_for_update']);
    expect(lockInputs).toEqual([{ recordKey: record.key }]);
  });

  it('does not acquire the auto-review reuse lock for non-allowlisted pending records', async () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      interactionId: 'quiz-1',
      phase: 'pending',
      scope: { type: 'global' },
      updatedAt: '2026-03-23T19:27:40.527Z',
      submittedAt: '2026-03-23T19:27:40.527Z',
    });
    const acquiredLocks: string[] = [];
    const repo = makeFakeLearningProgressRepo({
      onAcquireAutoReviewReuseTransactionLock() {
        acquiredLocks.push('lock');
      },
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-no-lock',
            payload: { record },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expect(acquiredLocks).toEqual([]);
  });

  it('stores a new interactive record update', async () => {
    const repo = makeFakeLearningProgressRepo();
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });
    const auditEvent = createTestSubmittedAuditEvent({
      recordKey: record.key,
      lessonId: record.lessonId,
      interactionId: record.interactionId,
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:00:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-1',
            payload: {
              record,
              auditEvents: [auditEvent],
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 1,
    });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    expect(storedRecords._unsafeUnwrap()).toHaveLength(1);
    expect(storedRecords._unsafeUnwrap()[0]?.record).toEqual(record);
    expect(storedRecords._unsafeUnwrap()[0]?.auditEvents[0]?.sourceClientEventId).toBe('event-1');
  });

  it('quarantines public sync attempts to author record.review without failing the request', async () => {
    const repo = makeFakeLearningProgressRepo();
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Not allowed from client.',
      },
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2026-03-23T19:30:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-review',
            payload: {
              record,
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 0,
      failedEvents: [
        {
          eventId: 'event-review',
          errorType: 'InvalidEventError',
          message: 'Public progress sync cannot set record.review.',
        },
      ],
      appliedEvents: [],
    });
  });

  it('quarantines public sync attempts to author internal records without failing the request', async () => {
    const repo = makeFakeLearningProgressRepo();
    const record = createTestInteractiveRecord({
      key: 'internal:funky:weekly_digest',
      interactionId: 'internal:funky:weekly_digest',
      lessonId: 'internal',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      scope: { type: 'global' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: {
          value: {
            campaignKey: 'funky',
            lastSentAt: null,
            watermarkAt: null,
            weekKey: null,
            outboxId: null,
          },
        },
      },
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2026-04-15T10:00:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-internal',
            payload: {
              record,
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 0,
      failedEvents: [
        {
          eventId: 'event-internal',
          errorType: 'InvalidEventError',
          message: 'Public progress sync cannot set internal records.',
        },
      ],
      appliedEvents: [],
    });
  });

  it('rejects newer client-authored changes to reviewed rows until they retry back to pending', async () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      interactionId: 'funky:interaction:city_hall_website',
      lessonId: 'civic-monitor-and-request',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://old.example.com',
          },
        },
      },
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });

    const resubmittedRecord = createTestInteractiveRecord({
      key: reviewedRecord.key,
      interactionId: reviewedRecord.interactionId,
      lessonId: reviewedRecord.lessonId,
      kind: reviewedRecord.kind,
      scope: reviewedRecord.scope,
      completionRule: reviewedRecord.completionRule,
      phase: reviewedRecord.phase,
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://new.example.com',
          },
        },
      },
      result: reviewedRecord.result,
      updatedAt: '2026-03-23T19:45:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', reviewedRecord, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2026-03-23T19:45:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-resubmit',
            payload: {
              record: resubmittedRecord,
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 0,
      failedEvents: [
        {
          eventId: 'event-resubmit',
          errorType: 'InvalidEventError',
          message:
            'Public progress sync cannot modify reviewed records unless they re-enter pending.',
        },
      ],
      appliedEvents: [],
    });

    const storedRecord = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRecord?.record.value).toEqual(reviewedRecord.value);
    expect(storedRecord?.record.updatedAt).toBe(reviewedRecord.updatedAt);
    expect(storedRecord?.record.review).toEqual(reviewedRecord.review);
  });

  it('clears stored review metadata on newer public retries back to pending', async () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      interactionId: 'funky:interaction:city_hall_website',
      lessonId: 'civic-monitor-and-request',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://old.example.com',
          },
        },
      },
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:30:00.000Z',
        feedbackText: 'Approved by review.',
      },
      updatedAt: '2026-03-23T19:30:00.000Z',
    });

    const retriedRecord = createTestInteractiveRecord({
      key: reviewedRecord.key,
      interactionId: reviewedRecord.interactionId,
      lessonId: reviewedRecord.lessonId,
      kind: reviewedRecord.kind,
      scope: reviewedRecord.scope,
      completionRule: reviewedRecord.completionRule,
      phase: 'pending',
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://new.example.com',
          },
        },
      },
      result: reviewedRecord.result,
      updatedAt: '2026-03-23T19:45:00.000Z',
      submittedAt: '2026-03-23T19:45:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', reviewedRecord, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2026-03-23T19:45:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-retry',
            payload: {
              record: retriedRecord,
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 1,
    });

    const storedRecord = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRecord?.record.value).toEqual(retriedRecord.value);
    expect(storedRecord?.record.updatedAt).toBe(retriedRecord.updatedAt);
    expect(storedRecord?.record.review).toBeUndefined();
  });

  it('rejects pending public records that include result data', async () => {
    const repo = makeFakeLearningProgressRepo();
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'pending',
      result: {
        outcome: null,
        evaluatedAt: '2026-03-24T19:30:00.000Z',
      },
      submittedAt: '2026-03-24T19:30:00.000Z',
      updatedAt: '2026-03-24T19:30:00.000Z',
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2026-03-24T19:30:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-invalid-pending-result',
            payload: {
              record,
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 0,
      failedEvents: [
        {
          eventId: 'event-invalid-pending-result',
          errorType: 'InvalidEventError',
          message: `Interactive record "${record.key}" cannot include result data while phase is "pending".`,
        },
      ],
      appliedEvents: [],
    });
  });

  it('quarantines pending public records that omit submittedAt', async () => {
    const repo = makeFakeLearningProgressRepo();
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      phase: 'pending',
      updatedAt: '2026-03-24T19:30:00.000Z',
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2026-03-24T19:30:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-invalid-pending-submitted-at',
            payload: {
              record,
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 0,
      failedEvents: [
        {
          eventId: 'event-invalid-pending-submitted-at',
          errorType: 'InvalidEventError',
          message: `Interactive record "${record.key}" must include submittedAt while phase is "pending".`,
        },
      ],
      appliedEvents: [],
    });
  });

  it('quarantines draft public records that include result data', async () => {
    const repo = makeFakeLearningProgressRepo();
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      phase: 'draft',
      result: {
        outcome: 'correct',
        score: 100,
        evaluatedAt: '2026-03-24T19:30:00.000Z',
      },
      updatedAt: '2026-03-24T19:30:00.000Z',
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2026-03-24T19:30:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-invalid-draft-result',
            payload: {
              record,
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 0,
      failedEvents: [
        {
          eventId: 'event-invalid-draft-result',
          errorType: 'InvalidEventError',
          message: `Interactive record "${record.key}" cannot include result data while phase is "draft".`,
        },
      ],
      appliedEvents: [],
    });
  });

  it('deduplicates interactive updates by client event id when audit events are present', async () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });
    const auditEvent = createTestSubmittedAuditEvent({
      recordKey: record.key,
      lessonId: record.lessonId,
      interactionId: record.interactionId,
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [
          {
            ...auditEvent,
            seq: '1',
            sourceClientEventId: 'event-1',
            sourceClientId: 'device-1',
          },
        ],
        updatedSeq: '1',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:01:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-1',
            payload: {
              record,
              auditEvents: [auditEvent],
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 0,
    });
  });

  it('accepts legacy client-authored evaluated audit events but drops them', async () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });

    const repo = makeFakeLearningProgressRepo();

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:01:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-evaluated-audit',
            payload: {
              record,
              auditEvents: [
                {
                  id: 'evaluated-1',
                  recordKey: record.key,
                  lessonId: record.lessonId,
                  interactionId: record.interactionId,
                  type: 'evaluated',
                  at: '2024-01-15T10:00:00.000Z',
                  actor: 'system',
                  phase: 'resolved',
                  result: {
                    outcome: 'correct',
                    evaluatedAt: '2024-01-15T10:00:00.000Z',
                  },
                },
              ],
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 1,
      failedEvents: [],
      appliedEvents: [
        createTestInteractiveUpdatedEvent({
          eventId: 'event-evaluated-audit',
          payload: {
            record,
          },
        }),
      ],
    });

    const storedRows = (await repo.getRecords('user-1'))._unsafeUnwrap();
    expect(storedRows[0]?.record).toEqual(record);
    expect(storedRows[0]?.auditEvents).toEqual([]);
  });

  it('ignores older record snapshots that arrive after newer state', async () => {
    const newerRecord = createTestInteractiveRecord({
      key: 'quiz-1::global',
      phase: 'resolved',
      updatedAt: '2024-01-15T10:05:00.000Z',
      result: {
        outcome: 'correct',
        evaluatedAt: '2024-01-15T10:05:00.000Z',
      },
    });
    const olderRecord = createTestInteractiveRecord({
      key: newerRecord.key,
      interactionId: newerRecord.interactionId,
      lessonId: newerRecord.lessonId,
      phase: 'draft',
      updatedAt: '2024-01-15T10:00:00.000Z',
      result: null,
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', newerRecord, '3')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:06:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'late-event',
            occurredAt: olderRecord.updatedAt,
            payload: {
              record: olderRecord,
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 0,
    });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    expect(storedRecords._unsafeUnwrap()[0]?.record).toEqual(newerRecord);
  });

  it('preserves internal rows for a user on progress.reset', async () => {
    const record = createTestInteractiveRecord({ key: 'system:learning-onboarding' });
    const internalRecord = createTestInteractiveRecord({
      key: 'internal:funky:weekly_digest',
      interactionId: 'internal:funky:weekly_digest',
      lessonId: 'internal',
      kind: 'custom',
      completionRule: { type: 'resolved' },
      scope: { type: 'global' },
      phase: 'resolved',
      value: {
        kind: 'json',
        json: {
          value: {
            campaignKey: 'funky',
            lastSentAt: null,
            watermarkAt: null,
            weekKey: null,
            outboxId: null,
          },
        },
      },
      updatedAt: '2024-01-15T10:01:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      makeRow('user-1', record, '1'),
      makeRow('user-1', internalRecord, '2'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:02:00.000Z',
        events: [createTestProgressResetEvent({ eventId: 'reset-1' })],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 1,
    });

    const publicRecords = await repo.getRecords('user-1');
    expect(publicRecords.isOk()).toBe(true);
    expect(publicRecords._unsafeUnwrap()).toEqual([]);

    const internalRecords = await repo.getRecords('user-1', { includeInternal: true });
    expect(internalRecords.isOk()).toBe(true);
    expect(internalRecords._unsafeUnwrap()).toEqual([
      expect.objectContaining({
        recordKey: 'internal:funky:weekly_digest',
      }),
    ]);
  });

  it('rolls back earlier writes when a later event in the batch fails', async () => {
    const record = createTestInteractiveRecord({ key: 'quiz-1::global' });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', record, '1')]);

    const repo = makeFakeLearningProgressRepo({
      initialRecords,
      failOnUpsertAttempt: 1,
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:02:00.000Z',
        events: [
          createTestProgressResetEvent({ eventId: 'reset-1' }),
          createTestInteractiveUpdatedEvent({
            eventId: 'event-2',
            payload: {
              record: createTestInteractiveRecord({
                key: 'quiz-2::global',
                interactionId: 'quiz-2',
                lessonId: 'lesson-2',
              }),
            },
          }),
        ],
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('DatabaseError');

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    expect(storedRecords._unsafeUnwrap()).toHaveLength(1);
    expect(storedRecords._unsafeUnwrap()[0]?.record).toEqual(record);
  });

  it('applies valid events around invalid ones and reports failed event ids', async () => {
    const repo = makeFakeLearningProgressRepo();
    const validBefore = createTestInteractiveRecord({
      key: 'quiz-before::global',
      interactionId: 'quiz-before',
      lessonId: 'lesson-before',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });
    const invalid = createTestInteractiveRecord({
      key: 'quiz-invalid::global',
      interactionId: 'quiz-invalid',
      lessonId: 'lesson-invalid',
      phase: 'pending',
      result: {
        outcome: null,
        evaluatedAt: '2024-01-15T10:01:00.000Z',
      },
      submittedAt: '2024-01-15T10:01:00.000Z',
      updatedAt: '2024-01-15T10:01:00.000Z',
    });
    const validAfter = createTestInteractiveRecord({
      key: 'quiz-after::global',
      interactionId: 'quiz-after',
      lessonId: 'lesson-after',
      updatedAt: '2024-01-15T10:02:00.000Z',
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:02:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'event-valid-before',
            payload: { record: validBefore },
          }),
          createTestInteractiveUpdatedEvent({
            eventId: 'event-invalid',
            payload: { record: invalid },
          }),
          createTestInteractiveUpdatedEvent({
            eventId: 'event-valid-after',
            payload: { record: validAfter },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 2,
      failedEvents: [
        {
          eventId: 'event-invalid',
          errorType: 'InvalidEventError',
          message: `Interactive record "${invalid.key}" cannot include result data while phase is "pending".`,
        },
      ],
      appliedEvents: [
        createTestInteractiveUpdatedEvent({
          eventId: 'event-valid-before',
          payload: { record: validBefore },
        }),
        createTestInteractiveUpdatedEvent({
          eventId: 'event-valid-after',
          payload: { record: validAfter },
        }),
      ],
    });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    expect(
      storedRecords
        ._unsafeUnwrap()
        .map((row) => row.recordKey)
        .sort()
    ).toEqual([validAfter.key, validBefore.key]);
  });

  it('retries safely after a later database failure rolls back the transaction', async () => {
    const record = createTestInteractiveRecord({ key: 'quiz-1::global' });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', record, '1')]);

    const repo = makeFakeLearningProgressRepo({
      initialRecords,
      failOnUpsertAttempt: 1,
    });

    const resetEvent = createTestProgressResetEvent({ eventId: 'reset-1' });
    const nextEvent = createTestInteractiveUpdatedEvent({
      eventId: 'event-2',
      payload: {
        record: createTestInteractiveRecord({
          key: 'quiz-2::global',
          interactionId: 'quiz-2',
          lessonId: 'lesson-2',
        }),
      },
    });

    const firstResult = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:02:00.000Z',
        events: [resetEvent, nextEvent],
      }
    );

    expect(firstResult.isErr()).toBe(true);
    expect(firstResult._unsafeUnwrapErr().type).toBe('DatabaseError');

    const secondResult = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:02:00.000Z',
        events: [resetEvent, nextEvent],
      }
    );

    expect(secondResult.isOk()).toBe(true);
    expectSyncEventsSuccess(secondResult._unsafeUnwrap(), {
      newEventsCount: 2,
      failedEvents: [],
      appliedEvents: [resetEvent, nextEvent],
    });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    expect(storedRecords._unsafeUnwrap()).toHaveLength(1);
    expect(storedRecords._unsafeUnwrap()[0]?.recordKey).toBe('quiz-2::global');
  });

  it('processes reset followed by interactive.updated atomically', async () => {
    const oldRecord = createTestInteractiveRecord({
      key: 'quiz-old::global',
      updatedAt: '2024-01-15T09:00:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', oldRecord, '1')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const newRecord = createTestInteractiveRecord({
      key: 'quiz-new::global',
      interactionId: 'quiz-new',
      lessonId: 'lesson-new',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:00:00.000Z',
        events: [
          createTestProgressResetEvent({ eventId: 'reset-1' }),
          createTestInteractiveUpdatedEvent({
            eventId: 'event-2',
            payload: { record: newRecord },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 2,
    });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    const rows = storedRecords._unsafeUnwrap();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.record).toEqual(newRecord);
  });

  it('merges new audit events even when the record snapshot is stale', async () => {
    const newerRecord = createTestInteractiveRecord({
      key: 'quiz-1::global',
      phase: 'resolved',
      updatedAt: '2024-01-15T10:05:00.000Z',
      result: { outcome: 'correct', evaluatedAt: '2024-01-15T10:05:00.000Z' },
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', newerRecord, '3')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const olderRecord = createTestInteractiveRecord({
      key: newerRecord.key,
      interactionId: newerRecord.interactionId,
      lessonId: newerRecord.lessonId,
      phase: 'pending',
      updatedAt: '2024-01-15T10:00:00.000Z',
      result: null,
      submittedAt: '2024-01-15T10:00:00.000Z',
    });
    const auditEvent = createTestSubmittedAuditEvent({
      recordKey: olderRecord.key,
      lessonId: olderRecord.lessonId,
      interactionId: olderRecord.interactionId,
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:06:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'stale-event',
            occurredAt: olderRecord.updatedAt,
            payload: {
              record: olderRecord,
              auditEvents: [auditEvent],
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 1,
    });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    const row = storedRecords._unsafeUnwrap()[0];
    expect(row?.record).toEqual(newerRecord);
    expect(row?.auditEvents).toHaveLength(1);
    expect(row?.auditEvents[0]?.sourceClientEventId).toBe('stale-event');
  });

  it('stores multiple interactive.updated events for different keys in one batch', async () => {
    const repo = makeFakeLearningProgressRepo();
    const recordA = createTestInteractiveRecord({
      key: 'quiz-a::global',
      interactionId: 'quiz-a',
      lessonId: 'lesson-a',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });
    const recordB = createTestInteractiveRecord({
      key: 'quiz-b::entity:456',
      interactionId: 'quiz-b',
      lessonId: 'lesson-b',
      updatedAt: '2024-01-15T10:01:00.000Z',
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:01:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({ eventId: 'ev-a', payload: { record: recordA } }),
          createTestInteractiveUpdatedEvent({ eventId: 'ev-b', payload: { record: recordB } }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 2,
    });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    const rows = storedRecords._unsafeUnwrap();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.recordKey).sort()).toEqual([recordA.key, recordB.key]);
  });

  it('returns appliedEvents for events that were actually applied', async () => {
    const repo = makeFakeLearningProgressRepo();
    const resetEvent = createTestProgressResetEvent({
      eventId: 'reset-1',
      occurredAt: '2024-01-15T10:00:00.000Z',
    });
    const appliedRecord = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:01:00.000Z',
    });
    const appliedEvent = createTestInteractiveUpdatedEvent({
      eventId: 'event-1',
      occurredAt: appliedRecord.updatedAt,
      payload: { record: appliedRecord },
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: appliedRecord.updatedAt,
        events: [resetEvent, appliedEvent],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 2,
      appliedEvents: [resetEvent, appliedEvent],
    });
  });

  it('excludes duplicate or stale events from appliedEvents', async () => {
    const newerRecord = createTestInteractiveRecord({
      key: 'quiz-1::global',
      phase: 'resolved',
      updatedAt: '2024-01-15T10:05:00.000Z',
      result: {
        outcome: 'correct',
        evaluatedAt: '2024-01-15T10:05:00.000Z',
      },
    });
    const staleRecord = createTestInteractiveRecord({
      key: newerRecord.key,
      interactionId: newerRecord.interactionId,
      lessonId: newerRecord.lessonId,
      phase: 'draft',
      updatedAt: '2024-01-15T10:00:00.000Z',
      result: null,
    });
    const appliedRecord = createTestInteractiveRecord({
      key: 'quiz-2::global',
      interactionId: 'quiz-2',
      lessonId: 'lesson-2',
      updatedAt: '2024-01-15T10:06:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', newerRecord, '3')]);
    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const staleEvent = createTestInteractiveUpdatedEvent({
      eventId: 'stale-event',
      occurredAt: staleRecord.updatedAt,
      payload: { record: staleRecord },
    });
    const appliedEvent = createTestInteractiveUpdatedEvent({
      eventId: 'applied-event',
      occurredAt: appliedRecord.updatedAt,
      payload: { record: appliedRecord },
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: appliedRecord.updatedAt,
        events: [staleEvent, appliedEvent],
      }
    );

    expect(result.isOk()).toBe(true);
    expectSyncEventsSuccess(result._unsafeUnwrap(), {
      newEventsCount: 1,
      appliedEvents: [appliedEvent],
    });
  });

  it('rejects requests larger than the configured batch size', async () => {
    const repo = makeFakeLearningProgressRepo();
    const events = Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, (_, index) =>
      createTestInteractiveUpdatedEvent({
        eventId: `event-${String(index)}`,
        payload: {
          record: createTestInteractiveRecord({
            key: `quiz-${String(index)}::global`,
            interactionId: `quiz-${String(index)}`,
            lessonId: `lesson-${String(index)}`,
          }),
        },
      })
    );

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:00:00.000Z',
        events,
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('TooManyEventsError');
  });

  it('returns database errors from the repository', async () => {
    const repo = makeFakeLearningProgressRepo({ simulateDbError: true });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: '2024-01-15T10:00:00.000Z',
        events: [
          createTestInteractiveUpdatedEvent({
            payload: {
              record: createTestInteractiveRecord(),
            },
          }),
        ],
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('DatabaseError');
  });
});
