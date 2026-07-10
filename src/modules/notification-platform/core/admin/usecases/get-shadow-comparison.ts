import { err, ok, type Result } from 'neverthrow';

import type { PlatformDeliveryError } from '../../delivery/errors.js';
import type { DeliveryRepo } from '../../delivery/ports.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { ShadowComparisonSummary } from '../types.js';

export interface ComparisonRecipient {
  userId: string;
  contentHash: string | null;
}

export interface LegacyOutboxReader {
  listComparisonRecipients(input: {
    kindId: string;
    periodKey: string | null;
  }): Promise<Result<ComparisonRecipient[], PlatformDeliveryError>>;
}

// DESIGN NOTE: Phase 4's legacyOutboxReader must normalize legacy content into the
// same framed hash contract as the platform. Direct equality with legacy raw stored
// hashes is not meaningful because their inputs and framing are not comparable.

export interface GetShadowComparisonDeps {
  deliveries: DeliveryRepo;
  legacyOutboxReader: LegacyOutboxReader;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface GetShadowComparisonInput {
  kindId: string;
  periodKey?: string;
}

export type GetShadowComparisonResult = ShadowComparisonSummary;
export type GetShadowComparisonError = PlatformDeliveryError;

export const getShadowComparison = async (
  deps: GetShadowComparisonDeps,
  input: GetShadowComparisonInput
): Promise<Result<GetShadowComparisonResult, GetShadowComparisonError>> => {
  const periodKey = input.periodKey ?? null;
  const legacy = await deps.legacyOutboxReader.listComparisonRecipients({
    kindId: input.kindId,
    periodKey,
  });
  if (legacy.isErr()) {
    return err(legacy.error);
  }
  const legacyByUser = new Map(legacy.value.map((entry) => [entry.userId, entry.contentHash]));
  const shadowByUser = new Map<string, string | null>();
  let cursor: string | null = null;
  do {
    const shadow = await deps.deliveries.listShadowRecipients({
      kindId: input.kindId,
      limit: 1_000,
      cursor,
    });
    if (shadow.isErr()) {
      return err(shadow.error);
    }
    for (const entry of shadow.value.items) {
      shadowByUser.set(entry.userId, entry.contentHash);
    }
    cursor = shadow.value.nextCursor;
  } while (cursor !== null);
  let matchingRecipientCount = 0;
  let matchingContentCount = 0;
  let contentMismatchCount = 0;
  for (const [userId, legacyHash] of legacyByUser) {
    if (!shadowByUser.has(userId)) {
      continue;
    }
    matchingRecipientCount += 1;
    if (shadowByUser.get(userId) === legacyHash) {
      matchingContentCount += 1;
    } else {
      contentMismatchCount += 1;
    }
  }
  return ok({
    kindId: input.kindId,
    periodKey,
    legacyRecipientCount: legacyByUser.size,
    shadowRecipientCount: shadowByUser.size,
    matchingRecipientCount,
    legacyOnlyRecipientCount: legacyByUser.size - matchingRecipientCount,
    shadowOnlyRecipientCount: shadowByUser.size - matchingRecipientCount,
    matchingContentCount,
    contentMismatchCount,
  });
};
