import { describe, expect, it } from 'vitest';

import { getProgress } from '@/modules/learning-progress/core/usecases/get-progress.js';

import {
  createTestEvaluatedAuditEvent,
  createTestInteractiveRecord,
  makeFakeLearningProgressRepo,
} from '../../fixtures/fakes.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/core/types.js';

describe('getProgress', () => {
  it('returns an empty snapshot and cursor 0 for users without progress', async () => {
    const repo = makeFakeLearningProgressRepo();

    const result = await getProgress({ repo }, { userId: 'user-1', since: undefined });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      snapshot: {
        version: 1,
        recordsByKey: {},
        lastUpdated: null,
      },
      events: [],
      cursor: '0',
    });
  });

  it('returns snapshot only on cold load', async () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '5',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await getProgress({ repo }, { userId: 'user-1', since: undefined });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      snapshot: {
        version: 1,
        recordsByKey: {
          [record.key]: record,
        },
        lastUpdated: '2024-01-15T10:00:00.000Z',
      },
      events: [],
      cursor: '5',
    });
  });

  it('returns changed rows as synthetic interactive.updated deltas', async () => {
    const recordA = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });
    const recordB = createTestInteractiveRecord({
      key: 'quiz-2::entity:123',
      interactionId: 'quiz-2',
      lessonId: 'lesson-2',
      phase: 'resolved',
      updatedAt: '2024-01-15T11:00:00.000Z',
      result: {
        outcome: 'correct',
        evaluatedAt: '2024-01-15T11:00:00.000Z',
      },
    });
    const evaluatedAudit = {
      ...createTestEvaluatedAuditEvent({
        recordKey: recordB.key,
        lessonId: recordB.lessonId,
        interactionId: recordB.interactionId,
        result: {
          outcome: 'correct',
          evaluatedAt: '2024-01-15T11:00:00.000Z',
        },
      }),
      seq: '7',
      sourceClientEventId: 'event-7',
      sourceClientId: 'device-1',
    };

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: recordA.key,
        record: recordA,
        auditEvents: [],
        updatedSeq: '5',
        createdAt: recordA.updatedAt,
        updatedAt: recordA.updatedAt,
      },
      {
        userId: 'user-1',
        recordKey: recordB.key,
        record: recordB,
        auditEvents: [evaluatedAudit],
        updatedSeq: '7',
        createdAt: recordB.updatedAt,
        updatedAt: recordB.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const result = await getProgress({ repo }, { userId: 'user-1', since: '5' });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.cursor).toBe('7');
    expect(data.events).toEqual([
      {
        eventId: 'server:7:quiz-2::entity:123',
        occurredAt: '2024-01-15T11:00:00.000Z',
        clientId: 'server',
        type: 'interactive.updated',
        payload: {
          record: recordB,
          auditEvents: [
            {
              id: evaluatedAudit.id,
              recordKey: evaluatedAudit.recordKey,
              lessonId: evaluatedAudit.lessonId,
              interactionId: evaluatedAudit.interactionId,
              type: 'evaluated',
              at: evaluatedAudit.at,
              actor: 'system',
              phase: 'resolved',
              result: evaluatedAudit.result,
            },
          ],
        },
      },
    ]);
  });

  it('treats empty string cursor as a cold load', async () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '3',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const result = await getProgress({ repo }, { userId: 'user-1', since: '' });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.events).toEqual([]);
    expect(data.snapshot.recordsByKey[record.key]).toEqual(record);
    expect(data.cursor).toBe('3');
  });

  it('returns all records as deltas when since is 0', async () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '5',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const result = await getProgress({ repo }, { userId: 'user-1', since: '0' });

    expect(result.isOk()).toBe(true);
    const data = result._unsafeUnwrap();
    expect(data.snapshot.recordsByKey[record.key]).toEqual(record);
    expect(data.events).toHaveLength(1);
    expect(data.events[0]?.type).toBe('interactive.updated');
    expect(data.events[0]?.payload.record).toEqual(record);
    expect(data.cursor).toBe('5');
  });

  it('returns an invalid cursor error for non-numeric cursors', async () => {
    const repo = makeFakeLearningProgressRepo();

    const result = await getProgress({ repo }, { userId: 'user-1', since: 'not-a-sequence' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('InvalidEventError');
  });

  it('returns database errors from the repository', async () => {
    const repo = makeFakeLearningProgressRepo({ simulateDbError: true });

    const result = await getProgress({ repo }, { userId: 'user-1', since: undefined });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('DatabaseError');
  });
});
