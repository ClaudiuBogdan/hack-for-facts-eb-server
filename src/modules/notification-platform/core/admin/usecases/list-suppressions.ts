import type { PlatformDeliveryError } from '../../delivery/errors.js';
import type { ChannelDestinationRepo } from '../../delivery/ports.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { Page } from '../../shared/types.js';
import type { SuppressionView } from '../types.js';
import type { Result } from 'neverthrow';

export interface ListSuppressionsDeps {
  destinations: ChannelDestinationRepo;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface ListSuppressionsInput {
  userId?: string;
  cursor?: string;
  limit?: number;
}

export type ListSuppressionsResult = Page<SuppressionView>;
export type ListSuppressionsError = PlatformDeliveryError;

export const listSuppressions = async (
  deps: ListSuppressionsDeps,
  input: ListSuppressionsInput
): Promise<Result<ListSuppressionsResult, ListSuppressionsError>> => {
  const result = await deps.destinations.listSuppressed({
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    cursor: input.cursor ?? null,
    limit: input.limit ?? 50,
  });
  return result.map((page) => ({
    items: page.items.map((destination) => ({
      userId: destination.userId,
      channel: destination.channel,
      fingerprint: destination.fingerprint,
      generation: destination.generation,
      suppressedAt: destination.suppressedAt,
      suppressionReason: destination.suppressionReason,
    })),
    nextCursor: page.nextCursor,
  }));
};
