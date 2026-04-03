import { err, ok, type Result } from 'neverthrow';

import { PUBLIC_DEBATE_CAMPAIGN_KEY } from '@/common/campaign-keys.js';
import { generateDeliveryKey } from '@/modules/notifications/core/types.js';

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
  composeJobScheduler?: ComposeJobScheduler;
}

export interface EnqueuePublicDebateEntityUpdateNotificationsResult {
  notificationIds: string[];
  createdOutboxIds: string[];
  reusedOutboxIds: string[];
  queuedOutboxIds: string[];
  enqueueFailedOutboxIds: string[];
}

const buildScopeKey = (input: PublicDebateEntityUpdateNotificationInput): string => {
  switch (input.eventType) {
    case 'thread_started':
      return `funky:delivery:thread_started_${input.threadId}`;
    case 'thread_failed':
      return `funky:delivery:thread_failed_${input.threadId}`;
    case 'reply_received':
      return `funky:delivery:reply_${input.threadId}_${input.replyEntryId ?? 'unknown'}`;
    case 'reply_reviewed':
      return `funky:delivery:review_${input.threadId}_${input.basedOnEntryId ?? 'unknown'}`;
  }
};

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

const maybeEnqueueCompose = async (
  composeJobScheduler: ComposeJobScheduler | undefined,
  runId: string,
  outboxId: string
): Promise<boolean> => {
  if (composeJobScheduler === undefined) {
    return false;
  }

  const enqueueResult = await composeJobScheduler.enqueue({
    runId,
    kind: 'outbox',
    outboxId,
  });

  return enqueueResult.isOk();
};

export const enqueuePublicDebateEntityUpdateNotifications = async (
  deps: EnqueuePublicDebateEntityUpdateNotificationsDeps,
  input: PublicDebateEntityUpdateNotificationInput
): Promise<Result<EnqueuePublicDebateEntityUpdateNotificationsResult, DeliveryError>> => {
  const scopeKey = buildScopeKey(input);
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
    const deliveryKey = generateDeliveryKey(notification.userId, notification.id, scopeKey);
    const createResult = await deps.deliveryRepo.create({
      userId: notification.userId,
      notificationType: 'funky:outbox:entity_update',
      referenceId: notification.id,
      scopeKey,
      deliveryKey,
      metadata: buildMetadata(input),
    });

    if (createResult.isErr()) {
      if (createResult.error.type !== 'DuplicateDelivery') {
        return err(createResult.error);
      }

      const duplicateResult = await deps.deliveryRepo.findByDeliveryKey(deliveryKey);
      if (duplicateResult.isErr()) {
        return err(duplicateResult.error);
      }

      if (duplicateResult.value !== null) {
        reusedOutboxIds.push(duplicateResult.value.id);
        const queued = await maybeEnqueueCompose(
          deps.composeJobScheduler,
          input.runId,
          duplicateResult.value.id
        );
        if (queued) {
          queuedOutboxIds.push(duplicateResult.value.id);
        } else if (deps.composeJobScheduler !== undefined) {
          enqueueFailedOutboxIds.push(duplicateResult.value.id);
        }
      }

      continue;
    }

    createdOutboxIds.push(createResult.value.id);
    const queued = await maybeEnqueueCompose(
      deps.composeJobScheduler,
      input.runId,
      createResult.value.id
    );
    if (queued) {
      queuedOutboxIds.push(createResult.value.id);
    } else if (deps.composeJobScheduler !== undefined) {
      enqueueFailedOutboxIds.push(createResult.value.id);
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
