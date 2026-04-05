import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { CorrespondenceThreadRecord } from './types.js';

const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);

export const PlatformSendThreadMetadataSchema = Type.Object(
  {
    providerSendAttemptId: NullableStringSchema,
    providerSendEmailId: NullableStringSchema,
    providerSendObservedAt: NullableStringSchema,
    providerSendMessageId: NullableStringSchema,
    threadStartedPublishedAt: NullableStringSchema,
  },
  { additionalProperties: false }
);

export type PlatformSendThreadMetadata = Static<typeof PlatformSendThreadMetadataSchema>;

export const PlatformSendThreadMetadataPatchSchema = Type.Object(
  {
    providerSendAttemptId: Type.Optional(NullableStringSchema),
    providerSendEmailId: Type.Optional(NullableStringSchema),
    providerSendObservedAt: Type.Optional(NullableStringSchema),
    providerSendMessageId: Type.Optional(NullableStringSchema),
    threadStartedPublishedAt: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false }
);

export type PlatformSendThreadMetadataPatch = Static<typeof PlatformSendThreadMetadataPatchSchema>;

const PROVIDER_SEND_ATTEMPT_ID_METADATA_KEY = 'providerSendAttemptId' as const;
const PROVIDER_SEND_EMAIL_ID_METADATA_KEY = 'providerSendEmailId' as const;
const PROVIDER_SEND_OBSERVED_AT_METADATA_KEY = 'providerSendObservedAt' as const;
const PROVIDER_SEND_MESSAGE_ID_METADATA_KEY = 'providerSendMessageId' as const;
const THREAD_STARTED_PUBLISHED_AT_METADATA_KEY = 'threadStartedPublishedAt' as const;

const EMPTY_PLATFORM_SEND_THREAD_METADATA: PlatformSendThreadMetadata = {
  providerSendAttemptId: null,
  providerSendEmailId: null,
  providerSendObservedAt: null,
  providerSendMessageId: null,
  threadStartedPublishedAt: null,
};

const normalizeNullableString = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

const toKnownMetadata = (value: Record<string, unknown>): PlatformSendThreadMetadata => {
  const knownMetadata: PlatformSendThreadMetadata = {
    providerSendAttemptId: normalizeNullableString(value[PROVIDER_SEND_ATTEMPT_ID_METADATA_KEY]),
    providerSendEmailId: normalizeNullableString(value[PROVIDER_SEND_EMAIL_ID_METADATA_KEY]),
    providerSendObservedAt: normalizeNullableString(value[PROVIDER_SEND_OBSERVED_AT_METADATA_KEY]),
    providerSendMessageId: normalizeNullableString(value[PROVIDER_SEND_MESSAGE_ID_METADATA_KEY]),
    threadStartedPublishedAt: normalizeNullableString(
      value[THREAD_STARTED_PUBLISHED_AT_METADATA_KEY]
    ),
  };

  return Value.Check(PlatformSendThreadMetadataSchema, knownMetadata)
    ? knownMetadata
    : EMPTY_PLATFORM_SEND_THREAD_METADATA;
};

const toNormalizedPatch = (
  patch: PlatformSendThreadMetadataPatch
): Partial<PlatformSendThreadMetadata> => {
  const normalizedPatch: Partial<PlatformSendThreadMetadata> = {};

  if (patch.providerSendAttemptId !== undefined) {
    normalizedPatch.providerSendAttemptId = normalizeNullableString(patch.providerSendAttemptId);
  }

  if (patch.providerSendEmailId !== undefined) {
    normalizedPatch.providerSendEmailId = normalizeNullableString(patch.providerSendEmailId);
  }

  if (patch.providerSendObservedAt !== undefined) {
    normalizedPatch.providerSendObservedAt = normalizeNullableString(patch.providerSendObservedAt);
  }

  if (patch.providerSendMessageId !== undefined) {
    normalizedPatch.providerSendMessageId = normalizeNullableString(patch.providerSendMessageId);
  }

  if (patch.threadStartedPublishedAt !== undefined) {
    normalizedPatch.threadStartedPublishedAt = normalizeNullableString(
      patch.threadStartedPublishedAt
    );
  }

  return normalizedPatch;
};

export const readPlatformSendThreadMetadata = (
  record: CorrespondenceThreadRecord
): PlatformSendThreadMetadata => {
  return toKnownMetadata(record.metadata);
};

export const writePlatformSendThreadMetadata = (
  record: CorrespondenceThreadRecord,
  patch: PlatformSendThreadMetadataPatch
): CorrespondenceThreadRecord['metadata'] => {
  const {
    [PROVIDER_SEND_ATTEMPT_ID_METADATA_KEY]: providerSendAttemptIdOmitted,
    [PROVIDER_SEND_EMAIL_ID_METADATA_KEY]: providerSendEmailIdOmitted,
    [PROVIDER_SEND_OBSERVED_AT_METADATA_KEY]: providerSendObservedAtOmitted,
    [PROVIDER_SEND_MESSAGE_ID_METADATA_KEY]: providerSendMessageIdOmitted,
    [THREAD_STARTED_PUBLISHED_AT_METADATA_KEY]: threadStartedPublishedAtOmitted,
    ...unrelatedMetadata
  } = record.metadata;
  void providerSendAttemptIdOmitted;
  void providerSendEmailIdOmitted;
  void providerSendObservedAtOmitted;
  void providerSendMessageIdOmitted;
  void threadStartedPublishedAtOmitted;
  const currentMetadata = readPlatformSendThreadMetadata(record);
  const nextKnownMetadata = {
    ...currentMetadata,
    ...toNormalizedPatch(patch),
  };

  return {
    ...unrelatedMetadata,
    ...(nextKnownMetadata.providerSendAttemptId !== null
      ? {
          [PROVIDER_SEND_ATTEMPT_ID_METADATA_KEY]: nextKnownMetadata.providerSendAttemptId,
        }
      : {}),
    ...(nextKnownMetadata.providerSendEmailId !== null
      ? {
          [PROVIDER_SEND_EMAIL_ID_METADATA_KEY]: nextKnownMetadata.providerSendEmailId,
        }
      : {}),
    ...(nextKnownMetadata.providerSendObservedAt !== null
      ? {
          [PROVIDER_SEND_OBSERVED_AT_METADATA_KEY]: nextKnownMetadata.providerSendObservedAt,
        }
      : {}),
    ...(nextKnownMetadata.providerSendMessageId !== null
      ? {
          [PROVIDER_SEND_MESSAGE_ID_METADATA_KEY]: nextKnownMetadata.providerSendMessageId,
        }
      : {}),
    ...(nextKnownMetadata.threadStartedPublishedAt !== null
      ? {
          [THREAD_STARTED_PUBLISHED_AT_METADATA_KEY]: nextKnownMetadata.threadStartedPublishedAt,
        }
      : {}),
  };
};
