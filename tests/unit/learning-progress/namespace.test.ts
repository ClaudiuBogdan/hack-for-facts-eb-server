import { describe, expect, it } from 'vitest';

import { validateRecordKeyPrefix } from '@/modules/learning-progress/core/namespace.js';
import { syncEvents } from '@/modules/learning-progress/core/usecases/sync-events.js';

import {
  createTestInteractiveRecord,
  createTestInteractiveUpdatedEvent,
  createTestSubmittedAuditEvent,
  makeFakeLearningProgressRepo,
} from '../../fixtures/fakes.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/core/types.js';

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

describe('learning progress recordKeyPrefix validation', () => {
  it('accepts arbitrary prefixes with at least 16 characters without format rules', () => {
    const result = validateRecordKeyPrefix('record-prefix-001');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('record-prefix-001');
  });

  it('rejects empty recordKeyPrefix values', () => {
    const result = validateRecordKeyPrefix('', { eventId: 'event-empty-prefix' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      expect.objectContaining({
        type: 'InvalidEventError',
        eventId: 'event-empty-prefix',
        message: 'recordKeyPrefix must not be empty.',
      })
    );
  });

  it('rejects recordKeyPrefix values shorter than 16 characters', () => {
    const result = validateRecordKeyPrefix('short-prefix', { eventId: 'event-short-prefix' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual(
      expect.objectContaining({
        type: 'InvalidEventError',
        eventId: 'event-short-prefix',
        message: 'recordKeyPrefix must be at least 16 characters long.',
      })
    );
  });
});

describe('syncEvents raw key preservation', () => {
  it('supports user-scoped prefix reads with raw string prefixes', async () => {
    const prefixedRecord = createTestInteractiveRecord({
      key: 'record-prefix-001/item-a',
      updatedAt: '2026-03-24T09:00:00.000Z',
    });
    const otherRecord = createTestInteractiveRecord({
      key: 'record-prefixed-001/item-a',
      updatedAt: '2026-03-24T09:05:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      makeRow('user-1', prefixedRecord, '1'),
      makeRow('user-1', otherRecord, '2'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const rows = await repo.getRecords('user-1', {
      recordKeyPrefix: 'record-prefix-001',
    });

    expect(rows.isOk()).toBe(true);
    expect(rows._unsafeUnwrap()).toEqual([
      expect.objectContaining({ recordKey: prefixedRecord.key }),
    ]);
  });

  it('preserves arbitrary incoming keys exactly as provided', async () => {
    const repo = makeFakeLearningProgressRepo();
    const record = createTestInteractiveRecord({
      key: 'legacy-key::global',
      lessonId: 'lesson-1',
      interactionId: 'interaction-1',
      updatedAt: '2026-03-24T10:00:00.000Z',
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'legacy-1',
            payload: {
              record,
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);

    const storedRow = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRow?.recordKey).toBe(record.key);
    expect(storedRow?.record.key).toBe(record.key);
  });

  it('preserves audit event record keys exactly as supplied', async () => {
    const repo = makeFakeLearningProgressRepo();
    const record = createTestInteractiveRecord({
      key: 'legacy-key::global',
      lessonId: 'lesson-1',
      interactionId: 'interaction-1',
      updatedAt: '2026-03-24T10:00:00.000Z',
    });
    const auditEvent = createTestSubmittedAuditEvent({
      recordKey: 'audit-key::legacy',
      lessonId: record.lessonId,
      interactionId: record.interactionId,
    });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: record.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'legacy-audit',
            payload: {
              record,
              auditEvents: [auditEvent],
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);

    const storedRow = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRow?.auditEvents[0]?.recordKey).toBe('audit-key::legacy');
  });
});
