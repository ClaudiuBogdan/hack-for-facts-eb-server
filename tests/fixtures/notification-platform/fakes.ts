import { err, ok, type Result } from 'neverthrow';

import { canTransition } from '@/modules/notification-platform/core/delivery/state-machine.js';

import {
  makeFaultPlan,
  makeKeyedStore,
  type FaultPlan,
  type InMemoryJobRuntime,
  type KeyedStore,
} from '../../support/index.js';

import type { ShadowComparisonReader } from '@/modules/notification-platform/core/admin/usecases/get-shadow-comparison.js';
import type {
  DeliveryTraceReader,
  NotificationEventTraceReader,
} from '@/modules/notification-platform/core/admin/usecases/trace-event.js';
import type { AuditError } from '@/modules/notification-platform/core/audit/errors.js';
import type { AuditLedgerPort } from '@/modules/notification-platform/core/audit/ports.js';
import type { AuditEntry } from '@/modules/notification-platform/core/audit/types.js';
import type { PlatformDeliveryError } from '@/modules/notification-platform/core/delivery/errors.js';
import type {
  AnonymizationCheckPort,
  ChannelAdapterPort,
  ChannelDestinationRepo,
  DeliveryAttemptRepo,
  DeliveryRepo,
  RenderJobScheduler,
  SendJobScheduler,
} from '@/modules/notification-platform/core/delivery/ports.js';
import type {
  ChannelDestination,
  Delivery,
  DeliveryAttempt,
  ResolvedDestination,
} from '@/modules/notification-platform/core/delivery/types.js';
import type { DigestError } from '@/modules/notification-platform/core/digest/errors.js';
import type { DigestBatchRepo } from '@/modules/notification-platform/core/digest/ports.js';
import type { DigestBatch } from '@/modules/notification-platform/core/digest/types.js';
import type {
  EventError,
  EventSourceError,
} from '@/modules/notification-platform/core/events/errors.js';
import type {
  EventFanOutScheduler,
  EventSourcePort,
  NotificationEventRepo,
  SourceWatermarkRepo,
} from '@/modules/notification-platform/core/events/ports.js';
import type {
  NotificationEvent,
  SourceOccurrence,
} from '@/modules/notification-platform/core/events/types.js';
import type { InboxError } from '@/modules/notification-platform/core/inbox/errors.js';
import type { LogicalNotificationRepo } from '@/modules/notification-platform/core/inbox/ports.js';
import type { LogicalNotification } from '@/modules/notification-platform/core/inbox/types.js';
import type { PreferenceError } from '@/modules/notification-platform/core/preferences/errors.js';
import type { PreferenceRepo } from '@/modules/notification-platform/core/preferences/ports.js';
import type { UserNotificationPreferences } from '@/modules/notification-platform/core/preferences/types.js';
import type { KindDefinition } from '@/modules/notification-platform/core/registry/kind-definition.js';
import type { QueueError } from '@/modules/notification-platform/core/shared/errors.js';
import type {
  Clock,
  IdGenerator,
  LoggerPort,
} from '@/modules/notification-platform/core/shared/ports.js';
import type { ExternalChannel } from '@/modules/notification-platform/core/shared/types.js';
import type { SubscriptionError } from '@/modules/notification-platform/core/subscriptions/errors.js';
import type {
  SubjectAuthorizationPort,
  SubscriptionRepo,
} from '@/modules/notification-platform/core/subscriptions/ports.js';
import type { Subscription } from '@/modules/notification-platform/core/subscriptions/types.js';

type EventRepoMethod =
  | 'insertOrFind'
  | 'findById'
  | 'findByOccurrence'
  | 'claimForResolution'
  | 'saveResolutionCursor'
  | 'markResolved'
  | 'markConflicted'
  | 'findUnresolvedOlderThan';

export interface FakeNotificationEventRepo
  extends NotificationEventRepo, NotificationEventTraceReader {
  store: KeyedStore<string, NotificationEvent>;
  faults: FaultPlan<EventRepoMethod, EventError>;
}

export const makeFakeNotificationEventRepo = (options: {
  clock: Clock;
  faults?: FaultPlan<EventRepoMethod, EventError>;
}): FakeNotificationEventRepo => {
  const store = makeKeyedStore<string, NotificationEvent>({
    keyOf: (event) => event.id,
    indexes: {
      occurrence: (event) => `${event.source}\u0000${event.eventType}\u0000${event.occurrenceKey}`,
    },
  });
  const faults = options.faults ?? makeFaultPlan<EventRepoMethod, EventError>();
  return {
    store,
    faults,
    insertOrFind: async (input) => {
      const fault = faults.intercept('insertOrFind');
      if (fault !== undefined) return err(fault);
      const occurrence = `${input.source}\u0000${input.eventType}\u0000${input.occurrenceKey}`;
      const existing = store.byIndex('occurrence', occurrence)[0];
      if (existing !== undefined) {
        return ok({
          event: existing,
          created: false,
          payloadConflict: existing.payloadHash !== input.payloadHash,
        });
      }
      const now = options.clock.now();
      const event: NotificationEvent = {
        id: input.id,
        source: input.source,
        eventType: input.eventType,
        eventSchemaVersion: input.eventSchemaVersion,
        occurrenceKey: input.occurrenceKey,
        occurredAt: input.occurredAt,
        facts: input.facts,
        payloadHash: input.payloadHash,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null,
        streamKey: input.streamKey,
        streamSequence: input.streamSequence,
        status: 'pending',
        resolutionCursor: null,
        claimToken: null,
        claimExpiresAt: null,
        createdAt: now,
        resolvedAt: null,
        retentionExpiresAt: input.retentionExpiresAt,
      };
      return ok({ event: store.put(event), created: true, payloadConflict: false });
    },
    findById: async (eventId) => {
      const fault = faults.intercept('findById');
      if (fault !== undefined) return err(fault);
      return ok(store.get(eventId) ?? null);
    },
    findByOccurrence: async (input) => {
      const fault = faults.intercept('findByOccurrence');
      if (fault !== undefined) return err(fault);
      const occurrence = `${input.source}\u0000${input.eventType}\u0000${input.occurrenceKey}`;
      return ok(store.byIndex('occurrence', occurrence)[0] ?? null);
    },
    claimForResolution: async (input) => {
      const fault = faults.intercept('claimForResolution');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.eventId);
      if (current === undefined) return ok(null);
      const expired =
        current.status === 'resolving' &&
        current.claimExpiresAt !== null &&
        current.claimExpiresAt.getTime() <= input.now.getTime();
      if (current.status !== 'pending' && !expired) return ok(null);
      const claimed = store.update(input.eventId, (event) => ({
        ...event,
        status: 'resolving',
        claimToken: input.claimToken,
        claimExpiresAt: new Date(input.now.getTime() + input.leaseSeconds * 1000),
      }));
      return ok(claimed ?? null);
    },
    saveResolutionCursor: async (input) => {
      const fault = faults.intercept('saveResolutionCursor');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.eventId);
      if (current?.claimToken !== input.expectedClaimToken) return ok(false);
      store.update(input.eventId, (event) => ({ ...event, resolutionCursor: input.cursor }));
      return ok(true);
    },
    markResolved: async (input) => {
      const fault = faults.intercept('markResolved');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.eventId);
      if (current?.claimToken !== input.expectedClaimToken) return ok(false);
      store.update(input.eventId, (event) => ({
        ...event,
        status: 'resolved',
        claimToken: null,
        claimExpiresAt: null,
        resolvedAt: input.now,
      }));
      return ok(true);
    },
    markConflicted: async (eventId) => {
      const fault = faults.intercept('markConflicted');
      if (fault !== undefined) return err(fault);
      store.update(eventId, (event) => ({ ...event, status: 'conflicted' }));
      return ok(undefined);
    },
    findUnresolvedOlderThan: async (input) => {
      const fault = faults.intercept('findUnresolvedOlderThan');
      if (fault !== undefined) return err(fault);
      return ok(
        store
          .filter(
            (event) =>
              (event.status === 'pending' || event.status === 'resolving') &&
              event.createdAt.getTime() <= input.olderThan.getTime()
          )
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .slice(0, input.limit)
      );
    },
  };
};

type WatermarkMethod = 'get' | 'compareAndSet';
interface WatermarkRow {
  sourceId: string;
  watermark: string | null;
}
export interface FakeSourceWatermarkRepo extends SourceWatermarkRepo {
  store: KeyedStore<string, WatermarkRow>;
  faults: FaultPlan<WatermarkMethod, EventError>;
}

export const makeFakeSourceWatermarkRepo = (
  options: {
    faults?: FaultPlan<WatermarkMethod, EventError>;
  } = {}
): FakeSourceWatermarkRepo => {
  const store = makeKeyedStore<string, WatermarkRow>({ keyOf: (row) => row.sourceId });
  const faults = options.faults ?? makeFaultPlan<WatermarkMethod, EventError>();
  return {
    store,
    faults,
    get: async (sourceId) => {
      const fault = faults.intercept('get');
      if (fault !== undefined) return err(fault);
      return ok(store.get(sourceId)?.watermark ?? null);
    },
    compareAndSet: async (input) => {
      const fault = faults.intercept('compareAndSet');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.sourceId)?.watermark ?? null;
      if (current !== input.expected) return ok(false);
      store.put({ sourceId: input.sourceId, watermark: input.next });
      return ok(true);
    },
  };
};

type SubscriptionMethod =
  | 'createOrReactivate'
  | 'findByIdForUser'
  | 'listByUser'
  | 'listActiveByKindAndSubject'
  | 'setState';
export interface FakeSubscriptionRepo extends SubscriptionRepo {
  store: KeyedStore<string, Subscription>;
  faults: FaultPlan<SubscriptionMethod, SubscriptionError>;
}

export const makeFakeSubscriptionRepo = (
  options: {
    faults?: FaultPlan<SubscriptionMethod, SubscriptionError>;
  } = {}
): FakeSubscriptionRepo => {
  const store = makeKeyedStore<string, Subscription>({
    keyOf: (subscription) => subscription.id,
    indexes: {
      unique: (subscription) =>
        `${subscription.userId}\u0000${subscription.kindId}\u0000${subscription.normalizedKey}`,
    },
  });
  const faults = options.faults ?? makeFaultPlan<SubscriptionMethod, SubscriptionError>();
  return {
    store,
    faults,
    createOrReactivate: async (input) => {
      const fault = faults.intercept('createOrReactivate');
      if (fault !== undefined) return err(fault);
      const key = `${input.userId}\u0000${input.kindId}\u0000${input.normalizedKey}`;
      const existing = store.byIndex('unique', key)[0];
      if (existing !== undefined) {
        const updated = store.update(existing.id, (subscription) => ({
          ...subscription,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          config: input.config,
          state: 'active',
          updatedAt: input.now,
          removedAt: null,
        }));
        return ok(updated ?? existing);
      }
      return ok(
        store.put({
          id: input.id,
          userId: input.userId,
          kindId: input.kindId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          config: input.config,
          normalizedKey: input.normalizedKey,
          state: 'active',
          createdAt: input.now,
          updatedAt: input.now,
          removedAt: null,
        })
      );
    },
    findByIdForUser: async (id, userId) => {
      const fault = faults.intercept('findByIdForUser');
      if (fault !== undefined) return err(fault);
      const subscription = store.get(id);
      return ok(subscription?.userId === userId ? subscription : null);
    },
    listByUser: async (input) => {
      const fault = faults.intercept('listByUser');
      if (fault !== undefined) return err(fault);
      const sorted = store
        .filter(
          (subscription) =>
            subscription.userId === input.userId &&
            (input.kindId === undefined || subscription.kindId === input.kindId)
        )
        .sort((left, right) => left.id.localeCompare(right.id));
      const start =
        input.cursor === undefined ? 0 : sorted.findIndex((item) => item.id === input.cursor) + 1;
      const items = sorted.slice(Math.max(0, start), Math.max(0, start) + input.limit);
      const hasMore = Math.max(0, start) + items.length < sorted.length;
      return ok({ items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null });
    },
    listActiveByKindAndSubject: async (input) => {
      const fault = faults.intercept('listActiveByKindAndSubject');
      if (fault !== undefined) return err(fault);
      return ok(
        store
          .filter(
            (subscription) =>
              subscription.kindId === input.kindId &&
              subscription.subjectType === input.subjectType &&
              subscription.subjectId === input.subjectId &&
              subscription.state === 'active' &&
              (input.afterId === null || subscription.id > input.afterId)
          )
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(0, input.limit)
      );
    },
    setState: async (input) => {
      const fault = faults.intercept('setState');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.id);
      if (current?.userId !== input.userId) return ok(false);
      store.update(input.id, (subscription) => ({
        ...subscription,
        state: input.state,
        updatedAt: input.now,
        removedAt: input.state === 'removed' ? input.now : null,
      }));
      return ok(true);
    },
  };
};

type PreferenceMethod = 'getForUser' | 'upsertGlobal' | 'upsertChannel';
export interface FakePreferenceRepo extends PreferenceRepo {
  store: KeyedStore<string, UserNotificationPreferences>;
  faults: FaultPlan<PreferenceMethod, PreferenceError>;
}

const defaultPreferences = (userId: string): UserNotificationPreferences => ({
  userId,
  globalOptionalEnabled: true,
  channels: {
    inbox: { enabled: true, cadence: 'immediate' },
    email: { enabled: true, cadence: 'immediate' },
  },
});

export const makeFakePreferenceRepo = (
  options: {
    faults?: FaultPlan<PreferenceMethod, PreferenceError>;
  } = {}
): FakePreferenceRepo => {
  const store = makeKeyedStore<string, UserNotificationPreferences>({
    keyOf: (preferences) => preferences.userId,
  });
  const faults = options.faults ?? makeFaultPlan<PreferenceMethod, PreferenceError>();
  return {
    store,
    faults,
    getForUser: async (userId) => {
      const fault = faults.intercept('getForUser');
      if (fault !== undefined) return err(fault);
      return ok(store.get(userId) ?? defaultPreferences(userId));
    },
    upsertGlobal: async (input) => {
      const fault = faults.intercept('upsertGlobal');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.userId) ?? defaultPreferences(input.userId);
      store.put({ ...current, globalOptionalEnabled: input.enabled });
      return ok(undefined);
    },
    upsertChannel: async (input) => {
      const fault = faults.intercept('upsertChannel');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.userId) ?? defaultPreferences(input.userId);
      store.put({
        ...current,
        channels: {
          ...current.channels,
          [input.channel]: { enabled: input.enabled, cadence: input.cadence },
        },
      });
      return ok(undefined);
    },
  };
};

type LogicalMethod =
  | 'insertBatchIdempotent'
  | 'findByIdForUser'
  | 'findByIds'
  | 'listForUser'
  | 'countUnread'
  | 'setReadState'
  | 'markAllRead'
  | 'setArchivedState'
  | 'listByEvent';
export interface FakeLogicalNotificationRepo extends LogicalNotificationRepo {
  store: KeyedStore<string, LogicalNotification>;
  faults: FaultPlan<LogicalMethod, InboxError>;
}

export const makeFakeLogicalNotificationRepo = (
  options: {
    faults?: FaultPlan<LogicalMethod, InboxError>;
  } = {}
): FakeLogicalNotificationRepo => {
  const store = makeKeyedStore<string, LogicalNotification>({
    keyOf: (logical) => logical.id,
    indexes: {
      unique: (logical) => `${logical.eventId}\u0000${logical.kindId}\u0000${logical.userId}`,
      event: (logical) => logical.eventId,
    },
  });
  const faults = options.faults ?? makeFaultPlan<LogicalMethod, InboxError>();
  return {
    store,
    faults,
    insertBatchIdempotent: async (rows) => {
      const fault = faults.intercept('insertBatchIdempotent');
      if (fault !== undefined) return err(fault);
      const createdIds: string[] = [];
      let duplicateCount = 0;
      for (const row of rows) {
        const key = `${row.eventId}\u0000${row.kindId}\u0000${row.userId}`;
        if (store.byIndex('unique', key).length > 0) {
          duplicateCount += 1;
          continue;
        }
        store.put({ ...row, readAt: null, archivedAt: null });
        createdIds.push(row.id);
      }
      return ok({ createdIds, duplicateCount });
    },
    findByIdForUser: async (id, userId) => {
      const fault = faults.intercept('findByIdForUser');
      if (fault !== undefined) return err(fault);
      const logical = store.get(id);
      return ok(logical?.userId === userId ? logical : null);
    },
    findByIds: async (ids) => {
      const fault = faults.intercept('findByIds');
      if (fault !== undefined) return err(fault);
      const wanted = new Set(ids);
      return ok(store.filter((logical) => wanted.has(logical.id)));
    },
    listForUser: async (input) => {
      const fault = faults.intercept('listForUser');
      if (fault !== undefined) return err(fault);
      const sorted = store
        .filter((logical) => {
          if (logical.userId !== input.userId || !logical.inboxVisible) return false;
          if (input.view === 'unread')
            return logical.readAt === null && logical.archivedAt === null;
          if (input.view === 'archived') return logical.archivedAt !== null;
          return logical.archivedAt === null;
        })
        .sort((left, right) => {
          const time = right.createdAt.getTime() - left.createdAt.getTime();
          return time === 0 ? right.id.localeCompare(left.id) : time;
        });
      const cursorIndex =
        input.cursor === null ? -1 : sorted.findIndex((logical) => logical.id === input.cursor);
      const start = cursorIndex < 0 ? 0 : cursorIndex + 1;
      const items = sorted.slice(start, start + input.limit);
      return ok({
        items,
        nextCursor: start + items.length < sorted.length ? (items.at(-1)?.id ?? null) : null,
      });
    },
    countUnread: async (userId) => {
      const fault = faults.intercept('countUnread');
      if (fault !== undefined) return err(fault);
      return ok(
        store.filter(
          (logical) =>
            logical.userId === userId &&
            logical.inboxVisible &&
            logical.readAt === null &&
            logical.archivedAt === null
        ).length
      );
    },
    setReadState: async (input) => {
      const fault = faults.intercept('setReadState');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.id);
      if (current?.userId !== input.userId) return ok(false);
      store.update(input.id, (logical) => ({ ...logical, readAt: input.readAt }));
      return ok(true);
    },
    markAllRead: async (input) => {
      const fault = faults.intercept('markAllRead');
      if (fault !== undefined) return err(fault);
      const unread = store.filter(
        (logical) =>
          logical.userId === input.userId &&
          logical.inboxVisible &&
          logical.readAt === null &&
          logical.archivedAt === null
      );
      for (const logical of unread) {
        store.update(logical.id, (current) => ({ ...current, readAt: input.now }));
      }
      return ok(unread.length);
    },
    setArchivedState: async (input) => {
      const fault = faults.intercept('setArchivedState');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.id);
      if (current?.userId !== input.userId) return ok(false);
      store.update(input.id, (logical) => ({ ...logical, archivedAt: input.archivedAt }));
      return ok(true);
    },
    listByEvent: async (eventId) => {
      const fault = faults.intercept('listByEvent');
      if (fault !== undefined) return err(fault);
      return ok(store.byIndex('event', eventId));
    },
  };
};

type DeliveryMethod =
  | 'insertIdempotent'
  | 'findById'
  | 'findByProviderRef'
  | 'listByLogicalNotification'
  | 'listShadowComparisonRecipients'
  | 'claimForRender'
  | 'claimForSending'
  | 'saveRenderedContent'
  | 'transition'
  | 'cancelPendingForUser'
  | 'findDueUnqueued'
  | 'findExpiredClaims'
  | 'findDueForExpiry'
  | 'searchDeadLetters';
export interface FakeDeliveryRepo
  extends DeliveryRepo, DeliveryTraceReader, ShadowComparisonReader {
  store: KeyedStore<string, Delivery>;
  faults: FaultPlan<DeliveryMethod, PlatformDeliveryError>;
}

const TERMINAL_STATES = new Set<Delivery['status']>([
  'delivered',
  'bounced',
  'complained',
  'suppressed',
  'cancelled',
  'expired',
  'permanent_failed',
  'dead_letter',
  'unknown',
]);

export const makeFakeDeliveryRepo = (options: {
  clock: Clock;
  faults?: FaultPlan<DeliveryMethod, PlatformDeliveryError>;
  eventIdByLogicalId?: ReadonlyMap<string, string>;
}): FakeDeliveryRepo => {
  const store = makeKeyedStore<string, Delivery>({
    keyOf: (delivery) => delivery.id,
    indexes: {
      deliveryKey: (delivery) => delivery.deliveryKey,
      providerRef: (delivery) => delivery.providerRef,
      logical: (delivery) => delivery.logicalNotificationId,
    },
  });
  const faults = options.faults ?? makeFaultPlan<DeliveryMethod, PlatformDeliveryError>();
  return {
    store,
    faults,
    insertIdempotent: async (input) => {
      const fault = faults.intercept('insertIdempotent');
      if (fault !== undefined) return err(fault);
      const existing = store.byIndex('deliveryKey', input.deliveryKey)[0];
      if (existing !== undefined) return ok({ delivery: existing, created: false });
      const delivery: Delivery = {
        id: input.id,
        deliveryKey: input.deliveryKey,
        logicalNotificationId: input.logicalNotificationId,
        digestBatchId: input.digestBatchId,
        kindId: input.kindId,
        userId: input.userId,
        channel: input.channel,
        destinationFingerprint: input.destinationFingerprint,
        destinationGeneration: input.destinationGeneration,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        renderedSubject: null,
        renderedHtml: null,
        renderedText: null,
        contentHash: null,
        status: 'pending_render',
        notBefore: input.notBefore,
        expiresAt: input.expiresAt,
        streamKey: input.streamKey,
        streamSequence: input.streamSequence,
        attemptCount: 0,
        nextAttemptAt: null,
        claimToken: null,
        claimExpiresAt: null,
        providerIdempotencyKey: null,
        providerRef: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        senderMode: input.senderMode,
        createdAt: input.now,
        updatedAt: input.now,
        acceptedAt: null,
        terminalAt: null,
        retentionExpiresAt: input.retentionExpiresAt,
      };
      return ok({ delivery: store.put(delivery), created: true });
    },
    findById: async (id) => {
      const fault = faults.intercept('findById');
      if (fault !== undefined) return err(fault);
      return ok(store.get(id) ?? null);
    },
    findByProviderRef: async (providerRef) => {
      const fault = faults.intercept('findByProviderRef');
      if (fault !== undefined) return err(fault);
      return ok(store.byIndex('providerRef', providerRef)[0] ?? null);
    },
    listByLogicalNotification: async (logicalNotificationId) => {
      const fault = faults.intercept('listByLogicalNotification');
      if (fault !== undefined) return err(fault);
      return ok(store.byIndex('logical', logicalNotificationId));
    },
    listShadowComparisonRecipients: async (input) => {
      const fault = faults.intercept('listShadowComparisonRecipients');
      if (fault !== undefined) return err(fault);
      return ok(
        store
          .filter(
            (delivery) => delivery.kindId === input.kindId && delivery.senderMode === 'shadow'
          )
          .map((delivery) => ({ userId: delivery.userId, contentHash: delivery.contentHash }))
      );
    },
    claimForRender: async (input) => {
      const fault = faults.intercept('claimForRender');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.deliveryId);
      if (current?.status !== 'pending_render') return ok(null);
      if (
        current.claimToken !== null &&
        current.claimExpiresAt !== null &&
        current.claimExpiresAt.getTime() > input.now.getTime()
      ) {
        return ok(null);
      }
      const claimed = store.update(current.id, (delivery) => ({
        ...delivery,
        claimToken: input.claimToken,
        claimExpiresAt: new Date(input.now.getTime() + input.leaseSeconds * 1000),
        updatedAt: input.now,
      }));
      return ok(claimed ?? null);
    },
    claimForSending: async (input) => {
      const fault = faults.intercept('claimForSending');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.deliveryId);
      const expiredSending =
        current?.status === 'sending' &&
        current.claimExpiresAt !== null &&
        current.claimExpiresAt.getTime() < input.now.getTime();
      if (
        current === undefined ||
        (current.status !== 'ready' && current.status !== 'retry_wait' && !expiredSending) ||
        current.senderMode !== 'active' ||
        (current.notBefore !== null && current.notBefore.getTime() > input.now.getTime()) ||
        (current.nextAttemptAt !== null && current.nextAttemptAt.getTime() > input.now.getTime())
      ) {
        return ok(null);
      }
      if (current.streamKey !== null && current.streamSequence !== null) {
        const currentSequence = current.streamSequence;
        const blocked = store.find(
          (predecessor) =>
            predecessor.userId === current.userId &&
            predecessor.channel === current.channel &&
            predecessor.streamKey === current.streamKey &&
            predecessor.streamSequence !== null &&
            predecessor.streamSequence < currentSequence &&
            !TERMINAL_STATES.has(predecessor.status)
        );
        if (blocked !== undefined) return ok(null);
      }
      const claimed = store.update(current.id, (delivery) => ({
        ...delivery,
        status: 'sending',
        attemptCount: delivery.attemptCount + 1,
        claimToken: input.claimToken,
        claimExpiresAt: new Date(input.now.getTime() + input.leaseSeconds * 1000),
        updatedAt: input.now,
      }));
      return ok(claimed ?? null);
    },
    saveRenderedContent: async (input) => {
      const fault = faults.intercept('saveRenderedContent');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.deliveryId);
      if (
        current?.status !== 'pending_render' ||
        current.claimToken !== input.expectedClaimToken ||
        !canTransition(current.status, input.nextStatus)
      ) {
        return ok(false);
      }
      store.update(current.id, (delivery) => ({
        ...delivery,
        renderedSubject: input.subject,
        renderedHtml: input.html,
        renderedText: input.text,
        contentHash: input.contentHash,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        status: input.nextStatus,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: options.clock.now(),
      }));
      return ok(true);
    },
    transition: async (input) => {
      const fault = faults.intercept('transition');
      if (fault !== undefined) return err(fault);
      const current = store.get(input.deliveryId);
      if (
        current === undefined ||
        !input.from.includes(current.status) ||
        !canTransition(current.status, input.to) ||
        (input.expectedClaimToken !== undefined && current.claimToken !== input.expectedClaimToken)
      ) {
        return ok(false);
      }
      store.update(current.id, (delivery) => ({
        ...delivery,
        ...input.patch,
        status: input.to,
        updatedAt: input.now,
      }));
      return ok(true);
    },
    cancelPendingForUser: async (input) => {
      const fault = faults.intercept('cancelPendingForUser');
      if (fault !== undefined) return err(fault);
      const pending = store.filter(
        (delivery) =>
          delivery.userId === input.userId &&
          !TERMINAL_STATES.has(delivery.status) &&
          delivery.status !== 'accepted' &&
          (input.channels === undefined || input.channels.includes(delivery.channel)) &&
          (input.kindIds === undefined || input.kindIds.includes(delivery.kindId))
      );
      let count = 0;
      for (const delivery of pending) {
        if (!canTransition(delivery.status, 'cancelled')) continue;
        store.update(delivery.id, (current) => ({
          ...current,
          status: 'cancelled',
          lastErrorCode: input.reason,
          lastErrorMessage: input.reason,
          terminalAt: input.now,
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: input.now,
        }));
        count += 1;
      }
      return ok(count);
    },
    findDueUnqueued: async (input) => {
      const fault = faults.intercept('findDueUnqueued');
      if (fault !== undefined) return err(fault);
      const now = options.clock.now();
      return ok(
        store
          .filter(
            (delivery) =>
              delivery.createdAt.getTime() <= input.olderThan.getTime() &&
              (delivery.status === 'pending_render' ||
                delivery.status === 'ready' ||
                delivery.status === 'retry_wait' ||
                delivery.status === 'scheduled') &&
              (delivery.notBefore === null || delivery.notBefore.getTime() <= now.getTime()) &&
              (delivery.nextAttemptAt === null || delivery.nextAttemptAt.getTime() <= now.getTime())
          )
          .slice(0, input.limit)
      );
    },
    findExpiredClaims: async (input) => {
      const fault = faults.intercept('findExpiredClaims');
      if (fault !== undefined) return err(fault);
      return ok(
        store
          .filter(
            (delivery) =>
              delivery.claimExpiresAt !== null &&
              delivery.claimExpiresAt.getTime() <= input.now.getTime() &&
              delivery.claimToken !== null
          )
          .slice(0, input.limit)
      );
    },
    findDueForExpiry: async (input) => {
      const fault = faults.intercept('findDueForExpiry');
      if (fault !== undefined) return err(fault);
      return ok(
        store
          .filter(
            (delivery) =>
              delivery.expiresAt !== null &&
              delivery.expiresAt.getTime() <= input.now.getTime() &&
              !TERMINAL_STATES.has(delivery.status) &&
              delivery.status !== 'sending' &&
              delivery.status !== 'accepted'
          )
          .slice(0, input.limit)
      );
    },
    searchDeadLetters: async (input) => {
      const fault = faults.intercept('searchDeadLetters');
      if (fault !== undefined) return err(fault);
      const dead = store
        .filter(
          (delivery) =>
            (delivery.status === 'dead_letter' ||
              delivery.status === 'unknown' ||
              delivery.status === 'permanent_failed') &&
            (input.kindId === undefined || delivery.kindId === input.kindId) &&
            (input.channel === undefined || delivery.channel === input.channel) &&
            (input.status === undefined || delivery.status === input.status) &&
            (input.userId === undefined || delivery.userId === input.userId) &&
            (input.eventId === undefined ||
              (delivery.logicalNotificationId !== null &&
                options.eventIdByLogicalId?.get(delivery.logicalNotificationId) === input.eventId))
        )
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
      const cursorIndex =
        input.cursor === null ? -1 : dead.findIndex((delivery) => delivery.id === input.cursor);
      const start = cursorIndex < 0 ? 0 : cursorIndex + 1;
      const items = dead.slice(start, start + input.limit);
      return ok({
        items,
        nextCursor: start + items.length < dead.length ? (items.at(-1)?.id ?? null) : null,
      });
    },
  };
};

type AttemptMethod = 'create' | 'complete' | 'listByDelivery';
export interface FakeDeliveryAttemptRepo extends DeliveryAttemptRepo {
  store: KeyedStore<string, DeliveryAttempt>;
  faults: FaultPlan<AttemptMethod, PlatformDeliveryError>;
  callSequence: string[];
}

export const makeFakeDeliveryAttemptRepo = (
  options: {
    faults?: FaultPlan<AttemptMethod, PlatformDeliveryError>;
  } = {}
): FakeDeliveryAttemptRepo => {
  const store = makeKeyedStore<string, DeliveryAttempt>({
    keyOf: (attempt) => attempt.id,
    indexes: {
      unique: (attempt) => `${attempt.deliveryId}\u0000${String(attempt.attemptNumber)}`,
      delivery: (attempt) => attempt.deliveryId,
    },
  });
  const faults = options.faults ?? makeFaultPlan<AttemptMethod, PlatformDeliveryError>();
  const callSequence: string[] = [];
  return {
    store,
    faults,
    callSequence,
    create: async (input) => {
      const fault = faults.intercept('create');
      if (fault !== undefined) return err(fault);
      callSequence.push('attempt.create');
      const unique = `${input.deliveryId}\u0000${String(input.attemptNumber)}`;
      const existing = store.byIndex('unique', unique)[0];
      if (existing !== undefined) return ok(existing);
      return ok(
        store.put({
          id: input.id,
          deliveryId: input.deliveryId,
          attemptNumber: input.attemptNumber,
          startedAt: input.startedAt,
          completedAt: null,
          providerIdempotencyKey: input.providerIdempotencyKey,
          requestCorrelationId: input.requestCorrelationId,
          destinationFingerprint: input.destinationFingerprint,
          result: null,
          errorCode: null,
          errorMessage: null,
          providerRef: null,
          latencyMs: null,
          retryAfterMs: null,
        })
      );
    },
    complete: async (input) => {
      const fault = faults.intercept('complete');
      if (fault !== undefined) return err(fault);
      callSequence.push('attempt.complete');
      store.update(input.attemptId, (attempt) => ({
        ...attempt,
        completedAt: input.completedAt,
        result: input.result,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        providerRef: input.providerRef ?? null,
        latencyMs: input.latencyMs ?? null,
        retryAfterMs: input.retryAfterMs ?? null,
      }));
      return ok(undefined);
    },
    listByDelivery: async (deliveryId) => {
      const fault = faults.intercept('listByDelivery');
      if (fault !== undefined) return err(fault);
      return ok(
        store
          .byIndex('delivery', deliveryId)
          .sort((left, right) => left.attemptNumber - right.attemptNumber)
      );
    },
  };
};

type DestinationMethod =
  | 'getCurrent'
  | 'ensureCurrent'
  | 'suppressByFingerprint'
  | 'listSuppressed';
export interface FakeChannelDestinationRepo extends ChannelDestinationRepo {
  store: KeyedStore<string, ChannelDestination>;
  faults: FaultPlan<DestinationMethod, PlatformDeliveryError>;
}

export const makeFakeChannelDestinationRepo = (options: {
  ids: IdGenerator;
  faults?: FaultPlan<DestinationMethod, PlatformDeliveryError>;
}): FakeChannelDestinationRepo => {
  const store = makeKeyedStore<string, ChannelDestination>({
    keyOf: (destination) => destination.id,
    indexes: {
      userChannel: (destination) => `${destination.userId}\u0000${destination.channel}`,
      fingerprint: (destination) => `${destination.channel}\u0000${destination.fingerprint}`,
    },
  });
  const faults = options.faults ?? makeFaultPlan<DestinationMethod, PlatformDeliveryError>();
  return {
    store,
    faults,
    getCurrent: async (input) => {
      const fault = faults.intercept('getCurrent');
      if (fault !== undefined) return err(fault);
      return ok(
        store
          .byIndex('userChannel', `${input.userId}\u0000${input.channel}`)
          .find((destination) => destination.isCurrent) ?? null
      );
    },
    ensureCurrent: async (input) => {
      const fault = faults.intercept('ensureCurrent');
      if (fault !== undefined) return err(fault);
      const candidates = store.byIndex('userChannel', `${input.userId}\u0000${input.channel}`);
      const current = candidates.find((destination) => destination.isCurrent);
      if (current?.fingerprint === input.fingerprint) return ok(current);
      if (current !== undefined) {
        store.update(current.id, (destination) => ({
          ...destination,
          isCurrent: false,
          updatedAt: input.now,
        }));
      }
      const sameFingerprint = candidates.find(
        (destination) => destination.fingerprint === input.fingerprint
      );
      const generation =
        candidates.reduce((maximum, destination) => Math.max(maximum, destination.generation), 0) +
        1;
      if (sameFingerprint !== undefined) {
        const restored = store.update(sameFingerprint.id, (destination) => ({
          ...destination,
          generation,
          isCurrent: true,
          updatedAt: input.now,
        }));
        return ok(restored ?? sameFingerprint);
      }
      return ok(
        store.put({
          id: options.ids.newId(),
          userId: input.userId,
          channel: input.channel,
          fingerprint: input.fingerprint,
          generation,
          isCurrent: true,
          suppressedAt: null,
          suppressionReason: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
      );
    },
    suppressByFingerprint: async (input) => {
      const fault = faults.intercept('suppressByFingerprint');
      if (fault !== undefined) return err(fault);
      const matches = store.byIndex('fingerprint', `${input.channel}\u0000${input.fingerprint}`);
      for (const destination of matches) {
        store.update(destination.id, (current) => ({
          ...current,
          suppressedAt: input.now,
          suppressionReason: input.reason,
          updatedAt: input.now,
        }));
      }
      return ok(matches.length);
    },
    listSuppressed: async (input) => {
      const fault = faults.intercept('listSuppressed');
      if (fault !== undefined) return err(fault);
      const suppressed = store
        .filter(
          (destination) =>
            destination.suppressedAt !== null &&
            (input.userId === undefined || destination.userId === input.userId)
        )
        .sort((left, right) => {
          const time = (right.suppressedAt?.getTime() ?? 0) - (left.suppressedAt?.getTime() ?? 0);
          return time === 0 ? right.id.localeCompare(left.id) : time;
        });
      const cursorIndex =
        input.cursor === null
          ? -1
          : suppressed.findIndex((destination) => destination.id === input.cursor);
      const start = cursorIndex < 0 ? 0 : cursorIndex + 1;
      const items = suppressed.slice(start, start + input.limit);
      return ok({
        items,
        nextCursor: start + items.length < suppressed.length ? (items.at(-1)?.id ?? null) : null,
      });
    },
  };
};

interface DigestMember {
  key: string;
  batchId: string;
  logicalNotificationId: string;
  createdAt: Date;
}
type DigestMethod =
  | 'findById'
  | 'findOrCreateOpen'
  | 'addMemberIdempotent'
  | 'claimDue'
  | 'listMembersNewestFirst'
  | 'markRendered'
  | 'cancelWholeBatch';
export interface FakeDigestBatchRepo extends DigestBatchRepo {
  store: KeyedStore<string, DigestBatch>;
  members: KeyedStore<string, DigestMember>;
  faults: FaultPlan<DigestMethod, DigestError>;
}

export const makeFakeDigestBatchRepo = (options: {
  clock: Clock;
  logicalNotifications?: KeyedStore<string, LogicalNotification>;
  deliveries?: KeyedStore<string, Delivery>;
  faults?: FaultPlan<DigestMethod, DigestError>;
}): FakeDigestBatchRepo => {
  const store = makeKeyedStore<string, DigestBatch>({
    keyOf: (batch) => batch.id,
    indexes: {
      unique: (batch) =>
        `${batch.userId}\u0000${batch.channel}\u0000${batch.cadence}\u0000${batch.windowStartUtc.toISOString()}`,
    },
  });
  const members = makeKeyedStore<string, DigestMember>({ keyOf: (member) => member.key });
  const faults = options.faults ?? makeFaultPlan<DigestMethod, DigestError>();
  return {
    store,
    members,
    faults,
    findById: async (id) => {
      const fault = faults.intercept('findById');
      if (fault !== undefined) return err(fault);
      return ok(store.get(id) ?? null);
    },
    findOrCreateOpen: async (input) => {
      const fault = faults.intercept('findOrCreateOpen');
      if (fault !== undefined) return err(fault);
      const unique = `${input.userId}\u0000${input.channel}\u0000${input.cadence}\u0000${input.window.windowStartUtc.toISOString()}`;
      const existing = store.byIndex('unique', unique)[0];
      if (existing !== undefined) return ok(existing);
      return ok(
        store.put({
          id: input.id,
          userId: input.userId,
          channel: input.channel,
          cadence: input.cadence,
          windowStartUtc: input.window.windowStartUtc,
          windowEndUtc: input.window.windowEndUtc,
          dispatchAtUtc: input.window.dispatchAtUtc,
          status: 'open',
          renderedItemIds: null,
          overflowCount: null,
          deliveryId: null,
          claimToken: null,
          claimExpiresAt: null,
          createdAt: input.now,
          updatedAt: input.now,
        })
      );
    },
    addMemberIdempotent: async (input) => {
      const fault = faults.intercept('addMemberIdempotent');
      if (fault !== undefined) return err(fault);
      const batch = store.get(input.batchId);
      if (batch === undefined) {
        return err({ type: 'NotFound', entity: 'digest batch', id: input.batchId });
      }
      if (batch.status !== 'open') {
        return ok('rejected');
      }
      const key = `${input.batchId}\u0000${input.logicalNotificationId}`;
      if (members.has(key)) return ok('duplicate');
      members.put({
        key,
        batchId: input.batchId,
        logicalNotificationId: input.logicalNotificationId,
        createdAt: input.now,
      });
      return ok('added');
    },
    claimDue: async (input) => {
      const fault = faults.intercept('claimDue');
      if (fault !== undefined) return err(fault);
      const due = store
        .filter(
          (batch) =>
            (batch.status === 'open' ||
              (batch.status === 'materializing' &&
                batch.claimExpiresAt !== null &&
                batch.claimExpiresAt.getTime() <= input.now.getTime())) &&
            batch.dispatchAtUtc.getTime() <= input.now.getTime()
        )
        .sort((left, right) => left.dispatchAtUtc.getTime() - right.dispatchAtUtc.getTime())
        .slice(0, input.limit);
      return ok(
        due.map(
          (batch) =>
            store.update(batch.id, (current) => ({
              ...current,
              status: 'materializing',
              claimToken: input.claimToken,
              claimExpiresAt: new Date(input.now.getTime() + input.leaseSeconds * 1000),
              updatedAt: input.now,
            })) ?? batch
        )
      );
    },
    listMembersNewestFirst: async (input) => {
      const fault = faults.intercept('listMembersNewestFirst');
      if (fault !== undefined) return err(fault);
      const batchMembers = members
        .filter((member) => member.batchId === input.batchId)
        .sort((left, right) => {
          const time = right.createdAt.getTime() - left.createdAt.getTime();
          return time === 0
            ? right.logicalNotificationId.localeCompare(left.logicalNotificationId)
            : time;
        });
      const items = batchMembers
        .map((member) => options.logicalNotifications?.get(member.logicalNotificationId))
        .filter((logical): logical is LogicalNotification => logical !== undefined)
        .slice(0, input.limit);
      return ok({ items, totalCount: batchMembers.length });
    },
    markRendered: async (input) => {
      const fault = faults.intercept('markRendered');
      if (fault !== undefined) return err(fault);
      const batch = store.get(input.batchId);
      if (batch?.status !== 'materializing' || batch.claimToken !== input.expectedClaimToken) {
        return ok(false);
      }
      store.update(batch.id, (current) => ({
        ...current,
        status: 'rendered',
        renderedItemIds: [...input.renderedItemIds],
        overflowCount: input.overflowCount,
        deliveryId: input.deliveryId,
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: input.now,
      }));
      return ok(true);
    },
    cancelWholeBatch: async (input) => {
      const fault = faults.intercept('cancelWholeBatch');
      if (fault !== undefined) return err(fault);
      const batch = store.get(input.batchId);
      if (batch === undefined || batch.status === 'cancelled') return ok(false);
      store.update(batch.id, (current) => ({
        ...current,
        status: 'cancelled',
        claimToken: null,
        claimExpiresAt: null,
        updatedAt: input.now,
      }));
      if (batch.deliveryId !== null) {
        const delivery = options.deliveries?.get(batch.deliveryId);
        if (delivery !== undefined && !TERMINAL_STATES.has(delivery.status)) {
          options.deliveries?.update(delivery.id, (current) => ({
            ...current,
            status: 'cancelled',
            lastErrorCode: input.reason,
            lastErrorMessage: input.reason,
            terminalAt: input.now,
            updatedAt: input.now,
          }));
        }
      }
      return ok(true);
    },
  };
};

type AuditMethod = 'append' | 'listByEntity';
export interface FakeAuditLedgerPort extends AuditLedgerPort {
  store: KeyedStore<string, AuditEntry>;
  faults: FaultPlan<AuditMethod, AuditError>;
}

export const makeFakeAuditLedgerPort = (options: {
  ids: IdGenerator;
  faults?: FaultPlan<AuditMethod, AuditError>;
}): FakeAuditLedgerPort => {
  const store = makeKeyedStore<string, AuditEntry>({ keyOf: (entry) => entry.id });
  const faults = options.faults ?? makeFaultPlan<AuditMethod, AuditError>();
  return {
    store,
    faults,
    append: async (entry) => {
      const fault = faults.intercept('append');
      if (fault !== undefined) return err(fault);
      store.put({ id: options.ids.newId(), ...entry });
      return ok(undefined);
    },
    listByEntity: async (input) => {
      const fault = faults.intercept('listByEntity');
      if (fault !== undefined) return err(fault);
      const entries = store
        .filter(
          (entry) =>
            (input.eventId === undefined || entry.eventId === input.eventId) &&
            (input.deliveryId === undefined || entry.deliveryId === input.deliveryId) &&
            (input.userId === undefined || entry.userId === input.userId)
        )
        .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
      const cursorIndex =
        input.cursor === null ? -1 : entries.findIndex((entry) => entry.id === input.cursor);
      const start = cursorIndex < 0 ? 0 : cursorIndex + 1;
      const items = entries.slice(start, start + input.limit);
      return ok({
        items,
        nextCursor: start + items.length < entries.length ? (items.at(-1)?.id ?? null) : null,
      });
    },
  };
};

type EventSourceMethod = 'readOccurrences';
export interface FakeEventSourcePort extends EventSourcePort {
  faults: FaultPlan<EventSourceMethod, EventSourceError>;
  occurrences: SourceOccurrence[];
}

export const makeFakeEventSourcePort = (
  options: {
    sourceId?: string;
    occurrences?: SourceOccurrence[];
    nextWatermark?: string | null;
    onRead?: () => void;
    faults?: FaultPlan<EventSourceMethod, EventSourceError>;
  } = {}
): FakeEventSourcePort => {
  const occurrences = [...(options.occurrences ?? [])];
  const faults = options.faults ?? makeFaultPlan<EventSourceMethod, EventSourceError>();
  return {
    sourceId: options.sourceId ?? 'test-source',
    occurrences,
    faults,
    readOccurrences: async (input) => {
      const fault = faults.intercept('readOccurrences');
      if (fault !== undefined) return err(fault);
      options.onRead?.();
      return ok({
        occurrences: occurrences.slice(0, input.limit),
        nextWatermark: options.nextWatermark ?? null,
      });
    },
  };
};

type ChannelAdapterMethod = 'resolveDestination' | 'render' | 'renderDigest' | 'send' | 'reconcile';
type ResolveDestinationResult = Result<
  { fingerprint: string; destination: ResolvedDestination } | null,
  PlatformDeliveryError
>;
type RenderResult = Result<
  { subject: string; html: string; text: string; contentHash: string },
  PlatformDeliveryError
>;
type RenderDigestResult = Awaited<ReturnType<ChannelAdapterPort['renderDigest']>>;
type SendResult = Awaited<ReturnType<ChannelAdapterPort['send']>>;
type SendResultValue =
  | { classification: 'accepted'; providerRef: string }
  | {
      classification: 'transient_failure' | 'permanent_failure' | 'ambiguous';
      errorCode: string;
      errorMessage: string;
      retryAfterMs?: number;
    };
type ReconcileResult = Awaited<ReturnType<ChannelAdapterPort['reconcile']>>;

export interface FakeChannelAdapterPort extends ChannelAdapterPort {
  faults: FaultPlan<ChannelAdapterMethod, PlatformDeliveryError>;
  calls: {
    resolvedUserIds: string[];
    renderedDeliveryIds: string[];
    renderedDigestItemIds: string[][];
    sentDeliveryIds: string[];
    reconciledIdempotencyKeys: string[];
  };
}

export const makeFakeChannelAdapterPort = (
  options: {
    channel?: ExternalChannel;
    resolveResult?: ResolveDestinationResult;
    renderResult?: RenderResult;
    renderDigestResult?: RenderDigestResult;
    sendResult?: SendResult;
    sendResultValue?: SendResultValue;
    reconcileResult?: ReconcileResult;
    resolvedFingerprint?: string;
    onSend?: () => void;
    faults?: FaultPlan<ChannelAdapterMethod, PlatformDeliveryError>;
    callSequence?: string[];
  } = {}
): FakeChannelAdapterPort => {
  const faults = options.faults ?? makeFaultPlan<ChannelAdapterMethod, PlatformDeliveryError>();
  const calls = {
    resolvedUserIds: [] as string[],
    renderedDeliveryIds: [] as string[],
    renderedDigestItemIds: [] as string[][],
    sentDeliveryIds: [] as string[],
    reconciledIdempotencyKeys: [] as string[],
  };
  return {
    channel: options.channel ?? 'email',
    faults,
    calls,
    resolveDestination: async (userId) => {
      const fault = faults.intercept('resolveDestination');
      if (fault !== undefined) return err(fault);
      calls.resolvedUserIds.push(userId);
      return (
        options.resolveResult ??
        ok({
          fingerprint: options.resolvedFingerprint ?? 'fingerprint-1',
          destination: { address: 'user@example.test' },
        })
      );
    },
    render: async (input) => {
      const fault = faults.intercept('render');
      if (fault !== undefined) return err(fault);
      calls.renderedDeliveryIds.push(input.delivery.id);
      return (
        options.renderResult ??
        ok({
          subject: input.projection.inbox.title,
          html: `<p>${input.projection.inbox.body}</p>`,
          text: input.projection.inbox.body,
          contentHash: `hash-${input.delivery.id}`,
        })
      );
    },
    renderDigest: async (input) => {
      const fault = faults.intercept('renderDigest');
      if (fault !== undefined) return err(fault);
      calls.renderedDeliveryIds.push(input.delivery.id);
      calls.renderedDigestItemIds.push(input.items.map((item) => item.id));
      return (
        options.renderDigestResult ??
        ok({
          subject: `Digest with ${String(input.items.length)} items`,
          html: input.items.map((item) => `<p>${item.inboxTitle}</p>`).join(''),
          text: input.items.map((item) => item.inboxTitle).join('\n'),
          contentHash: `digest-hash-${input.delivery.id}`,
        })
      );
    },
    send: async (input) => {
      const fault = faults.intercept('send');
      if (fault !== undefined) return err(fault);
      calls.sentDeliveryIds.push(input.delivery.id);
      options.callSequence?.push('adapter.send');
      options.onSend?.();
      return (
        options.sendResult ??
        ok(options.sendResultValue ?? { classification: 'accepted', providerRef: 'provider-1' })
      );
    },
    reconcile: async (input) => {
      const fault = faults.intercept('reconcile');
      if (fault !== undefined) return err(fault);
      calls.reconciledIdempotencyKeys.push(input.providerIdempotencyKey);
      return options.reconcileResult ?? ok({ known: false });
    },
  };
};

type AnonymizationCheckMethod = 'isUserAnonymized';

export interface FakeAnonymizationCheckPort extends AnonymizationCheckPort {
  anonymizedUserIds: Set<string>;
  faults: FaultPlan<AnonymizationCheckMethod, PlatformDeliveryError>;
  checkedUserIds: string[];
}

export const makeFakeAnonymizationCheckPort = (
  options: {
    anonymizedUserIds?: Iterable<string>;
    faults?: FaultPlan<AnonymizationCheckMethod, PlatformDeliveryError>;
  } = {}
): FakeAnonymizationCheckPort => {
  const anonymizedUserIds = new Set(options.anonymizedUserIds ?? []);
  const faults = options.faults ?? makeFaultPlan<AnonymizationCheckMethod, PlatformDeliveryError>();
  const checkedUserIds: string[] = [];
  return {
    anonymizedUserIds,
    faults,
    checkedUserIds,
    isUserAnonymized: async (userId) => {
      const fault = faults.intercept('isUserAnonymized');
      if (fault !== undefined) return err(fault);
      checkedUserIds.push(userId);
      return ok(anonymizedUserIds.has(userId));
    },
  };
};

type SubjectAuthorizationMethod = 'authorizeSubject';
export interface FakeSubjectAuthorizationPort extends SubjectAuthorizationPort {
  faults: FaultPlan<SubjectAuthorizationMethod, SubscriptionError>;
  calls: { userId: string; kindId: string; subjectType: string; subjectId: string }[];
}

export const makeFakeSubjectAuthorizationPort = (
  options: {
    allowed?: boolean;
    denyReason?: string;
    faults?: FaultPlan<SubjectAuthorizationMethod, SubscriptionError>;
  } = {}
): FakeSubjectAuthorizationPort => {
  const faults = options.faults ?? makeFaultPlan<SubjectAuthorizationMethod, SubscriptionError>();
  const calls: FakeSubjectAuthorizationPort['calls'] = [];
  return {
    faults,
    calls,
    authorizeSubject: async (input) => {
      const fault = faults.intercept('authorizeSubject');
      if (fault !== undefined) return err(fault);
      calls.push(input);
      const allowed = options.allowed ?? true;
      return ok({
        allowed,
        ...(allowed || options.denyReason === undefined ? {} : { denyReason: options.denyReason }),
      });
    },
  };
};

type SchedulerMethod = 'enqueue';
interface FakeSchedulerBase {
  faults: FaultPlan<SchedulerMethod, QueueError>;
}

const queueErrorFromRuntime = (error: { message: string; retryable: boolean }): QueueError => ({
  type: 'QueueError',
  message: error.message,
  retryable: error.retryable,
});

export interface FakeEventFanOutScheduler extends EventFanOutScheduler, FakeSchedulerBase {}

export const makeFakeEventFanOutScheduler = (
  runtime: InMemoryJobRuntime,
  options: { faults?: FaultPlan<SchedulerMethod, QueueError> } = {}
): FakeEventFanOutScheduler => {
  const faults = options.faults ?? makeFaultPlan<SchedulerMethod, QueueError>();
  const enqueue = runtime.enqueuer<{ eventId: string }>('np-event-fanout');
  return {
    faults,
    enqueue: async (payload) => {
      const fault = faults.intercept('enqueue');
      if (fault !== undefined) return err(fault);
      return (await enqueue(payload, { dedupeId: payload.eventId }))
        .map(() => undefined)
        .mapErr(queueErrorFromRuntime);
    },
  };
};

export interface FakeRenderJobScheduler extends RenderJobScheduler, FakeSchedulerBase {}

export const makeFakeRenderJobScheduler = (
  runtime: InMemoryJobRuntime,
  options: { faults?: FaultPlan<SchedulerMethod, QueueError> } = {}
): FakeRenderJobScheduler => {
  const faults = options.faults ?? makeFaultPlan<SchedulerMethod, QueueError>();
  const enqueue = runtime.enqueuer<{ deliveryId: string }>('np-delivery-render');
  return {
    faults,
    enqueue: async (payload) => {
      const fault = faults.intercept('enqueue');
      if (fault !== undefined) return err(fault);
      return (await enqueue(payload, { dedupeId: payload.deliveryId }))
        .map(() => undefined)
        .mapErr(queueErrorFromRuntime);
    },
  };
};

export interface FakeSendJobScheduler extends SendJobScheduler, FakeSchedulerBase {}

export const makeFakeSendJobScheduler = (
  runtime: InMemoryJobRuntime,
  options: { faults?: FaultPlan<SchedulerMethod, QueueError> } = {}
): FakeSendJobScheduler => {
  const faults = options.faults ?? makeFaultPlan<SchedulerMethod, QueueError>();
  const enqueue = runtime.enqueuer<{ deliveryId: string }>('np-delivery-send');
  return {
    faults,
    enqueue: async (payload, enqueueOptions) => {
      const fault = faults.intercept('enqueue');
      if (fault !== undefined) return err(fault);
      return (
        await enqueue(payload, {
          dedupeId: `${payload.deliveryId}:${String(enqueueOptions?.delayMs ?? 0)}`,
          ...(enqueueOptions?.delayMs === undefined ? {} : { delayMs: enqueueOptions.delayMs }),
        })
      )
        .map(() => undefined)
        .mapErr(queueErrorFromRuntime);
    },
  };
};

export interface FakeLoggerPort extends LoggerPort {
  entries: {
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    data?: Record<string, unknown>;
  }[];
}

export const makeFakeLoggerPort = (): FakeLoggerPort => {
  const entries: FakeLoggerPort['entries'] = [];
  return {
    entries,
    child: () => makeFakeLoggerPort(),
    debug: (msg, data) =>
      entries.push({ level: 'debug', msg, ...(data === undefined ? {} : { data }) }),
    info: (msg, data) =>
      entries.push({ level: 'info', msg, ...(data === undefined ? {} : { data }) }),
    warn: (msg, data) =>
      entries.push({ level: 'warn', msg, ...(data === undefined ? {} : { data }) }),
    error: (msg, data) =>
      entries.push({ level: 'error', msg, ...(data === undefined ? {} : { data }) }),
  };
};

export const makeFakeKindRegistry = (
  kinds: readonly KindDefinition[]
): {
  getByKindId(kindId: string): KindDefinition | undefined;
  getByEventType(eventType: string): KindDefinition | undefined;
  list(): readonly KindDefinition[];
} => {
  const byKindId = new Map(kinds.map((kind) => [kind.kindId, kind]));
  const byEventType = new Map(kinds.map((kind) => [kind.eventType, kind]));
  return {
    getByKindId: (kindId) => byKindId.get(kindId),
    getByEventType: (eventType) => byEventType.get(eventType),
    list: () => kinds,
  };
};
