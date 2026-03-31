import { describe, expect, it } from 'vitest';

import { buildDeltaEventsFromRecords } from '@/modules/learning-progress/core/reducer.js';
import {
  normalizePublicInteractiveRecord,
  syncEvents,
} from '@/modules/learning-progress/core/usecases/sync-events.js';

import {
  createTestInteractiveUpdatedEvent,
  makeFakeLearningProgressRepo,
} from '../../fixtures/fakes.js';

import type {
  InteractiveStateRecord,
  LearningProgressRecordRow,
} from '@/modules/learning-progress/core/types.js';

function createRecord(overrides: Partial<InteractiveStateRecord> = {}): InteractiveStateRecord {
  return {
    key: 'custom-submit::global',
    interactionId: 'custom-submit',
    lessonId: 'lesson-1',
    kind: 'custom',
    scope: { type: 'global' },
    completionRule: { type: 'resolved' },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          websiteUrl: 'https://example.com',
        },
      },
    },
    result: null,
    updatedAt: '2024-01-01T10:00:00.000Z',
    submittedAt: '2024-01-01T10:00:00.000Z',
    ...overrides,
  };
}

function createRow(
  record: InteractiveStateRecord,
  overrides: Partial<LearningProgressRecordRow> = {}
): LearningProgressRecordRow {
  return {
    userId: 'user-1',
    recordKey: record.key,
    record,
    auditEvents: [],
    updatedSeq: '1',
    createdAt: '2024-01-01T10:00:00.000Z',
    updatedAt: record.updatedAt,
    ...overrides,
  };
}

function createStoredRecordWithSourceUrl(sourceUrl: string): InteractiveStateRecord {
  const record = createRecord({ sourceUrl });
  const { updatedAt, submittedAt, ...recordWithoutDates } = record;

  return {
    ...recordWithoutDates,
    sourceUrl,
    updatedAt,
    ...(submittedAt === undefined ? {} : { submittedAt }),
  };
}

describe('normalizePublicInteractiveRecord sourceUrl handling', () => {
  it('accepts a valid absolute sourceUrl', () => {
    const result = normalizePublicInteractiveRecord({
      incomingRecord: createRecord({
        sourceUrl:
          'https://transparenta.eu/ro/learning/path/module/lesson-1?section=submit#custom-submit',
      }),
      storedRow: null,
      eventId: 'evt-1',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.sourceUrl).toBe(
        'https://transparenta.eu/ro/learning/path/module/lesson-1?section=submit#custom-submit'
      );
    }
  });

  it('preserves the stored sourceUrl when the incoming record omits it', () => {
    const storedRow = createRow(
      createRecord({
        sourceUrl: 'https://transparenta.eu/ro/learning/path/module/lesson-1',
      })
    );

    const result = normalizePublicInteractiveRecord({
      incomingRecord: createRecord({
        updatedAt: '2024-01-02T10:00:00.000Z',
        submittedAt: '2024-01-02T10:00:00.000Z',
      }),
      storedRow,
      eventId: 'evt-2',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.sourceUrl).toBe(
        'https://transparenta.eu/ro/learning/path/module/lesson-1'
      );
    }
  });

  it('replaces the stored sourceUrl when a newer record provides a new one', () => {
    const storedRow = createRow(
      createRecord({
        sourceUrl: 'https://transparenta.eu/ro/learning/path/module/lesson-1',
      })
    );

    const result = normalizePublicInteractiveRecord({
      incomingRecord: createRecord({
        updatedAt: '2024-01-02T10:00:00.000Z',
        submittedAt: '2024-01-02T10:00:00.000Z',
        sourceUrl:
          'https://transparenta.eu/ro/primarie/123/buget/provocari/modul/provocare/pas?section=quiz#dynamic-quiz',
      }),
      storedRow,
      eventId: 'evt-3',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.sourceUrl).toBe(
        'https://transparenta.eu/ro/primarie/123/buget/provocari/modul/provocare/pas?section=quiz#dynamic-quiz'
      );
    }
  });

  it('keeps records without sourceUrl valid', () => {
    const result = normalizePublicInteractiveRecord({
      incomingRecord: createRecord(),
      storedRow: null,
      eventId: 'evt-4',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.sourceUrl).toBeUndefined();
    }
  });

  it('rejects invalid sourceUrl values', () => {
    const result = normalizePublicInteractiveRecord({
      incomingRecord: createRecord({
        sourceUrl: '/relative/path',
      }),
      storedRow: null,
      eventId: 'evt-5',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('valid absolute sourceUrl');
    }
  });
});

describe('buildDeltaEventsFromRecords sourceUrl handling', () => {
  it('includes sourceUrl in interactive.updated payloads', () => {
    const events = buildDeltaEventsFromRecords(
      [
        createRow(
          createRecord({
            sourceUrl:
              'https://transparenta.eu/ro/learning/path/module/lesson-1?section=submit#custom-submit',
          })
        ),
      ],
      '0'
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.payload.record.sourceUrl).toBe(
      'https://transparenta.eu/ro/learning/path/module/lesson-1?section=submit#custom-submit'
    );
  });
});

describe('syncEvents sourceUrl handling', () => {
  it('deduplicates legacy round-trips that omit a stored sourceUrl', async () => {
    const storedRecord = createStoredRecordWithSourceUrl(
      'https://transparenta.eu/ro/learning/path/module/lesson-1?section=submit#custom-submit'
    );
    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [createRow(storedRecord)]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await syncEvents(
      { repo },
      {
        userId: 'user-1',
        clientUpdatedAt: storedRecord.updatedAt,
        events: [
          createTestInteractiveUpdatedEvent({
            eventId: 'evt-legacy-roundtrip',
            occurredAt: storedRecord.updatedAt,
            payload: {
              record: createRecord(),
            },
          }),
        ],
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      newEventsCount: 0,
      failedEvents: [],
      appliedEvents: [],
    });

    const storedRecords = await repo.getRecords('user-1');
    expect(storedRecords.isOk()).toBe(true);
    expect(storedRecords._unsafeUnwrap()[0]).toEqual(
      expect.objectContaining({
        updatedSeq: '1',
        record: storedRecord,
      })
    );
  });
});
