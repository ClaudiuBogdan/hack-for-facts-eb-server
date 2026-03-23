import { describe, expect, it } from 'vitest';

import {
  MAX_EVENTS_PER_REQUEST,
  type LearningProgressRecordRow,
} from '@/modules/learning-progress/core/types.js';
import { syncEvents } from '@/modules/learning-progress/core/usecases/sync-events.js';

import {
  createTestInteractiveRecord,
  createTestInteractiveUpdatedEvent,
  createTestProgressResetEvent,
  createTestSubmittedAuditEvent,
  makeFakeLearningProgressRepo,
} from '../../fixtures/fakes.js';

describe('syncEvents', () => {
  it('returns success for empty requests', async () => {
    const repo = makeFakeLearningProgressRepo();

    const result = await syncEvents(
      { repo },
      { userId: 'user-1', clientUpdatedAt: '2024-01-15T10:00:00.000Z', events: [] }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ newEventsCount: 0 });
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
    expect(result._unsafeUnwrap()).toEqual({ newEventsCount: 1 });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    expect(storedRecords._unsafeUnwrap()).toHaveLength(1);
    expect(storedRecords._unsafeUnwrap()[0]?.record).toEqual(record);
    expect(storedRecords._unsafeUnwrap()[0]?.auditEvents[0]?.sourceClientEventId).toBe('event-1');
  });

  it('rejects public sync attempts to author record.review', async () => {
    const repo = makeFakeLearningProgressRepo();
    const record = createTestInteractiveRecord({
      key: 'campaign:primarie-website-url::entity:4305857',
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

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      expect.objectContaining({
        type: 'InvalidEventError',
        eventId: 'event-review',
      })
    );
  });

  it('preserves stored review metadata on newer public resubmits', async () => {
    const reviewedRecord = createTestInteractiveRecord({
      key: 'campaign:primarie-website-url::entity:4305857',
      interactionId: 'campaign:primarie-website-url',
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
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: reviewedRecord.key,
        record: reviewedRecord,
        auditEvents: [],
        updatedSeq: '1',
        createdAt: reviewedRecord.updatedAt,
        updatedAt: reviewedRecord.updatedAt,
      },
    ]);

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
    expect(result._unsafeUnwrap()).toEqual({ newEventsCount: 1 });

    const storedRecord = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRecord?.record.value).toEqual(resubmittedRecord.value);
    expect(storedRecord?.record.updatedAt).toBe(resubmittedRecord.updatedAt);
    expect(storedRecord?.record.review).toEqual(reviewedRecord.review);
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
    expect(result._unsafeUnwrap()).toEqual({ newEventsCount: 0 });
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
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: newerRecord.key,
        record: newerRecord,
        auditEvents: [],
        updatedSeq: '3',
        createdAt: newerRecord.updatedAt,
        updatedAt: newerRecord.updatedAt,
      },
    ]);

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
    expect(result._unsafeUnwrap()).toEqual({ newEventsCount: 0 });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    expect(storedRecords._unsafeUnwrap()[0]?.record).toEqual(newerRecord);
  });

  it('resets all rows for a user on progress.reset', async () => {
    const record = createTestInteractiveRecord({ key: 'system:learning-onboarding' });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
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
        clientUpdatedAt: '2024-01-15T10:02:00.000Z',
        events: [createTestProgressResetEvent({ eventId: 'reset-1' })],
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ newEventsCount: 1 });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    expect(storedRecords._unsafeUnwrap()).toEqual([]);
  });

  it('rolls back earlier writes when a later event in the batch fails', async () => {
    const record = createTestInteractiveRecord({ key: 'quiz-1::global' });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '1',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

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

  it('processes reset followed by interactive.updated atomically', async () => {
    const oldRecord = createTestInteractiveRecord({
      key: 'quiz-old::global',
      updatedAt: '2024-01-15T09:00:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: oldRecord.key,
        record: oldRecord,
        auditEvents: [],
        updatedSeq: '1',
        createdAt: oldRecord.updatedAt,
        updatedAt: oldRecord.updatedAt,
      },
    ]);

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
    expect(result._unsafeUnwrap()).toEqual({ newEventsCount: 2 });

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
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: newerRecord.key,
        record: newerRecord,
        auditEvents: [],
        updatedSeq: '3',
        createdAt: newerRecord.updatedAt,
        updatedAt: newerRecord.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const olderRecord = createTestInteractiveRecord({
      key: newerRecord.key,
      interactionId: newerRecord.interactionId,
      lessonId: newerRecord.lessonId,
      phase: 'pending',
      updatedAt: '2024-01-15T10:00:00.000Z',
      result: null,
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
    expect(result._unsafeUnwrap()).toEqual({ newEventsCount: 1 });

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
    expect(result._unsafeUnwrap()).toEqual({ newEventsCount: 2 });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    const rows = storedRecords._unsafeUnwrap();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.recordKey).sort()).toEqual(['quiz-a::global', 'quiz-b::entity:456']);
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
