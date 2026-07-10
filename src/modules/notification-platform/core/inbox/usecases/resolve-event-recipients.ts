import { err, ok, type Result } from 'neverthrow';

import { planChannelDeliveries } from '../../delivery/usecases/plan-channel-deliveries.js';
import { evaluateEligibility } from '../../preferences/evaluate-eligibility.js';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { PlatformDeliveryError } from '../../delivery/errors.js';
import type {
  AnonymizationCheckPort,
  ChannelAdapterPort,
  ChannelDestinationRepo,
  DeliveryRepo,
  RenderJobScheduler,
} from '../../delivery/ports.js';
import type { DigestError } from '../../digest/errors.js';
import type { DigestBatchRepo } from '../../digest/ports.js';
import type { EventError } from '../../events/errors.js';
import type { NotificationEventRepo } from '../../events/ports.js';
import type { PreferenceError } from '../../preferences/errors.js';
import type { PreferenceRepo } from '../../preferences/ports.js';
import type { KindRegistry } from '../../registry/registry.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { ExternalChannel } from '../../shared/types.js';
import type { SubscriptionError } from '../../subscriptions/errors.js';
import type { SubscriptionRepo } from '../../subscriptions/ports.js';
import type { InboxError } from '../errors.js';
import type { LogicalNotificationRepo } from '../ports.js';
import type { CreateLogicalNotificationInput } from '../types.js';

const DEFAULT_PAGE_SIZE = 500;
const EVENT_CLAIM_LEASE_SECONDS = 120;
const LOGICAL_RETENTION_MS = 2 * 365 * 24 * 60 * 60 * 1000;

export interface ResolveEventRecipientsDeps {
  events: NotificationEventRepo;
  registry: KindRegistry;
  subscriptions: SubscriptionRepo;
  preferences: PreferenceRepo;
  anonymization: AnonymizationCheckPort;
  logicalNotifications: LogicalNotificationRepo;
  deliveries: DeliveryRepo;
  digests: DigestBatchRepo;
  destinations: ChannelDestinationRepo;
  channelAdapters: ReadonlyMap<ExternalChannel, ChannelAdapterPort>;
  renderScheduler: RenderJobScheduler;
  audit: AuditLedgerPort;
  platformBaseUrl?: string;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface ResolveEventRecipientsInput {
  eventId: string;
  pageSize?: number;
}

export interface ResolveEventRecipientsResult {
  created: number;
  skipped: number;
  resumed: boolean;
}

export type ResolveEventRecipientsError =
  | EventError
  | SubscriptionError
  | PreferenceError
  | InboxError
  | PlatformDeliveryError
  | DigestError
  | AuditError;

export const resolveEventRecipients = async (
  deps: ResolveEventRecipientsDeps,
  input: ResolveEventRecipientsInput
): Promise<Result<ResolveEventRecipientsResult, ResolveEventRecipientsError>> => {
  const now = deps.clock.now();
  const claimToken = deps.ids.newId();
  const claimed = await deps.events.claimForResolution({
    eventId: input.eventId,
    claimToken,
    leaseSeconds: EVENT_CLAIM_LEASE_SECONDS,
    now,
  });
  if (claimed.isErr()) {
    return err(claimed.error);
  }
  if (claimed.value === null) {
    return ok({ created: 0, skipped: 0, resumed: false });
  }

  const event = claimed.value;
  const resumed = event.resolutionCursor !== null;
  const kind = deps.registry.getByEventType(event.eventType);
  if (kind === undefined) {
    return err({
      type: 'ValidationError',
      message: `Unknown notification event type: ${event.eventType}`,
      field: 'eventType',
    });
  }
  if (kind.recipientResolution.strategy === 'policy') {
    return err({
      type: 'ValidationError',
      message: `Policy resolver ${kind.recipientResolution.policyResolverId} is not implemented; policy resolvers arrive in Phase 5`,
      field: 'recipientResolution',
    });
  }

  const subject = kind.recipientResolution.subscription.subjectFromFacts(event.facts);
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  let cursor = event.resolutionCursor;
  let created = 0;
  let skipped = 0;

  for (;;) {
    const subscriptions = await deps.subscriptions.listActiveByKindAndSubject({
      kindId: kind.kindId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      afterId: cursor,
      limit: pageSize,
    });
    if (subscriptions.isErr()) {
      return err(subscriptions.error);
    }
    if (subscriptions.value.length === 0) {
      break;
    }

    const rows: CreateLogicalNotificationInput[] = [];
    const plans = new Map<string, ReturnType<typeof evaluateEligibility> & { eligible: true }>();
    for (const subscription of subscriptions.value) {
      const anonymized = await deps.anonymization.isUserAnonymized(subscription.userId);
      if (anonymized.isErr()) {
        return err(anonymized.error);
      }
      if (anonymized.value) {
        skipped += 1;
        const audited = await deps.audit.append({
          action: 'recipient.skipped',
          occurredAt: now,
          actor: 'system',
          userId: subscription.userId,
          eventId: event.id,
          subscriptionId: subscription.id,
          reason: 'user_anonymized',
        });
        if (audited.isErr()) {
          return err(audited.error);
        }
        continue;
      }
      const preferences = await deps.preferences.getForUser(subscription.userId);
      if (preferences.isErr()) {
        return err(preferences.error);
      }
      const decision = evaluateEligibility({
        kind,
        preferences: preferences.value,
        hasActiveSubscription: true,
      });
      if (!decision.eligible) {
        skipped += 1;
        const audited = await deps.audit.append({
          action: 'recipient.skipped',
          occurredAt: now,
          actor: 'system',
          userId: subscription.userId,
          eventId: event.id,
          subscriptionId: subscription.id,
          reason: decision.reason,
        });
        if (audited.isErr()) {
          return err(audited.error);
        }
        continue;
      }

      const projection = kind.projectContent({
        facts: event.facts,
        locale: 'ro',
        recipient: { userId: subscription.userId, recipientFacts: subscription.config },
        links: { platformBaseUrl: deps.platformBaseUrl ?? '' },
      });
      if (projection.isErr()) {
        return err(projection.error);
      }
      const id = deps.ids.newId();
      rows.push({
        id,
        eventId: event.id,
        kindId: kind.kindId,
        kindVersion: kind.kindVersion,
        userId: subscription.userId,
        eligibilityReason: 'active_subscription',
        locale: 'ro',
        recipientFacts: subscription.config,
        inboxTemplateId: kind.templates.inbox.templateId,
        inboxTemplateVersion: kind.templates.inbox.version,
        inboxTitle: projection.value.inbox.title,
        inboxBody: projection.value.inbox.body,
        inboxActionUrl: projection.value.inbox.actionUrl,
        inboxVisible: decision.channelPlan.some((entry) => entry.channel === 'inbox'),
        streamKey: event.streamKey,
        streamSequence: event.streamSequence,
        createdAt: now,
        retentionExpiresAt: new Date(now.getTime() + LOGICAL_RETENTION_MS),
      });
      plans.set(subscription.userId, decision);
    }

    if (rows.length > 0) {
      const inserted = await deps.logicalNotifications.insertBatchIdempotent(rows);
      if (inserted.isErr()) {
        return err(inserted.error);
      }
      const createdIds = new Set(inserted.value.createdIds);
      for (const createdId of createdIds) {
        const row = rows.find((candidate) => candidate.id === createdId);
        if (row === undefined) {
          continue;
        }
        created += 1;
        const included = await deps.audit.append({
          action: 'recipient.included',
          occurredAt: now,
          actor: 'system',
          userId: row.userId,
          eventId: event.id,
          logicalNotificationId: row.id,
          reason: row.eligibilityReason,
        });
        if (included.isErr()) {
          return err(included.error);
        }
        const logicalCreated = await deps.audit.append({
          action: 'logical.created',
          occurredAt: now,
          actor: 'system',
          userId: row.userId,
          eventId: event.id,
          logicalNotificationId: row.id,
        });
        if (logicalCreated.isErr()) {
          return err(logicalCreated.error);
        }
      }

      const persisted = await deps.logicalNotifications.listByEvent(event.id);
      if (persisted.isErr()) {
        return err(persisted.error);
      }
      const pageUserIds = new Set(rows.map((row) => row.userId));
      for (const logical of persisted.value) {
        if (!pageUserIds.has(logical.userId)) {
          continue;
        }
        const plan = plans.get(logical.userId);
        if (plan === undefined) {
          continue;
        }
        const planned = await planChannelDeliveries(
          {
            deliveries: deps.deliveries,
            digests: deps.digests,
            destinations: deps.destinations,
            channelAdapters: deps.channelAdapters,
            renderScheduler: deps.renderScheduler,
            audit: deps.audit,
            clock: deps.clock,
            ids: deps.ids,
            logger: deps.logger,
          },
          {
            logical,
            kind,
            channelPlan: plan.channelPlan,
          }
        );
        if (planned.isErr()) {
          return err(planned.error);
        }
      }
    }

    const lastSubscription = subscriptions.value.at(-1);
    if (lastSubscription === undefined) {
      break;
    }
    cursor = lastSubscription.id;
    const saved = await deps.events.saveResolutionCursor({
      eventId: event.id,
      cursor,
      expectedClaimToken: claimToken,
    });
    if (saved.isErr()) {
      return err(saved.error);
    }
    if (!saved.value) {
      return ok({ created, skipped, resumed });
    }
    if (subscriptions.value.length < pageSize) {
      break;
    }
  }

  const resolved = await deps.events.markResolved({
    eventId: event.id,
    expectedClaimToken: claimToken,
    now: deps.clock.now(),
  });
  if (resolved.isErr()) {
    return err(resolved.error);
  }
  return ok({ created, skipped, resumed });
};
