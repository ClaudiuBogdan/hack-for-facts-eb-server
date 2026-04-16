import { ok, err, type Result } from 'neverthrow';

import { PUBLIC_DEBATE_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

import { createValidationError, type InstitutionCorrespondenceError } from '../errors.js';
import {
  hasPlatformSendSuccessConfirmation,
  markPlatformSendSuccessConfirmed,
  type PlatformSendSuccessConfirmationState,
  withPlatformSendSuccessMetadata,
} from './platform-send-success-confirmation.js';
import { publishPublicDebateUpdateBestEffort } from './publish-public-debate-update-best-effort.js';
export type { ReconcilePlatformSendSuccessInput } from './reconcile-platform-send-success-input.js';

import type {
  InstitutionCorrespondenceRepository,
  PublicDebateEntityUpdatePublisher,
} from '../ports.js';
import type { CorrespondenceEntry, ThreadRecord } from '../types.js';
import type { ReconcilePlatformSendSuccessInput } from './reconcile-platform-send-success-input.js';

export interface ReconcilePlatformSendSuccessDeps {
  repo: InstitutionCorrespondenceRepository;
  updatePublisher?: PublicDebateEntityUpdatePublisher;
}

export interface ReconcilePlatformSendSuccessResult {
  status: 'reconciled' | 'already_reconciled' | 'not_found' | 'not_applicable';
  thread: ThreadRecord | null;
  appendedOutboundEntry: boolean;
  confirmationState: PlatformSendSuccessConfirmationState;
}

const createOutboundEntry = (input: ReconcilePlatformSendSuccessInput): CorrespondenceEntry => ({
  id: `platform-send:${input.resendEmailId}`,
  campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
  direction: 'outbound',
  source: 'platform_send',
  resendEmailId: input.resendEmailId,
  messageId: input.messageId ?? null,
  fromAddress: input.fromAddress,
  toAddresses: input.toAddresses,
  ccAddresses: input.ccAddresses ?? [],
  bccAddresses: input.bccAddresses ?? [],
  subject: input.subject,
  textBody: input.textBody ?? null,
  htmlBody: input.htmlBody ?? null,
  headers: input.headers ?? {},
  attachments: input.attachments ?? [],
  occurredAt: input.observedAt.toISOString(),
  metadata: {
    threadKey: input.threadKey,
  },
});

const markThreadStartedPublished = async (
  repo: InstitutionCorrespondenceRepository,
  threadId: string,
  publishedAt: Date
): Promise<boolean> => {
  const updateResult = await repo.mutateThread(threadId, (thread) => {
    if (hasPlatformSendSuccessConfirmation(thread.record)) {
      return ok({ record: thread.record });
    }

    return ok({
      record: {
        ...thread.record,
        metadata: markPlatformSendSuccessConfirmed(thread.record, publishedAt),
      },
    });
  });

  if (updateResult.isErr()) {
    return false;
  }

  return true;
};

export const reconcilePlatformSendSuccess = async (
  deps: ReconcilePlatformSendSuccessDeps,
  input: ReconcilePlatformSendSuccessInput
): Promise<Result<ReconcilePlatformSendSuccessResult, InstitutionCorrespondenceError>> => {
  if (input.threadKey.trim() === '') {
    return err(createValidationError('threadKey is required.'));
  }

  if (input.resendEmailId.trim() === '') {
    return err(createValidationError('resendEmailId is required.'));
  }

  const existingResult = await deps.repo.findThreadByKey(input.threadKey);
  if (existingResult.isErr()) {
    return err(existingResult.error);
  }

  const existingThread = existingResult.value;
  if (existingThread === null) {
    return ok({
      status: 'not_found',
      thread: null,
      appendedOutboundEntry: false,
      confirmationState: 'not_requested',
    });
  }

  if (existingThread.record.submissionPath !== 'platform_send') {
    return ok({
      status: 'not_applicable',
      thread: existingThread,
      appendedOutboundEntry: false,
      confirmationState: 'not_requested',
    });
  }

  const hadOutboundEntry = existingThread.record.correspondence.some(
    (entry) => entry.resendEmailId === input.resendEmailId
  );

  const mutatedResult = await deps.repo.mutateThread(existingThread.id, (thread) => {
    if (thread.record.submissionPath !== 'platform_send') {
      return ok({ record: thread.record });
    }

    const existingEntry = thread.record.correspondence.find(
      (entry) => entry.resendEmailId === input.resendEmailId
    );

    const nextCorrespondence =
      existingEntry === undefined
        ? [...thread.record.correspondence, createOutboundEntry(input)]
        : thread.record.correspondence.map((entry) =>
            entry.resendEmailId === input.resendEmailId && input.messageId !== undefined
              ? {
                  ...entry,
                  messageId: input.messageId ?? null,
                }
              : entry
          );

    return ok({
      phase: thread.phase === 'sending' ? 'awaiting_reply' : thread.phase,
      lastEmailAt:
        thread.lastEmailAt === null || thread.lastEmailAt < input.observedAt
          ? input.observedAt
          : thread.lastEmailAt,
      record: {
        ...thread.record,
        correspondence: nextCorrespondence,
        metadata: withPlatformSendSuccessMetadata(thread.record, input),
      },
    });
  });

  if (mutatedResult.isErr()) {
    return err(mutatedResult.error);
  }

  const thread = mutatedResult.value;
  const appendedOutboundEntry =
    !hadOutboundEntry &&
    thread.record.correspondence.some((entry) => entry.resendEmailId === input.resendEmailId);
  const hadThreadStartedPublishedMarker = hasPlatformSendSuccessConfirmation(existingThread.record);
  let hasThreadStartedPublishedMarker = hasPlatformSendSuccessConfirmation(thread.record);
  const shouldPublishThreadStarted =
    thread.phase === 'awaiting_reply' && !hasThreadStartedPublishedMarker;
  let publishedThreadStarted = false;

  if (shouldPublishThreadStarted) {
    publishedThreadStarted = await publishPublicDebateUpdateBestEffort(deps.updatePublisher, {
      eventType: 'thread_started',
      thread,
      occurredAt: input.observedAt,
      requesterUserId: thread.record.ownerUserId,
    });

    if (publishedThreadStarted) {
      hasThreadStartedPublishedMarker = await markThreadStartedPublished(
        deps.repo,
        thread.id,
        input.observedAt
      );
    }
  }

  let confirmationState: PlatformSendSuccessConfirmationState = 'not_requested';
  if (
    thread.phase === 'awaiting_reply' &&
    hasThreadStartedPublishedMarker &&
    !publishedThreadStarted
  ) {
    confirmationState = 'already_confirmed';
  } else if (publishedThreadStarted && hasThreadStartedPublishedMarker) {
    confirmationState = 'published_and_marked';
  } else if (thread.phase === 'awaiting_reply' && !hasThreadStartedPublishedMarker) {
    confirmationState = 'pending_retry';
  }

  const markerWasPersistedDuringReconcile =
    !hadThreadStartedPublishedMarker && hasThreadStartedPublishedMarker;
  const status =
    appendedOutboundEntry ||
    existingThread.phase !== thread.phase ||
    markerWasPersistedDuringReconcile
      ? 'reconciled'
      : 'already_reconciled';

  return ok({
    status,
    thread,
    appendedOutboundEntry,
    confirmationState,
  });
};
