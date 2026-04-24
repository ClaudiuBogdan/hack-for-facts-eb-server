import { randomUUID } from 'crypto';

import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { vi } from 'vitest';

import {
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_NOTIFICATION_GLOBAL_TYPE,
} from '@/common/campaign-keys.js';
import {
  makeCampaignAdminThreadNotificationService,
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
  buildPublicDebateEntityAudienceSummaryKey,
  type DeliveryRepository,
  type ExtendedNotificationsRepository,
  type PublicDebateEntityAudienceSummaryReader,
} from '@/modules/notification-delivery/index.js';
import {
  ensurePublicDebateAutoSubscriptions,
  generateNotificationHash,
  sha256Hasher,
  type Notification,
  type NotificationError,
  type NotificationType,
  type NotificationsRepository,
} from '@/modules/notifications/index.js';

import { makeFakeDeliveryRepo } from './fakes.js';
import { makeInMemoryCorrespondenceRepo } from '../unit/institution-correspondence/fake-repo.js';

import type { EntityRepository } from '@/modules/entity/index.js';

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
  audienceSummaryReader: PublicDebateEntityAudienceSummaryReader;
} => {
  const store = new Map<string, Notification>();

  const applyManualOptIn = (userId: string, notificationType: NotificationType): void => {
    const updatedAt = new Date();
    const enabledGlobalConfig = { channels: { email: true } };

    for (const notification of store.values()) {
      if (
        notification.userId === userId &&
        notification.notificationType === 'global_unsubscribe'
      ) {
        store.set(notification.id, {
          ...notification,
          isActive: true,
          config: enabledGlobalConfig,
          hash: generateNotificationHash(
            sha256Hasher,
            userId,
            'global_unsubscribe',
            null,
            enabledGlobalConfig
          ),
          updatedAt,
        });
      }
    }

    if (notificationType !== FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE) {
      return;
    }

    for (const notification of store.values()) {
      if (
        notification.userId === userId &&
        notification.notificationType === FUNKY_NOTIFICATION_GLOBAL_TYPE
      ) {
        store.set(notification.id, { ...notification, isActive: true, updatedAt });
        return;
      }
    }

    const id = randomUUID();
    store.set(id, {
      id,
      userId,
      entityCui: null,
      notificationType: FUNKY_NOTIFICATION_GLOBAL_TYPE,
      isActive: true,
      config: null,
      hash: generateNotificationHash(
        sha256Hasher,
        userId,
        FUNKY_NOTIFICATION_GLOBAL_TYPE,
        null,
        null
      ),
      createdAt: updatedAt,
      updatedAt,
    });
  };

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

    async createWithManualOptIn(input) {
      const result = await this.create(input);
      if (result.isOk()) {
        applyManualOptIn(result.value.userId, result.value.notificationType);
      }
      return result;
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

    async updateWithManualOptIn(notificationId, input) {
      const result = await this.update(notificationId, input);
      if (result.isOk()) {
        applyManualOptIn(result.value.userId, result.value.notificationType);
      }
      return result;
    },

    async updateCampaignGlobalPreference(notificationId, input) {
      const existing = store.get(notificationId);
      if (existing === undefined) {
        return err({
          type: 'NotificationNotFoundError',
          message: `Notification with ID '${notificationId}' not found`,
          id: notificationId,
        } satisfies NotificationError);
      }

      const updatedAt = new Date();
      const updatedGlobal: Notification = {
        ...existing,
        isActive: input.isActive,
        ...(input.config !== undefined ? { config: input.config } : {}),
        ...(input.hash !== undefined ? { hash: input.hash } : {}),
        updatedAt,
      };
      store.set(notificationId, updatedGlobal);

      if (!input.isActive) {
        for (const notification of store.values()) {
          if (
            notification.userId !== updatedGlobal.userId ||
            notification.notificationType !== FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE ||
            !notification.isActive
          ) {
            continue;
          }

          store.set(notification.id, {
            ...notification,
            isActive: false,
            updatedAt,
          });
        }
      }

      return ok(updatedGlobal);
    },

    async applyManualNotificationOptIn(input) {
      applyManualOptIn(input.userId, input.notificationType);
      return ok(undefined);
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

    async findEligibleByUserTypeAndEntity(
      userId: string,
      notificationType: NotificationType,
      entityCui: string
    ) {
      const notification =
        [...store.values()].find(
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

      const globallyUnsubscribed = [...store.values()].some(
        (candidate) =>
          candidate.userId === userId &&
          candidate.notificationType === 'global_unsubscribe' &&
          !candidate.isActive
      );

      if (globallyUnsubscribed) {
        return ok({
          isEligible: false,
          reason: 'global_unsubscribe' as const,
          notification,
        });
      }

      if (
        notificationType === FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE &&
        [...store.values()].some(
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

  const audienceSummaryReader = {
    async summarize(inputs) {
      const summaries = new Map<
        string,
        {
          requesterCount: number;
          subscriberCount: number;
          eligibleRequesterCount: number;
          eligibleSubscriberCount: number;
        }
      >();

      for (const input of inputs) {
        const rawUsers = [...store.values()]
          .filter(
            (notification) =>
              notification.notificationType === FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE &&
              notification.entityCui === input.entityCui &&
              notification.isActive
          )
          .map((notification) => notification.userId);
        const requesterUserId =
          input.requesterUserId === null || input.requesterUserId.trim() === ''
            ? null
            : input.requesterUserId.trim();
        const eligibleUsers = rawUsers.filter((userId) => {
          const globallyUnsubscribed = [...store.values()].some((candidate) => {
            if (
              candidate.userId !== userId ||
              candidate.notificationType !== 'global_unsubscribe'
            ) {
              return false;
            }

            if (!candidate.isActive) {
              return true;
            }

            const channels = (candidate.config as Record<string, unknown> | null)?.['channels'] as
              | Record<string, unknown>
              | undefined;
            return channels?.['email'] === false;
          });

          if (globallyUnsubscribed) {
            return false;
          }

          return ![...store.values()].some(
            (candidate) =>
              candidate.userId === userId &&
              candidate.notificationType === 'funky:notification:global' &&
              !candidate.isActive
          );
        });
        const requesterCount =
          requesterUserId !== null && rawUsers.includes(requesterUserId) ? 1 : 0;
        const eligibleRequesterCount =
          requesterUserId !== null && eligibleUsers.includes(requesterUserId) ? 1 : 0;

        summaries.set(
          buildPublicDebateEntityAudienceSummaryKey({
            entityCui: input.entityCui,
            requesterUserId,
          }),
          {
            requesterCount,
            subscriberCount: rawUsers.length - requesterCount,
            eligibleRequesterCount,
            eligibleSubscriberCount: eligibleUsers.length - eligibleRequesterCount,
          }
        );
      }

      return ok(summaries);
    },
  } satisfies PublicDebateEntityAudienceSummaryReader;

  return {
    notificationsRepo,
    extendedNotificationsRepo,
    audienceSummaryReader,
  };
};

export interface PublicDebateNotificationHarness {
  correspondenceRepo: ReturnType<typeof makeInMemoryCorrespondenceRepo>;
  notificationsRepo: NotificationsRepository;
  extendedNotificationsRepo: ExtendedNotificationsRepository;
  audienceSummaryReader: PublicDebateEntityAudienceSummaryReader;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: {
    enqueue: ReturnType<typeof vi.fn>;
  };
  entityRepo: EntityRepository;
  threadNotificationService: ReturnType<typeof makeCampaignAdminThreadNotificationService>;
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
  const { notificationsRepo, extendedNotificationsRepo, audienceSummaryReader } =
    createSharedNotificationsRepo();
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
  const threadNotificationService = makeCampaignAdminThreadNotificationService({
    entityRepo,
    audienceSummaryReader,
    extendedNotificationsRepo,
    deliveryRepo,
    composeJobScheduler,
    logger: pinoLogger({ level: 'silent' }),
  });
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
    audienceSummaryReader,
    deliveryRepo,
    composeJobScheduler,
    entityRepo,
    threadNotificationService,
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
