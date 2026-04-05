import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { createQueueError } from '@/modules/notification-delivery/core/errors.js';
import { enqueueCreatedOrReusedOutbox } from '@/modules/notification-delivery/core/usecases/enqueue-created-or-reused-outbox.js';

import { makeFakeDeliveryRepo } from '../../fixtures/fakes.js';

describe('enqueueCreatedOrReusedOutbox', () => {
  const createComposeJobScheduler = () => ({
    enqueue: vi.fn(async () => ok(undefined)),
  });

  const createInput = {
    userId: 'user-1',
    notificationType: 'funky:outbox:entity_update' as const,
    referenceId: 'notif-1',
    scopeKey: 'scope-1',
    deliveryKey: 'user-1:notif-1:scope-1',
    metadata: { eventType: 'thread_started' },
  };

  it('creates a new outbox row and enqueues compose', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const composeJobScheduler = createComposeJobScheduler();

    const result = await enqueueCreatedOrReusedOutbox(
      {
        deliveryRepo,
        composeJobScheduler,
      },
      {
        runId: 'run-1',
        deliveryKey: createInput.deliveryKey,
        createInput,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.source).toBe('created');
      expect(result.value.composeEnqueued).toBe(true);
    }
    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing outbox row when create reports DuplicateDelivery', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const initialCreateResult = await deliveryRepo.create(createInput);
    expect(initialCreateResult.isOk()).toBe(true);
    const composeJobScheduler = createComposeJobScheduler();

    const result = await enqueueCreatedOrReusedOutbox(
      {
        deliveryRepo,
        composeJobScheduler,
      },
      {
        runId: 'run-2',
        deliveryKey: createInput.deliveryKey,
        createInput,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.source).toBe('reused');
      expect(result.value.composeEnqueued).toBe(true);
    }
    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('returns a DatabaseError when DuplicateDelivery is reported but the outbox row cannot be reloaded', async () => {
    const baseRepo = makeFakeDeliveryRepo();
    const deliveryRepo = {
      ...baseRepo,
      create: vi.fn(async () =>
        err({
          type: 'DuplicateDelivery' as const,
          deliveryKey: createInput.deliveryKey,
        })
      ),
      findByDeliveryKey: vi.fn(async () => ok(null)),
    };

    const result = await enqueueCreatedOrReusedOutbox(
      {
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-3',
        deliveryKey: createInput.deliveryKey,
        createInput,
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('DatabaseError');
      if (result.error.type === 'DatabaseError') {
        expect(result.error.message).toContain(createInput.deliveryKey);
      }
    }
  });

  it('reports composeEnqueued=false when compose scheduling fails', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();

    const result = await enqueueCreatedOrReusedOutbox(
      {
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async () => err(createQueueError('queue down', true)),
        },
      },
      {
        runId: 'run-4',
        deliveryKey: createInput.deliveryKey,
        createInput,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.source).toBe('created');
      expect(result.value.composeEnqueued).toBe(false);
    }
  });
});
