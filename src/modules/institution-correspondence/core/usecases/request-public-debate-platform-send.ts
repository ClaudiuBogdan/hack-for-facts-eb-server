import { err, ok, type Result } from 'neverthrow';

import { sendPlatformRequest, type SendPlatformRequestDeps } from './send-platform-request.js';
import {
  PUBLIC_DEBATE_REQUEST_TYPE,
  type SendPlatformRequestInput,
  type SendPlatformRequestOutput,
} from '../types.js';

import type { InstitutionCorrespondenceError } from '../errors.js';
import type { PublicDebateEntitySubscriptionService } from '../ports.js';

export interface RequestPublicDebatePlatformSendDeps extends SendPlatformRequestDeps {
  subscriptionService?: PublicDebateEntitySubscriptionService;
}

export async function requestPublicDebatePlatformSend(
  deps: RequestPublicDebatePlatformSendDeps,
  input: SendPlatformRequestInput
): Promise<Result<SendPlatformRequestOutput, InstitutionCorrespondenceError>> {
  if (deps.subscriptionService !== undefined) {
    const subscribeResult = await deps.subscriptionService.ensureSubscribed(
      input.ownerUserId,
      input.entityCui
    );
    if (subscribeResult.isErr()) {
      return err(subscribeResult.error);
    }
  }

  const existingThreadResult = await deps.repo.findPlatformSendThreadByEntity({
    entityCui: input.entityCui,
    campaign: PUBLIC_DEBATE_REQUEST_TYPE,
  });

  if (existingThreadResult.isErr()) {
    return err(existingThreadResult.error);
  }

  if (existingThreadResult.value !== null) {
    return ok({
      created: false,
      thread: existingThreadResult.value,
    });
  }

  const sendResult = await sendPlatformRequest(deps, input);
  if (sendResult.isErr() && sendResult.error.type === 'CorrespondenceConflictError') {
    const reloadedThreadResult = await deps.repo.findPlatformSendThreadByEntity({
      entityCui: input.entityCui,
      campaign: PUBLIC_DEBATE_REQUEST_TYPE,
    });

    if (reloadedThreadResult.isErr()) {
      return err(reloadedThreadResult.error);
    }

    if (reloadedThreadResult.value !== null) {
      return ok({
        created: false,
        thread: reloadedThreadResult.value,
      });
    }
  }

  return sendResult;
}
