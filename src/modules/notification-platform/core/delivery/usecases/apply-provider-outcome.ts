import { err, ok, type Result } from 'neverthrow';

import { canTransition } from '../state-machine.js';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { PlatformDeliveryError } from '../errors.js';
import type { ChannelDestinationRepo, DeliveryRepo } from '../ports.js';
import type { Delivery, DeliveryState } from '../types.js';

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
  deliveryId?: string;
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
  if (
    input.providerRef === undefined &&
    input.deliveryId === undefined &&
    input.idempotencyKey === undefined
  ) {
    return err({
      type: 'ValidationError',
      message: 'providerRef, deliveryId, or idempotencyKey is required',
      field: 'providerRef',
    });
  }

  let delivery: Delivery | null = null;
  if (input.providerRef !== undefined) {
    const byProviderRef = await deps.deliveries.findByProviderRef(input.providerRef);
    if (byProviderRef.isErr()) {
      return err(byProviderRef.error);
    }
    delivery = byProviderRef.value;
  }

  let matchedByDeliveryId = false;
  const fallbackDeliveryId = input.deliveryId ?? input.idempotencyKey;
  if (delivery === null && fallbackDeliveryId !== undefined) {
    const byDeliveryId = await deps.deliveries.findById(fallbackDeliveryId);
    if (byDeliveryId.isErr()) {
      return err(byDeliveryId.error);
    }
    delivery = byDeliveryId.value;
    matchedByDeliveryId = input.deliveryId !== undefined && delivery !== null;
  }
  if (delivery === null) {
    return ok({ applied: false });
  }

  if (matchedByDeliveryId && input.providerRef !== undefined) {
    const savedProviderRef = await deps.deliveries.saveProviderRefIfMissing({
      deliveryId: delivery.id,
      providerRef: input.providerRef,
      now: input.occurredAt,
    });
    if (savedProviderRef.isErr()) {
      return err(savedProviderRef.error);
    }
  }
  if (input.outcome === 'delayed') {
    return ok({ applied: false });
  }

  const target: DeliveryState = input.outcome;
  if (!canTransition(delivery.status, target)) {
    return ok({ applied: false });
  }
  const transitioned = await deps.deliveries.transition({
    deliveryId: delivery.id,
    from: [delivery.status],
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
    const fingerprint = input.destinationFingerprint ?? delivery.destinationFingerprint;
    if (fingerprint !== null) {
      const suppressed = await deps.destinations.suppressByFingerprint({
        fingerprint,
        channel: delivery.channel,
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
        userId: delivery.userId,
        deliveryId: delivery.id,
        reason: input.outcome,
        details: { channel: delivery.channel, affected: suppressed.value },
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
    userId: delivery.userId,
    deliveryId: delivery.id,
    reason: input.outcome,
  });
  if (terminalAudit.isErr()) {
    return err(terminalAudit.error);
  }
  return ok({ applied: true });
};
