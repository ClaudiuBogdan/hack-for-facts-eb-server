import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { enqueuePublicDebateAdminResponseNotifications } from '@/modules/notification-delivery/index.js';

import {
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
} from '../../fixtures/fakes.js';

describe('enqueuePublicDebateAdminResponseNotifications', () => {
  const createComposeJobScheduler = () => ({
    enqueue: vi.fn(async () => ok(undefined)),
  });

  it('creates one admin-response outbox row per eligible requester/subscriber and tags recipient roles', async () => {
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

    const result = await enqueuePublicDebateAdminResponseNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler,
      },
      {
        runId: 'run-1',
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        responseEventId: 'response-1',
        responseStatus: 'registration_number_received',
        responseDate: '2026-04-16T10:00:00.000Z',
        messageContent: 'Am înregistrat solicitarea.',
        ownerUserId: 'user-1',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.createdOutboxIds).toHaveLength(2);
      expect(result.value.queuedOutboxIds).toHaveLength(2);
    }

    const requesterOutbox = await deliveryRepo.findByDeliveryKey(
      'user-1:notif-1:funky:delivery:admin_response_thread-1_response-1'
    );
    const subscriberOutbox = await deliveryRepo.findByDeliveryKey(
      'user-2:notif-2:funky:delivery:admin_response_thread-1_response-1'
    );

    expect(requesterOutbox.isOk()).toBe(true);
    expect(subscriberOutbox.isOk()).toBe(true);
    if (requesterOutbox.isOk()) {
      expect(requesterOutbox.value?.notificationType).toBe('funky:outbox:admin_response');
      expect(requesterOutbox.value?.metadata).toEqual(
        expect.objectContaining({
          responseEventId: 'response-1',
          responseStatus: 'registration_number_received',
          recipientRole: 'requester',
        })
      );
    }
    if (subscriberOutbox.isOk()) {
      expect(subscriberOutbox.value?.metadata).toEqual(
        expect.objectContaining({
          recipientRole: 'subscriber',
        })
      );
    }
  });

  it('dedupes the same admin response event but allows a later response event to create new outbox rows', async () => {
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

    const firstResult = await enqueuePublicDebateAdminResponseNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-first',
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        responseEventId: 'response-1',
        responseStatus: 'request_confirmed',
        responseDate: '2026-04-16T10:00:00.000Z',
        messageContent: 'Solicitarea a fost confirmată.',
        ownerUserId: 'user-1',
      }
    );
    const duplicateResult = await enqueuePublicDebateAdminResponseNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-duplicate',
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        responseEventId: 'response-1',
        responseStatus: 'request_confirmed',
        responseDate: '2026-04-16T10:00:00.000Z',
        messageContent: 'Solicitarea a fost confirmată.',
        ownerUserId: 'user-1',
      }
    );
    const laterResult = await enqueuePublicDebateAdminResponseNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-later',
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        responseEventId: 'response-2',
        responseStatus: 'request_denied',
        responseDate: '2026-04-16T11:00:00.000Z',
        messageContent: 'Solicitarea a fost respinsă.',
        ownerUserId: 'user-1',
      }
    );

    expect(firstResult.isOk()).toBe(true);
    expect(duplicateResult.isOk()).toBe(true);
    expect(laterResult.isOk()).toBe(true);
    if (duplicateResult.isOk()) {
      expect(duplicateResult.value.createdOutboxIds).toEqual([]);
      expect(duplicateResult.value.reusedOutboxIds).toHaveLength(1);
    }
    if (laterResult.isOk()) {
      expect(laterResult.value.createdOutboxIds).toHaveLength(1);
    }

    const laterOutbox = await deliveryRepo.findByDeliveryKey(
      'user-1:notif-1:funky:delivery:admin_response_thread-1_response-2'
    );
    expect(laterOutbox.isOk()).toBe(true);
    if (laterOutbox.isOk()) {
      expect(laterOutbox.value?.metadata).toEqual(
        expect.objectContaining({
          responseEventId: 'response-2',
          responseStatus: 'request_denied',
        })
      );
    }
  });

  it('dedupes duplicate active entity-update rows for the same user before enqueueing admin-response deliveries', async () => {
    const notificationsRepo = makeFakeExtendedNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notif-1a',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        }),
        createTestNotification({
          id: 'notif-1b',
          userId: 'user-1',
          notificationType: 'funky:notification:entity_updates',
          entityCui: '12345678',
        }),
      ],
    });
    const deliveryRepo = makeFakeDeliveryRepo();

    const result = await enqueuePublicDebateAdminResponseNotifications(
      {
        notificationsRepo,
        deliveryRepo,
        composeJobScheduler: createComposeJobScheduler(),
      },
      {
        runId: 'run-duplicate-user',
        entityCui: '12345678',
        entityName: 'Municipiul Exemplu',
        threadId: 'thread-1',
        threadKey: 'thread-key-1',
        responseEventId: 'response-1',
        responseStatus: 'registration_number_received',
        responseDate: '2026-04-16T10:00:00.000Z',
        messageContent: 'Am înregistrat solicitarea.',
        ownerUserId: 'user-1',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.notificationIds).toEqual(['notif-1a']);
      expect(result.value.createdOutboxIds).toHaveLength(1);
    }

    const keptOutbox = await deliveryRepo.findByDeliveryKey(
      'user-1:notif-1a:funky:delivery:admin_response_thread-1_response-1'
    );
    const duplicateOutbox = await deliveryRepo.findByDeliveryKey(
      'user-1:notif-1b:funky:delivery:admin_response_thread-1_response-1'
    );

    expect(keptOutbox.isOk()).toBe(true);
    if (keptOutbox.isOk()) {
      expect(keptOutbox.value).not.toBeNull();
    }
    expect(duplicateOutbox.isOk()).toBe(true);
    if (duplicateOutbox.isOk()) {
      expect(duplicateOutbox.value).toBeNull();
    }
  });
});
