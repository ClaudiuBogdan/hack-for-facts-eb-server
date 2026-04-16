import { describe, expect, it, vi } from 'vitest';

import { reconcileAutoReviewReuse } from '@/modules/learning-progress/index.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../fixtures/fakes.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/core/types.js';

function makeLearningRow(
  userId: string,
  record: LearningProgressRecordRow['record'],
  updatedSeq: string
): LearningProgressRecordRow {
  return {
    userId,
    recordKey: record.key,
    record,
    auditEvents: [],
    updatedSeq,
    createdAt: record.updatedAt,
    updatedAt: record.updatedAt,
  };
}

function createPendingBudgetDocumentRow(): LearningProgressRecordRow {
  const record = createTestInteractiveRecord({
    key: 'funky:interaction:budget_document::entity:12345678',
    interactionId: 'funky:interaction:budget_document',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    scope: { type: 'entity', entityCui: '12345678' },
    completionRule: { type: 'resolved' },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          documentUrl: ' https://primarie.test/buget.pdf ',
          documentTypes: ['pdf', 'word'],
          submittedAt: '2026-04-16T10:00:00.000Z',
        },
      },
    },
    updatedAt: '2026-04-16T10:00:00.000Z',
    submittedAt: '2026-04-16T10:00:00.000Z',
  });

  return makeLearningRow('user-pending', record, '1');
}

function createApprovedBudgetDocumentRow(): LearningProgressRecordRow {
  const record = createTestInteractiveRecord({
    key: 'funky:interaction:budget_document::entity:12345678',
    interactionId: 'funky:interaction:budget_document',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    scope: { type: 'entity', entityCui: '12345678' },
    completionRule: { type: 'resolved' },
    phase: 'resolved',
    value: {
      kind: 'json',
      json: {
        value: {
          documentUrl: 'https://primarie.test/buget.pdf',
          documentTypes: ['word', 'pdf'],
          submittedAt: '2026-04-16T09:00:00.000Z',
        },
      },
    },
    review: {
      status: 'approved',
      reviewedAt: '2026-04-16T09:00:00.000Z',
      reviewSource: 'campaign_admin_api',
    },
    updatedAt: '2026-04-16T09:00:00.000Z',
    submittedAt: '2026-04-16T09:00:00.000Z',
  });

  return makeLearningRow('user-reviewed', record, '2');
}

describe('reconcileAutoReviewReuse', () => {
  it('approves pending rows missed by the hook and is idempotent on repeat runs', async () => {
    const pendingRow = createPendingBudgetDocumentRow();
    const reviewedRow = createApprovedBudgetDocumentRow();
    const onAutoApproved = vi.fn();
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [pendingRow.userId, [pendingRow]],
        [reviewedRow.userId, [reviewedRow]],
      ]),
    });

    const firstResult = await reconcileAutoReviewReuse(
      {
        repo,
        onAutoApproved,
      },
      {
        batchLimit: 10,
      }
    );

    expect(firstResult.isOk()).toBe(true);
    if (firstResult.isErr()) {
      return;
    }

    expect(firstResult.value).toEqual({
      attempts: 1,
      failures: 0,
      autoApproved: 1,
      skipped: {},
    });
    expect(onAutoApproved).toHaveBeenCalledTimes(1);
    expect(
      (await repo.getRecord(pendingRow.userId, pendingRow.recordKey))._unsafeUnwrap()?.record.phase
    ).toBe('resolved');

    const secondResult = await reconcileAutoReviewReuse(
      {
        repo,
        onAutoApproved,
      },
      {
        batchLimit: 10,
      }
    );

    expect(secondResult.isOk()).toBe(true);
    expect(secondResult._unsafeUnwrap()).toEqual({
      attempts: 0,
      failures: 0,
      autoApproved: 0,
      skipped: {},
    });
    expect(onAutoApproved).toHaveBeenCalledTimes(1);
  });
});
