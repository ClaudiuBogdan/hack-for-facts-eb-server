import { err, ok, type Result } from 'neverthrow';

import type { PlatformDeliveryError } from '../../delivery/errors.js';
import type { DeliveryRepo } from '../../delivery/ports.js';
import type { InboxError } from '../../inbox/errors.js';
import type { LogicalNotificationRepo } from '../../inbox/ports.js';
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

export interface ShadowComparisonReader {
  listShadowComparisonRecipients(input: {
    kindId: string;
    periodKey: string | null;
  }): Promise<Result<ComparisonRecipient[], PlatformDeliveryError | InboxError>>;
}

export interface GetShadowComparisonDeps {
  deliveries: DeliveryRepo & ShadowComparisonReader;
  logicalNotifications: LogicalNotificationRepo;
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
export type GetShadowComparisonError = PlatformDeliveryError | InboxError;

export const getShadowComparison = async (
  deps: GetShadowComparisonDeps,
  input: GetShadowComparisonInput
): Promise<Result<GetShadowComparisonResult, GetShadowComparisonError>> => {
  // DESIGN NOTE: neither committed repo exposes the kind/period comparison query;
  // the explicit read-only projection port keeps parity math in core.
  const periodKey = input.periodKey ?? null;
  const legacy = await deps.legacyOutboxReader.listComparisonRecipients({
    kindId: input.kindId,
    periodKey,
  });
  if (legacy.isErr()) {
    return err(legacy.error);
  }
  const shadow = await deps.deliveries.listShadowComparisonRecipients({
    kindId: input.kindId,
    periodKey,
  });
  if (shadow.isErr()) {
    return err(shadow.error);
  }

  const legacyByUser = new Map(legacy.value.map((entry) => [entry.userId, entry.contentHash]));
  const shadowByUser = new Map(shadow.value.map((entry) => [entry.userId, entry.contentHash]));
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
