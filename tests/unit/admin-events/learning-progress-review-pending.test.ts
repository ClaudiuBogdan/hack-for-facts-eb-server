import { describe, expect, it, vi } from 'vitest';

import { makeLearningProgressReviewPendingEventDefinition } from '@/modules/admin-events/index.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../../fixtures/index.js';

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

describe('learning_progress.review_pending event definition', () => {
  it('loads context and applies approve or reject outcomes', async () => {
    const pendingRecord = createTestInteractiveRecord({
      key: 'review-me::global',
      phase: 'pending',
      updatedAt: '2026-04-05T10:00:00.000Z',
    });
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([['user-1', [makeRow('user-1', pendingRecord, '1')]]]),
    });
    const prepareApproveReviews = vi.fn(async () => ({
      isOk: () => true,
      isErr: () => false,
      value: null,
    }));
    const definition = makeLearningProgressReviewPendingEventDefinition({
      learningProgressRepo: repo,
      prepareApproveReviews: prepareApproveReviews as never,
    });

    const contextResult = await definition.loadContext({
      userId: 'user-1',
      recordKey: pendingRecord.key,
    });
    expect(contextResult.isOk()).toBe(true);
    if (contextResult.isErr() || contextResult.value === null) {
      return;
    }

    const exportBundle = definition.buildExportBundle({
      jobId: 'job-1',
      payload: {
        userId: 'user-1',
        recordKey: pendingRecord.key,
      },
      context: contextResult.value,
    });

    expect(
      definition.classifyState({
        payload: {
          userId: 'user-1',
          recordKey: pendingRecord.key,
        },
        context: contextResult.value,
        exportBundle: {
          ...exportBundle,
          exportMetadata: {
            exportId: 'export-1',
            exportedAt: '2026-04-05T10:00:10.000Z',
            workspace: '/tmp',
          },
          outcomeSchema: {},
        },
      })
    ).toBe('actionable');

    const approveResult = await definition.applyOutcome({
      payload: {
        userId: 'user-1',
        recordKey: pendingRecord.key,
      },
      context: contextResult.value,
      outcome: {
        decision: 'approve',
      },
    });
    expect(approveResult.isOk()).toBe(true);
    expect(prepareApproveReviews).toHaveBeenCalledTimes(1);

    const approvedContext = await definition.loadContext({
      userId: 'user-1',
      recordKey: pendingRecord.key,
    });
    expect(approvedContext.isOk()).toBe(true);
    if (approvedContext.isErr() || approvedContext.value === null) {
      return;
    }

    expect(
      definition.classifyState({
        payload: {
          userId: 'user-1',
          recordKey: pendingRecord.key,
        },
        context: approvedContext.value,
        outcome: {
          decision: 'approve',
        },
        exportBundle: {
          ...exportBundle,
          exportMetadata: {
            exportId: 'export-1',
            exportedAt: '2026-04-05T10:00:10.000Z',
            workspace: '/tmp',
          },
          outcomeSchema: {},
        },
      })
    ).toBe('already_applied');
  });

  it('detects stale exports and rejects rows with feedback', async () => {
    const staleRecord = createTestInteractiveRecord({
      key: 'review-stale::global',
      phase: 'pending',
      updatedAt: '2026-04-05T10:05:00.000Z',
    });
    const rejectRecord = createTestInteractiveRecord({
      key: 'review-reject::global',
      phase: 'pending',
      updatedAt: '2026-04-05T10:06:00.000Z',
    });
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        ['user-1', [makeRow('user-1', staleRecord, '1'), makeRow('user-1', rejectRecord, '2')]],
      ]),
    });
    const definition = makeLearningProgressReviewPendingEventDefinition({
      learningProgressRepo: repo,
    });

    const staleContext = await definition.loadContext({
      userId: 'user-1',
      recordKey: staleRecord.key,
    });
    expect(staleContext.isOk()).toBe(true);
    if (staleContext.isErr() || staleContext.value === null) {
      return;
    }

    expect(
      definition.classifyState({
        payload: {
          userId: 'user-1',
          recordKey: staleRecord.key,
        },
        context: {
          row: {
            ...staleContext.value.row,
            updatedAt: '2026-04-05T10:07:00.000Z',
          },
        },
        exportBundle: {
          ...definition.buildExportBundle({
            jobId: 'job-stale',
            payload: {
              userId: 'user-1',
              recordKey: staleRecord.key,
            },
            context: staleContext.value,
          }),
          exportMetadata: {
            exportId: 'export-stale',
            exportedAt: '2026-04-05T10:05:10.000Z',
            workspace: '/tmp',
          },
          outcomeSchema: {},
        },
      })
    ).toBe('stale');

    const rejectContext = await definition.loadContext({
      userId: 'user-1',
      recordKey: rejectRecord.key,
    });
    expect(rejectContext.isOk()).toBe(true);
    if (rejectContext.isErr() || rejectContext.value === null) {
      return;
    }

    const rejectResult = await definition.applyOutcome({
      payload: {
        userId: 'user-1',
        recordKey: rejectRecord.key,
      },
      context: rejectContext.value,
      outcome: {
        decision: 'reject',
        feedbackText: 'Needs more evidence.',
      },
    });

    expect(rejectResult.isOk()).toBe(true);

    const updatedContext = await definition.loadContext({
      userId: 'user-1',
      recordKey: rejectRecord.key,
    });
    expect(updatedContext.isOk()).toBe(true);
    if (updatedContext.isErr() || updatedContext.value === null) {
      return;
    }

    expect(updatedContext.value.row.record.phase).toBe('failed');
    expect(updatedContext.value.row.record.review?.status).toBe('rejected');
    expect(updatedContext.value.row.record.review?.feedbackText).toBe('Needs more evidence.');
  });
});
