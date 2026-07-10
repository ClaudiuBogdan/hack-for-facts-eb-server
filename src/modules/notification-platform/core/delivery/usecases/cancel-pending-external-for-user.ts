import { type Result } from 'neverthrow';

import type { AuditLedgerPort } from '../../audit/ports.js';
import type { DigestBatchRepo } from '../../digest/ports.js';
import type { KindRegistry } from '../../registry/registry.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { ExternalChannel } from '../../shared/types.js';
import type { PlatformDeliveryError } from '../errors.js';
import type { DeliveryRepo } from '../ports.js';

export interface CancelPendingExternalForUserDeps {
  deliveries: DeliveryRepo;
  digests: DigestBatchRepo;
  audit: AuditLedgerPort;
  registry: KindRegistry;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface CancelPendingExternalForUserInput {
  userId: string;
  channels?: readonly ExternalChannel[];
  reason: string;
}

export interface CancelPendingExternalForUserResult {
  cancelled: number;
}

export type CancelPendingExternalForUserError = PlatformDeliveryError;

export const cancelPendingExternalForUser = async (
  deps: CancelPendingExternalForUserDeps,
  input: CancelPendingExternalForUserInput
): Promise<Result<CancelPendingExternalForUserResult, CancelPendingExternalForUserError>> => {
  const optionalKindIds = deps.registry
    .list()
    .filter((kind) => kind.preferenceClass !== 'required')
    .map((kind) => kind.kindId);
  const cancelled = await deps.deliveries.cancelPendingForUser({
    userId: input.userId,
    ...(input.channels === undefined ? {} : { channels: input.channels }),
    kindIds: optionalKindIds,
    reason: input.reason,
    now: deps.clock.now(),
  });
  return cancelled.map((count) => ({ cancelled: count }));
};
