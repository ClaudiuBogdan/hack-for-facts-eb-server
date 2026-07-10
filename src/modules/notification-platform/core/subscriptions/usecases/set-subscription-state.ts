import { err, ok, type Result } from 'neverthrow';

import type { AuditLedgerPort } from '../../audit/ports.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { SubscriptionError } from '../errors.js';
import type { SubscriptionRepo } from '../ports.js';
import type { Subscription, SubscriptionState } from '../types.js';

export interface SetSubscriptionStateDeps {
  subscriptions: SubscriptionRepo;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface SetSubscriptionStateInput {
  userId: string;
  subscriptionId: string;
  state: SubscriptionState;
}

export type SetSubscriptionStateResult = Subscription;
export type SetSubscriptionStateError = SubscriptionError;

export const setSubscriptionState = async (
  deps: SetSubscriptionStateDeps,
  input: SetSubscriptionStateInput
): Promise<Result<SetSubscriptionStateResult, SetSubscriptionStateError>> => {
  const owned = await deps.subscriptions.findByIdForUser(input.subscriptionId, input.userId);
  if (owned.isErr()) {
    return err(owned.error);
  }
  if (owned.value === null) {
    return err({ type: 'NotFound', entity: 'subscription', id: input.subscriptionId });
  }
  const changed = await deps.subscriptions.setState({
    id: input.subscriptionId,
    userId: input.userId,
    state: input.state,
    now: deps.clock.now(),
  });
  if (changed.isErr()) {
    return err(changed.error);
  }
  if (!changed.value) {
    return err({ type: 'NotFound', entity: 'subscription', id: input.subscriptionId });
  }
  const updated = await deps.subscriptions.findByIdForUser(input.subscriptionId, input.userId);
  if (updated.isErr()) {
    return err(updated.error);
  }
  if (updated.value === null) {
    return err({ type: 'NotFound', entity: 'subscription', id: input.subscriptionId });
  }
  // DESIGN NOTE: the committed AuditAction union has no subscription-state action.
  return ok(updated.value);
};
