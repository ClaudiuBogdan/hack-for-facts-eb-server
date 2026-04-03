import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  readPlatformSendSuccessMetadata,
  recoverPlatformSendSuccessConfirmation,
} from '@/modules/institution-correspondence/index.js';

import {
  createAwaitingReplyPlatformSendThreadPendingConfirmation,
  createPlatformSendSuccessInput,
  createSendingPlatformSendThread,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';

describe('recoverPlatformSendSuccessConfirmation', () => {
  it('reconciles sending platform threads using the original email send timestamp', async () => {
    const successInput = createPlatformSendSuccessInput();
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createSendingPlatformSendThread({
          id: 'thread-1',
          threadKey: successInput.threadKey,
        }),
      ],
    });
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
    const deliveredEventCreatedAt = new Date('2026-04-03T16:49:00.000Z');

    const result = await recoverPlatformSendSuccessConfirmation(
      {
        repo,
        evidenceLookup: {
          async findLatestSuccessfulSendByThreadKey(threadKey) {
            if (threadKey !== successInput.threadKey) {
              return ok(null);
            }

            return ok(successInput);
          },
        },
        updatePublisher: {
          publish,
        },
      },
      {
        thresholdMinutes: 15,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.foundCount).toBe(1);
      expect(result.value.reconciledCount).toBe(1);
      expect(result.value.publishedCount).toBe(1);
      expect(result.value.recoveredThreadKeys).toEqual([successInput.threadKey]);
      expect(result.value.pendingConfirmationThreadKeys).toEqual([]);
      expect(result.value.errors).toEqual({});
    }

    const thread = await repo.findThreadByKey(successInput.threadKey);
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.phase).toBe('awaiting_reply');
      expect(thread.value?.lastEmailAt?.toISOString()).toBe(successInput.observedAt.toISOString());
      expect(thread.value?.record.correspondence[0]?.occurredAt).toBe(
        successInput.observedAt.toISOString()
      );
      expect(readPlatformSendSuccessMetadata(thread.value!.record).providerSendObservedAt).toBe(
        successInput.observedAt.toISOString()
      );
      expect(readPlatformSendSuccessMetadata(thread.value!.record).threadStartedPublishedAt).toBe(
        successInput.observedAt.toISOString()
      );
    }

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        occurredAt: successInput.observedAt,
      })
    );
    expect(publish).not.toHaveBeenCalledWith(
      expect.objectContaining({
        occurredAt: deliveredEventCreatedAt,
      })
    );
  });

  it('retries awaiting_reply threads that are missing the thread_started marker using stored thread data', async () => {
    const successInput = createPlatformSendSuccessInput();
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createAwaitingReplyPlatformSendThreadPendingConfirmation({
          successInput,
          thread: {
            id: 'thread-1',
          },
        }),
      ],
    });
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

    const result = await recoverPlatformSendSuccessConfirmation(
      {
        repo,
        evidenceLookup: {
          async findLatestSuccessfulSendByThreadKey() {
            return ok(null);
          },
        },
        updatePublisher: {
          publish,
        },
      },
      {
        thresholdMinutes: 15,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.foundCount).toBe(1);
      expect(result.value.reconciledCount).toBe(1);
      expect(result.value.publishedCount).toBe(1);
      expect(result.value.recoveredThreadKeys).toEqual([successInput.threadKey]);
      expect(result.value.pendingConfirmationThreadKeys).toEqual([]);
      expect(result.value.errors).toEqual({});
    }

    const thread = await repo.findThreadByKey(successInput.threadKey);
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.phase).toBe('awaiting_reply');
      expect(readPlatformSendSuccessMetadata(thread.value!.record).threadStartedPublishedAt).toBe(
        successInput.observedAt.toISOString()
      );
    }

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        occurredAt: successInput.observedAt,
      })
    );
  });

  it('keeps awaiting_reply threads retryable when confirmation publish still fails', async () => {
    const successInput = createPlatformSendSuccessInput();
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createAwaitingReplyPlatformSendThreadPendingConfirmation({
          successInput,
          thread: {
            id: 'thread-1',
          },
        }),
      ],
    });

    const result = await recoverPlatformSendSuccessConfirmation(
      {
        repo,
        evidenceLookup: {
          async findLatestSuccessfulSendByThreadKey() {
            return ok(null);
          },
        },
        updatePublisher: {
          publish: vi.fn(async () => {
            throw new Error('publisher down');
          }),
        },
      },
      {
        thresholdMinutes: 15,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.foundCount).toBe(1);
      expect(result.value.reconciledCount).toBe(0);
      expect(result.value.publishedCount).toBe(0);
      expect(result.value.recoveredThreadKeys).toEqual([]);
      expect(result.value.pendingConfirmationThreadKeys).toEqual([successInput.threadKey]);
      expect(result.value.errors).toEqual({});
    }

    const thread = await repo.findThreadByKey(successInput.threadKey);
    expect(thread.isOk()).toBe(true);
    if (thread.isOk()) {
      expect(thread.value?.phase).toBe('awaiting_reply');
      expect(
        readPlatformSendSuccessMetadata(thread.value!.record).threadStartedPublishedAt
      ).toBeNull();
    }
  });
});
