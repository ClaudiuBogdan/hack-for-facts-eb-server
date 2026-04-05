import { randomUUID } from 'crypto';

import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { vi } from 'vitest';

import {
  makePublicDebateNotificationOrchestrator,
  PUBLIC_DEBATE_REQUEST_TYPE,
  createDatabaseError as createCorrespondenceDatabaseError,
  publishCurrentPlatformSendUpdate,
  requestPublicDebatePlatformSend,
  type PublicDebateEntitySubscriptionService,
  type SendPlatformRequestInput,
  type ThreadRecord,
} from '@/modules/institution-correspondence/index.js';
import {
  ensurePublicDebateAutoSubscriptions,
  sha256Hasher,
  type Notification,
  type NotificationError,
  type NotificationType,
  type NotificationsRepository,
} from '@/modules/notifications/index.js';

import { makeFakeDeliveryRepo } from './fakes.js';
import { makeInMemoryCorrespondenceRepo } from '../unit/institution-correspondence/fake-repo.js';

import type { EntityRepository } from '@/modules/entity/index.js';
import type {
  DeliveryRepository,
  ExtendedNotificationsRepository,
} from '@/modules/notification-delivery/index.js';

const DEFAULT_ENTITY_NAME = 'Oras Test';

const makeTestEntityRepo = (entityNames: Record<string, string>): EntityRepository => ({
  async getById(cui) {
    const name = entityNames[cui] ?? DEFAULT_ENTITY_NAME;

    return ok({
      cui,
      name,
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
  async getByIds(cuis) {
    return ok(
      new Map(
        cuis.map((cui) => [
          cui,
          {
            cui,
            name: entityNames[cui] ?? DEFAULT_ENTITY_NAME,
            entity_type: null,
            default_report_type: 'Executie bugetara detaliata',
            uat_id: null,
            is_uat: true,
            address: null,
            last_updated: null,
            main_creditor_1_cui: null,
            main_creditor_2_cui: null,
          },
        ])
      )
    );
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
});

const createSharedNotificationsRepo = (): {
  notificationsRepo: NotificationsRepository;
  extendedNotificationsRepo: ExtendedNotificationsRepository;
} => {
  const store = new Map<string, Notification>();

  const notificationsRepo: NotificationsRepository = {
    async create(input) {
      const now = new Date();
      const notification: Notification = {
        id: randomUUID(),
        userId: input.userId,
        entityCui: input.entityCui,
        notificationType: input.notificationType,
        isActive: true,
        config: input.config,
        hash: input.hash,
        createdAt: now,
        updatedAt: now,
      };
      store.set(notification.id, notification);
      return ok(notification);
    },

    async findById(notificationId) {
      return ok(store.get(notificationId) ?? null);
    },

    async findByHash(hash) {
      return ok([...store.values()].find((notification) => notification.hash === hash) ?? null);
    },

    async findByUserId(userId, activeOnly) {
      return ok(
        [...store.values()].filter(
          (notification) => notification.userId === userId && (!activeOnly || notification.isActive)
        )
      );
    },

    async findByUserAndEntity(userId, entityCui, activeOnly) {
      return ok(
        [...store.values()].filter(
          (notification) =>
            notification.userId === userId &&
            notification.entityCui === entityCui &&
            (!activeOnly || notification.isActive)
        )
      );
    },

    async findByUserTypeAndEntity(userId, notificationType, entityCui) {
      return ok(
        [...store.values()].find(
          (notification) =>
            notification.userId === userId &&
            notification.notificationType === notificationType &&
            notification.entityCui === entityCui
        ) ?? null
      );
    },

    async update(notificationId, input) {
      const existing = store.get(notificationId);
      if (existing === undefined) {
        return err({
          type: 'NotificationNotFoundError',
          message: `Notification with ID '${notificationId}' not found`,
          id: notificationId,
        } satisfies NotificationError);
      }

      const updated: Notification = {
        ...existing,
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.config !== undefined ? { config: input.config } : {}),
        ...(input.hash !== undefined ? { hash: input.hash } : {}),
        updatedAt: new Date(),
      };
      store.set(notificationId, updated);
      return ok(updated);
    },

    async deleteCascade(notificationId) {
      const existing = store.get(notificationId) ?? null;
      if (existing !== null) {
        store.delete(notificationId);
      }
      return ok(existing);
    },

    async deactivateGlobalUnsubscribe() {
      return ok(undefined);
    },
  };

  const extendedNotificationsRepo = {
    async findById(notificationId) {
      return ok(store.get(notificationId) ?? null);
    },

    async findEligibleForDelivery() {
      return ok([]);
    },

    async findActiveByTypeAndEntity(notificationType: NotificationType, entityCui: string) {
      return ok(
        [...store.values()].filter((notification) => {
          if (
            notification.notificationType !== notificationType ||
            notification.entityCui !== entityCui ||
            !notification.isActive
          ) {
            return false;
          }

          return ![...store.values()].some(
            (candidate) =>
              candidate.userId === notification.userId &&
              candidate.notificationType === 'funky:notification:global' &&
              !candidate.isActive
          );
        })
      );
    },

    async findActiveByType(notificationType: NotificationType) {
      return ok(
        [...store.values()].filter((notification) => {
          if (notification.notificationType !== notificationType || !notification.isActive) {
            return false;
          }

          return ![...store.values()].some(
            (candidate) =>
              candidate.userId === notification.userId &&
              candidate.notificationType === 'funky:notification:global' &&
              !candidate.isActive
          );
        })
      );
    },

    async deactivate(notificationId) {
      const existing = store.get(notificationId);
      if (existing !== undefined) {
        store.set(notificationId, {
          ...existing,
          isActive: false,
          updatedAt: new Date(),
        });
      }
      return ok(undefined);
    },

    async isUserGloballyUnsubscribed(userId) {
      return ok(
        [...store.values()].some(
          (notification) =>
            notification.userId === userId &&
            notification.notificationType === 'global_unsubscribe' &&
            (!notification.isActive ||
              (
                (notification.config as Record<string, unknown> | null)?.['channels'] as
                  | Record<string, unknown>
                  | undefined
              )?.['email'] === false)
        )
      );
    },
  } satisfies ExtendedNotificationsRepository;

  return {
    notificationsRepo,
    extendedNotificationsRepo,
  };
};

export interface PublicDebateNotificationHarness {
  correspondenceRepo: ReturnType<typeof makeInMemoryCorrespondenceRepo>;
  notificationsRepo: NotificationsRepository;
  extendedNotificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: {
    enqueue: ReturnType<typeof vi.fn>;
  };
  entityRepo: EntityRepository;
  updatePublisher: ReturnType<typeof makePublicDebateNotificationOrchestrator>['updatePublisher'];
  subscriptionService: PublicDebateEntitySubscriptionService;
  send: ReturnType<typeof vi.fn>;
  snapshotResults: Awaited<ReturnType<typeof publishCurrentPlatformSendUpdate>>[];
  requestPlatformSend(
    input: SendPlatformRequestInput
  ): ReturnType<typeof requestPublicDebatePlatformSend>;
  findOutboxById: DeliveryRepository['findById'];
}

export const createPublicDebateNotificationHarness = (
  input: {
    threads?: ThreadRecord[];
    entityNames?: Record<string, string>;
    auditCcRecipients?: string[];
  } = {}
): PublicDebateNotificationHarness => {
  const correspondenceRepo = makeInMemoryCorrespondenceRepo({
    ...(input.threads !== undefined ? { threads: input.threads } : {}),
  });
  const { notificationsRepo, extendedNotificationsRepo } = createSharedNotificationsRepo();
  const deliveryRepo = makeFakeDeliveryRepo();
  const composeJobScheduler = {
    enqueue: vi.fn(async () => ok(undefined)),
  };
  const entityRepo = makeTestEntityRepo(input.entityNames ?? {});
  const updatePublisher = makePublicDebateNotificationOrchestrator({
    repo: correspondenceRepo,
    entityRepo,
    notificationsRepo,
    extendedNotificationsRepo,
    deliveryRepo,
    composeJobScheduler,
    hasher: sha256Hasher,
    campaignAuditCcRecipients: input.auditCcRecipients ?? [],
    logger: pinoLogger({ level: 'silent' }),
  }).updatePublisher;
  const snapshotResults: Awaited<ReturnType<typeof publishCurrentPlatformSendUpdate>>[] = [];
  const subscriptionService: PublicDebateEntitySubscriptionService = {
    async ensureSubscribed(userId: string, entityCui: string) {
      const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
        {
          notificationsRepo,
          hasher: sha256Hasher,
        },
        {
          userId,
          entityCui,
        }
      );

      if (subscriptionResult.isErr()) {
        return err(
          createCorrespondenceDatabaseError(
            'Failed to ensure public debate notification subscriptions',
            subscriptionResult.error
          )
        );
      }

      if (!subscriptionResult.value.entitySubscription.isActive) {
        return ok(undefined);
      }

      const snapshotResult = await publishCurrentPlatformSendUpdate(
        {
          repo: correspondenceRepo,
          updatePublisher,
        },
        {
          entityCui,
          campaign: PUBLIC_DEBATE_REQUEST_TYPE,
        }
      );
      snapshotResults.push(snapshotResult);

      if (snapshotResult.isErr()) {
        return err(snapshotResult.error);
      }

      return ok(undefined);
    },
  };
  const send = vi.fn(async () => ok({ emailId: 'email-ignored' }));

  return {
    correspondenceRepo,
    notificationsRepo,
    extendedNotificationsRepo,
    deliveryRepo,
    composeJobScheduler,
    entityRepo,
    updatePublisher,
    subscriptionService,
    send,
    snapshotResults,
    requestPlatformSend(input) {
      return requestPublicDebatePlatformSend(
        {
          repo: correspondenceRepo,
          emailSender: {
            getFromAddress() {
              return 'noreply@transparenta.eu';
            },
            send,
          },
          templateRenderer: {
            renderPublicDebateRequest() {
              return {
                subject: 'unused',
                text: 'unused',
                html: '<p>unused</p>',
              };
            },
          },
          auditCcRecipients: [],
          platformBaseUrl: 'https://transparenta.test',
          captureAddress: 'debate@transparenta.test',
          subscriptionService,
        },
        input
      );
    },
    findOutboxById(outboxId: string) {
      return deliveryRepo.findById(outboxId);
    },
  };
};
