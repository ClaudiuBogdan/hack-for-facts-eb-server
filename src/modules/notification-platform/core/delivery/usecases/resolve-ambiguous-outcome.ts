import { err, ok, type Result } from 'neverthrow';

import { canTransition } from '../state-machine.js';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { ExternalChannel } from '../../shared/types.js';
import type { PlatformDeliveryError } from '../errors.js';
import type {
  ChannelAdapterPort,
  DeliveryAttemptRepo,
  DeliveryRepo,
  SendJobScheduler,
} from '../ports.js';
import type { Delivery, DeliveryState } from '../types.js';

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ResolveAmbiguousOutcomeDeps {
  deliveries: DeliveryRepo;
  attempts: DeliveryAttemptRepo;
  channelAdapters: ReadonlyMap<ExternalChannel, ChannelAdapterPort>;
  sendScheduler: SendJobScheduler;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface ResolveAmbiguousOutcomeInput {
  deliveryId: string;
  expectedClaimToken: string;
}

export interface ResolveAmbiguousOutcomeResult {
  resolution: 'accepted' | 'retried' | 'unknown';
}

export type ResolveAmbiguousOutcomeError = PlatformDeliveryError | AuditError;

const applyKnownState = async (
  deps: ResolveAmbiguousOutcomeDeps,
  delivery: Delivery,
  state: 'accepted' | 'delivered' | 'bounced',
  expectedClaimToken: string,
  now: Date
): Promise<Result<'accepted' | 'unknown', ResolveAmbiguousOutcomeError>> => {
  let current: DeliveryState = delivery.status;
  if (state !== 'accepted' && current === 'sending' && canTransition(current, 'accepted')) {
    const accepted = await deps.deliveries.transition({
      deliveryId: delivery.id,
      from: [current],
      to: 'accepted',
      expectedClaimToken,
      patch: { acceptedAt: now },
      now,
    });
    if (accepted.isErr()) {
      return err(accepted.error);
    }
    if (!accepted.value) {
      return ok('unknown');
    }
    current = 'accepted';
  }
  if (!canTransition(current, state)) {
    return ok(state === 'accepted' && current === 'accepted' ? 'accepted' : 'unknown');
  }
  const transitioned = await deps.deliveries.transition({
    deliveryId: delivery.id,
    from: [current],
    to: state,
    expectedClaimToken,
    patch: {
      ...(state === 'accepted' ? { acceptedAt: now } : { terminalAt: now }),
      claimToken: null,
      claimExpiresAt: null,
    },
    now,
  });
  if (transitioned.isErr()) {
    return err(transitioned.error);
  }
  return ok(transitioned.value ? 'accepted' : 'unknown');
};

export const resolveAmbiguousOutcome = async (
  deps: ResolveAmbiguousOutcomeDeps,
  input: ResolveAmbiguousOutcomeInput
): Promise<Result<ResolveAmbiguousOutcomeResult, ResolveAmbiguousOutcomeError>> => {
  const found = await deps.deliveries.findById(input.deliveryId);
  if (found.isErr()) {
    return err(found.error);
  }
  if (found.value === null) {
    return err({ type: 'NotFound', entity: 'delivery', id: input.deliveryId });
  }
  if (found.value.status === 'accepted' || found.value.status === 'delivered') {
    return ok({ resolution: 'accepted' });
  }
  if (found.value.status === 'unknown') {
    return ok({ resolution: 'unknown' });
  }
  if (found.value.status !== 'sending') {
    return err({
      type: 'InvalidDeliveryTransition',
      from: found.value.status,
      to: 'retry_wait',
    });
  }

  const attempts = await deps.attempts.listByDelivery(found.value.id);
  if (attempts.isErr()) {
    return err(attempts.error);
  }
  const firstAttemptAt =
    attempts.value.reduce<Date | null>((earliest, attempt) => {
      return earliest === null || attempt.startedAt.getTime() < earliest.getTime()
        ? attempt.startedAt
        : earliest;
    }, null) ?? found.value.createdAt;
  const now = deps.clock.now();
  if (now.getTime() - firstAttemptAt.getTime() < IDEMPOTENCY_WINDOW_MS) {
    const retried = await deps.deliveries.transition({
      deliveryId: found.value.id,
      from: ['sending'],
      to: 'retry_wait',
      expectedClaimToken: input.expectedClaimToken,
      patch: {
        nextAttemptAt: now,
        providerIdempotencyKey: found.value.providerIdempotencyKey ?? found.value.id,
        claimToken: null,
        claimExpiresAt: null,
      },
      now,
    });
    if (retried.isErr()) {
      return err(retried.error);
    }
    if (!retried.value) {
      return ok({ resolution: 'unknown' });
    }
    const enqueued = await deps.sendScheduler.enqueue({ deliveryId: found.value.id });
    if (enqueued.isErr()) {
      return err(enqueued.error);
    }
    return ok({ resolution: 'retried' });
  }

  const adapter = deps.channelAdapters.get(found.value.channel);
  if (adapter === undefined) {
    return err({
      type: 'ValidationError',
      message: `No channel adapter registered for ${found.value.channel}`,
      field: 'channel',
    });
  }
  const reconciled = await adapter.reconcile({
    providerIdempotencyKey: found.value.providerIdempotencyKey ?? found.value.id,
    providerRef: found.value.providerRef,
  });
  if (reconciled.isErr()) {
    return err(reconciled.error);
  }
  if (reconciled.value.known && reconciled.value.state !== undefined) {
    const applied = await applyKnownState(
      deps,
      found.value,
      reconciled.value.state,
      input.expectedClaimToken,
      now
    );
    if (applied.isErr()) {
      return err(applied.error);
    }
    if (applied.value === 'accepted') {
      return ok({ resolution: 'accepted' });
    }
  }

  const unknown = await deps.deliveries.transition({
    deliveryId: found.value.id,
    from: ['sending'],
    to: 'unknown',
    expectedClaimToken: input.expectedClaimToken,
    patch: { terminalAt: now, claimToken: null, claimExpiresAt: null },
    now,
  });
  if (unknown.isErr()) {
    return err(unknown.error);
  }
  if (unknown.value) {
    const audited = await deps.audit.append({
      action: 'delivery.terminal',
      occurredAt: now,
      actor: 'system',
      userId: found.value.userId,
      deliveryId: found.value.id,
      reason: 'ambiguous_outcome_unknown',
    });
    if (audited.isErr()) {
      return err(audited.error);
    }
  }
  return ok({ resolution: 'unknown' });
};
