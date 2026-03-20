import { describe, expect, it } from 'vitest';

import {
  buildDeltaEventsFromRecords,
  buildSnapshotFromRecords,
  createEmptySnapshot,
  getLatestCursor,
} from '@/modules/learning-progress/core/reducer.js';

import {
  createTestEvaluatedAuditEvent,
  createTestInteractiveRecord,
  createTestSubmittedAuditEvent,
} from '../../fixtures/fakes.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/core/types.js';

describe('learning progress reducer helpers', () => {
  it('creates an empty generic snapshot', () => {
    expect(createEmptySnapshot()).toEqual({
      version: 1,
      recordsByKey: {},
      lastUpdated: null,
    });
  });

  it('builds a snapshot from stored records', () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T10:00:00.000Z',
    });

    const rows: LearningProgressRecordRow[] = [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '3',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ];

    expect(buildSnapshotFromRecords(rows)).toEqual({
      version: 1,
      recordsByKey: {
        [record.key]: record,
      },
      lastUpdated: '2024-01-15T10:00:00.000Z',
    });
  });

  it('builds delta events using row sequence and filtered audit events', () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::entity:123',
      updatedAt: '2024-01-15T11:00:00.000Z',
      phase: 'resolved',
      result: {
        outcome: 'correct',
        evaluatedAt: '2024-01-15T11:00:00.000Z',
      },
    });
    const submittedAudit = {
      ...createTestSubmittedAuditEvent({
        recordKey: record.key,
        lessonId: record.lessonId,
        interactionId: record.interactionId,
      }),
      seq: '2',
      sourceClientEventId: 'event-1',
      sourceClientId: 'device-1',
    };
    const evaluatedAudit = {
      ...createTestEvaluatedAuditEvent({
        recordKey: record.key,
        lessonId: record.lessonId,
        interactionId: record.interactionId,
        result: {
          outcome: 'correct',
          evaluatedAt: '2024-01-15T11:00:00.000Z',
        },
      }),
      seq: '4',
      sourceClientEventId: 'event-2',
      sourceClientId: 'device-1',
    };

    const rows: LearningProgressRecordRow[] = [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [submittedAudit, evaluatedAudit],
        updatedSeq: '4',
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: record.updatedAt,
      },
    ];

    expect(buildDeltaEventsFromRecords(rows, '3')).toEqual([
      {
        eventId: 'server:4:quiz-1::entity:123',
        occurredAt: '2024-01-15T11:00:00.000Z',
        clientId: 'server',
        type: 'interactive.updated',
        payload: {
          record,
          auditEvents: [
            {
              id: evaluatedAudit.id,
              recordKey: evaluatedAudit.recordKey,
              lessonId: evaluatedAudit.lessonId,
              interactionId: evaluatedAudit.interactionId,
              type: 'evaluated',
              at: evaluatedAudit.at,
              actor: 'system',
              phase: evaluatedAudit.phase,
              result: evaluatedAudit.result,
            },
          ],
        },
      },
    ]);
  });

  it('builds a snapshot from multiple records and picks the latest updatedAt', () => {
    const recordA = createTestInteractiveRecord({
      key: 'quiz-a::global',
      updatedAt: '2024-01-15T08:00:00.000Z',
    });
    const recordB = createTestInteractiveRecord({
      key: 'quiz-b::entity:123',
      interactionId: 'quiz-b',
      lessonId: 'lesson-b',
      updatedAt: '2024-01-15T11:00:00.000Z',
    });
    const recordC = createTestInteractiveRecord({
      key: 'quiz-c::global',
      interactionId: 'quiz-c',
      lessonId: 'lesson-c',
      updatedAt: '2024-01-15T09:00:00.000Z',
    });

    const rows: LearningProgressRecordRow[] = [
      {
        userId: 'user-1',
        recordKey: recordA.key,
        record: recordA,
        auditEvents: [],
        updatedSeq: '2',
        createdAt: recordA.updatedAt,
        updatedAt: recordA.updatedAt,
      },
      {
        userId: 'user-1',
        recordKey: recordC.key,
        record: recordC,
        auditEvents: [],
        updatedSeq: '5',
        createdAt: recordC.updatedAt,
        updatedAt: recordC.updatedAt,
      },
      {
        userId: 'user-1',
        recordKey: recordB.key,
        record: recordB,
        auditEvents: [],
        updatedSeq: '10',
        createdAt: recordB.updatedAt,
        updatedAt: recordB.updatedAt,
      },
    ];

    const snapshot = buildSnapshotFromRecords(rows);
    expect(snapshot.version).toBe(1);
    expect(Object.keys(snapshot.recordsByKey)).toHaveLength(3);
    expect(snapshot.recordsByKey[recordA.key]).toEqual(recordA);
    expect(snapshot.recordsByKey[recordB.key]).toEqual(recordB);
    expect(snapshot.recordsByKey[recordC.key]).toEqual(recordC);
    expect(snapshot.lastUpdated).toBe('2024-01-15T11:00:00.000Z');
  });

  it('excludes rows and audit events at the since boundary from delta events', () => {
    const record = createTestInteractiveRecord({
      key: 'quiz-1::global',
      updatedAt: '2024-01-15T11:00:00.000Z',
    });
    const atBoundaryAudit = {
      ...createTestSubmittedAuditEvent({
        id: 'audit-at-boundary',
        recordKey: record.key,
        lessonId: record.lessonId,
        interactionId: record.interactionId,
      }),
      seq: '5',
      sourceClientEventId: 'event-old',
      sourceClientId: 'device-1',
    };
    const afterBoundaryAudit = {
      ...createTestEvaluatedAuditEvent({
        id: 'audit-after-boundary',
        recordKey: record.key,
        lessonId: record.lessonId,
        interactionId: record.interactionId,
      }),
      seq: '8',
      sourceClientEventId: 'event-new',
      sourceClientId: 'device-1',
    };

    const rowAtBoundary: LearningProgressRecordRow = {
      userId: 'user-1',
      recordKey: 'at-boundary',
      record: createTestInteractiveRecord({
        key: 'at-boundary',
        updatedAt: '2024-01-15T09:00:00.000Z',
      }),
      auditEvents: [],
      updatedSeq: '5',
      createdAt: '2024-01-15T09:00:00.000Z',
      updatedAt: '2024-01-15T09:00:00.000Z',
    };
    const rowAfterBoundary: LearningProgressRecordRow = {
      userId: 'user-1',
      recordKey: record.key,
      record,
      auditEvents: [atBoundaryAudit, afterBoundaryAudit],
      updatedSeq: '8',
      createdAt: '2024-01-15T10:00:00.000Z',
      updatedAt: record.updatedAt,
    };

    const deltas = buildDeltaEventsFromRecords([rowAtBoundary, rowAfterBoundary], '5');

    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.eventId).toBe(`server:8:${record.key}`);
    const auditEvents = deltas[0]?.payload.auditEvents;
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents?.[0]?.id).toBe('audit-after-boundary');
  });

  it('returns 0 for getLatestCursor with an empty array', () => {
    expect(getLatestCursor([])).toBe('0');
  });

  it('returns the latest cursor from the max row sequence', () => {
    const rows: LearningProgressRecordRow[] = [
      {
        userId: 'user-1',
        recordKey: 'record-a',
        record: createTestInteractiveRecord({ key: 'record-a' }),
        auditEvents: [],
        updatedSeq: '9',
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
      {
        userId: 'user-1',
        recordKey: 'record-b',
        record: createTestInteractiveRecord({ key: 'record-b' }),
        auditEvents: [],
        updatedSeq: '12',
        createdAt: '2024-01-15T11:00:00.000Z',
        updatedAt: '2024-01-15T11:00:00.000Z',
      },
    ];

    expect(getLatestCursor(rows)).toBe('12');
  });
});
