import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  PUBLIC_DEBATE_REQUEST_TYPE,
  publishCurrentPlatformSendUpdate,
} from '@/modules/institution-correspondence/index.js';

import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';

describe('publishCurrentPlatformSendUpdate', () => {
  it('publishes thread_started for the current awaiting-reply platform thread', async () => {
    const thread = createThreadRecord({
      id: 'thread-1',
      entityCui: '12345678',
      phase: 'awaiting_reply',
      lastEmailAt: new Date('2026-04-03T16:43:04.930Z'),
      record: createThreadAggregateRecord({
        campaign: PUBLIC_DEBATE_REQUEST_TYPE,
        campaignKey: 'funky',
        submissionPath: 'platform_send',
      }),
    });
    const repo = makeInMemoryCorrespondenceRepo({ threads: [thread] });
    const publish = vi.fn(async () =>
      ok({
        status: 'queued' as const,
        notificationIds: ['notif-1'],
        createdOutboxIds: ['outbox-1'],
        reusedOutboxIds: [],
        queuedOutboxIds: ['outbox-1'],
        enqueueFailedOutboxIds: [],
      })
    );

    const result = await publishCurrentPlatformSendUpdate(
      {
        repo,
        updatePublisher: { publish },
      },
      {
        entityCui: '12345678',
        campaign: PUBLIC_DEBATE_REQUEST_TYPE,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('published');
      expect(result.value.eventType).toBe('thread_started');
      expect(result.value.publishResult?.createdOutboxIds).toEqual(['outbox-1']);
    }
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'thread_started',
        occurredAt: new Date('2026-04-03T16:43:04.930Z'),
        requesterUserId: 'user-1',
        thread: expect.objectContaining({
          id: 'thread-1',
          entityCui: '12345678',
          phase: 'awaiting_reply',
        }),
      })
    );
  });

  it('publishes thread_failed for the latest failed platform thread without a failure message', async () => {
    const olderThread = createThreadRecord({
      id: 'thread-older',
      entityCui: '12345678',
      phase: 'awaiting_reply',
      record: createThreadAggregateRecord({
        campaign: PUBLIC_DEBATE_REQUEST_TYPE,
        campaignKey: 'funky',
        submissionPath: 'platform_send',
      }),
    });
    const failedThread = createThreadRecord({
      id: 'thread-failed',
      entityCui: '12345678',
      phase: 'failed',
      updatedAt: new Date('2026-04-04T09:00:00.000Z'),
      record: createThreadAggregateRecord({
        campaign: PUBLIC_DEBATE_REQUEST_TYPE,
        campaignKey: 'funky',
        submissionPath: 'platform_send',
      }),
    });
    const repo = makeInMemoryCorrespondenceRepo({ threads: [olderThread, failedThread] });
    const publish = vi.fn(async () =>
      ok({
        status: 'queued' as const,
        notificationIds: ['notif-failed'],
        createdOutboxIds: ['outbox-failed'],
        reusedOutboxIds: [],
        queuedOutboxIds: ['outbox-failed'],
        enqueueFailedOutboxIds: [],
      })
    );

    const result = await publishCurrentPlatformSendUpdate(
      {
        repo,
        updatePublisher: { publish },
      },
      {
        entityCui: '12345678',
        campaign: PUBLIC_DEBATE_REQUEST_TYPE,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('published');
      expect(result.value.eventType).toBe('thread_failed');
      expect(result.value.thread?.id).toBe('thread-failed');
    }
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'thread_failed',
        occurredAt: new Date('2026-04-04T09:00:00.000Z'),
        thread: expect.objectContaining({
          id: 'thread-failed',
          entityCui: '12345678',
          phase: 'failed',
        }),
      })
    );
  });

  it('publishes reply_reviewed for reviewed platform threads using the latest review', async () => {
    const reply = createCorrespondenceEntry({
      id: 'reply-1',
      direction: 'inbound',
      occurredAt: '2026-04-03T08:00:00.000Z',
    });
    const thread = createThreadRecord({
      id: 'thread-reviewed',
      entityCui: '12345678',
      phase: 'resolved_positive',
      record: createThreadAggregateRecord({
        campaign: PUBLIC_DEBATE_REQUEST_TYPE,
        campaignKey: 'funky',
        submissionPath: 'platform_send',
        correspondence: [reply],
        latestReview: {
          basedOnEntryId: 'reply-1',
          resolutionCode: 'debate_announced',
          notes: 'Debate scheduled',
          reviewedAt: '2026-04-04T10:00:00.000Z',
        },
      }),
    });
    const repo = makeInMemoryCorrespondenceRepo({ threads: [thread] });
    const publish = vi.fn(async () =>
      ok({
        status: 'queued' as const,
        notificationIds: ['notif-reviewed'],
        createdOutboxIds: ['outbox-reviewed'],
        reusedOutboxIds: [],
        queuedOutboxIds: ['outbox-reviewed'],
        enqueueFailedOutboxIds: [],
      })
    );

    const result = await publishCurrentPlatformSendUpdate(
      {
        repo,
        updatePublisher: { publish },
      },
      {
        entityCui: '12345678',
        campaign: PUBLIC_DEBATE_REQUEST_TYPE,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('published');
      expect(result.value.eventType).toBe('reply_reviewed');
      expect(result.value.publishResult?.createdOutboxIds).toEqual(['outbox-reviewed']);
    }
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'reply_reviewed',
        occurredAt: new Date('2026-04-04T10:00:00.000Z'),
        thread: expect.objectContaining({
          id: 'thread-reviewed',
          entityCui: '12345678',
          phase: 'resolved_positive',
        }),
        reply,
        basedOnEntryId: 'reply-1',
        resolutionCode: 'debate_announced',
        reviewNotes: 'Debate scheduled',
      })
    );
  });
});
