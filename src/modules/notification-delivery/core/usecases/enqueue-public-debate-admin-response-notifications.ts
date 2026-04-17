import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
  FUNKY_OUTBOX_ADMIN_RESPONSE_TYPE,
  PUBLIC_DEBATE_CAMPAIGN_KEY,
} from '@/common/campaign-keys.js';

import {
  PUBLIC_DEBATE_ADMIN_RESPONSE_EVENT_TYPE,
  PUBLIC_DEBATE_ADMIN_RESPONSE_FAMILY_ID,
  parsePublicDebateAdminResponseOutboxMetadata,
  type PublicDebateAdminResponseOutboxMetadata,
  type PublicDebateAdminResponseRecipientRole,
  type PublicDebateAdminResponseStatus,
} from '../admin-response.js';
import {
  enqueueCreatedOrReusedOutbox,
  type ReusedOutboxComposeStrategy,
} from './enqueue-created-or-reused-outbox.js';
import {
  buildPublicDebateAdminResponseDeliveryKey,
  buildPublicDebateAdminResponseScopeKey,
} from './public-debate-admin-response-keys.js';
import { createValidationError, type DeliveryError } from '../errors.js';

import type {
  ComposeJobScheduler,
  DeliveryRepository,
  ExtendedNotificationsRepository,
} from '../ports.js';

export interface PublicDebateAdminResponseNotificationInput {
  runId: string;
  triggerSource?: string;
  triggeredByUserId?: string;
  reusedOutboxComposeStrategy?: ReusedOutboxComposeStrategy;
  entityCui: string;
  entityName: string;
  threadId: string;
  threadKey: string;
  responseEventId: string;
  responseStatus: PublicDebateAdminResponseStatus;
  responseDate: string;
  messageContent: string;
  ownerUserId?: string | null;
}

export interface EnqueuePublicDebateAdminResponseNotificationsDeps {
  notificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export interface EnqueuePublicDebateAdminResponseNotificationsResult {
  notificationIds: string[];
  createdOutboxIds: string[];
  reusedOutboxIds: string[];
  queuedOutboxIds: string[];
  skippedTerminalOutboxIds: string[];
  enqueueFailedOutboxIds: string[];
}

const normalizeOwnerUserId = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const buildRecipientRole = (
  ownerUserId: string | null,
  recipientUserId: string
): PublicDebateAdminResponseRecipientRole => {
  if (ownerUserId === null) {
    return 'subscriber';
  }

  return recipientUserId === ownerUserId ? 'requester' : 'subscriber';
};

const buildMetadata = (
  input: PublicDebateAdminResponseNotificationInput,
  recipientRole: PublicDebateAdminResponseRecipientRole
): Result<PublicDebateAdminResponseOutboxMetadata, DeliveryError> => {
  const candidate: Record<string, unknown> = {
    campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
    familyId: PUBLIC_DEBATE_ADMIN_RESPONSE_FAMILY_ID,
    eventType: PUBLIC_DEBATE_ADMIN_RESPONSE_EVENT_TYPE,
    entityCui: input.entityCui,
    entityName: input.entityName,
    threadId: input.threadId,
    threadKey: input.threadKey,
    responseEventId: input.responseEventId,
    responseStatus: input.responseStatus,
    responseDate: input.responseDate,
    messageContent: input.messageContent,
    recipientRole,
    ...(input.triggerSource !== undefined ? { triggerSource: input.triggerSource } : {}),
    ...(input.triggeredByUserId !== undefined
      ? { triggeredByUserId: input.triggeredByUserId }
      : {}),
  };

  const metadataResult = parsePublicDebateAdminResponseOutboxMetadata(candidate);
  if (metadataResult.isErr()) {
    return err(createValidationError(metadataResult.error));
  }

  return ok(metadataResult.value);
};

export const enqueuePublicDebateAdminResponseNotifications = async (
  deps: EnqueuePublicDebateAdminResponseNotificationsDeps,
  input: PublicDebateAdminResponseNotificationInput
): Promise<Result<EnqueuePublicDebateAdminResponseNotificationsResult, DeliveryError>> => {
  const reusedOutboxComposeStrategy = input.reusedOutboxComposeStrategy ?? 'always_enqueue_compose';
  const ownerUserId = normalizeOwnerUserId(input.ownerUserId);
  const scopeKey = buildPublicDebateAdminResponseScopeKey({
    threadId: input.threadId,
    responseEventId: input.responseEventId,
  });
  const notificationsResult = await deps.notificationsRepo.findActiveByTypeAndEntity(
    FUNKY_NOTIFICATION_ENTITY_UPDATES_TYPE,
    input.entityCui
  );

  if (notificationsResult.isErr()) {
    return err(notificationsResult.error);
  }

  const notificationsByUserId = new Map<string, (typeof notificationsResult.value)[number]>();
  for (const notification of notificationsResult.value) {
    if (!notificationsByUserId.has(notification.userId)) {
      notificationsByUserId.set(notification.userId, notification);
    }
  }
  const uniqueNotifications = [...notificationsByUserId.values()];

  const createdOutboxIds: string[] = [];
  const reusedOutboxIds: string[] = [];
  const queuedOutboxIds: string[] = [];
  const skippedTerminalOutboxIds: string[] = [];
  const enqueueFailedOutboxIds: string[] = [];

  for (const notification of uniqueNotifications) {
    const recipientRole = buildRecipientRole(ownerUserId, notification.userId);
    const metadataResult = buildMetadata(input, recipientRole);
    if (metadataResult.isErr()) {
      return err(metadataResult.error);
    }

    const deliveryKey = buildPublicDebateAdminResponseDeliveryKey({
      userId: notification.userId,
      notificationId: notification.id,
      scopeKey,
    });
    const enqueueResult = await enqueueCreatedOrReusedOutbox(
      {
        deliveryRepo: deps.deliveryRepo,
        composeJobScheduler: deps.composeJobScheduler,
      },
      {
        runId: input.runId,
        deliveryKey,
        reusedOutboxComposeStrategy,
        createInput: {
          userId: notification.userId,
          notificationType: FUNKY_OUTBOX_ADMIN_RESPONSE_TYPE,
          referenceId: notification.id,
          scopeKey,
          deliveryKey,
          metadata: metadataResult.value,
        },
      }
    );

    if (enqueueResult.isErr()) {
      return err(enqueueResult.error);
    }

    if (enqueueResult.value.source === 'created') {
      createdOutboxIds.push(enqueueResult.value.outboxId);
    } else {
      reusedOutboxIds.push(enqueueResult.value.outboxId);
    }

    if (enqueueResult.value.composeStatus === 'compose_enqueued') {
      queuedOutboxIds.push(enqueueResult.value.outboxId);
    } else if (enqueueResult.value.composeStatus === 'skipped_terminal') {
      skippedTerminalOutboxIds.push(enqueueResult.value.outboxId);
    } else {
      enqueueFailedOutboxIds.push(enqueueResult.value.outboxId);
    }
  }

  return ok({
    notificationIds: uniqueNotifications.map((notification) => notification.id),
    createdOutboxIds,
    reusedOutboxIds,
    queuedOutboxIds,
    skippedTerminalOutboxIds,
    enqueueFailedOutboxIds,
  });
};
