import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { createQueueError } from '@/modules/notification-delivery/core/errors.js';
import { enqueuePublicDebateEntityUpdateNotifications } from '@/modules/notification-delivery/index.js';

import {
  createTestDeliveryRecord,
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
} from '../../fixtures/fakes.js';

describe('enqueuePublicDebateEntityUpdateNotifications', () => {
  const createComposeJobScheduler = () => ({
    enqueue: vi.fn(async () => ok(undefined)),
  });

  it('creates one outbox row per active public debate entity subscription', async () => {
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notif-1',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        }),
        createTestNotification({
          id: 'notif-2',
          userId: 'user-2',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const composeJobScheduler = createComposeJobScheduler();

    const result = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler,
      },
      {
        runId: 'run-1',
        eventType: 'thread_started',
        entityCui: '12345678',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'awaiting_reply',
        requesterUserId: 'user-1',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Solicitare organizare dezbatere publica',
        occurredAt: '2026-03-31T10:00:00.000Z',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.notificationIds).toEqual(['notif-1', 'notif-2']);
      expect(result.value.createdOutboxIds).toHaveLength(2);
      expect(result.value.enqueueFailedOutboxIds).toEqual([]);
      expect(result.value.queuedOutboxIds).toHaveLength(2);
      expect(result.value.skippedTerminalOutboxIds).toEqual([]);
    }

    const outbox1 = await deliveryRepo.findByDeliveryKey(
      'user-1:notif-1:funky:delivery:thread_started_thread-1'
    );
    const outbox2 = await deliveryRepo.findByDeliveryKey(
      'user-2:notif-2:funky:delivery:thread_started_thread-1'
    );
    expect(outbox1.isOk()).toBe(true);
    expect(outbox2.isOk()).toBe(true);
    if (outbox1.isOk()) {
      expect(outbox1.value?.notificationType).toBe('funky:outbox:entity_update');
      expect(outbox1.value?.metadata).toEqual(
        expect.objectContaining({
          campaignKey: 'funky',
          eventType: 'thread_started',
          entityCui: '12345678',
          threadId: 'thread-1',
          threadKey: 'thread-key-1',
          phase: 'awaiting_reply',
          recipientRole: 'requester',
        })
      );
    }
    if (outbox2.isOk()) {
      expect(outbox2.value?.metadata).toEqual(
        expect.objectContaining({
          recipientRole: 'subscriber',
        })
      );
    }
    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(2);
  });

  it('reuses an existing deterministic outbox row instead of creating a duplicate', async () => {
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notif-1',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const firstResult = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-1',
        eventType: 'thread_started',
        entityCui: '12345678',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'awaiting_reply',
        requesterUserId: 'user-1',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Solicitare organizare dezbatere publica',
        occurredAt: '2026-03-31T10:00:00.000Z',
      }
    );
    const secondResult = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-2',
        eventType: 'thread_started',
        entityCui: '12345678',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'awaiting_reply',
        requesterUserId: 'user-1',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Solicitare organizare dezbatere publica',
        occurredAt: '2026-03-31T10:00:00.000Z',
      }
    );

    expect(firstResult.isOk()).toBe(true);
    expect(secondResult.isOk()).toBe(true);
    if (secondResult.isOk()) {
      expect(secondResult.value.createdOutboxIds).toEqual([]);
      expect(secondResult.value.reusedOutboxIds).toHaveLength(1);
      expect(secondResult.value.queuedOutboxIds).toHaveLength(1);
      expect(secondResult.value.skippedTerminalOutboxIds).toEqual([]);
    }
  });

  it('requeues terminal outbox rows by default for existing entity-update flows', async () => {
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notif-1',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        }),
      ],
    });
    const existingOutbox = createTestDeliveryRecord({
      id: 'outbox-terminal',
      userId: 'user-1',
      notificationType: 'funky:outbox:entity_update',
      referenceId: 'notif-1',
      scopeKey: 'funky:delivery:thread_started_thread-1',
      deliveryKey: 'user-1:notif-1:funky:delivery:thread_started_thread-1',
      status: 'delivered',
      metadata: {
        campaignKey: 'funky',
        eventType: 'thread_started',
        entityCui: '12345678',
        threadId: 'thread-1',
      },
    });
    const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [existingOutbox] });
    const composeJobScheduler = createComposeJobScheduler();

    const result = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler,
      },
      {
        runId: 'run-terminal',
        eventType: 'thread_started',
        entityCui: '12345678',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'awaiting_reply',
        requesterUserId: 'user-1',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Solicitare organizare dezbatere publica',
        occurredAt: '2026-03-31T10:00:00.000Z',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.createdOutboxIds).toEqual([]);
      expect(result.value.reusedOutboxIds).toEqual([existingOutbox.id]);
      expect(result.value.queuedOutboxIds).toEqual([existingOutbox.id]);
      expect(result.value.skippedTerminalOutboxIds).toEqual([]);
      expect(result.value.enqueueFailedOutboxIds).toEqual([]);
    }
    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('skips compose requeue for terminal outbox rows when explicitly requested', async () => {
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notif-1',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        }),
      ],
    });
    const existingOutbox = createTestDeliveryRecord({
      id: 'outbox-terminal',
      userId: 'user-1',
      notificationType: 'funky:outbox:entity_update',
      referenceId: 'notif-1',
      scopeKey: 'funky:delivery:thread_started_thread-1',
      deliveryKey: 'user-1:notif-1:funky:delivery:thread_started_thread-1',
      status: 'delivered',
      metadata: {
        campaignKey: 'funky',
        eventType: 'thread_started',
        entityCui: '12345678',
        threadId: 'thread-1',
      },
    });
    const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [existingOutbox] });
    const composeJobScheduler = createComposeJobScheduler();

    const result = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler,
      },
      {
        runId: 'run-terminal-admin',
        eventType: 'thread_started',
        entityCui: '12345678',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'awaiting_reply',
        requesterUserId: 'user-1',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Solicitare organizare dezbatere publica',
        occurredAt: '2026-03-31T10:00:00.000Z',
        reusedOutboxComposeStrategy: 'skip_terminal_compose',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.createdOutboxIds).toEqual([]);
      expect(result.value.reusedOutboxIds).toEqual([existingOutbox.id]);
      expect(result.value.queuedOutboxIds).toEqual([]);
      expect(result.value.skippedTerminalOutboxIds).toEqual([existingOutbox.id]);
      expect(result.value.enqueueFailedOutboxIds).toEqual([]);
    }
    expect(composeJobScheduler.enqueue).not.toHaveBeenCalled();
  });

  it('records enqueue failures without failing after the outbox row is persisted', async () => {
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notif-1',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const result = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: {
          enqueue: async () => err(createQueueError('queue down', true)),
        },
      },
      {
        runId: 'run-1',
        eventType: 'reply_received',
        entityCui: '12345678',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'reply_received_unreviewed',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Solicitare organizare dezbatere publica',
        occurredAt: '2026-03-31T10:00:00.000Z',
        replyEntryId: 'reply-1',
        replyTextPreview: 'Va raspundem in termenul legal.',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.createdOutboxIds).toHaveLength(1);
      expect(result.value.enqueueFailedOutboxIds).toHaveLength(1);
      expect(result.value.queuedOutboxIds).toEqual([]);
      expect(result.value.skippedTerminalOutboxIds).toEqual([]);
    }

    const outbox = await deliveryRepo.findByDeliveryKey(
      'user-1:notif-1:funky:delivery:reply_thread-1_reply-1'
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.metadata).not.toHaveProperty('recipientRole');
    }
  });

  it('excludes users whose public debate campaign preference is disabled', async () => {
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notif-entity',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        }),
        createTestNotification({
          id: 'notif-global',
          userId: 'user-1',
          notificationType: 'funky:notification:global',
          entityCui: null,
          isActive: false,
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const result = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-filtered',
        eventType: 'thread_started',
        entityCui: '12345678',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'awaiting_reply',
        requesterUserId: 'user-1',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Solicitare organizare dezbatere publica',
        occurredAt: '2026-03-31T10:00:00.000Z',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.notificationIds).toEqual([]);
      expect(result.value.createdOutboxIds).toEqual([]);
      expect(result.value.reusedOutboxIds).toEqual([]);
      expect(result.value.skippedTerminalOutboxIds).toEqual([]);
    }
  });

  it('treats ownerless thread_started notifications as subscriber updates', async () => {
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notif-1',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const result = await enqueuePublicDebateEntityUpdateNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-unknown-owner',
        eventType: 'thread_started',
        entityCui: '12345678',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        phase: 'awaiting_reply',
        requesterUserId: null,
        institutionEmail: 'contact@primarie.ro',
        subject: 'Solicitare organizare dezbatere publica',
        occurredAt: '2026-03-31T10:00:00.000Z',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.notificationIds).toEqual(['notif-1']);
      expect(result.value.createdOutboxIds).toHaveLength(1);
      expect(result.value.queuedOutboxIds).toHaveLength(1);
    }

    const outbox = await deliveryRepo.findByDeliveryKey(
      'user-1:notif-1:funky:delivery:thread_started_thread-1'
    );
    expect(outbox.isOk()).toBe(true);
    if (outbox.isOk()) {
      expect(outbox.value?.metadata).toEqual(
        expect.objectContaining({
          recipientRole: 'subscriber',
        })
      );
    }
  });
});
