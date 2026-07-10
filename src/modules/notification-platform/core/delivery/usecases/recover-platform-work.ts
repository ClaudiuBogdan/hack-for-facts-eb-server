import { err, ok, type Result } from 'neverthrow';

import { resolveAmbiguousOutcome } from './resolve-ambiguous-outcome.js';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { DigestBatchRepo } from '../../digest/ports.js';
import type { EventError } from '../../events/errors.js';
import type { EventFanOutScheduler, NotificationEventRepo } from '../../events/ports.js';
import type { QueueError } from '../../shared/errors.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { ExternalChannel } from '../../shared/types.js';
import type { PlatformDeliveryError } from '../errors.js';
import type {
  ChannelAdapterPort,
  DeliveryAttemptRepo,
  DeliveryRepo,
  RenderJobScheduler,
  SendJobScheduler,
} from '../ports.js';

export interface DigestMaterializeScheduler {
  enqueue(payload: { limit: number }): Promise<Result<void, QueueError>>;
}

export interface RecoverPlatformWorkDeps {
  events: NotificationEventRepo;
  deliveries: DeliveryRepo;
  attempts: DeliveryAttemptRepo;
  digests: DigestBatchRepo;
  channelAdapters: ReadonlyMap<ExternalChannel, ChannelAdapterPort>;
  fanOutScheduler: EventFanOutScheduler;
  renderScheduler: RenderJobScheduler;
  sendScheduler: SendJobScheduler;
  digestScheduler?: DigestMaterializeScheduler;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface RecoverPlatformWorkInput {
  thresholdMinutes: number;
  limit: number;
}

export interface RecoverySummary {
  eventsEnqueued: number;
  rendersEnqueued: number;
  sendsEnqueued: number;
  ambiguousResolved: number;
  digestSweepsEnqueued: number;
}

export type RecoverPlatformWorkError = EventError | PlatformDeliveryError | QueueError | AuditError;

export const recoverPlatformWork = async (
  deps: RecoverPlatformWorkDeps,
  input: RecoverPlatformWorkInput
): Promise<Result<RecoverySummary, RecoverPlatformWorkError>> => {
  const now = deps.clock.now();
  const olderThan = new Date(now.getTime() - input.thresholdMinutes * 60 * 1000);
  const summary: RecoverySummary = {
    eventsEnqueued: 0,
    rendersEnqueued: 0,
    sendsEnqueued: 0,
    ambiguousResolved: 0,
    digestSweepsEnqueued: 0,
  };

  const events = await deps.events.findUnresolvedOlderThan({ olderThan, limit: input.limit });
  if (events.isErr()) {
    return err(events.error);
  }
  for (const event of events.value) {
    const enqueued = await deps.fanOutScheduler.enqueue({ eventId: event.id });
    if (enqueued.isErr()) {
      return err(enqueued.error);
    }
    summary.eventsEnqueued += 1;
  }

  const due = await deps.deliveries.findDueUnqueued({ olderThan, limit: input.limit });
  if (due.isErr()) {
    return err(due.error);
  }
  for (const delivery of due.value) {
    if (delivery.status === 'pending_render') {
      const enqueued = await deps.renderScheduler.enqueue({ deliveryId: delivery.id });
      if (enqueued.isErr()) {
        return err(enqueued.error);
      }
      summary.rendersEnqueued += 1;
      continue;
    }
    if (delivery.status === 'scheduled') {
      const readied = await deps.deliveries.transition({
        deliveryId: delivery.id,
        from: ['scheduled'],
        to: 'ready',
        now,
      });
      if (readied.isErr()) {
        return err(readied.error);
      }
      if (!readied.value) {
        continue;
      }
    }
    const enqueued = await deps.sendScheduler.enqueue(
      { deliveryId: delivery.id },
      { dedupeToken: String(delivery.attemptCount + 1) }
    );
    if (enqueued.isErr()) {
      return err(enqueued.error);
    }
    summary.sendsEnqueued += 1;
  }

  const expiredClaims = await deps.deliveries.findExpiredClaims({ now, limit: input.limit });
  if (expiredClaims.isErr()) {
    return err(expiredClaims.error);
  }
  for (const delivery of expiredClaims.value) {
    if (delivery.status === 'sending') {
      const resolved = await resolveAmbiguousOutcome(
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
        { deliveryId: delivery.id, expectedClaimToken: delivery.claimToken ?? '' }
      );
      if (resolved.isErr()) {
        return err(resolved.error);
      }
      summary.ambiguousResolved += 1;
    } else if (delivery.status === 'pending_render') {
      const enqueued = await deps.renderScheduler.enqueue({ deliveryId: delivery.id });
      if (enqueued.isErr()) {
        return err(enqueued.error);
      }
      summary.rendersEnqueued += 1;
    } else {
      const enqueued = await deps.sendScheduler.enqueue(
        { deliveryId: delivery.id },
        { dedupeToken: String(delivery.attemptCount + 1) }
      );
      if (enqueued.isErr()) {
        return err(enqueued.error);
      }
      summary.sendsEnqueued += 1;
    }
  }

  // DESIGN NOTE: DigestBatchRepo has no non-claiming due finder and the inventory
  // omitted a digest scheduler. An optional scheduler seam triggers the idempotent
  // sweep without mutating batch claims in the recovery usecase.
  if (deps.digestScheduler !== undefined) {
    const enqueued = await deps.digestScheduler.enqueue({ limit: input.limit });
    if (enqueued.isErr()) {
      return err(enqueued.error);
    }
    summary.digestSweepsEnqueued = 1;
  }
  return ok(summary);
};
