import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { createQueueError } from '@/modules/notification-delivery/core/errors.js';
import { enqueueCreatedOrReusedOutbox } from '@/modules/notification-delivery/core/usecases/enqueue-created-or-reused-outbox.js';

import { createTestDeliveryRecord, makeFakeDeliveryRepo } from '../../fixtures/fakes.js';

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
      expect(result.value.composeStatus).toBe('compose_enqueued');
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
      expect(result.value.composeStatus).toBe('compose_enqueued');
    }
    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('refreshes metadata on reused unrendered outbox rows before compose', async () => {
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
        runId: 'run-refresh',
        deliveryKey: createInput.deliveryKey,
        createInput,
        reusedOutboxMetadataRefresh: {
          eventType: 'thread_started',
          recipientRole: 'subscriber',
        },
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const outbox = await deliveryRepo.findById(result.value.outboxId);
      expect(outbox.isOk()).toBe(true);
      if (outbox.isOk()) {
        expect(outbox.value?.metadata).toEqual({
          eventType: 'thread_started',
          recipientRole: 'subscriber',
        });
      }
    }
  });

  it('does not refresh metadata on reused outbox rows that are already rendered', async () => {
    const existingOutbox = createTestDeliveryRecord({
      id: 'delivery-rendered',
      userId: createInput.userId,
      notificationType: createInput.notificationType,
      referenceId: createInput.referenceId,
      scopeKey: createInput.scopeKey,
      deliveryKey: createInput.deliveryKey,
      status: 'pending',
      renderedSubject: 'Already rendered',
      renderedHtml: '<p>Already rendered</p>',
      renderedText: 'Already rendered',
      metadata: createInput.metadata,
    });
    const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [existingOutbox] });

    const result = await enqueueCreatedOrReusedOutbox(
      {
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-refresh-rendered',
        deliveryKey: createInput.deliveryKey,
        createInput,
        reusedOutboxMetadataRefresh: {
          eventType: 'thread_started',
          recipientRole: 'subscriber',
        },
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const outbox = await deliveryRepo.findById(result.value.outboxId);
      expect(outbox.isOk()).toBe(true);
      if (outbox.isOk()) {
        expect(outbox.value?.metadata).toEqual(createInput.metadata);
      }
    }
  });

  it('skips compose requeue when a reused outbox row is already terminal and the caller opts in', async () => {
    const existingOutbox = createTestDeliveryRecord({
      id: 'delivery-terminal',
      userId: createInput.userId,
      notificationType: createInput.notificationType,
      referenceId: createInput.referenceId,
      scopeKey: createInput.scopeKey,
      deliveryKey: createInput.deliveryKey,
      status: 'delivered',
      metadata: createInput.metadata,
    });
    const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [existingOutbox] });
    const composeJobScheduler = createComposeJobScheduler();

    const result = await enqueueCreatedOrReusedOutbox(
      {
        deliveryRepo,
        composeJobScheduler,
      },
      {
        runId: 'run-terminal',
        deliveryKey: createInput.deliveryKey,
        reusedOutboxComposeStrategy: 'skip_terminal_compose',
        createInput,
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.outboxId).toBe(existingOutbox.id);
      expect(result.value.source).toBe('reused');
      expect(result.value.composeEnqueued).toBe(false);
      expect(result.value.composeStatus).toBe('skipped_terminal');
    }
    expect(composeJobScheduler.enqueue).not.toHaveBeenCalled();
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
      expect(result.value.composeStatus).toBe('compose_enqueue_failed');
    }
  });
});
