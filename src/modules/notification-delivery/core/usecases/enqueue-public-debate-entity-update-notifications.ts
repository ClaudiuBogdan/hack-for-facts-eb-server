import { err, ok, type Result } from 'neverthrow';

import { PUBLIC_DEBATE_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

import { enqueueCreatedOrReusedOutbox } from './enqueue-created-or-reused-outbox.js';
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

export interface PublicDebateEntityUpdateNotificationInput {
  runId: string;
  eventType: PublicDebateEntityUpdateEventType;
  entityCui: string;
  entityName?: string;
  threadId: string;
  threadKey: string;
  phase: string;
  institutionEmail: string;
  subject: string;
  occurredAt: string;
  replyEntryId?: string;
  basedOnEntryId?: string;
  replyTextPreview?: string | null;
  resolutionCode?: string | null;
  reviewNotes?: string | null;
}

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
  enqueueFailedOutboxIds: string[];
}

const buildMetadata = (
  input: PublicDebateEntityUpdateNotificationInput
): Record<string, unknown> => ({
  campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
  eventType: input.eventType,
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
});

export const enqueuePublicDebateEntityUpdateNotifications = async (
  deps: EnqueuePublicDebateEntityUpdateNotificationsDeps,
  input: PublicDebateEntityUpdateNotificationInput
): Promise<Result<EnqueuePublicDebateEntityUpdateNotificationsResult, DeliveryError>> => {
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
  const enqueueFailedOutboxIds: string[] = [];

  for (const notification of notificationsResult.value) {
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
        createInput: {
          userId: notification.userId,
          notificationType: 'funky:outbox:entity_update',
          referenceId: notification.id,
          scopeKey,
          deliveryKey,
          metadata: buildMetadata(input),
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

    if (enqueueResult.value.composeEnqueued) {
      queuedOutboxIds.push(enqueueResult.value.outboxId);
    } else {
      enqueueFailedOutboxIds.push(enqueueResult.value.outboxId);
    }
  }

  return ok({
    notificationIds: notificationsResult.value.map((notification) => notification.id),
    createdOutboxIds,
    reusedOutboxIds,
    queuedOutboxIds,
    enqueueFailedOutboxIds,
  });
};
