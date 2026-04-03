import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_OUTBOX_ADMIN_FAILURE_TYPE,
  PUBLIC_DEBATE_CAMPAIGN_KEY,
} from '@/common/campaign-keys.js';

import type { DeliveryError } from '../errors.js';
import type { ComposeJobScheduler, DeliveryRepository } from '../ports.js';

export interface PublicDebateAdminFailureNotificationInput {
  runId: string;
  recipientEmails: string[];
  entityCui: string;
  entityName?: string;
  threadId: string;
  threadKey: string;
  phase: string;
  institutionEmail: string;
  subject: string;
  occurredAt: string;
  failureMessage: string;
}

export interface EnqueuePublicDebateAdminFailureNotificationsDeps {
  deliveryRepo: DeliveryRepository;
  composeJobScheduler?: ComposeJobScheduler;
}

export interface EnqueuePublicDebateAdminFailureNotificationsResult {
  recipientEmails: string[];
  createdOutboxIds: string[];
  reusedOutboxIds: string[];
  queuedOutboxIds: string[];
  enqueueFailedOutboxIds: string[];
}

const buildScopeKey = (threadId: string): string => `funky:delivery:admin_failure_${threadId}`;

const buildDeliveryKey = (recipientEmail: string, threadId: string): string => {
  return `admin:${recipientEmail}:admin_failure:${threadId}`;
};

const normalizeRecipientEmails = (emails: readonly string[]): string[] => {
  return [...new Set(emails.map((value) => value.trim().toLowerCase()).filter(Boolean))];
};

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

export const enqueuePublicDebateAdminFailureNotifications = async (
  deps: EnqueuePublicDebateAdminFailureNotificationsDeps,
  input: PublicDebateAdminFailureNotificationInput
): Promise<Result<EnqueuePublicDebateAdminFailureNotificationsResult, DeliveryError>> => {
  const recipientEmails = normalizeRecipientEmails(input.recipientEmails);
  const scopeKey = buildScopeKey(input.threadId);
  const createdOutboxIds: string[] = [];
  const reusedOutboxIds: string[] = [];
  const queuedOutboxIds: string[] = [];
  const enqueueFailedOutboxIds: string[] = [];

  for (const recipientEmail of recipientEmails) {
    const deliveryKey = buildDeliveryKey(recipientEmail, input.threadId);
    const createResult = await deps.deliveryRepo.create({
      userId: `admin:${recipientEmail}`,
      toEmail: recipientEmail,
      notificationType: FUNKY_OUTBOX_ADMIN_FAILURE_TYPE,
      referenceId: null,
      scopeKey,
      deliveryKey,
      metadata: {
        campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
        entityCui: input.entityCui,
        ...(input.entityName !== undefined ? { entityName: input.entityName } : {}),
        threadId: input.threadId,
        threadKey: input.threadKey,
        phase: input.phase,
        institutionEmail: input.institutionEmail,
        subject: input.subject,
        occurredAt: input.occurredAt,
        failureMessage: input.failureMessage,
      },
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
    recipientEmails,
    createdOutboxIds,
    reusedOutboxIds,
    queuedOutboxIds,
    enqueueFailedOutboxIds,
  });
};
