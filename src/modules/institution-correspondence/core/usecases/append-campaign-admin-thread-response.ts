import { randomUUID } from 'node:crypto';

import { err, ok, type Result } from 'neverthrow';

import { appendAdminResponseEvent, projectCampaignAdminThread } from '../admin-workflow.js';
import {
  createConflictError,
  createValidationError,
  type InstitutionCorrespondenceError,
} from '../errors.js';
import { normalizeOptionalString } from './helpers.js';
import {
  type AdminResponseEvent,
  type AppendCampaignAdminThreadResponseInput,
  type AppendCampaignAdminThreadResponseOutput,
} from '../types.js';

import type { InstitutionCorrespondenceRepository } from '../ports.js';

export interface AppendCampaignAdminThreadResponseDeps {
  repo: Pick<InstitutionCorrespondenceRepository, 'mutateCampaignAdminThread'>;
}

const maxDate = (left: Date | null, right: Date): Date => {
  if (left === null) {
    return right;
  }

  return left.getTime() >= right.getTime() ? left : right;
};

export async function appendCampaignAdminThreadResponse(
  deps: AppendCampaignAdminThreadResponseDeps,
  input: AppendCampaignAdminThreadResponseInput
): Promise<Result<AppendCampaignAdminThreadResponseOutput, InstitutionCorrespondenceError>> {
  const normalizedMessageContent = normalizeOptionalString(input.messageContent);
  if (normalizedMessageContent === null) {
    return err(createValidationError('messageContent is required.'));
  }

  const appendedAt = new Date();
  const createdResponseEventId = randomUUID();

  const threadResult = await deps.repo.mutateCampaignAdminThread(
    {
      threadId: input.threadId,
      campaignKey: input.campaignKey,
      expectedUpdatedAt: input.expectedUpdatedAt,
    },
    (thread) => {
      const projectedThread = projectCampaignAdminThread(thread);
      if (projectedThread.threadState === 'resolved') {
        return err(
          createConflictError('This thread is already resolved and cannot accept more responses.')
        );
      }

      const responseEvent: AdminResponseEvent = {
        id: createdResponseEventId,
        responseDate: input.responseDate.toISOString(),
        messageContent: normalizedMessageContent,
        responseStatus: input.responseStatus,
        actorUserId: input.actorUserId,
        createdAt: appendedAt.toISOString(),
        source: 'campaign_admin_api',
      };

      const compatibilityState =
        input.responseStatus === 'request_confirmed'
          ? {
              phase: 'resolved_positive' as const,
              nextActionAt: null,
              closedAt: input.responseDate,
            }
          : input.responseStatus === 'request_denied'
            ? {
                phase: 'resolved_negative' as const,
                nextActionAt: null,
                closedAt: input.responseDate,
              }
            : {};

      return ok({
        lastReplyAt: maxDate(thread.lastReplyAt, input.responseDate),
        ...compatibilityState,
        record: appendAdminResponseEvent({
          record: thread.record,
          event: responseEvent,
        }),
      });
    }
  );

  if (threadResult.isErr()) {
    return err(threadResult.error);
  }

  return ok({
    thread: threadResult.value,
    createdResponseEventId,
  });
}
