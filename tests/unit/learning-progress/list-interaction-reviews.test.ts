import { describe, expect, it } from 'vitest';

import { listInteractionReviews } from '@/modules/learning-progress/core/usecases/list-interaction-reviews.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../../fixtures/fakes.js';

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

describe('listInteractionReviews', () => {
  it('returns only pending rows when the pending queue is requested', async () => {
    const pendingNewest = createTestInteractiveRecord({
      key: 'pending-newest::global',
      phase: 'pending',
      interactionId: 'review-target',
      updatedAt: '2026-03-23T20:10:00.000Z',
    });
    const pendingOlder = createTestInteractiveRecord({
      key: 'pending-older::global',
      phase: 'pending',
      interactionId: 'review-target',
      updatedAt: '2026-03-23T20:05:00.000Z',
    });
    const approved = createTestInteractiveRecord({
      key: 'approved::global',
      phase: 'resolved',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T20:06:00.000Z',
      },
      updatedAt: '2026-03-23T20:06:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      makeRow('user-1', pendingOlder, '1'),
      makeRow('user-1', approved, '2'),
      makeRow('user-1', pendingNewest, '3'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await listInteractionReviews(
      { repo },
      {
        status: 'pending',
        interactionId: 'review-target',
        limit: 10,
        offset: 0,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      rows: [
        expect.objectContaining({ recordKey: pendingNewest.key }),
        expect.objectContaining({ recordKey: pendingOlder.key }),
      ],
      hasMore: false,
    });
  });

  it('uses record.review.status for approved and rejected queues', async () => {
    const approved = createTestInteractiveRecord({
      key: 'approved::global',
      phase: 'resolved',
      lessonId: 'lesson-review',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T20:06:00.000Z',
      },
      updatedAt: '2026-03-23T20:06:00.000Z',
    });
    const rejected = createTestInteractiveRecord({
      key: 'rejected::global',
      phase: 'failed',
      lessonId: 'lesson-review',
      review: {
        status: 'rejected',
        reviewedAt: '2026-03-23T20:07:00.000Z',
        feedbackText: 'Invalid evidence',
      },
      updatedAt: '2026-03-23T20:07:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      makeRow('user-1', approved, '1'),
      makeRow('user-1', rejected, '2'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const approvedResult = await listInteractionReviews(
      { repo },
      {
        status: 'approved',
        lessonId: 'lesson-review',
        limit: 10,
        offset: 0,
      }
    );
    const rejectedResult = await listInteractionReviews(
      { repo },
      {
        status: 'rejected',
        lessonId: 'lesson-review',
        limit: 10,
        offset: 0,
      }
    );

    expect(approvedResult.isOk()).toBe(true);
    expect(approvedResult._unsafeUnwrap().rows).toEqual([
      expect.objectContaining({ recordKey: approved.key }),
    ]);

    expect(rejectedResult.isOk()).toBe(true);
    expect(rejectedResult._unsafeUnwrap().rows).toEqual([
      expect.objectContaining({ recordKey: rejected.key }),
    ]);
  });

  it('filters rows by raw recordKeyPrefix starts-with matches', async () => {
    const lessonOneRecord = createTestInteractiveRecord({
      key: 'record-prefix-001/item-a',
      lessonId: 'lesson-1',
      interactionId: 'review-target',
      phase: 'pending',
      updatedAt: '2026-03-23T20:10:00.000Z',
    });
    const lessonTenRecord = createTestInteractiveRecord({
      key: 'record-prefixed-001/item-a',
      lessonId: 'lesson-10',
      interactionId: 'review-target',
      phase: 'pending',
      updatedAt: '2026-03-23T20:09:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      makeRow('user-1', lessonOneRecord, '1'),
      makeRow('user-1', lessonTenRecord, '2'),
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await listInteractionReviews(
      { repo },
      {
        status: 'pending',
        recordKeyPrefix: 'record-prefix-001',
        limit: 10,
        offset: 0,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      rows: [expect.objectContaining({ recordKey: lessonOneRecord.key })],
      hasMore: false,
    });
  });
});
