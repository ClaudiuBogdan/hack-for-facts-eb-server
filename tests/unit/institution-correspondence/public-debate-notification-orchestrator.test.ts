import { randomUUID } from 'crypto';

import { ok, err } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE } from '@/common/campaign-keys.js';
import { makePublicDebateNotificationOrchestrator } from '@/modules/institution-correspondence/index.js';

import {
  createThreadAggregateRecord,
  createThreadRecord,
  makeInMemoryCorrespondenceRepo,
} from './fake-repo.js';
import { createTestNotification, makeFakeDeliveryRepo } from '../../fixtures/fakes.js';

import type { EntityRepository } from '@/modules/entity/index.js';
import type { ExtendedNotificationsRepository } from '@/modules/notification-delivery/index.js';
import type {
  Notification,
  NotificationError,
  NotificationType,
  NotificationsRepository,
} from '@/modules/notifications/index.js';

const makeTestEntityRepo = (entityName = 'Oras Test'): EntityRepository => {
  return {
    async getById(cui) {
      return ok({
        cui,
        name: entityName,
        entity_type: null,
        default_report_type: 'Executie bugetara detaliata',
        uat_id: null,
        is_uat: true,
        address: null,
        last_updated: null,
        main_creditor_1_cui: null,
        main_creditor_2_cui: null,
      });
    },
    async getByIds() {
      return ok(new Map());
    },
    async getAll() {
      return ok({
        nodes: [],
        pageInfo: {
          totalCount: 0,
          hasNextPage: false,
          hasPreviousPage: false,
        },
      });
    },
    async getChildren() {
      return ok([]);
    },
    async getParents() {
      return ok([]);
    },
    async getCountyEntity() {
      return ok(null);
    },
  };
};

const makeSharedNotificationRepos = (
  initialNotifications: Notification[] = []
): {
  notificationsRepo: NotificationsRepository;
  extendedNotificationsRepo: ExtendedNotificationsRepository;
} => {
  const notifications = [...initialNotifications];

  const notificationsRepo: NotificationsRepository = {
    async create(input) {
      const now = new Date();
      const notification: Notification = {
        id: randomUUID(),
        userId: input.userId,
        notificationType: input.notificationType,
        entityCui: input.entityCui,
        config: input.config,
        hash: input.hash,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      };
      notifications.push(notification);
      return ok(notification);
    },

    async findById(id) {
      return ok(notifications.find((notification) => notification.id === id) ?? null);
    },

    async findByHash(hash) {
      return ok(notifications.find((notification) => notification.hash === hash) ?? null);
    },

    async findByUserId(userId, activeOnly) {
      return ok(
        notifications.filter(
          (notification) => notification.userId === userId && (!activeOnly || notification.isActive)
        )
      );
    },

    async findByUserAndEntity(userId, entityCui, activeOnly) {
      return ok(
        notifications.filter(
          (notification) =>
            notification.userId === userId &&
            notification.entityCui === entityCui &&
            (!activeOnly || notification.isActive)
        )
      );
    },

    async findByUserTypeAndEntity(userId, notificationType, entityCui) {
      return ok(
        notifications.find(
          (notification) =>
            notification.userId === userId &&
            notification.notificationType === notificationType &&
            notification.entityCui === entityCui
        ) ?? null
      );
    },

    async update(id, input) {
      const notificationIndex = notifications.findIndex((notification) => notification.id === id);
      if (notificationIndex === -1) {
        return err({
          type: 'NotificationNotFoundError',
          message: `Notification with ID '${id}' not found`,
          id,
        } satisfies NotificationError);
      }

      const current = notifications[notificationIndex]!;
      const updated: Notification = {
        ...current,
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.config !== undefined ? { config: input.config } : {}),
        ...(input.hash !== undefined ? { hash: input.hash } : {}),
        updatedAt: new Date(),
      };
      notifications[notificationIndex] = updated;
      return ok(updated);
    },

    async updateCampaignGlobalPreference(id, input) {
      const notificationIndex = notifications.findIndex((notification) => notification.id === id);
      if (notificationIndex === -1) {
        return err({
          type: 'NotificationNotFoundError',
          message: `Notification with ID '${id}' not found`,
          id,
        } satisfies NotificationError);
      }

      const current = notifications[notificationIndex]!;
      const updatedAt = new Date();
      const updatedGlobal: Notification = {
        ...current,
        isActive: input.isActive,
        ...(input.config !== undefined ? { config: input.config } : {}),
        ...(input.hash !== undefined ? { hash: input.hash } : {}),
        updatedAt,
      };

      notifications[notificationIndex] = updatedGlobal;

      for (const [index, notification] of notifications.entries()) {
        if (
          notification.userId !== updatedGlobal.userId ||
          notification.notificationType !== FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE
        ) {
          continue;
        }

        notifications[index] = {
          ...notification,
          isActive: input.isActive,
          updatedAt,
        };
      }

      return ok(updatedGlobal);
    },

    async deleteCascade(id) {
      const notificationIndex = notifications.findIndex((notification) => notification.id === id);
      if (notificationIndex === -1) {
        return ok(null);
      }

      const [deletedNotification] = notifications.splice(notificationIndex, 1);
      return ok(deletedNotification ?? null);
    },

    async deactivateGlobalUnsubscribe() {
      return ok(undefined);
    },
  };

  const extendedNotificationsRepo: ExtendedNotificationsRepository = {
    async findById(notificationId) {
      return ok(notifications.find((notification) => notification.id === notificationId) ?? null);
    },

    async findEligibleForDelivery() {
      return ok([]);
    },

    async findActiveByType(notificationType: NotificationType) {
      return ok(
        notifications.filter((notification) => {
          if (notification.notificationType !== notificationType || !notification.isActive) {
            return false;
          }

          return !notifications.some(
            (candidate) =>
              candidate.userId === notification.userId &&
              candidate.notificationType === 'funky:notification:global' &&
              !candidate.isActive
          );
        })
      );
    },

    async findActiveByTypeAndEntity(notificationType: NotificationType, entityCui: string) {
      return ok(
        notifications.filter((notification) => {
          if (
            notification.notificationType !== notificationType ||
            notification.entityCui !== entityCui ||
            !notification.isActive
          ) {
            return false;
          }

          return !notifications.some(
            (candidate) =>
              candidate.userId === notification.userId &&
              candidate.notificationType === 'funky:notification:global' &&
              !candidate.isActive
          );
        })
      );
    },

    async findEligibleByUserTypeAndEntity(
      userId: string,
      notificationType: NotificationType,
      entityCui: string
    ) {
      const notification =
        notifications.find(
          (candidate) =>
            candidate.userId === userId &&
            candidate.notificationType === notificationType &&
            candidate.entityCui === entityCui
        ) ?? null;

      if (notification === null) {
        return ok({
          isEligible: false,
          reason: 'missing_preference' as const,
          notification: null,
        });
      }

      if (!notification.isActive) {
        return ok({
          isEligible: false,
          reason: 'inactive_preference' as const,
          notification,
        });
      }

      if (
        notificationType === 'funky:notification:entity_updates' &&
        notifications.some(
          (candidate) =>
            candidate.userId === userId &&
            candidate.notificationType === 'funky:notification:global' &&
            !candidate.isActive
        )
      ) {
        return ok({
          isEligible: false,
          reason: 'campaign_disabled' as const,
          notification,
        });
      }

      return ok({
        isEligible: true,
        reason: 'eligible' as const,
        notification,
      });
    },

    async deactivate(notificationId) {
      const notificationIndex = notifications.findIndex(
        (notification) => notification.id === notificationId
      );
      if (notificationIndex !== -1) {
        notifications[notificationIndex] = {
          ...notifications[notificationIndex]!,
          isActive: false,
          updatedAt: new Date(),
        };
      }

      return ok(undefined);
    },

    async isUserGloballyUnsubscribed() {
      return ok(false);
    },
  };

  return {
    notificationsRepo,
    extendedNotificationsRepo,
  };
};

const testHasher = {
  sha256(value: string): string {
    return value;
  },
};

describe('makePublicDebateNotificationOrchestrator', () => {
  it('publishes thread_failed through the entity update pipeline and admin alerts when failureMessage is present', async () => {
    const notification = createTestNotification({
      id: 'notification-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const composeJobScheduler = {
      enqueue: vi.fn(async () => ok(undefined)),
    };
    const { notificationsRepo, extendedNotificationsRepo } = makeSharedNotificationRepos([
      notification,
    ]);
    const orchestrator = makePublicDebateNotificationOrchestrator({
      repo: makeInMemoryCorrespondenceRepo(),
      entityRepo: makeTestEntityRepo(),
      notificationsRepo,
      extendedNotificationsRepo,
      deliveryRepo,
      composeJobScheduler,
      hasher: testHasher,
      campaignAuditCcRecipients: ['Review@Test.Example.com'],
      logger: pinoLogger({ level: 'silent' }),
    });
    const thread = createThreadRecord({
      id: 'thread-failed',
      entityCui: '12345678',
      phase: 'failed',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Oras Test',
      }),
    });

    const result = await orchestrator.updatePublisher.publish({
      eventType: 'thread_failed',
      thread,
      occurredAt: new Date('2026-04-05T09:00:00.000Z'),
      failureMessage: 'Provider send failed',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('queued');
      expect(result.value.notificationIds).toEqual(['notification-1']);
      expect(result.value.createdOutboxIds).toHaveLength(2);
    }

    const entityUpdateOutbox = await deliveryRepo.findByDeliveryKey(
      'user-1:notification-1:funky:delivery:thread_failed_thread-failed'
    );
    expect(entityUpdateOutbox.isOk()).toBe(true);
    if (entityUpdateOutbox.isOk()) {
      expect(entityUpdateOutbox.value?.notificationType).toBe('funky:outbox:entity_update');
    }
    const adminFailureOutbox = await deliveryRepo.findByDeliveryKey(
      'admin:review@test.example.com:admin_failure:thread-failed'
    );
    expect(adminFailureOutbox.isOk()).toBe(true);
    if (adminFailureOutbox.isOk()) {
      expect(adminFailureOutbox.value?.notificationType).toBe('funky:outbox:admin_failure');
    }
    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(2);
  });

  it('publishes recovery-only thread_failed snapshots without admin failure fanout', async () => {
    const notification = createTestNotification({
      id: 'notification-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const composeJobScheduler = {
      enqueue: vi.fn(async () => ok(undefined)),
    };
    const { notificationsRepo, extendedNotificationsRepo } = makeSharedNotificationRepos([
      notification,
    ]);
    const orchestrator = makePublicDebateNotificationOrchestrator({
      repo: makeInMemoryCorrespondenceRepo(),
      entityRepo: makeTestEntityRepo(),
      notificationsRepo,
      extendedNotificationsRepo,
      deliveryRepo,
      composeJobScheduler,
      hasher: testHasher,
      campaignAuditCcRecipients: ['Review@Test.Example.com'],
      logger: pinoLogger({ level: 'silent' }),
    });
    const thread = createThreadRecord({
      id: 'thread-failed',
      entityCui: '12345678',
      phase: 'failed',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Oras Test',
      }),
    });

    const result = await orchestrator.updatePublisher.publish({
      eventType: 'thread_failed',
      thread,
      occurredAt: new Date('2026-04-05T09:00:00.000Z'),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('queued');
      expect(result.value.notificationIds).toEqual(['notification-1']);
      expect(result.value.createdOutboxIds).toHaveLength(1);
    }

    const entityUpdateOutbox = await deliveryRepo.findByDeliveryKey(
      'user-1:notification-1:funky:delivery:thread_failed_thread-failed'
    );
    expect(entityUpdateOutbox.isOk()).toBe(true);
    if (entityUpdateOutbox.isOk()) {
      expect(entityUpdateOutbox.value?.notificationType).toBe('funky:outbox:entity_update');
    }

    const adminFailureOutbox = await deliveryRepo.findByDeliveryKey(
      'admin:review@test.example.com:admin_failure:thread-failed'
    );
    expect(adminFailureOutbox.isOk()).toBe(true);
    if (adminFailureOutbox.isOk()) {
      expect(adminFailureOutbox.value).toBeNull();
    }

    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('publishes thread_started through the entity update pipeline only', async () => {
    const notification = createTestNotification({
      id: 'notification-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const composeJobScheduler = {
      enqueue: vi.fn(async () => ok(undefined)),
    };
    const { notificationsRepo, extendedNotificationsRepo } = makeSharedNotificationRepos([
      notification,
    ]);
    const orchestrator = makePublicDebateNotificationOrchestrator({
      repo: makeInMemoryCorrespondenceRepo(),
      entityRepo: makeTestEntityRepo(),
      notificationsRepo,
      extendedNotificationsRepo,
      deliveryRepo,
      composeJobScheduler,
      hasher: testHasher,
      campaignAuditCcRecipients: ['review@test.example.com'],
      logger: pinoLogger({ level: 'silent' }),
    });
    const thread = createThreadRecord({
      id: 'thread-started',
      entityCui: '12345678',
      phase: 'awaiting_reply',
      lastEmailAt: new Date('2026-04-05T08:00:00.000Z'),
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Oras Test',
      }),
    });

    const result = await orchestrator.updatePublisher.publish({
      eventType: 'thread_started',
      thread,
      occurredAt: new Date('2026-04-05T08:00:00.000Z'),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.status).toBe('queued');
      expect(result.value.notificationIds).toEqual(['notification-1']);
      expect(result.value.createdOutboxIds).toHaveLength(1);

      const createdOutbox = await deliveryRepo.findById(result.value.createdOutboxIds[0] ?? '');
      expect(createdOutbox.isOk()).toBe(true);
      if (createdOutbox.isOk()) {
        expect(createdOutbox.value?.notificationType).toBe('funky:outbox:entity_update');
      }
    }

    const adminFailureOutbox = await deliveryRepo.findByDeliveryKey(
      'admin:review@test.example.com:admin_failure:thread-started'
    );
    expect(adminFailureOutbox.isOk()).toBe(true);
    if (adminFailureOutbox.isOk()) {
      expect(adminFailureOutbox.value).toBeNull();
    }
    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('still enqueues admin failure alerts when entity update enqueue fails for thread_failed', async () => {
    const notification = createTestNotification({
      id: 'notification-1',
      userId: 'user-1',
      entityCui: '12345678',
      notificationType: 'funky:notification:entity_updates',
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const composeJobScheduler = {
      enqueue: vi.fn(async () => ok(undefined)),
    };
    const { notificationsRepo, extendedNotificationsRepo } = makeSharedNotificationRepos([
      notification,
    ]);
    const failingExtendedNotificationsRepo: ExtendedNotificationsRepository = {
      ...extendedNotificationsRepo,
      async findActiveByTypeAndEntity() {
        return err({
          type: 'DatabaseError',
          message: 'entity update lookup failed',
          retryable: true,
        });
      },
    };
    const orchestrator = makePublicDebateNotificationOrchestrator({
      repo: makeInMemoryCorrespondenceRepo(),
      entityRepo: makeTestEntityRepo(),
      notificationsRepo,
      extendedNotificationsRepo: failingExtendedNotificationsRepo,
      deliveryRepo,
      composeJobScheduler,
      hasher: testHasher,
      campaignAuditCcRecipients: ['Review@Test.Example.com'],
      logger: pinoLogger({ level: 'silent' }),
    });
    const thread = createThreadRecord({
      id: 'thread-failed',
      entityCui: '12345678',
      phase: 'failed',
      record: createThreadAggregateRecord({
        campaignKey: 'funky',
        submissionPath: 'platform_send',
        institutionEmail: 'contact@primarie.ro',
        subject: 'Cerere dezbatere buget local - Oras Test',
      }),
    });

    const result = await orchestrator.updatePublisher.publish({
      eventType: 'thread_failed',
      thread,
      occurredAt: new Date('2026-04-05T09:00:00.000Z'),
      failureMessage: 'Provider send failed',
    });

    expect(result.isErr()).toBe(true);

    const adminFailureOutbox = await deliveryRepo.findByDeliveryKey(
      'admin:review@test.example.com:admin_failure:thread-failed'
    );
    expect(adminFailureOutbox.isOk()).toBe(true);
    if (adminFailureOutbox.isOk()) {
      expect(adminFailureOutbox.value?.notificationType).toBe('funky:outbox:admin_failure');
    }
    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('ensures subscriptions and best-effort publishes the current snapshot', async () => {
    const deliveryRepo = makeFakeDeliveryRepo();
    const composeJobScheduler = {
      enqueue: vi.fn(async () => ok(undefined)),
    };
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          entityCui: '12345678',
          phase: 'awaiting_reply',
          lastEmailAt: new Date('2026-04-05T08:00:00.000Z'),
          record: createThreadAggregateRecord({
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Cerere dezbatere buget local - Oras Test',
          }),
        }),
      ],
    });
    const { notificationsRepo, extendedNotificationsRepo } = makeSharedNotificationRepos();
    const orchestrator = makePublicDebateNotificationOrchestrator({
      repo,
      entityRepo: makeTestEntityRepo(),
      notificationsRepo,
      extendedNotificationsRepo,
      deliveryRepo,
      composeJobScheduler,
      hasher: testHasher,
      campaignAuditCcRecipients: ['review@test.example.com'],
      logger: pinoLogger({ level: 'silent' }),
    });

    const result = await orchestrator.subscriptionService.ensureSubscribed('user-1', '12345678');

    expect(result.isOk()).toBe(true);

    const entitySubscriptionResult = await notificationsRepo.findByUserTypeAndEntity(
      'user-1',
      'funky:notification:entity_updates',
      '12345678'
    );
    expect(entitySubscriptionResult.isOk()).toBe(true);
    if (entitySubscriptionResult.isOk()) {
      const entitySubscription = entitySubscriptionResult.value;
      expect(entitySubscription).not.toBeNull();
      if (entitySubscription !== null) {
        const outboxResult = await deliveryRepo.findByDeliveryKey(
          `user-1:${entitySubscription.id}:funky:delivery:thread_started_thread-1`
        );
        expect(outboxResult.isOk()).toBe(true);
        if (outboxResult.isOk()) {
          expect(outboxResult.value?.notificationType).toBe('funky:outbox:entity_update');
        }
      }
    }
    expect(composeJobScheduler.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not publish a snapshot when the entity subscription remains inactive', async () => {
    const globalPreference = createTestNotification({
      id: 'global-notification',
      userId: 'user-1',
      notificationType: 'funky:notification:global',
      entityCui: null,
      isActive: false,
    });
    const deliveryRepo = makeFakeDeliveryRepo();
    const composeJobScheduler = {
      enqueue: vi.fn(async () => ok(undefined)),
    };
    const repo = makeInMemoryCorrespondenceRepo({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          entityCui: '12345678',
          phase: 'awaiting_reply',
          lastEmailAt: new Date('2026-04-05T08:00:00.000Z'),
          record: createThreadAggregateRecord({
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            institutionEmail: 'contact@primarie.ro',
            subject: 'Cerere dezbatere buget local - Oras Test',
          }),
        }),
      ],
    });
    const { notificationsRepo, extendedNotificationsRepo } = makeSharedNotificationRepos([
      globalPreference,
    ]);
    const orchestrator = makePublicDebateNotificationOrchestrator({
      repo,
      entityRepo: makeTestEntityRepo(),
      notificationsRepo,
      extendedNotificationsRepo,
      deliveryRepo,
      composeJobScheduler,
      hasher: testHasher,
      campaignAuditCcRecipients: ['review@test.example.com'],
      logger: pinoLogger({ level: 'silent' }),
    });

    const result = await orchestrator.subscriptionService.ensureSubscribed('user-1', '12345678');

    expect(result.isOk()).toBe(true);
    expect(composeJobScheduler.enqueue).not.toHaveBeenCalled();
  });
});
