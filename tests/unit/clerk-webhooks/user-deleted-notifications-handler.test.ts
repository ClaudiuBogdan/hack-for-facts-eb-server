import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import {
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_NOTIFICATION_GLOBAL_TYPE,
} from '@/common/campaign-keys.js';
import {
  makeClerkUserDeletedNotificationsHandler,
  type ClerkWebhookEvent,
} from '@/modules/clerk-webhooks/index.js';

import { createTestNotification, makeFakeNotificationsRepo } from '../../fixtures/fakes.js';

import type { NotificationsRepository } from '@/modules/notifications/index.js';

const logger = pinoLogger({ level: 'silent' });

const createEvent = (overrides: Partial<ClerkWebhookEvent> = {}): ClerkWebhookEvent => ({
  data: {
    id: 'user_123',
  },
  object: 'event',
  type: 'user.deleted',
  timestamp: 1_654_012_591_835,
  instance_id: 'ins_123',
  ...overrides,
});

const findUserNotifications = async (repo: NotificationsRepository, userId: string) => {
  const result = await repo.findByUserId(userId, false);
  if (result.isErr()) {
    throw new Error(result.error.message);
  }

  return result.value;
};

describe('makeClerkUserDeletedNotificationsHandler', () => {
  it('disables all notification preferences for Clerk user.deleted events', async () => {
    const userId = 'user_123';
    const otherUserId = 'user_456';
    const repo = makeFakeNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'global-unsubscribe',
          userId,
          notificationType: 'global_unsubscribe',
          isActive: true,
          config: { channels: { email: true } },
        }),
        createTestNotification({
          id: 'monthly-newsletter',
          userId,
          notificationType: 'newsletter_entity_monthly',
          entityCui: '123',
          isActive: true,
        }),
        createTestNotification({
          id: 'campaign-global',
          userId,
          notificationType: FUNKY_NOTIFICATION_GLOBAL_TYPE,
          isActive: true,
        }),
        createTestNotification({
          id: 'campaign-entity',
          userId,
          notificationType: FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
          entityCui: '456',
          isActive: true,
        }),
        createTestNotification({
          id: 'other-user-newsletter',
          userId: otherUserId,
          notificationType: 'newsletter_entity_monthly',
          entityCui: '789',
          isActive: true,
        }),
      ],
    });
    const handler = makeClerkUserDeletedNotificationsHandler({
      notificationsRepo: repo,
      logger,
    });

    await handler({ event: createEvent(), svixId: 'msg_1' });

    const userNotifications = await findUserNotifications(repo, userId);
    expect(userNotifications).toHaveLength(4);
    expect(userNotifications.map((notification) => notification.isActive)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(
      userNotifications.find(
        (notification) => notification.notificationType === 'global_unsubscribe'
      )?.config
    ).toEqual({ channels: { email: false } });

    const otherUserNotifications = await findUserNotifications(repo, otherUserId);
    expect(otherUserNotifications).toHaveLength(1);
    expect(otherUserNotifications[0]?.isActive).toBe(true);
  });

  it('does nothing for non-delete Clerk events', async () => {
    const deactivateGlobalUnsubscribe = vi.fn();
    const handler = makeClerkUserDeletedNotificationsHandler({
      notificationsRepo: { deactivateGlobalUnsubscribe },
      logger,
    });

    await handler({ event: createEvent({ type: 'user.created' }), svixId: 'msg_1' });

    expect(deactivateGlobalUnsubscribe).not.toHaveBeenCalled();
  });

  it('fails when a Clerk user.deleted event has no usable user id', async () => {
    const deactivateGlobalUnsubscribe = vi.fn();
    const handler = makeClerkUserDeletedNotificationsHandler({
      notificationsRepo: { deactivateGlobalUnsubscribe },
      logger,
    });

    await expect(
      handler({ event: createEvent({ data: { id: '   ' } }), svixId: 'msg_1' })
    ).rejects.toThrow('Clerk user.deleted webhook is missing a usable data.id');
    expect(deactivateGlobalUnsubscribe).not.toHaveBeenCalled();
  });

  it('fails when notification cleanup cannot be persisted', async () => {
    const repo = makeFakeNotificationsRepo({ simulateDbError: true });
    const handler = makeClerkUserDeletedNotificationsHandler({
      notificationsRepo: repo,
      logger,
    });

    await expect(handler({ event: createEvent(), svixId: 'msg_1' })).rejects.toThrow(
      'Simulated database error'
    );
  });
});
