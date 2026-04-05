import { err, ok, type Result } from 'neverthrow';

import {
  FUNKY_OUTBOX_ADMIN_FAILURE_TYPE,
  PUBLIC_DEBATE_CAMPAIGN_KEY,
} from '@/common/campaign-keys.js';

import { enqueueCreatedOrReusedOutbox } from './enqueue-created-or-reused-outbox.js';

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
  composeJobScheduler: ComposeJobScheduler;
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
    const enqueueResult = await enqueueCreatedOrReusedOutbox(
      {
        deliveryRepo: deps.deliveryRepo,
        composeJobScheduler: deps.composeJobScheduler,
      },
      {
        runId: input.runId,
        deliveryKey,
        createInput: {
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
    recipientEmails,
    createdOutboxIds,
    reusedOutboxIds,
    queuedOutboxIds,
    enqueueFailedOutboxIds,
  });
};
