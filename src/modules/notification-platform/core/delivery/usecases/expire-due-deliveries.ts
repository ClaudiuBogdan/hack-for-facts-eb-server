import { err, ok, type Result } from 'neverthrow';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { PlatformDeliveryError } from '../errors.js';
import type { DeliveryRepo } from '../ports.js';
import type { DeliveryState } from '../types.js';

const EXPIRABLE_STATES: readonly DeliveryState[] = [
  'pending_render',
  'scheduled',
  'ready',
  'retry_wait',
];

export interface ExpireDueDeliveriesDeps {
  deliveries: DeliveryRepo;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface ExpireDueDeliveriesInput {
  limit: number;
}

export interface ExpireDueDeliveriesResult {
  expired: number;
}

export type ExpireDueDeliveriesError = PlatformDeliveryError | AuditError;

export const expireDueDeliveries = async (
  deps: ExpireDueDeliveriesDeps,
  input: ExpireDueDeliveriesInput
): Promise<Result<ExpireDueDeliveriesResult, ExpireDueDeliveriesError>> => {
  const now = deps.clock.now();
  const due = await deps.deliveries.findDueForExpiry({ now, limit: input.limit });
  if (due.isErr()) {
    return err(due.error);
  }
  let expired = 0;
  for (const delivery of due.value) {
    const transitioned = await deps.deliveries.transition({
      deliveryId: delivery.id,
      from: EXPIRABLE_STATES,
      to: 'expired',
      patch: { terminalAt: now, lastErrorCode: 'expired', lastErrorMessage: 'expired' },
      now,
    });
    if (transitioned.isErr()) {
      return err(transitioned.error);
    }
    if (!transitioned.value) {
      continue;
    }
    expired += 1;
    const audited = await deps.audit.append({
      action: 'delivery.terminal',
      occurredAt: now,
      actor: 'system',
      userId: delivery.userId,
      deliveryId: delivery.id,
      reason: 'expired',
    });
    if (audited.isErr()) {
      return err(audited.error);
    }
  }
  return ok({ expired });
};
