import { err, ok, type Result } from 'neverthrow';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { ForbiddenError, ValidationError } from '../../shared/errors.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { PlatformDeliveryError } from '../errors.js';
import type { DeliveryRepo, SendJobScheduler } from '../ports.js';

export interface RequeueDeadLetterDeps {
  deliveries: DeliveryRepo;
  sendScheduler: SendJobScheduler;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface RequeueDeadLetterInput {
  deliveryId: string;
  adminUserId: string;
  reason: string;
  acknowledgeDuplicateRisk: boolean;
}

export interface RequeueDeadLetterResult {
  requeued: boolean;
}

export type RequeueDeadLetterError =
  | PlatformDeliveryError
  | AuditError
  | ForbiddenError
  | ValidationError;

export const requeueDeadLetter = async (
  deps: RequeueDeadLetterDeps,
  input: RequeueDeadLetterInput
): Promise<Result<RequeueDeadLetterResult, RequeueDeadLetterError>> => {
  if (input.reason.trim().length === 0) {
    return err({ type: 'ValidationError', message: 'Requeue reason is required', field: 'reason' });
  }
  const found = await deps.deliveries.findById(input.deliveryId);
  if (found.isErr()) {
    return err(found.error);
  }
  if (found.value === null) {
    return err({ type: 'NotFound', entity: 'delivery', id: input.deliveryId });
  }
  if (
    found.value.status !== 'dead_letter' &&
    found.value.status !== 'unknown' &&
    found.value.status !== 'permanent_failed'
  ) {
    return err({
      type: 'InvalidDeliveryTransition',
      from: found.value.status,
      to: 'ready',
    });
  }
  if (found.value.status === 'unknown' && !input.acknowledgeDuplicateRisk) {
    return err({
      type: 'Forbidden',
      reason: 'Unknown delivery requeue requires duplicate-risk acknowledgement',
    });
  }

  const now = deps.clock.now();
  const transitioned = await deps.deliveries.transition({
    deliveryId: found.value.id,
    from: [found.value.status],
    to: 'ready',
    patch: {
      nextAttemptAt: null,
      terminalAt: null,
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
    now,
  });
  if (transitioned.isErr()) {
    return err(transitioned.error);
  }
  if (!transitioned.value) {
    return ok({ requeued: false });
  }
  if (found.value.status === 'unknown') {
    const acknowledged = await deps.audit.append({
      action: 'admin.ambiguous_acknowledged',
      occurredAt: now,
      actor: input.adminUserId,
      userId: found.value.userId,
      deliveryId: found.value.id,
      reason: input.reason,
    });
    if (acknowledged.isErr()) {
      return err(acknowledged.error);
    }
  }
  const audited = await deps.audit.append({
    action: 'admin.requeued',
    occurredAt: now,
    actor: input.adminUserId,
    userId: found.value.userId,
    deliveryId: found.value.id,
    reason: input.reason,
  });
  if (audited.isErr()) {
    return err(audited.error);
  }
  const enqueued = await deps.sendScheduler.enqueue({ deliveryId: found.value.id });
  if (enqueued.isErr()) {
    return err(enqueued.error);
  }
  return ok({ requeued: true });
};
