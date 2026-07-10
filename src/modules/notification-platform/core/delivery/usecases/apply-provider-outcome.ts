import { err, ok, type Result } from 'neverthrow';

import { canTransition } from '../state-machine.js';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { PlatformDeliveryError } from '../errors.js';
import type { ChannelDestinationRepo, DeliveryRepo } from '../ports.js';
import type { DeliveryState } from '../types.js';

export interface ApplyProviderOutcomeDeps {
  deliveries: DeliveryRepo;
  destinations: ChannelDestinationRepo;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface ApplyProviderOutcomeInput {
  providerRef?: string;
  idempotencyKey?: string;
  outcome: 'delivered' | 'bounced' | 'complained' | 'delayed';
  occurredAt: Date;
  destinationFingerprint?: string;
}

export interface ApplyProviderOutcomeResult {
  applied: boolean;
}

export type ApplyProviderOutcomeError = PlatformDeliveryError | AuditError;

export const applyProviderOutcome = async (
  deps: ApplyProviderOutcomeDeps,
  input: ApplyProviderOutcomeInput
): Promise<Result<ApplyProviderOutcomeResult, ApplyProviderOutcomeError>> => {
  if (input.providerRef === undefined && input.idempotencyKey === undefined) {
    return err({
      type: 'ValidationError',
      message: 'providerRef or idempotencyKey is required',
      field: 'providerRef',
    });
  }
  const found =
    input.providerRef === undefined
      ? await deps.deliveries.findById(input.idempotencyKey ?? '')
      : await deps.deliveries.findByProviderRef(input.providerRef);
  if (found.isErr()) {
    return err(found.error);
  }
  if (found.value === null || input.outcome === 'delayed') {
    return ok({ applied: false });
  }

  const target: DeliveryState = input.outcome;
  if (!canTransition(found.value.status, target)) {
    return ok({ applied: false });
  }
  const transitioned = await deps.deliveries.transition({
    deliveryId: found.value.id,
    from: [found.value.status],
    to: target,
    patch: {
      ...(input.providerRef === undefined ? {} : { providerRef: input.providerRef }),
      terminalAt: input.occurredAt,
    },
    now: input.occurredAt,
  });
  if (transitioned.isErr()) {
    return err(transitioned.error);
  }
  if (!transitioned.value) {
    return ok({ applied: false });
  }

  if (input.outcome === 'bounced' || input.outcome === 'complained') {
    const fingerprint = input.destinationFingerprint ?? found.value.destinationFingerprint;
    if (fingerprint !== null) {
      const suppressed = await deps.destinations.suppressByFingerprint({
        fingerprint,
        channel: found.value.channel,
        reason: input.outcome,
        now: input.occurredAt,
      });
      if (suppressed.isErr()) {
        return err(suppressed.error);
      }
      const audited = await deps.audit.append({
        action: 'destination.suppressed',
        occurredAt: input.occurredAt,
        actor: 'system',
        userId: found.value.userId,
        deliveryId: found.value.id,
        reason: input.outcome,
        details: { channel: found.value.channel, affected: suppressed.value },
      });
      if (audited.isErr()) {
        return err(audited.error);
      }
    }
  }
  const terminalAudit = await deps.audit.append({
    action: 'delivery.terminal',
    occurredAt: input.occurredAt,
    actor: 'system',
    userId: found.value.userId,
    deliveryId: found.value.id,
    reason: input.outcome,
  });
  if (terminalAudit.isErr()) {
    return err(terminalAudit.error);
  }
  return ok({ applied: true });
};
