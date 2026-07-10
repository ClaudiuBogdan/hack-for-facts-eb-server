import type { PlatformDeliveryError } from '../../delivery/errors.js';
import type { DeliveryRepo } from '../../delivery/ports.js';
import type { Delivery } from '../../delivery/types.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { Page } from '../../shared/types.js';
import type { DeadLetterSearchFilter } from '../types.js';
import type { Result } from 'neverthrow';

export interface SearchDeadLettersDeps {
  deliveries: DeliveryRepo;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface SearchDeadLettersInput extends DeadLetterSearchFilter {
  cursor?: string;
  limit?: number;
}

export type SearchDeadLettersResult = Page<Delivery>;
export type SearchDeadLettersError = PlatformDeliveryError;

const redactDelivery = (delivery: Delivery): Delivery => ({
  ...delivery,
  destinationFingerprint: null,
  destinationGeneration: null,
  renderedSubject: null,
  renderedHtml: null,
  renderedText: null,
  contentHash: null,
});

export const searchDeadLetters = async (
  deps: SearchDeadLettersDeps,
  input: SearchDeadLettersInput
): Promise<Result<SearchDeadLettersResult, SearchDeadLettersError>> => {
  const result = await deps.deliveries.searchDeadLetters({
    ...(input.kindId === undefined ? {} : { kindId: input.kindId }),
    ...(input.channel === undefined ? {} : { channel: input.channel }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    cursor: input.cursor ?? null,
    limit: input.limit ?? 50,
  });
  return result.map((page) => ({
    items: page.items.map(redactDelivery),
    nextCursor: page.nextCursor,
  }));
};
