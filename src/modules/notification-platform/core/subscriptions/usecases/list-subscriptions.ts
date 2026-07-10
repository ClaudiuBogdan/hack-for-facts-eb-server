import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { Page } from '../../shared/types.js';
import type { SubscriptionError } from '../errors.js';
import type { SubscriptionRepo } from '../ports.js';
import type { Subscription } from '../types.js';
import type { Result } from 'neverthrow';

export interface ListSubscriptionsDeps {
  subscriptions: SubscriptionRepo;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface ListSubscriptionsInput {
  userId: string;
  kindId?: string;
  cursor?: string;
  limit?: number;
}

export type ListSubscriptionsResult = Page<Subscription>;
export type ListSubscriptionsError = SubscriptionError;

export const listSubscriptions = async (
  deps: ListSubscriptionsDeps,
  input: ListSubscriptionsInput
): Promise<Result<ListSubscriptionsResult, ListSubscriptionsError>> => {
  return deps.subscriptions.listByUser({
    userId: input.userId,
    ...(input.kindId === undefined ? {} : { kindId: input.kindId }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit: input.limit ?? 50,
  });
};
