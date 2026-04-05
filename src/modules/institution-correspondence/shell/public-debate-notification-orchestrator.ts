import { err, ok } from 'neverthrow';

import {
  enqueuePublicDebateAdminFailureNotifications,
  enqueuePublicDebateEntityUpdateNotifications,
  type ComposeJobScheduler,
  type DeliveryRepository,
  type ExtendedNotificationsRepository,
} from '@/modules/notification-delivery/index.js';
import {
  ensurePublicDebateAutoSubscriptions,
  type Hasher,
  type NotificationsRepository,
} from '@/modules/notifications/index.js';

import { createDatabaseError as createCorrespondenceDatabaseError } from '../core/errors.js';
import { PUBLIC_DEBATE_REQUEST_TYPE } from '../core/types.js';
import { publishCurrentPlatformSendUpdate } from '../core/usecases/publish-current-platform-send-update.js';

import type {
  InstitutionCorrespondenceRepository,
  PublicDebateEntityUpdateNotification,
  PublicDebateEntitySubscriptionService,
  PublicDebateEntityUpdatePublishResult,
  PublicDebateEntityUpdatePublisher,
} from '../core/ports.js';
import type { EntityRepository } from '@/modules/entity/index.js';
import type { Logger } from 'pino';

export interface MakePublicDebateNotificationOrchestratorDeps {
  repo: InstitutionCorrespondenceRepository;
  entityRepo: EntityRepository;
  notificationsRepo: NotificationsRepository;
  extendedNotificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
  hasher: Hasher;
  campaignAuditCcRecipients: string[];
  logger: Logger;
}

export interface PublicDebateNotificationOrchestrator {
  updatePublisher: PublicDebateEntityUpdatePublisher;
  subscriptionService: PublicDebateEntitySubscriptionService;
}

const buildReplyTextPreview = (
  input: PublicDebateEntityUpdateNotification['reply']
): string | null => {
  const textBody = input?.textBody?.trim();
  if (textBody === undefined || textBody === '') {
    return null;
  }

  return textBody.length > 400 ? `${textBody.slice(0, 397)}...` : textBody;
};

const buildRunIdParts = (input: PublicDebateEntityUpdateNotification): string[] => {
  const runIdParts = [input.eventType, input.thread.id];
  if (input.reply !== undefined) {
    runIdParts.push(input.reply.id);
  } else if (input.basedOnEntryId !== undefined) {
    runIdParts.push(input.basedOnEntryId);
  }

  return runIdParts;
};

const emptyPublishResult = (): PublicDebateEntityUpdatePublishResult => ({
  status: 'none',
  notificationIds: [],
  createdOutboxIds: [],
  reusedOutboxIds: [],
  queuedOutboxIds: [],
  enqueueFailedOutboxIds: [],
});

const loadEntityName = async (
  entityRepo: EntityRepository,
  input: PublicDebateEntityUpdateNotification,
  logger: Logger
): Promise<string> => {
  let entityName = input.thread.entityCui;
  const entityResult = await entityRepo.getById(input.thread.entityCui);
  if (entityResult.isErr()) {
    logger.warn(
      {
        error: entityResult.error,
        entityCui: input.thread.entityCui,
        eventType: input.eventType,
        threadId: input.thread.id,
      },
      'Failed to load entity name for public debate update notification'
    );
  } else if (entityResult.value?.name !== undefined && entityResult.value.name.trim() !== '') {
    entityName = entityResult.value.name;
  }

  return entityName;
};

const publishEntityUpdate = async (
  deps: Pick<
    MakePublicDebateNotificationOrchestratorDeps,
    'extendedNotificationsRepo' | 'deliveryRepo' | 'composeJobScheduler'
  > & {
    entityName: string;
    logger: Logger;
  },
  input: PublicDebateEntityUpdateNotification
) => {
  const enqueueResult = await enqueuePublicDebateEntityUpdateNotifications(
    {
      notificationsRepo: deps.extendedNotificationsRepo,
      deliveryRepo: deps.deliveryRepo,
      composeJobScheduler: deps.composeJobScheduler,
    },
    {
      runId: `public-debate-${buildRunIdParts(input).join('-')}`,
      eventType: input.eventType,
      entityCui: input.thread.entityCui,
      entityName: deps.entityName,
      threadId: input.thread.id,
      threadKey: input.thread.threadKey,
      phase: input.thread.phase,
      institutionEmail: input.thread.record.institutionEmail,
      subject: input.thread.record.subject,
      occurredAt: input.occurredAt.toISOString(),
      ...(input.reply !== undefined ? { replyEntryId: input.reply.id } : {}),
      ...(input.reply !== undefined
        ? { replyTextPreview: buildReplyTextPreview(input.reply) }
        : {}),
      ...(input.basedOnEntryId !== undefined ? { basedOnEntryId: input.basedOnEntryId } : {}),
      ...(input.resolutionCode !== undefined ? { resolutionCode: input.resolutionCode } : {}),
      ...(input.reviewNotes !== undefined ? { reviewNotes: input.reviewNotes } : {}),
    }
  );

  if (enqueueResult.isErr()) {
    deps.logger.error(
      {
        error: enqueueResult.error,
        entityCui: input.thread.entityCui,
        eventType: input.eventType,
        threadId: input.thread.id,
      },
      'Failed to enqueue public debate entity update notifications'
    );
    return err(
      createCorrespondenceDatabaseError(
        'Failed to enqueue public debate entity update notifications',
        enqueueResult.error
      )
    );
  }

  if (enqueueResult.value.enqueueFailedOutboxIds.length > 0) {
    deps.logger.warn(
      {
        entityCui: input.thread.entityCui,
        eventType: input.eventType,
        outboxIds: enqueueResult.value.enqueueFailedOutboxIds,
        threadId: input.thread.id,
      },
      'Public debate update outbox rows were created but compose jobs were not enqueued'
    );
  }

  return ok({
    status:
      enqueueResult.value.notificationIds.length === 0
        ? 'none'
        : enqueueResult.value.enqueueFailedOutboxIds.length > 0
          ? 'partial'
          : 'queued',
    notificationIds: enqueueResult.value.notificationIds,
    createdOutboxIds: enqueueResult.value.createdOutboxIds,
    reusedOutboxIds: enqueueResult.value.reusedOutboxIds,
    queuedOutboxIds: enqueueResult.value.queuedOutboxIds,
    enqueueFailedOutboxIds: enqueueResult.value.enqueueFailedOutboxIds,
  } satisfies PublicDebateEntityUpdatePublishResult);
};

const publishAdminFailureUpdate = async (
  deps: Pick<
    MakePublicDebateNotificationOrchestratorDeps,
    'deliveryRepo' | 'composeJobScheduler' | 'campaignAuditCcRecipients'
  > & {
    entityName: string;
    logger: Logger;
  },
  input: PublicDebateEntityUpdateNotification
) => {
  if (input.failureMessage === undefined || input.failureMessage === null) {
    return ok(emptyPublishResult());
  }

  if (deps.campaignAuditCcRecipients.length === 0) {
    deps.logger.info(
      {
        entityCui: input.thread.entityCui,
        eventType: input.eventType,
        threadId: input.thread.id,
      },
      'Skipping public debate admin failure alert because no audit recipients are configured'
    );
    return ok(emptyPublishResult());
  }

  const adminFailureResult = await enqueuePublicDebateAdminFailureNotifications(
    {
      deliveryRepo: deps.deliveryRepo,
      composeJobScheduler: deps.composeJobScheduler,
    },
    {
      runId: `public-debate-admin-${buildRunIdParts(input).join('-')}`,
      recipientEmails: deps.campaignAuditCcRecipients,
      entityCui: input.thread.entityCui,
      entityName: deps.entityName,
      threadId: input.thread.id,
      threadKey: input.thread.threadKey,
      phase: input.thread.phase,
      institutionEmail: input.thread.record.institutionEmail,
      subject: input.thread.record.subject,
      occurredAt: input.occurredAt.toISOString(),
      failureMessage: input.failureMessage,
    }
  );

  if (adminFailureResult.isErr()) {
    deps.logger.error(
      {
        error: adminFailureResult.error,
        entityCui: input.thread.entityCui,
        eventType: input.eventType,
        threadId: input.thread.id,
      },
      'Failed to enqueue public debate admin failure notifications'
    );
    return err(
      createCorrespondenceDatabaseError(
        'Failed to enqueue public debate admin failure notifications',
        adminFailureResult.error
      )
    );
  }

  if (adminFailureResult.value.enqueueFailedOutboxIds.length > 0) {
    deps.logger.warn(
      {
        entityCui: input.thread.entityCui,
        eventType: input.eventType,
        outboxIds: adminFailureResult.value.enqueueFailedOutboxIds,
        threadId: input.thread.id,
      },
      'Public debate admin failure outbox rows were created but compose jobs were not enqueued'
    );
  }

  return ok({
    status:
      adminFailureResult.value.recipientEmails.length === 0
        ? 'none'
        : adminFailureResult.value.enqueueFailedOutboxIds.length > 0
          ? 'partial'
          : 'queued',
    notificationIds: [],
    createdOutboxIds: adminFailureResult.value.createdOutboxIds,
    reusedOutboxIds: adminFailureResult.value.reusedOutboxIds,
    queuedOutboxIds: adminFailureResult.value.queuedOutboxIds,
    enqueueFailedOutboxIds: adminFailureResult.value.enqueueFailedOutboxIds,
  } satisfies PublicDebateEntityUpdatePublishResult);
};

const combinePublishResults = (
  entityUpdateResult: PublicDebateEntityUpdatePublishResult,
  adminFailureResult: PublicDebateEntityUpdatePublishResult
): PublicDebateEntityUpdatePublishResult => {
  const hasAnyRecipients =
    entityUpdateResult.notificationIds.length > 0 ||
    adminFailureResult.createdOutboxIds.length > 0 ||
    adminFailureResult.reusedOutboxIds.length > 0;
  const enqueueFailedOutboxIds = [
    ...entityUpdateResult.enqueueFailedOutboxIds,
    ...adminFailureResult.enqueueFailedOutboxIds,
  ];

  return {
    status: !hasAnyRecipients ? 'none' : enqueueFailedOutboxIds.length > 0 ? 'partial' : 'queued',
    notificationIds: entityUpdateResult.notificationIds,
    createdOutboxIds: [
      ...entityUpdateResult.createdOutboxIds,
      ...adminFailureResult.createdOutboxIds,
    ],
    reusedOutboxIds: [...entityUpdateResult.reusedOutboxIds, ...adminFailureResult.reusedOutboxIds],
    queuedOutboxIds: [...entityUpdateResult.queuedOutboxIds, ...adminFailureResult.queuedOutboxIds],
    enqueueFailedOutboxIds,
  };
};

export const makePublicDebateNotificationOrchestrator = (
  deps: MakePublicDebateNotificationOrchestratorDeps
): PublicDebateNotificationOrchestrator => {
  const logger = deps.logger.child({ component: 'PublicDebateNotificationOrchestrator' });

  const updatePublisher: PublicDebateEntityUpdatePublisher = {
    async publish(input) {
      const entityName = await loadEntityName(deps.entityRepo, input, logger);
      const entityUpdateResult = await publishEntityUpdate(
        {
          extendedNotificationsRepo: deps.extendedNotificationsRepo,
          deliveryRepo: deps.deliveryRepo,
          composeJobScheduler: deps.composeJobScheduler,
          entityName,
          logger,
        },
        input
      );
      if (input.eventType !== 'thread_failed') {
        return entityUpdateResult;
      }

      const adminFailureResult = await publishAdminFailureUpdate(
        {
          deliveryRepo: deps.deliveryRepo,
          composeJobScheduler: deps.composeJobScheduler,
          campaignAuditCcRecipients: deps.campaignAuditCcRecipients,
          entityName,
          logger,
        },
        input
      );
      if (adminFailureResult.isErr()) {
        return adminFailureResult;
      }

      if (entityUpdateResult.isErr()) {
        return entityUpdateResult;
      }

      return ok(combinePublishResults(entityUpdateResult.value, adminFailureResult.value));
    },
  };

  const subscriptionService: PublicDebateEntitySubscriptionService = {
    async ensureSubscribed(userId, entityCui) {
      const subscriptionResult = await ensurePublicDebateAutoSubscriptions(
        {
          notificationsRepo: deps.notificationsRepo,
          hasher: deps.hasher,
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
          repo: deps.repo,
          updatePublisher,
        },
        {
          entityCui,
          campaign: PUBLIC_DEBATE_REQUEST_TYPE,
        }
      );

      if (snapshotResult.isErr()) {
        logger.warn(
          {
            error: snapshotResult.error,
            userId,
            entityCui,
          },
          'Failed to publish current public debate platform update after ensuring subscription'
        );
        return ok(undefined);
      }

      logger.debug(
        {
          userId,
          entityCui,
          status: snapshotResult.value.status,
          eventType: snapshotResult.value.eventType,
          threadId: snapshotResult.value.thread?.id,
          notificationStatus: snapshotResult.value.publishResult?.status,
        },
        'Processed current public debate platform update after ensuring subscription'
      );

      return ok(undefined);
    },
  };

  return {
    updatePublisher,
    subscriptionService,
  };
};
