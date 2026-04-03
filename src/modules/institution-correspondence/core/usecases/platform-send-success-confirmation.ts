import type { CorrespondenceThreadRecord, ThreadRecord } from '../types.js';
import type { ReconcilePlatformSendSuccessInput } from './reconcile-platform-send-success.js';

export const PROVIDER_SEND_EMAIL_ID_METADATA_KEY = 'providerSendEmailId' as const;
export const PROVIDER_SEND_OBSERVED_AT_METADATA_KEY = 'providerSendObservedAt' as const;
export const PROVIDER_SEND_MESSAGE_ID_METADATA_KEY = 'providerSendMessageId' as const;
export const THREAD_STARTED_PUBLISHED_AT_METADATA_KEY = 'threadStartedPublishedAt' as const;

export type PlatformSendSuccessConfirmationState =
  | 'not_requested'
  | 'already_confirmed'
  | 'published_and_marked'
  | 'pending_retry';

export interface PlatformSendSuccessMetadata {
  providerSendEmailId: string | null;
  providerSendObservedAt: string | null;
  providerSendMessageId: string | null;
  threadStartedPublishedAt: string | null;
}

export const readPlatformSendSuccessMetadata = (
  record: CorrespondenceThreadRecord
): PlatformSendSuccessMetadata => {
  const providerSendEmailId = record.metadata[PROVIDER_SEND_EMAIL_ID_METADATA_KEY];
  const providerSendObservedAt = record.metadata[PROVIDER_SEND_OBSERVED_AT_METADATA_KEY];
  const providerSendMessageId = record.metadata[PROVIDER_SEND_MESSAGE_ID_METADATA_KEY];
  const threadStartedPublishedAt = record.metadata[THREAD_STARTED_PUBLISHED_AT_METADATA_KEY];

  return {
    providerSendEmailId: typeof providerSendEmailId === 'string' ? providerSendEmailId : null,
    providerSendObservedAt:
      typeof providerSendObservedAt === 'string' ? providerSendObservedAt : null,
    providerSendMessageId: typeof providerSendMessageId === 'string' ? providerSendMessageId : null,
    threadStartedPublishedAt:
      typeof threadStartedPublishedAt === 'string' ? threadStartedPublishedAt : null,
  };
};

export const withPlatformSendSuccessMetadata = (
  record: CorrespondenceThreadRecord,
  input: Pick<ReconcilePlatformSendSuccessInput, 'resendEmailId' | 'observedAt' | 'messageId'>
): CorrespondenceThreadRecord['metadata'] => {
  const nextMetadata: Record<string, unknown> = {
    ...record.metadata,
    [PROVIDER_SEND_EMAIL_ID_METADATA_KEY]: input.resendEmailId,
    [PROVIDER_SEND_OBSERVED_AT_METADATA_KEY]: input.observedAt.toISOString(),
  };

  if (input.messageId !== undefined && input.messageId !== null) {
    nextMetadata[PROVIDER_SEND_MESSAGE_ID_METADATA_KEY] = input.messageId;
  }

  return nextMetadata;
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

  return {
    ...record.metadata,
    [THREAD_STARTED_PUBLISHED_AT_METADATA_KEY]: publishedAt.toISOString(),
  };
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
