import { describe, expect, it } from 'vitest';

import { submitInteractionReviews } from '@/modules/learning-progress/core/usecases/submit-interaction-reviews.js';

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

describe('submitInteractionReviews', () => {
  it('rejects duplicate decisions in the same request', async () => {
    const repo = makeFakeLearningProgressRepo();

    const result = await submitInteractionReviews(
      { repo },
      {
        items: [
          {
            userId: 'user-1',
            recordKey: 'record-1',
            expectedUpdatedAt: '2026-03-23T20:00:00.000Z',
            status: 'approved',
          },
          {
            userId: 'user-1',
            recordKey: 'record-1',
            expectedUpdatedAt: '2026-03-23T20:00:00.000Z',
            status: 'rejected',
            feedbackText: 'Duplicate decision',
          },
        ],
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'InvalidEventError',
      message: 'Duplicate review decision for user "user-1" and record "record-1".',
      eventId: undefined,
    });
  });

  it('rolls back the full batch when any item is invalid', async () => {
    const pendingRecord = createTestInteractiveRecord({
      key: 'pending-record::global',
      phase: 'pending',
      updatedAt: '2026-03-23T20:00:00.000Z',
    });
    const resolvedRecord = createTestInteractiveRecord({
      key: 'resolved-record::global',
      phase: 'resolved',
      updatedAt: '2026-03-23T20:01:00.000Z',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T20:01:00.000Z',
      },
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [makeRow('user-1', pendingRecord, '1')]);
    initialRecords.set('user-2', [makeRow('user-2', resolvedRecord, '2')]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await submitInteractionReviews(
      { repo },
      {
        items: [
          {
            userId: 'user-1',
            recordKey: pendingRecord.key,
            expectedUpdatedAt: pendingRecord.updatedAt,
            status: 'approved',
          },
          {
            userId: 'user-2',
            recordKey: resolvedRecord.key,
            expectedUpdatedAt: resolvedRecord.updatedAt,
            status: 'approved',
          },
        ],
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'ConflictError',
      message: `Interaction record "${resolvedRecord.key}" is no longer reviewable because it is not pending.`,
    });

    const user1Rows = (await repo.getRecords('user-1'))._unsafeUnwrap();
    const user2Rows = (await repo.getRecords('user-2'))._unsafeUnwrap();

    expect(user1Rows[0]?.record.phase).toBe('pending');
    expect(user1Rows[0]?.record.review).toBeUndefined();
    expect(user2Rows[0]?.record.phase).toBe('resolved');
    expect(user2Rows[0]?.record.review?.status).toBe('approved');
  });
});
