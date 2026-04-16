import { err } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { createLearningProgressAutoReviewReuseHook } from '@/modules/learning-progress/shell/auto-review-reuse-hook.js';

import {
  createTestInteractiveRecord,
  createTestInteractiveUpdatedEvent,
  createTestProgressResetEvent,
  makeFakeLearningProgressRepo,
} from '../../fixtures/fakes.js';

import type { LearningProgressRepository } from '@/modules/learning-progress/core/ports.js';
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

function createLoggerSpy() {
  const logger = {
    child: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };

  logger.child.mockReturnValue(logger);
  return logger;
}

function createPendingWebsiteRow(): LearningProgressRecordRow {
  const record = createTestInteractiveRecord({
    key: 'funky:interaction:city_hall_website::entity:12345678',
    interactionId: 'funky:interaction:city_hall_website',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    scope: { type: 'entity', entityCui: '12345678' },
    completionRule: { type: 'resolved' },
    phase: 'pending',
    value: {
      kind: 'json',
      json: {
        value: {
          websiteUrl: ' https://primarie.test ',
          submittedAt: '2026-04-16T10:00:00.000Z',
        },
      },
    },
    updatedAt: '2026-04-16T10:00:00.000Z',
    submittedAt: '2026-04-16T10:00:00.000Z',
  });

  return makeLearningRow('user-1', record, '1');
}

function createApprovedWebsiteRow(): LearningProgressRecordRow {
  const record = createTestInteractiveRecord({
    key: 'funky:interaction:city_hall_website::entity:12345678',
    interactionId: 'funky:interaction:city_hall_website',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    scope: { type: 'entity', entityCui: '12345678' },
    completionRule: { type: 'resolved' },
    phase: 'resolved',
    value: {
      kind: 'json',
      json: {
        value: {
          websiteUrl: 'https://primarie.test',
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

describe('createLearningProgressAutoReviewReuseHook', () => {
  it('auto-approves matching pending interactive.updated events and logs a summary', async () => {
    const pendingRow = createPendingWebsiteRow();
    const approvedRow = createApprovedWebsiteRow();
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [pendingRow.userId, [pendingRow]],
        [approvedRow.userId, [approvedRow]],
      ]),
    });
    const logger = createLoggerSpy();
    const hook = createLearningProgressAutoReviewReuseHook({
      repo,
      logger: logger as never,
    });

    await hook({
      userId: pendingRow.userId,
      events: [
        createTestInteractiveUpdatedEvent({
          payload: {
            record: pendingRow.record,
          },
        }),
      ],
    });

    expect(
      (await repo.getRecord(pendingRow.userId, pendingRow.recordKey))._unsafeUnwrap()?.record.phase
    ).toBe('resolved');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingUserId: pendingRow.userId,
        pendingRecordKey: pendingRow.recordKey,
        sourceUserId: approvedRow.userId,
        sourceRecordKey: approvedRow.recordKey,
      }),
      'Auto-resolved pending interaction from reviewed match'
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: pendingRow.userId,
        eventCount: 1,
        attempts: 1,
        failures: 0,
        autoApproved: 1,
        skipped: {},
      }),
      'Learning progress auto-review reuse hook completed'
    );
  });

  it('ignores non-pending and non-interactive.updated events', async () => {
    const logger = createLoggerSpy();
    const hook = createLearningProgressAutoReviewReuseHook({
      repo: makeFakeLearningProgressRepo(),
      logger: logger as never,
    });
    const resolvedRecord = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:12345678',
      interactionId: 'funky:interaction:city_hall_website',
      phase: 'resolved',
      updatedAt: '2026-04-16T10:00:00.000Z',
    });

    await hook({
      userId: 'user-1',
      events: [
        createTestProgressResetEvent(),
        createTestInteractiveUpdatedEvent({
          payload: {
            record: resolvedRecord,
          },
        }),
      ],
    });

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        eventCount: 2,
        attempts: 0,
        failures: 0,
        autoApproved: 0,
        skipped: {},
      }),
      'Learning progress auto-review reuse hook completed'
    );
  });

  it('logs failures and continues processing later events', async () => {
    const pendingRow = createPendingWebsiteRow();
    const approvedRow = createApprovedWebsiteRow();
    const baseRepo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [pendingRow.userId, [pendingRow]],
        [approvedRow.userId, [approvedRow]],
      ]),
    });
    let transactionCalls = 0;
    const repo: LearningProgressRepository = {
      ...baseRepo,
      async withTransaction(callback) {
        transactionCalls += 1;
        if (transactionCalls === 1) {
          return err({
            type: 'DatabaseError',
            message: 'Simulated failure',
            retryable: true,
          });
        }

        return baseRepo.withTransaction(callback);
      },
    };
    const logger = createLoggerSpy();
    const hook = createLearningProgressAutoReviewReuseHook({
      repo,
      logger: logger as never,
    });

    await hook({
      userId: pendingRow.userId,
      events: [
        createTestInteractiveUpdatedEvent({
          payload: {
            record: pendingRow.record,
          },
        }),
        createTestInteractiveUpdatedEvent({
          payload: {
            record: pendingRow.record,
          },
        }),
      ],
    });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: pendingRow.userId,
        recordKey: pendingRow.recordKey,
        interactionId: pendingRow.record.interactionId,
      }),
      'Learning progress auto-review reuse failed'
    );
    expect(
      (await baseRepo.getRecord(pendingRow.userId, pendingRow.recordKey))._unsafeUnwrap()?.record
        .phase
    ).toBe('resolved');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: pendingRow.userId,
        eventCount: 2,
        attempts: 2,
        failures: 1,
        autoApproved: 1,
      }),
      'Learning progress auto-review reuse hook completed'
    );
  });
});
