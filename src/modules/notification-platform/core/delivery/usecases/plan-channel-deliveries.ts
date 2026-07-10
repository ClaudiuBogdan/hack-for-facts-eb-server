import { err, ok, type Result } from 'neverthrow';

import { assignToDigest } from '../../digest/usecases/assign-to-digest.js';
import { buildImmediateDeliveryKey } from '../delivery-keys.js';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { DigestError } from '../../digest/errors.js';
import type { DigestBatchRepo } from '../../digest/ports.js';
import type { LogicalNotification } from '../../inbox/types.js';
import type { ChannelPlanEntry } from '../../preferences/types.js';
import type { KindDefinition } from '../../registry/kind-definition.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { ExternalChannel } from '../../shared/types.js';
import type { PlatformDeliveryError } from '../errors.js';
import type {
  ChannelAdapterPort,
  ChannelDestinationRepo,
  DeliveryRepo,
  RenderJobScheduler,
} from '../ports.js';

const DELIVERY_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export interface PlanChannelDeliveriesDeps {
  deliveries: DeliveryRepo;
  digests: DigestBatchRepo;
  destinations: ChannelDestinationRepo;
  channelAdapters: ReadonlyMap<ExternalChannel, ChannelAdapterPort>;
  renderScheduler: RenderJobScheduler;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface PlanChannelDeliveriesInput {
  logical: LogicalNotification;
  kind: KindDefinition;
  channelPlan: ChannelPlanEntry[];
}

export interface PlanChannelDeliveriesResult {
  immediate: number;
  digested: number;
}

export type PlanChannelDeliveriesError = PlatformDeliveryError | DigestError | AuditError;

export const planChannelDeliveries = async (
  deps: PlanChannelDeliveriesDeps,
  input: PlanChannelDeliveriesInput
): Promise<Result<PlanChannelDeliveriesResult, PlanChannelDeliveriesError>> => {
  if (input.kind.activeSender === 'legacy') {
    return ok({ immediate: 0, digested: 0 });
  }

  let immediate = 0;
  let digested = 0;
  for (const entry of input.channelPlan) {
    if (entry.channel === 'inbox' || entry.cadence === 'off') {
      continue;
    }
    if (entry.cadence === 'daily' || entry.cadence === 'weekly') {
      const assignment = await assignToDigest(
        {
          digests: deps.digests,
          clock: deps.clock,
          ids: deps.ids,
          logger: deps.logger,
        },
        {
          logicalNotificationId: input.logical.id,
          userId: input.logical.userId,
          channel: entry.channel,
          cadence: entry.cadence,
        }
      );
      if (assignment.isErr()) {
        return err(assignment.error);
      }
      if (assignment.value.membership === 'added') {
        digested += 1;
      }
      continue;
    }

    const adapter = deps.channelAdapters.get(entry.channel);
    if (adapter === undefined) {
      return err({
        type: 'ValidationError',
        message: `No channel adapter registered for ${entry.channel}`,
        field: 'channel',
      });
    }
    const resolved = await adapter.resolveDestination(input.logical.userId);
    if (resolved.isErr()) {
      return err(resolved.error);
    }
    if (resolved.value === null) {
      const audited = await deps.audit.append({
        action: 'recipient.skipped',
        occurredAt: deps.clock.now(),
        actor: 'system',
        userId: input.logical.userId,
        eventId: input.logical.eventId,
        logicalNotificationId: input.logical.id,
        reason: 'destination_unavailable',
        details: { channel: entry.channel },
      });
      if (audited.isErr()) {
        return err(audited.error);
      }
      continue;
    }

    const now = deps.clock.now();
    const destination = await deps.destinations.ensureCurrent({
      userId: input.logical.userId,
      channel: entry.channel,
      fingerprint: resolved.value.fingerprint,
      now,
    });
    if (destination.isErr()) {
      return err(destination.error);
    }
    const inserted = await deps.deliveries.insertIdempotent({
      id: deps.ids.newId(),
      deliveryKey: buildImmediateDeliveryKey(
        input.logical.id,
        entry.channel,
        destination.value.generation
      ),
      logicalNotificationId: input.logical.id,
      digestBatchId: null,
      kindId: input.kind.kindId,
      userId: input.logical.userId,
      channel: entry.channel,
      destinationFingerprint: destination.value.fingerprint,
      destinationGeneration: destination.value.generation,
      templateId: input.kind.templates.email.templateId,
      templateVersion: input.kind.templates.email.version,
      status: 'pending_render',
      notBefore: null,
      expiresAt:
        input.kind.deliveryExpiryHours === null
          ? null
          : new Date(now.getTime() + input.kind.deliveryExpiryHours * 60 * 60 * 1000),
      streamKey: input.logical.streamKey,
      streamSequence: input.logical.streamSequence,
      senderMode: input.kind.activeSender,
      now,
      retentionExpiresAt: new Date(now.getTime() + DELIVERY_RETENTION_MS),
    });
    if (inserted.isErr()) {
      return err(inserted.error);
    }
    if (!inserted.value.created) {
      continue;
    }
    const audited = await deps.audit.append({
      action: 'delivery.created',
      occurredAt: now,
      actor: 'system',
      userId: input.logical.userId,
      eventId: input.logical.eventId,
      logicalNotificationId: input.logical.id,
      deliveryId: inserted.value.delivery.id,
    });
    if (audited.isErr()) {
      return err(audited.error);
    }
    const enqueued = await deps.renderScheduler.enqueue({
      deliveryId: inserted.value.delivery.id,
    });
    if (enqueued.isErr()) {
      return err(enqueued.error);
    }
    immediate += 1;
  }
  return ok({ immediate, digested });
};
