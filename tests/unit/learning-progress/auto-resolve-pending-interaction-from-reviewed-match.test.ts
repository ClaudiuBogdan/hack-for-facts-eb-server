import { describe, expect, it, vi } from 'vitest';

import {
  AUTO_REVIEW_REUSE_SYSTEM_AUDIT_ADMIN_ID,
  autoResolvePendingInteractionFromReviewedMatch,
} from '@/modules/learning-progress/core/usecases/auto-resolve-pending-interaction-from-reviewed-match.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../../fixtures/fakes.js';

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

function createPendingWebsiteRecord(input?: {
  userId?: string;
  recordKey?: string;
  updatedAt?: string;
  websiteUrl?: string;
}): LearningProgressRecordRow {
  const record = createTestInteractiveRecord({
    key: input?.recordKey ?? 'funky:interaction:city_hall_website::entity:12345678',
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
          websiteUrl: input?.websiteUrl ?? ' https://primarie.test ',
          submittedAt: input?.updatedAt ?? '2026-04-16T10:00:00.000Z',
        },
      },
    },
    result: {
      outcome: null,
      response: {
        reviewStatus: 'pending',
      },
      evaluatedAt: input?.updatedAt ?? '2026-04-16T10:00:00.000Z',
    },
    updatedAt: input?.updatedAt ?? '2026-04-16T10:00:00.000Z',
    submittedAt: input?.updatedAt ?? '2026-04-16T10:00:00.000Z',
  });

  return makeLearningRow(input?.userId ?? 'user-pending', record, '1');
}

function createReviewedWebsiteRecord(input?: {
  userId?: string;
  recordKey?: string;
  updatedAt?: string;
  websiteUrl?: string;
  reviewStatus?: 'approved' | 'rejected';
  reviewSource?: 'campaign_admin_api' | 'auto_review_reuse_match';
  feedbackText?: string;
  reviewedByUserId?: string;
}): LearningProgressRecordRow {
  const reviewStatus = input?.reviewStatus ?? 'approved';
  const phase = reviewStatus === 'approved' ? 'resolved' : 'failed';
  const updatedAt = input?.updatedAt ?? '2026-04-16T09:00:00.000Z';
  const record = createTestInteractiveRecord({
    key: input?.recordKey ?? 'funky:interaction:city_hall_website::entity:12345678',
    interactionId: 'funky:interaction:city_hall_website',
    lessonId: 'civic-monitor-and-request',
    kind: 'custom',
    scope: { type: 'entity', entityCui: '12345678' },
    completionRule: { type: 'resolved' },
    phase,
    value: {
      kind: 'json',
      json: {
        value: {
          websiteUrl: input?.websiteUrl ?? 'https://primarie.test',
          submittedAt: updatedAt,
        },
      },
    },
    result: {
      outcome: null,
      feedbackText: input?.feedbackText ?? null,
      response: {
        approvalRiskAcknowledged: true,
      },
      evaluatedAt: updatedAt,
    },
    review: {
      status: reviewStatus,
      reviewedAt: updatedAt,
      ...(input?.feedbackText !== undefined ? { feedbackText: input.feedbackText } : {}),
      ...(input?.reviewedByUserId !== undefined
        ? { reviewedByUserId: input.reviewedByUserId }
        : {}),
      reviewSource: input?.reviewSource ?? 'campaign_admin_api',
    },
    updatedAt,
    submittedAt: updatedAt,
  });

  return makeLearningRow(
    input?.userId ?? 'user-reviewed',
    record,
    updatedAt === '2026-04-16T09:00:00.000Z' ? '2' : '3'
  );
}

describe('autoResolvePendingInteractionFromReviewedMatch', () => {
  it('reads, locks, re-reads for update, then loads precedent rows', async () => {
    const pendingRow = createPendingWebsiteRecord();
    const precedentRow = createReviewedWebsiteRecord();
    const callOrder: string[] = [];
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [pendingRow.userId, [pendingRow]],
        [precedentRow.userId, [precedentRow]],
      ]),
      onGetRecord() {
        callOrder.push('get_record');
      },
      onAcquireAutoReviewReuseTransactionLock() {
        callOrder.push('lock');
      },
      onGetRecordForUpdate() {
        callOrder.push('get_record_for_update');
      },
      onFindLatestCampaignAdminReviewedExactKeyMatches() {
        callOrder.push('precedent_lookup');
      },
    });

    const result = await autoResolvePendingInteractionFromReviewedMatch(
      { repo },
      {
        userId: pendingRow.userId,
        recordKey: pendingRow.recordKey,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(callOrder.slice(0, 4)).toEqual([
      'get_record',
      'lock',
      'get_record_for_update',
      'precedent_lookup',
    ]);
  });

  it('approves a matching pending record and does not copy human review metadata', async () => {
    const pendingRow = createPendingWebsiteRecord();
    const precedentRow = createReviewedWebsiteRecord({
      feedbackText: 'Human reviewer note',
      reviewedByUserId: 'admin-1',
    });
    const onAutoApproved = vi.fn();
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [pendingRow.userId, [pendingRow]],
        [precedentRow.userId, [precedentRow]],
      ]),
    });

    const result = await autoResolvePendingInteractionFromReviewedMatch(
      {
        repo,
        onAutoApproved,
      },
      {
        userId: pendingRow.userId,
        recordKey: pendingRow.recordKey,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isErr()) {
      return;
    }

    expect(result.value.status).toBe('approved');
    if (result.value.status !== 'approved') {
      return;
    }

    expect(result.value.row.record.phase).toBe('resolved');
    expect(result.value.row.record.review).toEqual({
      status: 'approved',
      reviewedAt: result.value.row.record.updatedAt,
      reviewedByUserId: AUTO_REVIEW_REUSE_SYSTEM_AUDIT_ADMIN_ID,
      reviewSource: 'auto_review_reuse_match',
    });
    expect(result.value.row.record.result?.response).toBeNull();

    const storedRow = (
      await repo.getRecord(pendingRow.userId, pendingRow.recordKey)
    )._unsafeUnwrap();
    expect(storedRow?.record.review?.feedbackText).toBeUndefined();
    expect(storedRow?.record.review?.reviewedByUserId).toBe(
      AUTO_REVIEW_REUSE_SYSTEM_AUDIT_ADMIN_ID
    );
    expect(storedRow?.auditEvents.at(-1)).toEqual(
      expect.objectContaining({
        actor: 'admin',
        actorUserId: AUTO_REVIEW_REUSE_SYSTEM_AUDIT_ADMIN_ID,
        actorSource: 'auto_review_reuse_match',
      })
    );
    expect(onAutoApproved).toHaveBeenCalledWith({
      pendingUserId: pendingRow.userId,
      pendingRecordKey: pendingRow.recordKey,
      sourceUserId: precedentRow.userId,
      sourceRecordKey: precedentRow.recordKey,
      interactionId: pendingRow.record.interactionId,
      entityCui: '12345678',
    });
  });

  it('skips when the latest reviewed precedent is rejected even if an older approval exists', async () => {
    const pendingRow = createPendingWebsiteRecord();
    const olderApprovedRow = createReviewedWebsiteRecord({
      updatedAt: '2026-04-16T08:00:00.000Z',
      websiteUrl: 'https://primarie.test',
    });
    const latestRejectedRow = createReviewedWebsiteRecord({
      updatedAt: '2026-04-16T09:00:00.000Z',
      websiteUrl: 'https://primarie.test',
      reviewStatus: 'rejected',
      feedbackText: 'Rejected by admin',
    });
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [pendingRow.userId, [pendingRow]],
        ['older-admin', [olderApprovedRow]],
        ['latest-admin', [latestRejectedRow]],
      ]),
    });

    const result = await autoResolvePendingInteractionFromReviewedMatch(
      { repo },
      {
        userId: pendingRow.userId,
        recordKey: pendingRow.recordKey,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      status: 'skipped',
      reason: 'precedent_rejected',
    });
    expect(
      (await repo.getRecord(pendingRow.userId, pendingRow.recordKey))._unsafeUnwrap()?.record.phase
    ).toBe('pending');
  });

  it('skips when the latest precedence group has conflicting normalized values', async () => {
    const pendingRow = createPendingWebsiteRecord();
    const firstPrecedent = createReviewedWebsiteRecord({
      userId: 'reviewer-a',
      updatedAt: '2026-04-16T09:00:00.000Z',
      websiteUrl: 'https://primarie.test/a',
    });
    const secondPrecedent = createReviewedWebsiteRecord({
      userId: 'reviewer-b',
      updatedAt: '2026-04-16T09:00:00.000Z',
      websiteUrl: 'https://primarie.test/b',
    });
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [pendingRow.userId, [pendingRow]],
        [firstPrecedent.userId, [firstPrecedent]],
        [secondPrecedent.userId, [secondPrecedent]],
      ]),
    });

    const result = await autoResolvePendingInteractionFromReviewedMatch(
      { repo },
      {
        userId: pendingRow.userId,
        recordKey: pendingRow.recordKey,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      status: 'skipped',
      reason: 'precedent_group_value_conflict',
    });
  });

  it('skips for interactions outside the v1 allowlist', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:public_debate_request::entity:12345678::request-platform',
      interactionId: 'funky:interaction:public_debate_request',
      lessonId: 'civic-monitor-and-request',
      kind: 'custom',
      scope: { type: 'entity', entityCui: '12345678' },
      completionRule: { type: 'resolved' },
      phase: 'pending',
      value: {
        kind: 'json',
        json: {
          value: {
            primariaEmail: 'contact@primarie.test',
            submissionPath: 'request_platform',
            submittedAt: '2026-04-16T10:00:00.000Z',
          },
        },
      },
      updatedAt: '2026-04-16T10:00:00.000Z',
      submittedAt: '2026-04-16T10:00:00.000Z',
    });
    const row = makeLearningRow('user-pending', record, '1');
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([[row.userId, [row]]]),
    });

    const result = await autoResolvePendingInteractionFromReviewedMatch(
      { repo },
      {
        userId: row.userId,
        recordKey: row.recordKey,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      status: 'skipped',
      reason: 'interaction_not_enabled',
    });
  });

  it('does not treat auto-resolved rows as precedent', async () => {
    const pendingRow = createPendingWebsiteRecord();
    const autoReviewedRow = createReviewedWebsiteRecord({
      reviewSource: 'auto_review_reuse_match',
    });
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([
        [pendingRow.userId, [pendingRow]],
        [autoReviewedRow.userId, [autoReviewedRow]],
      ]),
    });

    const result = await autoResolvePendingInteractionFromReviewedMatch(
      { repo },
      {
        userId: pendingRow.userId,
        recordKey: pendingRow.recordKey,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      status: 'skipped',
      reason: 'no_precedent',
    });
  });

  it('skips global-scope rows', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::global',
      interactionId: 'funky:interaction:city_hall_website',
      lessonId: 'civic-monitor-and-request',
      kind: 'custom',
      scope: { type: 'global' },
      completionRule: { type: 'resolved' },
      phase: 'pending',
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://primarie.test',
            submittedAt: '2026-04-16T10:00:00.000Z',
          },
        },
      },
      updatedAt: '2026-04-16T10:00:00.000Z',
      submittedAt: '2026-04-16T10:00:00.000Z',
    });
    const row = makeLearningRow('user-pending', record, '1');
    const repo = makeFakeLearningProgressRepo({
      initialRecords: new Map([[row.userId, [row]]]),
    });

    const result = await autoResolvePendingInteractionFromReviewedMatch(
      { repo },
      {
        userId: row.userId,
        recordKey: row.recordKey,
      }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      status: 'skipped',
      reason: 'unsupported_scope',
    });
  });
});
