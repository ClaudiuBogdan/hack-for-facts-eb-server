import { err, ok, type Result } from 'neverthrow';

import { PUBLIC_DEBATE_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

import {
  enqueueCreatedOrReusedOutbox,
  type ReusedOutboxComposeStrategy,
} from './enqueue-created-or-reused-outbox.js';
import {
  buildPublicDebateEntityUpdateDeliveryKey,
  buildPublicDebateEntityUpdateScopeKey,
} from './public-debate-entity-update-keys.js';

import type { DeliveryError } from '../errors.js';
import type {
  ComposeJobScheduler,
  DeliveryRepository,
  ExtendedNotificationsRepository,
} from '../ports.js';

export type PublicDebateEntityUpdateEventType =
  | 'thread_started'
  | 'thread_failed'
  | 'reply_received'
  | 'reply_reviewed';

export type PublicDebateThreadStartedRecipientRole = 'requester' | 'subscriber';

interface PublicDebateEntityUpdateNotificationInputBase {
  runId: string;
  eventType: PublicDebateEntityUpdateEventType;
  triggerSource?: string;
  triggeredByUserId?: string;
  reusedOutboxComposeStrategy?: ReusedOutboxComposeStrategy;
  entityCui: string;
  entityName?: string;
  threadId: string;
  threadKey: string;
  phase: string;
  ownerUserId?: string | null;
  institutionEmail: string;
  subject: string;
  occurredAt: string;
  replyEntryId?: string;
  basedOnEntryId?: string;
  replyTextPreview?: string | null;
  resolutionCode?: string | null;
  reviewNotes?: string | null;
}

type ThreadStartedPublicDebateEntityUpdateNotificationInput =
  PublicDebateEntityUpdateNotificationInputBase & {
    eventType: 'thread_started';
    requesterUserId: string | null;
  };

type NonThreadStartedPublicDebateEntityUpdateNotificationInput =
  PublicDebateEntityUpdateNotificationInputBase & {
    eventType: 'thread_failed' | 'reply_received' | 'reply_reviewed';
  };

export type PublicDebateEntityUpdateNotificationInput =
  | ThreadStartedPublicDebateEntityUpdateNotificationInput
  | NonThreadStartedPublicDebateEntityUpdateNotificationInput;

export interface EnqueuePublicDebateEntityUpdateNotificationsDeps {
  notificationsRepo: ExtendedNotificationsRepository;
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export interface EnqueuePublicDebateEntityUpdateNotificationsResult {
  notificationIds: string[];
  createdOutboxIds: string[];
  reusedOutboxIds: string[];
  queuedOutboxIds: string[];
  skippedTerminalOutboxIds: string[];
  enqueueFailedOutboxIds: string[];
}

const THREAD_STARTED_RECIPIENT_ROLE_METADATA_KEY = 'recipientRole';

const normalizeUserId = (userId: string | null | undefined): string | null => {
  if (userId === undefined || userId === null) {
    return null;
  }

  const trimmedUserId = userId.trim();
  return trimmedUserId === '' ? null : trimmedUserId;
};

const buildThreadStartedRecipientRole = (
  requesterUserId: string | null,
  recipientUserId: string
): PublicDebateThreadStartedRecipientRole => {
  if (requesterUserId === null) {
    return 'subscriber';
  }

  return recipientUserId === requesterUserId ? 'requester' : 'subscriber';
};

const buildMetadata = (
  input: PublicDebateEntityUpdateNotificationInput,
  recipientRole?: PublicDebateThreadStartedRecipientRole
): Record<string, unknown> => ({
  runId: input.runId,
  campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
  eventType: input.eventType,
  ...(input.triggerSource !== undefined ? { triggerSource: input.triggerSource } : {}),
  ...(input.triggeredByUserId !== undefined ? { triggeredByUserId: input.triggeredByUserId } : {}),
  entityCui: input.entityCui,
  ...(input.entityName !== undefined ? { entityName: input.entityName } : {}),
  threadId: input.threadId,
  threadKey: input.threadKey,
  phase: input.phase,
  institutionEmail: input.institutionEmail,
  subject: input.subject,
  occurredAt: input.occurredAt,
  ...(input.replyEntryId !== undefined ? { replyEntryId: input.replyEntryId } : {}),
  ...(input.basedOnEntryId !== undefined ? { basedOnEntryId: input.basedOnEntryId } : {}),
  ...(input.replyTextPreview !== undefined ? { replyTextPreview: input.replyTextPreview } : {}),
  ...(input.resolutionCode !== undefined ? { resolutionCode: input.resolutionCode } : {}),
  ...(input.reviewNotes !== undefined ? { reviewNotes: input.reviewNotes } : {}),
  ...(input.eventType === 'thread_started' && recipientRole !== undefined
    ? { [THREAD_STARTED_RECIPIENT_ROLE_METADATA_KEY]: recipientRole }
    : {}),
});

export const enqueuePublicDebateEntityUpdateNotifications = async (
  deps: EnqueuePublicDebateEntityUpdateNotificationsDeps,
  input: PublicDebateEntityUpdateNotificationInput
): Promise<Result<EnqueuePublicDebateEntityUpdateNotificationsResult, DeliveryError>> => {
  const reusedOutboxComposeStrategy = input.reusedOutboxComposeStrategy ?? 'always_enqueue_compose';
  const requesterUserId =
    input.eventType === 'thread_started' ? normalizeUserId(input.requesterUserId) : null;
  const scopeKey = buildPublicDebateEntityUpdateScopeKey({
    eventType: input.eventType,
    threadId: input.threadId,
    ...(input.replyEntryId !== undefined ? { replyEntryId: input.replyEntryId } : {}),
    ...(input.basedOnEntryId !== undefined ? { basedOnEntryId: input.basedOnEntryId } : {}),
  });
  const notificationsResult = await deps.notificationsRepo.findActiveByTypeAndEntity(
    'funky:notification:entity_updates',
    input.entityCui
  );

  if (notificationsResult.isErr()) {
    return err(notificationsResult.error);
  }

  const createdOutboxIds: string[] = [];
  const reusedOutboxIds: string[] = [];
  const queuedOutboxIds: string[] = [];
  const skippedTerminalOutboxIds: string[] = [];
  const enqueueFailedOutboxIds: string[] = [];

  for (const notification of notificationsResult.value) {
    const recipientRole =
      input.eventType === 'thread_started'
        ? buildThreadStartedRecipientRole(requesterUserId, notification.userId)
        : undefined;
    const metadata = buildMetadata(input, recipientRole);
    const deliveryKey = buildPublicDebateEntityUpdateDeliveryKey({
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
          notificationType: 'funky:outbox:entity_update',
          referenceId: notification.id,
          scopeKey,
          deliveryKey,
          metadata,
        },
        ...(input.eventType === 'thread_started' ? { reusedOutboxMetadataRefresh: metadata } : {}),
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
    notificationIds: notificationsResult.value.map((notification) => notification.id),
    createdOutboxIds,
    reusedOutboxIds,
    queuedOutboxIds,
    skippedTerminalOutboxIds,
    enqueueFailedOutboxIds,
  });
};
