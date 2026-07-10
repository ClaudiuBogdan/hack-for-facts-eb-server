import { err, ok, type Result } from 'neverthrow';

import { DIGEST_EMAIL_MAX_ITEMS } from '../../digest/windowing.js';

import type { DigestError } from '../../digest/errors.js';
import type { DigestBatchRepo } from '../../digest/ports.js';
import type { EventError } from '../../events/errors.js';
import type { NotificationEventRepo } from '../../events/ports.js';
import type { InboxError } from '../../inbox/errors.js';
import type { LogicalNotificationRepo } from '../../inbox/ports.js';
import type { KindRegistry } from '../../registry/registry.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { ExternalChannel } from '../../shared/types.js';
import type { PlatformDeliveryError } from '../errors.js';
import type { ChannelAdapterPort, DeliveryRepo, SendJobScheduler } from '../ports.js';

const RENDER_CLAIM_LEASE_SECONDS = 120;

export interface RenderDeliveryDeps {
  deliveries: DeliveryRepo;
  logicalNotifications: LogicalNotificationRepo;
  digests: DigestBatchRepo;
  registry: KindRegistry;
  events: NotificationEventRepo;
  channelAdapters: ReadonlyMap<ExternalChannel, ChannelAdapterPort>;
  sendScheduler: SendJobScheduler;
  platformBaseUrl?: string;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface RenderDeliveryInput {
  deliveryId: string;
}

export interface RenderDeliveryResult {
  rendered: boolean;
}

export type RenderDeliveryError = PlatformDeliveryError | EventError | InboxError | DigestError;

export const renderDelivery = async (
  deps: RenderDeliveryDeps,
  input: RenderDeliveryInput
): Promise<Result<RenderDeliveryResult, RenderDeliveryError>> => {
  const now = deps.clock.now();
  const claimToken = deps.ids.newId();
  const claimed = await deps.deliveries.claimForRender({
    deliveryId: input.deliveryId,
    claimToken,
    leaseSeconds: RENDER_CLAIM_LEASE_SECONDS,
    now,
  });
  if (claimed.isErr()) {
    return err(claimed.error);
  }
  if (claimed.value === null) {
    return ok({ rendered: false });
  }
  const delivery = claimed.value;
  const adapter = deps.channelAdapters.get(delivery.channel);
  if (adapter === undefined) {
    return err({
      type: 'ValidationError',
      message: `No channel adapter registered for ${delivery.channel}`,
      field: 'channel',
    });
  }

  let renderedContent: { subject: string; html: string; text: string; contentHash: string };
  let templateId: string;
  let templateVersion: string;
  if (delivery.digestBatchId !== null) {
    const batch = await deps.digests.findById(delivery.digestBatchId);
    if (batch.isErr()) {
      return err(batch.error);
    }
    if (batch.value === null) {
      return err({ type: 'NotFound', entity: 'digest batch', id: delivery.digestBatchId });
    }
    const members = await deps.digests.listMembersNewestFirst({
      batchId: batch.value.id,
      limit: DIGEST_EMAIL_MAX_ITEMS,
    });
    if (members.isErr()) {
      return err(members.error);
    }
    const renderedItemIds = batch.value.renderedItemIds;
    if (renderedItemIds === null || batch.value.overflowCount === null) {
      return err({
        type: 'ValidationError',
        message: 'Digest batch has no rendered item snapshot',
        field: 'digestBatchId',
      });
    }
    const logicals = await deps.logicalNotifications.findByIds(renderedItemIds);
    if (logicals.isErr()) {
      return err(logicals.error);
    }
    const logicalById = new Map(logicals.value.map((logical) => [logical.id, logical]));
    const orderedItems = renderedItemIds.flatMap((id) => {
      const logical = logicalById.get(id);
      return logical === undefined ? [] : [logical];
    });
    if (orderedItems.length !== renderedItemIds.length) {
      return err({
        type: 'NotFound',
        entity: 'digest logical notification',
        id: renderedItemIds.find((id) => !logicalById.has(id)) ?? batch.value.id,
      });
    }
    const rendered = await adapter.renderDigest({
      delivery,
      batch: batch.value,
      items: orderedItems,
      overflowCount: batch.value.overflowCount,
    });
    if (rendered.isErr()) {
      return err(rendered.error);
    }
    renderedContent = rendered.value;
    templateId = delivery.templateId ?? 'notification-platform-digest';
    templateVersion = delivery.templateVersion ?? 'v1';
  } else {
    if (delivery.logicalNotificationId === null) {
      return err({
        type: 'ValidationError',
        message: 'Delivery has no logical notification or digest parent',
        field: 'deliveryId',
      });
    }
    const logical = await deps.logicalNotifications.findByIdForUser(
      delivery.logicalNotificationId,
      delivery.userId
    );
    if (logical.isErr()) {
      return err(logical.error);
    }
    if (logical.value === null) {
      return err({
        type: 'NotFound',
        entity: 'logical notification',
        id: delivery.logicalNotificationId,
      });
    }
    const event = await deps.events.findById(logical.value.eventId);
    if (event.isErr()) {
      return err(event.error);
    }
    if (event.value === null) {
      return err({ type: 'NotFound', entity: 'notification event', id: logical.value.eventId });
    }
    const kind = deps.registry.getByKindId(delivery.kindId);
    if (kind === undefined) {
      return err({ type: 'NotFound', entity: 'notification kind', id: delivery.kindId });
    }
    const projection = kind.projectContent({
      facts: event.value.facts,
      locale: logical.value.locale,
      recipient: {
        userId: delivery.userId,
        ...(logical.value.recipientFacts === null
          ? {}
          : { recipientFacts: logical.value.recipientFacts }),
      },
      links: { platformBaseUrl: deps.platformBaseUrl ?? '' },
    });
    if (projection.isErr()) {
      return err(projection.error);
    }
    const rendered = await adapter.render({
      delivery,
      kind,
      projection: projection.value,
      unsubscribeContext: { userId: delivery.userId, kindId: delivery.kindId },
    });
    if (rendered.isErr()) {
      return err(rendered.error);
    }
    renderedContent = rendered.value;
    templateId = delivery.templateId ?? kind.templates.email.templateId;
    templateVersion = delivery.templateVersion ?? kind.templates.email.version;
  }
  const nextStatus =
    delivery.notBefore !== null && delivery.notBefore.getTime() > now.getTime()
      ? 'scheduled'
      : 'ready';
  const saved = await deps.deliveries.saveRenderedContent({
    deliveryId: delivery.id,
    expectedClaimToken: claimToken,
    subject: renderedContent.subject,
    html: renderedContent.html,
    text: renderedContent.text,
    contentHash: renderedContent.contentHash,
    templateId,
    templateVersion,
    nextStatus,
  });
  if (saved.isErr()) {
    return err(saved.error);
  }
  if (!saved.value) {
    return ok({ rendered: false });
  }
  if (nextStatus === 'ready' && delivery.senderMode === 'active') {
    const enqueued = await deps.sendScheduler.enqueue({ deliveryId: delivery.id });
    if (enqueued.isErr()) {
      return err(enqueued.error);
    }
  }
  return ok({ rendered: true });
};
