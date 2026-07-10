import { Type } from '@sinclair/typebox';
import { ok } from 'neverthrow';

import type { AuditEntry } from '@/modules/notification-platform/core/audit/types.js';
import type {
  ChannelDestination,
  Delivery,
  DeliveryAttempt,
} from '@/modules/notification-platform/core/delivery/types.js';
import type { DigestBatch } from '@/modules/notification-platform/core/digest/types.js';
import type {
  NotificationEvent,
  SourceOccurrence,
} from '@/modules/notification-platform/core/events/types.js';
import type { LogicalNotification } from '@/modules/notification-platform/core/inbox/types.js';
import type { UserNotificationPreferences } from '@/modules/notification-platform/core/preferences/types.js';
import type { KindDefinition } from '@/modules/notification-platform/core/registry/kind-definition.js';
import type { Clock, IdGenerator } from '@/modules/notification-platform/core/shared/ports.js';
import type { Subscription } from '@/modules/notification-platform/core/subscriptions/types.js';

export interface BuilderDeps {
  ids: IdGenerator;
  clock: Clock;
}

const EVENT_FACTS_SCHEMA = Type.Object(
  {
    subjectId: Type.String({ minLength: 1 }),
    title: Type.String(),
    sequence: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false }
);
const SUBSCRIPTION_CONFIG_SCHEMA = Type.Object({}, { additionalProperties: false });

export const makeNotificationEvent = (
  deps: BuilderDeps,
  overrides: Partial<NotificationEvent> = {}
): NotificationEvent => {
  const now = deps.clock.now();
  return {
    id: deps.ids.newId(),
    source: 'test-source',
    eventType: 'test.event.created',
    eventSchemaVersion: 1,
    occurrenceKey: 'occurrence-1',
    occurredAt: now,
    facts: { subjectId: 'subject-1', title: 'Test event' },
    payloadHash: 'a'.repeat(64),
    correlationId: null,
    causationId: null,
    streamKey: null,
    streamSequence: null,
    status: 'pending',
    resolutionCursor: null,
    claimToken: null,
    claimExpiresAt: null,
    createdAt: now,
    resolvedAt: null,
    retentionExpiresAt: new Date(now.getTime() + 2 * 365 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
};

export const makeSourceOccurrence = (
  deps: BuilderDeps,
  overrides: Partial<SourceOccurrence> = {}
): SourceOccurrence => ({
  eventType: 'test.event.created',
  occurrenceKey: `occurrence-${deps.ids.newId()}`,
  occurredAt: deps.clock.now(),
  facts: { subjectId: 'subject-1', title: 'Test event' },
  ...overrides,
});

export const makeSubscription = (
  deps: BuilderDeps,
  overrides: Partial<Subscription> = {}
): Subscription => {
  const now = deps.clock.now();
  return {
    id: deps.ids.newId(),
    userId: 'user-1',
    kindId: 'test.kind',
    subjectType: 'test-subject',
    subjectId: 'subject-1',
    config: {},
    normalizedKey: '["test.kind","test-subject","subject-1"]:{}',
    state: 'active',
    createdAt: now,
    updatedAt: now,
    removedAt: null,
    ...overrides,
  };
};

export const makeUserNotificationPreferences = (
  deps: BuilderDeps,
  overrides: Partial<UserNotificationPreferences> = {}
): UserNotificationPreferences => ({
  userId: `user-${deps.ids.newId()}`,
  globalOptionalEnabled: true,
  channels: {
    inbox: { enabled: true, cadence: 'immediate' },
    email: { enabled: true, cadence: 'immediate' },
  },
  ...overrides,
});

export const makeLogicalNotification = (
  deps: BuilderDeps,
  overrides: Partial<LogicalNotification> = {}
): LogicalNotification => {
  const now = deps.clock.now();
  return {
    id: deps.ids.newId(),
    eventId: 'event-1',
    kindId: 'test.kind',
    kindVersion: 1,
    userId: 'user-1',
    eligibilityReason: 'active_subscription',
    locale: 'ro',
    recipientFacts: {},
    inboxTemplateId: 'test-inbox',
    inboxTemplateVersion: 'v1',
    inboxTitle: 'Test title',
    inboxBody: 'Test body',
    inboxActionUrl: '/test',
    inboxVisible: true,
    readAt: null,
    archivedAt: null,
    streamKey: null,
    streamSequence: null,
    createdAt: now,
    retentionExpiresAt: new Date(now.getTime() + 2 * 365 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
};

export const makeDelivery = (deps: BuilderDeps, overrides: Partial<Delivery> = {}): Delivery => {
  const now = deps.clock.now();
  const id = deps.ids.newId();
  return {
    id,
    deliveryKey: `logical:logical-1:email:1:${id}`,
    logicalNotificationId: 'logical-1',
    digestBatchId: null,
    kindId: 'test.kind',
    userId: 'user-1',
    channel: 'email',
    destinationFingerprint: 'fingerprint-1',
    destinationGeneration: 1,
    templateId: 'test-email',
    templateVersion: 'v1',
    renderedSubject: 'Subject',
    renderedHtml: '<p>Body</p>',
    renderedText: 'Body',
    contentHash: 'content-hash',
    status: 'ready',
    notBefore: null,
    expiresAt: null,
    streamKey: null,
    streamSequence: null,
    attemptCount: 0,
    nextAttemptAt: null,
    claimToken: null,
    claimExpiresAt: null,
    providerIdempotencyKey: null,
    providerRef: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    senderMode: 'active',
    createdAt: now,
    updatedAt: now,
    acceptedAt: null,
    terminalAt: null,
    retentionExpiresAt: new Date(now.getTime() + 2 * 365 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
};

export const makeDeliveryAttempt = (
  deps: BuilderDeps,
  overrides: Partial<DeliveryAttempt> = {}
): DeliveryAttempt => ({
  id: deps.ids.newId(),
  deliveryId: 'delivery-1',
  attemptNumber: 1,
  startedAt: deps.clock.now(),
  completedAt: null,
  providerIdempotencyKey: 'delivery-1',
  requestCorrelationId: null,
  destinationFingerprint: 'fingerprint-1',
  result: null,
  errorCode: null,
  errorMessage: null,
  providerRef: null,
  latencyMs: null,
  retryAfterMs: null,
  ...overrides,
});

export const makeChannelDestination = (
  deps: BuilderDeps,
  overrides: Partial<ChannelDestination> = {}
): ChannelDestination => {
  const now = deps.clock.now();
  return {
    id: deps.ids.newId(),
    userId: 'user-1',
    channel: 'email',
    fingerprint: 'fingerprint-1',
    generation: 1,
    isCurrent: true,
    suppressedAt: null,
    suppressionReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

export const makeDigestBatch = (
  deps: BuilderDeps,
  overrides: Partial<DigestBatch> = {}
): DigestBatch => {
  const now = deps.clock.now();
  return {
    id: deps.ids.newId(),
    userId: 'user-1',
    channel: 'email',
    cadence: 'daily',
    windowStartUtc: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    windowEndUtc: now,
    dispatchAtUtc: now,
    status: 'open',
    renderedItemIds: null,
    overflowCount: null,
    deliveryId: null,
    claimToken: null,
    claimExpiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

export const makeAuditEntry = (
  deps: BuilderDeps,
  overrides: Partial<AuditEntry> = {}
): AuditEntry => ({
  id: deps.ids.newId(),
  action: 'event.accepted',
  occurredAt: deps.clock.now(),
  actor: 'system',
  ...overrides,
});

export const makeTestKind = (
  overrides: Partial<
    KindDefinition<typeof EVENT_FACTS_SCHEMA, typeof SUBSCRIPTION_CONFIG_SCHEMA>
  > = {}
): KindDefinition<typeof EVENT_FACTS_SCHEMA, typeof SUBSCRIPTION_CONFIG_SCHEMA> => ({
  kindId: 'test.kind',
  kindVersion: 1,
  eventType: 'test.event.created',
  eventSchemaVersion: 1,
  eventFactsSchema: EVENT_FACTS_SCHEMA,
  recipientResolution: {
    strategy: 'subscription',
    subscription: {
      configSchema: SUBSCRIPTION_CONFIG_SCHEMA,
      allowedSubjectTypes: ['test-subject'],
      subjectFromFacts: (facts) => ({ subjectType: 'test-subject', subjectId: facts.subjectId }),
    },
  },
  preferenceClass: 'subscription-required',
  supportedChannels: ['inbox', 'email'],
  cadence: {
    allowed: ['immediate', 'daily', 'weekly', 'off'],
    defaultByChannel: { inbox: 'immediate', email: 'immediate' },
  },
  deliveryExpiryHours: 24,
  ordering: null,
  projectContent: ({ facts }) =>
    ok({
      inbox: { title: facts.title, body: `Body: ${facts.title}`, actionUrl: '/test' },
      email: { templatePayload: { title: facts.title } },
      digestItem: { title: facts.title, summary: `Summary: ${facts.title}`, actionUrl: '/test' },
    }),
  redaction: { redactedFactPaths: [], redactedRecipientFactPaths: [] },
  templates: {
    inbox: { templateId: 'test-inbox', version: 'v1' },
    email: { templateId: 'test-email', version: 'v1' },
  },
  activeSender: 'active',
  ...overrides,
});
