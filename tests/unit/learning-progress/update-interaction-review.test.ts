import { describe, expect, it, vi } from 'vitest';

import { updateInteractionReview } from '@/modules/learning-progress/core/usecases/update-interaction-review.js';

import { createTestInteractiveRecord, makeFakeLearningProgressRepo } from '../../fixtures/fakes.js';

import type { LearningProgressRecordRow } from '@/modules/learning-progress/core/types.js';

describe('updateInteractionReview', () => {
  it('reads, locks, then re-reads for update on entity-scoped reviews', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      interactionId: 'funky:interaction:city_hall_website',
      phase: 'pending',
      scope: { type: 'entity', entityCui: '4305857' },
      updatedAt: '2026-03-23T19:27:40.527Z',
      submittedAt: '2026-03-23T19:27:40.527Z',
    });
    const callOrder: string[] = [];
    const lockInputs: { recordKey: string }[] = [];

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '1',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({
      initialRecords,
      onGetRecord() {
        callOrder.push('get_record');
      },
      onAcquireAutoReviewReuseTransactionLock(input) {
        callOrder.push('lock');
        lockInputs.push(input);
      },
      onGetRecordForUpdate() {
        callOrder.push('get_record_for_update');
      },
    });

    const result = await updateInteractionReview(
      { repo },
      {
        userId: 'user-1',
        recordKey: record.key,
        expectedUpdatedAt: record.updatedAt,
        status: 'approved',
      }
    );

    expect(result.isOk()).toBe(true);
    expect(callOrder.slice(0, 3)).toEqual(['get_record', 'lock', 'get_record_for_update']);
    expect(lockInputs).toEqual([{ recordKey: record.key }]);
  });

  it('keeps the advisory lock boundary narrow by skipping global-scoped reviews', async () => {
    const record = createTestInteractiveRecord({
      key: 'lesson:introduction::global',
      interactionId: 'lesson:introduction',
      phase: 'pending',
      scope: { type: 'global' },
      updatedAt: '2026-03-23T19:27:40.527Z',
      submittedAt: '2026-03-23T19:27:40.527Z',
    });
    const callOrder: string[] = [];

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '1',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({
      initialRecords,
      onGetRecord() {
        callOrder.push('get_record');
      },
      onAcquireAutoReviewReuseTransactionLock() {
        callOrder.push('lock');
      },
      onGetRecordForUpdate() {
        callOrder.push('get_record_for_update');
      },
    });

    const result = await updateInteractionReview(
      { repo },
      {
        userId: 'user-1',
        recordKey: record.key,
        expectedUpdatedAt: record.updatedAt,
        status: 'approved',
      }
    );

    expect(result.isOk()).toBe(true);
    expect(callOrder).toEqual(['get_record', 'get_record_for_update']);
  });

  it('approves a pending record, updates sync timestamps, and appends an audit event', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      phase: 'pending',
      scope: { type: 'entity', entityCui: '4305857' },
      completionRule: { type: 'resolved' },
      value: {
        kind: 'json',
        json: {
          value: {
            websiteUrl: 'https://example.com',
            submittedAt: '2026-03-23T19:27:40.526Z',
          },
        },
      },
      result: {
        outcome: null,
        response: {
          reviewStatus: 'pending',
        },
        evaluatedAt: '2026-03-23T19:27:40.527Z',
      },
      updatedAt: '2026-03-23T19:27:40.527Z',
      submittedAt: '2026-03-23T19:27:40.527Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '1',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await updateInteractionReview(
      { repo },
      {
        userId: 'user-1',
        recordKey: record.key,
        expectedUpdatedAt: record.updatedAt,
        status: 'approved',
      }
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.applied).toBe(true);
    expect(value.row.record.phase).toBe('resolved');
    expect(value.row.record.updatedAt).not.toBe(record.updatedAt);
    expect(value.row.record.review).toEqual({
      status: 'approved',
      reviewedAt: value.row.record.updatedAt,
    });
    expect(value.row.record.result?.response).toBeNull();

    const storedRecord = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRecord).toBeDefined();
    expect(storedRecord?.record.review).toEqual({
      status: 'approved',
      reviewedAt: storedRecord?.record.updatedAt,
    });
    expect(storedRecord?.auditEvents.at(-1)).toEqual(
      expect.objectContaining({
        type: 'evaluated',
        actor: 'system',
        phase: 'resolved',
        result: expect.objectContaining({
          evaluatedAt: storedRecord?.record.updatedAt,
        }),
      })
    );
  });

  it('rejects a pending record, requires feedback, and transitions it to error', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      kind: 'custom',
      phase: 'pending',
      scope: { type: 'entity', entityCui: '4305857' },
      completionRule: { type: 'resolved' },
      updatedAt: '2026-03-23T19:35:00.000Z',
      submittedAt: '2026-03-23T19:35:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '2',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await updateInteractionReview(
      { repo },
      {
        userId: 'user-1',
        recordKey: record.key,
        expectedUpdatedAt: record.updatedAt,
        status: 'rejected',
        feedbackText: 'The submitted URL does not match the campaign requirement.',
      }
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.row.record.phase).toBe('failed');
    expect(value.row.record.review).toEqual({
      status: 'rejected',
      reviewedAt: value.row.record.updatedAt,
      feedbackText: 'The submitted URL does not match the campaign requirement.',
    });
    expect(value.row.auditEvents.at(-1)).toEqual(
      expect.objectContaining({
        type: 'evaluated',
        phase: 'failed',
        result: expect.objectContaining({
          feedbackText: 'The submitted URL does not match the campaign requirement.',
        }),
      })
    );
  });

  it('rejects missing feedback for rejected reviews', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      phase: 'pending',
      updatedAt: '2026-03-23T19:35:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '2',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await updateInteractionReview(
      { repo },
      {
        userId: 'user-1',
        recordKey: record.key,
        expectedUpdatedAt: record.updatedAt,
        status: 'rejected',
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'InvalidEventError',
      message: 'Rejected reviews require non-empty feedback.',
      eventId: undefined,
    });
  });

  it('stores admin reviewer attribution when the actor is admin', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      phase: 'pending',
      updatedAt: '2026-03-23T19:35:00.000Z',
      submittedAt: '2026-03-23T19:35:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '2',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await updateInteractionReview(
      { repo },
      {
        userId: 'user-1',
        recordKey: record.key,
        expectedUpdatedAt: record.updatedAt,
        status: 'approved',
        actor: {
          actor: 'admin',
          actorUserId: 'admin-user-1',
          actorPermission: 'campaign:funky_admin',
          actorSource: 'campaign_admin_api',
        },
      }
    );

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.row.record.review).toEqual({
      status: 'approved',
      reviewedAt: value.row.record.updatedAt,
      reviewedByUserId: 'admin-user-1',
      reviewSource: 'campaign_admin_api',
    });
    expect(value.row.auditEvents.at(-1)).toEqual(
      expect.objectContaining({
        type: 'evaluated',
        actor: 'admin',
        actorUserId: 'admin-user-1',
        actorPermission: 'campaign:funky_admin',
        actorSource: 'campaign_admin_api',
      })
    );
  });

  it('treats same-admin same-decision retries as idempotent', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      phase: 'pending',
      updatedAt: '2026-03-23T19:35:00.000Z',
      submittedAt: '2026-03-23T19:35:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '2',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });
    const input = {
      userId: 'user-1',
      recordKey: record.key,
      expectedUpdatedAt: record.updatedAt,
      status: 'approved' as const,
      actor: {
        actor: 'admin' as const,
        actorUserId: 'admin-user-1',
        actorPermission: 'campaign:funky_admin',
        actorSource: 'campaign_admin_api' as const,
      },
    };

    const firstResult = await updateInteractionReview({ repo }, input);
    expect(firstResult.isOk()).toBe(true);

    const storedRow = (await repo.getRecords('user-1'))._unsafeUnwrap()[0];
    expect(storedRow).toBeDefined();

    const retryResult = await updateInteractionReview({ repo }, input);

    expect(retryResult.isOk()).toBe(true);
    expect(retryResult._unsafeUnwrap()).toEqual({
      applied: false,
      row: storedRow,
    });
  });

  it('rejects stale expectedUpdatedAt values with a conflict', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      phase: 'pending',
      updatedAt: '2026-03-23T19:35:00.000Z',
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '2',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await updateInteractionReview(
      { repo },
      {
        userId: 'user-1',
        recordKey: record.key,
        expectedUpdatedAt: '2026-03-23T19:30:00.000Z',
        status: 'approved',
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'ConflictError',
      message: `Interaction record "${record.key}" changed since it was loaded for review.`,
    });
  });

  it('accepts equivalent expectedUpdatedAt timestamps serialized with different offsets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T18:05:00.000Z'));

    try {
      const record = createTestInteractiveRecord({
        key: 'funky:interaction:city_hall_website::entity:4305857',
        phase: 'pending',
        updatedAt: '2026-03-23T20:00:00+02:00',
      });

      const initialRecords = new Map<string, LearningProgressRecordRow[]>();
      initialRecords.set('user-1', [
        {
          userId: 'user-1',
          recordKey: record.key,
          record,
          auditEvents: [],
          updatedSeq: '2',
          createdAt: record.updatedAt,
          updatedAt: record.updatedAt,
        },
      ]);

      const repo = makeFakeLearningProgressRepo({ initialRecords });

      const result = await updateInteractionReview(
        { repo },
        {
          userId: 'user-1',
          recordKey: record.key,
          expectedUpdatedAt: '2026-03-23T18:00:00.000Z',
          status: 'approved',
        }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().row.record.updatedAt).toBe('2026-03-23T18:05:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('always moves review updatedAt forward when the stored timestamp is later than now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T19:00:00.000Z'));

    try {
      const record = createTestInteractiveRecord({
        key: 'funky:interaction:city_hall_website::entity:4305857',
        phase: 'pending',
        updatedAt: '2026-03-23T18:30:00-02:00',
      });

      const initialRecords = new Map<string, LearningProgressRecordRow[]>();
      initialRecords.set('user-1', [
        {
          userId: 'user-1',
          recordKey: record.key,
          record,
          auditEvents: [],
          updatedSeq: '2',
          createdAt: record.updatedAt,
          updatedAt: record.updatedAt,
        },
      ]);

      const repo = makeFakeLearningProgressRepo({ initialRecords });

      const result = await updateInteractionReview(
        { repo },
        {
          userId: 'user-1',
          recordKey: record.key,
          expectedUpdatedAt: '2026-03-23T20:30:00.000Z',
          status: 'approved',
        }
      );

      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();
      expect(value.row.record.updatedAt).toBe('2026-03-23T20:30:00.001Z');
      expect(value.row.record.review).toEqual({
        status: 'approved',
        reviewedAt: '2026-03-23T20:30:00.001Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects conflicting reviews for non-pending rows', async () => {
    const record = createTestInteractiveRecord({
      key: 'funky:interaction:city_hall_website::entity:4305857',
      phase: 'resolved',
      updatedAt: '2026-03-23T19:35:00.000Z',
      review: {
        status: 'approved',
        reviewedAt: '2026-03-23T19:35:00.000Z',
      },
    });

    const initialRecords = new Map<string, LearningProgressRecordRow[]>();
    initialRecords.set('user-1', [
      {
        userId: 'user-1',
        recordKey: record.key,
        record,
        auditEvents: [],
        updatedSeq: '2',
        createdAt: record.updatedAt,
        updatedAt: record.updatedAt,
      },
    ]);

    const repo = makeFakeLearningProgressRepo({ initialRecords });

    const result = await updateInteractionReview(
      { repo },
      {
        userId: 'user-1',
        recordKey: record.key,
        expectedUpdatedAt: record.updatedAt,
        status: 'rejected',
        feedbackText: 'Needs more evidence.',
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'ConflictError',
      message: `Interaction record "${record.key}" is no longer reviewable because it is not pending.`,
    });
  });
});
