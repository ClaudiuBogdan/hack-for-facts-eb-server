import { err, ok, type Result } from 'neverthrow';

import { buildDigestDeliveryKey } from '../../delivery/delivery-keys.js';
import { DIGEST_EMAIL_MAX_ITEMS } from '../windowing.js';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { PlatformDeliveryError } from '../../delivery/errors.js';
import type {
  ChannelAdapterPort,
  ChannelDestinationRepo,
  DeliveryRepo,
  RenderJobScheduler,
} from '../../delivery/ports.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { ExternalChannel } from '../../shared/types.js';
import type { DigestError } from '../errors.js';
import type { DigestBatchRepo } from '../ports.js';

const DELIVERY_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const DIGEST_CLAIM_LEASE_SECONDS = 120;

export interface MaterializeDueDigestsDeps {
  digests: DigestBatchRepo;
  deliveries: DeliveryRepo;
  destinations: ChannelDestinationRepo;
  channelAdapters: ReadonlyMap<ExternalChannel, ChannelAdapterPort>;
  renderScheduler: RenderJobScheduler;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface MaterializeDueDigestsInput {
  limit: number;
}

export interface MaterializeDueDigestsResult {
  materialized: number;
}

export type MaterializeDueDigestsError = DigestError | PlatformDeliveryError | AuditError;

export const materializeDueDigests = async (
  deps: MaterializeDueDigestsDeps,
  input: MaterializeDueDigestsInput
): Promise<Result<MaterializeDueDigestsResult, MaterializeDueDigestsError>> => {
  const now = deps.clock.now();
  const claimToken = deps.ids.newId();
  const claimed = await deps.digests.claimDue({
    now,
    limit: input.limit,
    claimToken,
    leaseSeconds: DIGEST_CLAIM_LEASE_SECONDS,
  });
  if (claimed.isErr()) {
    return err(claimed.error);
  }

  let materialized = 0;
  for (const batch of claimed.value) {
    const members = await deps.digests.listMembersNewestFirst({
      batchId: batch.id,
      limit: DIGEST_EMAIL_MAX_ITEMS,
    });
    if (members.isErr()) {
      return err(members.error);
    }
    const newest = members.value.items[0];
    if (newest === undefined) {
      const cancelled = await deps.digests.cancelWholeBatch({
        batchId: batch.id,
        reason: 'empty_digest',
        now,
      });
      if (cancelled.isErr()) {
        return err(cancelled.error);
      }
      continue;
    }

    const adapter = deps.channelAdapters.get(batch.channel);
    if (adapter === undefined) {
      return err({
        type: 'ValidationError',
        message: `No channel adapter registered for ${batch.channel}`,
        field: 'channel',
      });
    }
    const resolved = await adapter.resolveDestination(batch.userId);
    if (resolved.isErr()) {
      return err(resolved.error);
    }
    if (resolved.value === null) {
      const cancelled = await deps.digests.cancelWholeBatch({
        batchId: batch.id,
        reason: 'destination_unavailable',
        now,
      });
      if (cancelled.isErr()) {
        return err(cancelled.error);
      }
      continue;
    }
    const destination = await deps.destinations.ensureCurrent({
      userId: batch.userId,
      channel: batch.channel,
      fingerprint: resolved.value.fingerprint,
      now,
    });
    if (destination.isErr()) {
      return err(destination.error);
    }

    // DESIGN NOTE: DigestBatch and the materialization dependency contract carry no
    // digest kind/template/sender policy. The first snapshotted item's kind is retained
    // for traceability and v1 digest rows use the active sender lane.
    const deliveryId = deps.ids.newId();
    const inserted = await deps.deliveries.insertIdempotent({
      id: deliveryId,
      deliveryKey: buildDigestDeliveryKey(batch.id),
      logicalNotificationId: null,
      digestBatchId: batch.id,
      kindId: newest.kindId,
      userId: batch.userId,
      channel: batch.channel,
      destinationFingerprint: destination.value.fingerprint,
      destinationGeneration: destination.value.generation,
      templateId: null,
      templateVersion: null,
      status: 'pending_render',
      notBefore: null,
      expiresAt: null,
      streamKey: null,
      streamSequence: null,
      senderMode: 'active',
      now,
      retentionExpiresAt: new Date(now.getTime() + DELIVERY_RETENTION_MS),
    });
    if (inserted.isErr()) {
      return err(inserted.error);
    }

    const renderedItemIds = members.value.items.map((item) => item.id);
    const marked = await deps.digests.markRendered({
      batchId: batch.id,
      expectedClaimToken: claimToken,
      renderedItemIds,
      overflowCount: Math.max(0, members.value.totalCount - renderedItemIds.length),
      deliveryId: inserted.value.delivery.id,
      now,
    });
    if (marked.isErr()) {
      return err(marked.error);
    }
    if (!marked.value) {
      continue;
    }
    if (inserted.value.created) {
      const audited = await deps.audit.append({
        action: 'delivery.created',
        occurredAt: now,
        actor: 'system',
        userId: batch.userId,
        deliveryId: inserted.value.delivery.id,
        batchId: batch.id,
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
    }
    materialized += 1;
  }
  return ok({ materialized });
};
