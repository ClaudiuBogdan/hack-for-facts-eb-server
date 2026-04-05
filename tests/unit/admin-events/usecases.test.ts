import { describe, expect, it } from 'vitest';

import {
  INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
  LEARNING_PROGRESS_REVIEW_PENDING_EVENT_TYPE,
  makeAdminEventRegistry,
  makeInstitutionCorrespondenceReplyReviewPendingEventDefinition,
  makeLearningProgressReviewPendingEventDefinition,
  queueAdminEvent,
  scanAndQueueAdminEvents,
} from '@/modules/admin-events/index.js';

import {
  createTestInteractiveRecord,
  makeFakeLearningProgressRepo,
  makeInMemoryAdminEventQueue,
} from '../../fixtures/index.js';
import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from '../institution-correspondence/fake-repo.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/index.js';

const makeRow = (
  userId: string,
  record: LearningProgressRecordRow['record'],
  updatedSeq: string
): LearningProgressRecordRow => ({
  userId,
  recordKey: record.key,
  record,
  auditEvents: [],
  updatedSeq,
  createdAt: record.updatedAt,
  updatedAt: record.updatedAt,
});

describe('admin event queue use cases', () => {
  it('validates payloads before enqueueing and uses deterministic job ids', async () => {
    const pendingRecord = createTestInteractiveRecord({
      key: 'review-target::global',
      phase: 'pending',
      updatedAt: '2026-04-05T09:00:00.000Z',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeRow('user-1', pendingRecord, '1')]]]),
    });
    const correspondenceRepo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          phase: 'reply_received_unreviewed',
          record: createThreadAggregateRecord({
            correspondence: [
              createCorrespondenceEntry({
                id: 'reply-1',
                direction: 'inbound',
                source: 'institution_reply',
              }),
            ],
          }),
        }),
      ],
    });
    const registry = makeAdminEventRegistry([
      makeLearningProgressReviewPendingEventDefinition({
        learningProgressRepo,
      }),
      makeInstitutionCorrespondenceReplyReviewPendingEventDefinition({
        repo: correspondenceRepo,
      }),
    ]);
    const queue = makeInMemoryAdminEventQueue();

    const learningProgressResult = await queueAdminEvent(
      { registry, queue },
      {
        eventType: LEARNING_PROGRESS_REVIEW_PENDING_EVENT_TYPE,
        payload: {
          userId: 'user-1',
          recordKey: pendingRecord.key,
        },
      }
    );

    expect(learningProgressResult.isOk()).toBe(true);
    if (learningProgressResult.isOk()) {
      expect(learningProgressResult.value.jobId).toBe(
        'learning_progress.review_pending:user-1:review-target::global'
      );
    }

    const correspondenceResult = await queueAdminEvent(
      { registry, queue },
      {
        eventType: INSTITUTION_CORRESPONDENCE_REPLY_REVIEW_PENDING_EVENT_TYPE,
        payload: {
          threadId: 'thread-1',
          basedOnEntryId: 'reply-1',
        },
      }
    );

    expect(correspondenceResult.isOk()).toBe(true);
    if (correspondenceResult.isOk()) {
      expect(correspondenceResult.value.jobId).toBe(
        'institution_correspondence.reply_review_pending:thread-1:reply-1'
      );
    }

    const invalidResult = await queueAdminEvent(
      { registry, queue },
      {
        eventType: LEARNING_PROGRESS_REVIEW_PENDING_EVENT_TYPE,
        payload: {
          userId: 'user-1',
        },
      }
    );

    expect(invalidResult.isErr()).toBe(true);
    if (invalidResult.isErr()) {
      expect(invalidResult.error.type).toBe('AdminEventValidationError');
    }
  });

  it('re-scans pending rows without creating duplicate jobs', async () => {
    const pendingRecord = createTestInteractiveRecord({
      key: 'review-repeat::global',
      phase: 'pending',
      updatedAt: '2026-04-05T09:05:00.000Z',
    });
    const learningProgressRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeRow('user-1', pendingRecord, '1')]]]),
    });
    const registry = makeAdminEventRegistry([
      makeLearningProgressReviewPendingEventDefinition({
        learningProgressRepo,
      }),
    ]);
    const queue = makeInMemoryAdminEventQueue();

    const firstScan = await scanAndQueueAdminEvents({ registry, queue });
    expect(firstScan.isOk()).toBe(true);

    const secondScan = await scanAndQueueAdminEvents({ registry, queue });
    expect(secondScan.isOk()).toBe(true);
    expect(queue.snapshot()).toHaveLength(1);
    expect(queue.snapshot()[0]?.jobId).toBe(
      'learning_progress.review_pending:user-1:review-repeat::global'
    );
  });
});
