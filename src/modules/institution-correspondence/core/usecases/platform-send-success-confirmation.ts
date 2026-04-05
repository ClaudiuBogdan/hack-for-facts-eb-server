import {
  readPlatformSendThreadMetadata,
  writePlatformSendThreadMetadata,
  type PlatformSendThreadMetadata,
} from '../platform-send-thread-metadata.js';

import type { CorrespondenceThreadRecord, ThreadRecord } from '../types.js';
import type { ReconcilePlatformSendSuccessInput } from './reconcile-platform-send-success-input.js';

export type PlatformSendSuccessConfirmationState =
  | 'not_requested'
  | 'already_confirmed'
  | 'published_and_marked'
  | 'pending_retry';

export type PlatformSendSuccessMetadata = PlatformSendThreadMetadata;

export const readPlatformSendSuccessMetadata = (
  record: CorrespondenceThreadRecord
): PlatformSendSuccessMetadata => {
  return readPlatformSendThreadMetadata(record);
};

export const withPlatformSendAttemptMetadata = (
  record: CorrespondenceThreadRecord,
  providerSendAttemptId: string
): CorrespondenceThreadRecord['metadata'] => {
  return writePlatformSendThreadMetadata(record, {
    providerSendAttemptId,
  });
};

export const withPlatformSendSuccessMetadata = (
  record: CorrespondenceThreadRecord,
  input: Pick<ReconcilePlatformSendSuccessInput, 'resendEmailId' | 'observedAt' | 'messageId'>
): CorrespondenceThreadRecord['metadata'] => {
  return writePlatformSendThreadMetadata(record, {
    providerSendEmailId: input.resendEmailId,
    providerSendObservedAt: input.observedAt.toISOString(),
    ...(input.messageId !== undefined ? { providerSendMessageId: input.messageId } : {}),
  });
};

export const hasPlatformSendSuccessConfirmation = (record: CorrespondenceThreadRecord): boolean => {
  return readPlatformSendSuccessMetadata(record).threadStartedPublishedAt !== null;
};

export const markPlatformSendSuccessConfirmed = (
  record: CorrespondenceThreadRecord,
  publishedAt: Date
): CorrespondenceThreadRecord['metadata'] => {
  if (hasPlatformSendSuccessConfirmation(record)) {
    return record.metadata;
  }

  return writePlatformSendThreadMetadata(record, {
    threadStartedPublishedAt: publishedAt.toISOString(),
  });
};

const normalizeHeaders = (headers: Record<string, unknown>): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
};

export const buildReconcilePlatformSendSuccessInputFromThread = (
  thread: ThreadRecord
): ReconcilePlatformSendSuccessInput | null => {
  const metadata = readPlatformSendSuccessMetadata(thread.record);

  if (metadata.providerSendEmailId === null || metadata.providerSendObservedAt === null) {
    return null;
  }

  const observedAt = new Date(metadata.providerSendObservedAt);
  if (Number.isNaN(observedAt.getTime())) {
    return null;
  }

  const matchingEntry = [...thread.record.correspondence]
    .reverse()
    .find(
      (entry) =>
        entry.direction === 'outbound' &&
        entry.source === 'platform_send' &&
        entry.resendEmailId === metadata.providerSendEmailId
    );

  if (matchingEntry === undefined) {
    return null;
  }

  return {
    threadKey: thread.threadKey,
    resendEmailId: metadata.providerSendEmailId,
    ...(matchingEntry.messageId !== null ? { messageId: matchingEntry.messageId } : {}),
    observedAt,
    fromAddress: matchingEntry.fromAddress,
    toAddresses: matchingEntry.toAddresses,
    ccAddresses: matchingEntry.ccAddresses,
    bccAddresses: matchingEntry.bccAddresses,
    subject: matchingEntry.subject,
    textBody: matchingEntry.textBody,
    htmlBody: matchingEntry.htmlBody,
    headers: normalizeHeaders(matchingEntry.headers),
    attachments: matchingEntry.attachments,
  };
};
