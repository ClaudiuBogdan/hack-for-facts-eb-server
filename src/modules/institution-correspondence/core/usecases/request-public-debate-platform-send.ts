import { err, ok, type Result } from 'neverthrow';

import { createConflictError, type InstitutionCorrespondenceError } from '../errors.js';
import {
  PUBLIC_DEBATE_REQUEST_TYPE,
  type SendPlatformRequestInput,
  type SendPlatformRequestOutput,
} from '../types.js';
import { normalizeEmailAddress } from './helpers.js';
import { sendPlatformRequest, type SendPlatformRequestDeps } from './send-platform-request.js';

export interface RequestPublicDebatePlatformSendDeps extends SendPlatformRequestDeps {
  subscriptionService?: import('../ports.js').PublicDebateEntitySubscriptionService;
}

const EXISTING_THREAD_EMAIL_CONFLICT_MESSAGE =
  'An active platform-send thread already exists for this entity with a different city hall email.';

function threadUsesInstitutionEmail(
  institutionEmail: string,
  thread: SendPlatformRequestOutput['thread']
): boolean {
  return (
    normalizeEmailAddress(thread.record.institutionEmail) ===
    normalizeEmailAddress(institutionEmail)
  );
}

function requiresInstitutionEmailReuseMatch(input: SendPlatformRequestInput): boolean {
  const metadata = input.metadata;
  if (typeof metadata !== 'object' || metadata === null) {
    return false;
  }

  return typeof metadata['institutionEmailOverride'] === 'object';
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
    if (
      requiresInstitutionEmailReuseMatch(input) &&
      !threadUsesInstitutionEmail(input.institutionEmail, existingThreadResult.value)
    ) {
      return err(createConflictError(EXISTING_THREAD_EMAIL_CONFLICT_MESSAGE));
    }

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
      if (
        requiresInstitutionEmailReuseMatch(input) &&
        !threadUsesInstitutionEmail(input.institutionEmail, reloadedThreadResult.value)
      ) {
        return err(createConflictError(EXISTING_THREAD_EMAIL_CONFLICT_MESSAGE));
      }

      return ok({
        created: false,
        thread: reloadedThreadResult.value,
      });
    }
  }

  return sendResult;
}
