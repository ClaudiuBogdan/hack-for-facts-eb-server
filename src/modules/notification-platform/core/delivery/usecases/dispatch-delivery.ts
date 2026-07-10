import { err, ok, type Result } from 'neverthrow';

import { evaluateEligibility } from '../../preferences/evaluate-eligibility.js';
import { computeNextAttemptAt } from '../retry-policy.js';
import { resolveAmbiguousOutcome } from './resolve-ambiguous-outcome.js';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { PreferenceError } from '../../preferences/errors.js';
import type { PreferenceRepo } from '../../preferences/ports.js';
import type { KindRegistry } from '../../registry/registry.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { ExternalChannel } from '../../shared/types.js';
import type { PlatformDeliveryError } from '../errors.js';
import type {
  AnonymizationCheckPort,
  ChannelAdapterPort,
  ChannelDestinationRepo,
  DeliveryAttemptRepo,
  DeliveryRepo,
  SendJobScheduler,
} from '../ports.js';
import type { Delivery, DeliveryState } from '../types.js';

const SEND_CLAIM_LEASE_SECONDS = 120;

export interface DispatchDeliveryDeps {
  deliveries: DeliveryRepo;
  attempts: DeliveryAttemptRepo;
  destinations: ChannelDestinationRepo;
  preferences: PreferenceRepo;
  anonymization: AnonymizationCheckPort;
  registry: KindRegistry;
  channelAdapters: ReadonlyMap<ExternalChannel, ChannelAdapterPort>;
  sendScheduler: SendJobScheduler;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface DispatchDeliveryInput {
  deliveryId: string;
}

export type DispatchOutcome =
  | 'noop'
  | 'accepted'
  | 'retry_wait'
  | 'dead_letter'
  | 'permanent_failed'
  | 'cancelled'
  | 'suppressed'
  | 'expired'
  | 'ambiguous_retried'
  | 'ambiguous_unknown';

export interface DispatchDeliveryResult {
  outcome: DispatchOutcome;
}

export type DispatchDeliveryError = PlatformDeliveryError | PreferenceError | AuditError;

const jitterSeedFor = (deliveryId: string, attemptNumber: number): number => {
  let hash = 2_166_136_261;
  const value = `${deliveryId}:${String(attemptNumber)}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

const transitionToTerminal = async (
  deps: DispatchDeliveryDeps,
  delivery: Delivery,
  claimToken: string,
  to: Extract<
    DeliveryState,
    'cancelled' | 'suppressed' | 'expired' | 'permanent_failed' | 'dead_letter'
  >,
  reason: string,
  now: Date
): Promise<Result<boolean, DispatchDeliveryError>> => {
  const transitioned = await deps.deliveries.transition({
    deliveryId: delivery.id,
    from: ['sending'],
    to,
    expectedClaimToken: claimToken,
    patch: {
      lastErrorCode: reason,
      lastErrorMessage: reason,
      terminalAt: now,
      claimToken: null,
      claimExpiresAt: null,
    },
    now,
  });
  if (transitioned.isErr()) {
    return err(transitioned.error);
  }
  if (transitioned.value) {
    const audited = await deps.audit.append({
      action: 'delivery.terminal',
      occurredAt: now,
      actor: 'system',
      userId: delivery.userId,
      deliveryId: delivery.id,
      reason,
    });
    if (audited.isErr()) {
      return err(audited.error);
    }
  }
  return ok(transitioned.value);
};

export const dispatchDelivery = async (
  deps: DispatchDeliveryDeps,
  input: DispatchDeliveryInput
): Promise<Result<DispatchDeliveryResult, DispatchDeliveryError>> => {
  const now = deps.clock.now();
  const claimToken = deps.ids.newId();
  const claimed = await deps.deliveries.claimForSending({
    deliveryId: input.deliveryId,
    claimToken,
    leaseSeconds: SEND_CLAIM_LEASE_SECONDS,
    now,
  });
  if (claimed.isErr()) {
    return err(claimed.error);
  }
  if (claimed.value === null) {
    return ok({ outcome: 'noop' });
  }
  const delivery = claimed.value;
  const kind = deps.registry.getByKindId(delivery.kindId);
  if (kind === undefined) {
    return err({ type: 'NotFound', entity: 'notification kind', id: delivery.kindId });
  }

  const anonymized = await deps.anonymization.isUserAnonymized(delivery.userId);
  if (anonymized.isErr()) {
    return err(anonymized.error);
  }
  if (anonymized.value) {
    const cancelled = await transitionToTerminal(
      deps,
      delivery,
      claimToken,
      'cancelled',
      'user_anonymized',
      now
    );
    if (cancelled.isErr()) {
      return err(cancelled.error);
    }
    return ok({ outcome: cancelled.value ? 'cancelled' : 'noop' });
  }

  const preferences = await deps.preferences.getForUser(delivery.userId);
  if (preferences.isErr()) {
    return err(preferences.error);
  }
  const eligibility = evaluateEligibility({
    kind,
    preferences: preferences.value,
    hasActiveSubscription: true,
  });
  const channelStillEligible =
    eligibility.eligible &&
    eligibility.channelPlan.some(
      (entry) => entry.channel === delivery.channel && entry.cadence !== 'off'
    );
  if (!channelStillEligible) {
    const cancelled = await transitionToTerminal(
      deps,
      delivery,
      claimToken,
      'cancelled',
      eligibility.eligible ? 'channel_disabled' : eligibility.reason,
      now
    );
    if (cancelled.isErr()) {
      return err(cancelled.error);
    }
    return ok({ outcome: cancelled.value ? 'cancelled' : 'noop' });
  }

  const currentDestination = await deps.destinations.getCurrent({
    userId: delivery.userId,
    channel: delivery.channel,
  });
  if (currentDestination.isErr()) {
    return err(currentDestination.error);
  }
  if (
    currentDestination.value !== null &&
    currentDestination.value.fingerprint === delivery.destinationFingerprint &&
    currentDestination.value.suppressedAt !== null
  ) {
    const suppressed = await transitionToTerminal(
      deps,
      delivery,
      claimToken,
      'suppressed',
      'destination_suppressed',
      now
    );
    if (suppressed.isErr()) {
      return err(suppressed.error);
    }
    return ok({ outcome: suppressed.value ? 'suppressed' : 'noop' });
  }

  if (delivery.expiresAt !== null && delivery.expiresAt.getTime() <= now.getTime()) {
    const expired = await transitionToTerminal(
      deps,
      delivery,
      claimToken,
      'expired',
      'expired',
      now
    );
    if (expired.isErr()) {
      return err(expired.error);
    }
    return ok({ outcome: expired.value ? 'expired' : 'noop' });
  }

  const adapter = deps.channelAdapters.get(delivery.channel);
  if (adapter === undefined) {
    return err({
      type: 'ValidationError',
      message: `No channel adapter registered for ${delivery.channel}`,
      field: 'channel',
    });
  }
  const resolved = await adapter.resolveDestination(delivery.userId);
  if (resolved.isErr()) {
    return err(resolved.error);
  }
  if (resolved.value === null) {
    const suppressed = await transitionToTerminal(
      deps,
      delivery,
      claimToken,
      'suppressed',
      'destination_unavailable',
      now
    );
    if (suppressed.isErr()) {
      return err(suppressed.error);
    }
    return ok({ outcome: suppressed.value ? 'suppressed' : 'noop' });
  }
  if (resolved.value.fingerprint !== delivery.destinationFingerprint) {
    const cancelled = await transitionToTerminal(
      deps,
      delivery,
      claimToken,
      'cancelled',
      'destination_changed',
      now
    );
    if (cancelled.isErr()) {
      return err(cancelled.error);
    }
    return ok({ outcome: cancelled.value ? 'cancelled' : 'noop' });
  }

  if (delivery.attemptCount < 1) {
    return err({
      type: 'ValidationError',
      message: 'A sending claim must increment attemptCount',
      field: 'attemptCount',
    });
  }
  const providerIdempotencyKey = delivery.providerIdempotencyKey ?? delivery.id;
  const attempt = await deps.attempts.create({
    id: deps.ids.newId(),
    deliveryId: delivery.id,
    attemptNumber: delivery.attemptCount,
    startedAt: now,
    providerIdempotencyKey,
    destinationFingerprint: delivery.destinationFingerprint,
    requestCorrelationId: null,
  });
  if (attempt.isErr()) {
    return err(attempt.error);
  }
  const sent = await adapter.send({
    delivery: { ...delivery, providerIdempotencyKey },
    attempt: attempt.value,
    destination: resolved.value.destination,
  });
  if (sent.isErr()) {
    return err(sent.error);
  }

  if (sent.value.classification === 'accepted') {
    const completed = await deps.attempts.complete({
      attemptId: attempt.value.id,
      completedAt: deps.clock.now(),
      result: 'accepted',
      providerRef: sent.value.providerRef,
    });
    if (completed.isErr()) {
      return err(completed.error);
    }
    const acceptedAt = deps.clock.now();
    const accepted = await deps.deliveries.transition({
      deliveryId: delivery.id,
      from: ['sending'],
      to: 'accepted',
      expectedClaimToken: claimToken,
      patch: {
        providerIdempotencyKey,
        providerRef: sent.value.providerRef,
        acceptedAt,
        claimToken: null,
        claimExpiresAt: null,
      },
      now: acceptedAt,
    });
    if (accepted.isErr()) {
      return err(accepted.error);
    }
    return ok({ outcome: accepted.value ? 'accepted' : 'noop' });
  }

  const completedAt = deps.clock.now();
  const attemptResult =
    sent.value.classification === 'transient_failure'
      ? 'transient_failure'
      : sent.value.classification === 'permanent_failure'
        ? 'permanent_failure'
        : 'ambiguous';
  const completed = await deps.attempts.complete({
    attemptId: attempt.value.id,
    completedAt,
    result: attemptResult,
    errorCode: sent.value.errorCode,
    errorMessage: sent.value.errorMessage,
    ...(sent.value.retryAfterMs === undefined ? {} : { retryAfterMs: sent.value.retryAfterMs }),
  });
  if (completed.isErr()) {
    return err(completed.error);
  }

  if (sent.value.classification === 'ambiguous') {
    const resolvedAmbiguity = await resolveAmbiguousOutcome(
      {
        deliveries: deps.deliveries,
        attempts: deps.attempts,
        channelAdapters: deps.channelAdapters,
        sendScheduler: deps.sendScheduler,
        audit: deps.audit,
        clock: deps.clock,
        ids: deps.ids,
        logger: deps.logger,
      },
      { deliveryId: delivery.id, expectedClaimToken: claimToken }
    );
    if (resolvedAmbiguity.isErr()) {
      return err(resolvedAmbiguity.error);
    }
    return ok({
      outcome:
        resolvedAmbiguity.value.resolution === 'retried'
          ? 'ambiguous_retried'
          : resolvedAmbiguity.value.resolution === 'accepted'
            ? 'accepted'
            : 'ambiguous_unknown',
    });
  }

  if (sent.value.classification === 'permanent_failure') {
    const failed = await transitionToTerminal(
      deps,
      delivery,
      claimToken,
      'permanent_failed',
      sent.value.errorCode,
      completedAt
    );
    if (failed.isErr()) {
      return err(failed.error);
    }
    return ok({ outcome: failed.value ? 'permanent_failed' : 'noop' });
  }

  const history = await deps.attempts.listByDelivery(delivery.id);
  if (history.isErr()) {
    return err(history.error);
  }
  const firstAttemptAt =
    history.value.reduce<Date | null>((earliest, item) => {
      return earliest === null || item.startedAt.getTime() < earliest.getTime()
        ? item.startedAt
        : earliest;
    }, null) ?? delivery.createdAt;
  const next = computeNextAttemptAt({
    attemptNumber: delivery.attemptCount,
    now: completedAt,
    firstAttemptAt,
    ...(sent.value.retryAfterMs === undefined ? {} : { retryAfterMs: sent.value.retryAfterMs }),
    expiresAt: delivery.expiresAt,
    jitterSeed: jitterSeedFor(delivery.id, delivery.attemptCount),
  });
  if ('exhausted' in next) {
    const dead = await transitionToTerminal(
      deps,
      delivery,
      claimToken,
      'dead_letter',
      'retry_exhausted',
      completedAt
    );
    if (dead.isErr()) {
      return err(dead.error);
    }
    return ok({ outcome: dead.value ? 'dead_letter' : 'noop' });
  }
  const retry = await deps.deliveries.transition({
    deliveryId: delivery.id,
    from: ['sending'],
    to: 'retry_wait',
    expectedClaimToken: claimToken,
    patch: {
      nextAttemptAt: next.nextAttemptAt,
      providerIdempotencyKey,
      lastErrorCode: sent.value.errorCode,
      lastErrorMessage: sent.value.errorMessage,
      claimToken: null,
      claimExpiresAt: null,
    },
    now: completedAt,
  });
  if (retry.isErr()) {
    return err(retry.error);
  }
  if (!retry.value) {
    return ok({ outcome: 'noop' });
  }
  const enqueued = await deps.sendScheduler.enqueue(
    { deliveryId: delivery.id },
    { delayMs: Math.max(0, next.nextAttemptAt.getTime() - completedAt.getTime()) }
  );
  if (enqueued.isErr()) {
    return err(enqueued.error);
  }
  return ok({ outcome: 'retry_wait' });
};
