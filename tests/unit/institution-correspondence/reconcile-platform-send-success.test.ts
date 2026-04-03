import { ok, err } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  createDatabaseError,
  markPlatformSendSuccessConfirmed,
  readPlatformSendSuccessMetadata,
  reconcilePlatformSendSuccess,
  type InstitutionCorrespondenceRepository,
} from '@/modules/institution-correspondence/index.js';

import {
  createAwaitingReplyPlatformSendThreadPendingConfirmation,
  createPlatformSendSuccessInput,
  createSendingPlatformSendThread,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';

describe('reconcilePlatformSendSuccess', () => {
  const baseInput = createPlatformSendSuccessInput();

  const createSendingRepo = () =>
    makeInMemoryCorrespondenceRepo({
      threads: [
        createSendingPlatformSendThread({
          id: 'thread-1',
          threadKey: baseInput.threadKey,
        }),
      ],
    });

  it('moves a sending platform thread to awaiting_reply, appends the outbound entry, and publishes thread_started', async () => {
    const repo = createSendingRepo();
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

    const result = await reconcilePlatformSendSuccess(
      {
        repo,
        updatePublisher: {
          publish,
        },
      },
      baseInput
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('reconciled');
      expect(result.value.appendedOutboundEntry).toBe(true);
      expect(result.value.confirmationState).toBe('published_and_marked');
      expect(result.value.thread?.phase).toBe('awaiting_reply');
      expect(result.value.thread?.record.correspondence).toHaveLength(1);
      expect(result.value.thread?.record.correspondence[0]?.resendEmailId).toBe('email-1');
      expect(readPlatformSendSuccessMetadata(result.value.thread!.record).providerSendEmailId).toBe(
        'email-1'
      );
      expect(
        readPlatformSendSuccessMetadata(result.value.thread!.record).threadStartedPublishedAt
      ).toBeNull();
    }

    const storedThread = await repo.findThreadById('thread-1');
    expect(storedThread.isOk()).toBe(true);
    if (storedThread.isOk()) {
      expect(storedThread.value?.phase).toBe('awaiting_reply');
      expect(readPlatformSendSuccessMetadata(storedThread.value!.record).providerSendEmailId).toBe(
        'email-1'
      );
      expect(
        readPlatformSendSuccessMetadata(storedThread.value!.record).threadStartedPublishedAt
      ).toBe('2026-04-03T16:43:04.930Z');
    }

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'thread_started',
      })
    );
  });

  it('keeps reconciliation successful when thread_started publishing throws', async () => {
    const repo = createSendingRepo();
    const publish = vi.fn(async () => {
      throw new Error('publisher unavailable');
    });

    const result = await reconcilePlatformSendSuccess(
      {
        repo,
        updatePublisher: {
          publish,
        },
      },
      baseInput
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('reconciled');
      expect(result.value.appendedOutboundEntry).toBe(true);
      expect(result.value.confirmationState).toBe('pending_retry');
      expect(result.value.thread?.phase).toBe('awaiting_reply');
      expect(result.value.thread?.record.correspondence).toHaveLength(1);
      expect(result.value.thread?.record.correspondence[0]?.occurredAt).toBe(
        '2026-04-03T16:43:04.930Z'
      );
    }

    const storedThread = await repo.findThreadById('thread-1');
    expect(storedThread.isOk()).toBe(true);
    if (storedThread.isOk()) {
      expect(storedThread.value?.phase).toBe('awaiting_reply');
      expect(
        readPlatformSendSuccessMetadata(storedThread.value!.record).threadStartedPublishedAt
      ).toBeNull();
    }
  });

  it('keeps reconciliation successful when thread_started publishing returns Err', async () => {
    const repo = createSendingRepo();
    const publish = vi.fn(async () =>
      err({
        type: 'CorrespondenceDatabaseError' as const,
        message: 'publisher queue failed',
        retryable: true,
      })
    );

    const result = await reconcilePlatformSendSuccess(
      {
        repo,
        updatePublisher: {
          publish,
        },
      },
      baseInput
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('reconciled');
      expect(result.value.appendedOutboundEntry).toBe(true);
      expect(result.value.confirmationState).toBe('pending_retry');
      expect(result.value.thread?.phase).toBe('awaiting_reply');
      expect(result.value.thread?.record.correspondence).toHaveLength(1);
      expect(
        readPlatformSendSuccessMetadata(result.value.thread!.record).providerSendObservedAt
      ).toBe('2026-04-03T16:43:04.930Z');
    }

    const storedThread = await repo.findThreadById('thread-1');
    expect(storedThread.isOk()).toBe(true);
    if (storedThread.isOk()) {
      expect(storedThread.value?.phase).toBe('awaiting_reply');
      expect(
        readPlatformSendSuccessMetadata(storedThread.value!.record).threadStartedPublishedAt
      ).toBeNull();
    }
  });

  it('does not append or republish when the thread is already confirmed', async () => {
    const existingThread = createAwaitingReplyPlatformSendThreadPendingConfirmation({
      successInput: baseInput,
      thread: {
        id: 'thread-1',
      },
    });
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        {
          ...existingThread,
          record: {
            ...existingThread.record,
            metadata: markPlatformSendSuccessConfirmed(
              existingThread.record,
              new Date('2026-04-03T16:43:04.930Z')
            ),
          },
        },
      ],
    });
    const publish = vi.fn(async () =>
      err({
        type: 'CorrespondenceDatabaseError' as const,
        message: 'should not publish',
        retryable: true,
      })
    );

    const result = await reconcilePlatformSendSuccess(
      {
        repo,
        updatePublisher: {
          publish,
        },
      },
      {
        ...baseInput,
        observedAt: new Date('2026-04-03T16:50:00.000Z'),
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('already_reconciled');
      expect(result.value.appendedOutboundEntry).toBe(false);
      expect(result.value.confirmationState).toBe('already_confirmed');
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('surfaces pending retry when thread_started publish succeeds but marker persistence fails', async () => {
    const baseRepo = createSendingRepo();
    const repo = {
      ...baseRepo,
      async mutateThread(
        threadId: string,
        mutator: Parameters<InstitutionCorrespondenceRepository['mutateThread']>[1]
      ) {
        const threadResult = await baseRepo.findThreadById(threadId);
        if (threadResult.isErr()) {
          return err(threadResult.error);
        }

        const thread = threadResult.value;
        if (thread === null) {
          return err(createDatabaseError('Thread not found for marker write test'));
        }

        const mutationResult = mutator(thread);
        if (mutationResult.isErr()) {
          return err(mutationResult.error);
        }

        if (
          readPlatformSendSuccessMetadata({
            ...thread.record,
            metadata: mutationResult.value.record.metadata,
          }).threadStartedPublishedAt !== null
        ) {
          return err(createDatabaseError('marker write failed'));
        }

        return baseRepo.mutateThread(threadId, mutator);
      },
    };
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

    const result = await reconcilePlatformSendSuccess(
      {
        repo,
        updatePublisher: {
          publish,
        },
      },
      baseInput
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('reconciled');
      expect(result.value.appendedOutboundEntry).toBe(true);
      expect(result.value.confirmationState).toBe('pending_retry');
    }

    const storedThread = await baseRepo.findThreadById('thread-1');
    expect(storedThread.isOk()).toBe(true);
    if (storedThread.isOk()) {
      expect(storedThread.value?.phase).toBe('awaiting_reply');
      expect(
        readPlatformSendSuccessMetadata(storedThread.value!.record).threadStartedPublishedAt
      ).toBeNull();
    }
  });
});
