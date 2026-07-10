# Notification Platform — Module & Contract Design

**Status:** Design — no implementation
**Companion documents:** `NOTIFICATION-PLATFORM-ARCHITECTURE.md` (the what and why), `TEST-SUPPORT-KIT-DESIGN.md` (the test infrastructure this module's tests use)

This document translates the architecture into concrete modules, files, interfaces, and contracts. Every signature here is a commitment: implementation should follow these contracts, and deviations should be recorded back into this document. Style follows the codebase's verified conventions: `Result<T,E>` (neverthrow) in core, TypeBox `*Schema` + `Static<typeof X>` for anything crossing an HTTP/queue/JSONB boundary, discriminated-union errors with `create*` factories, `KyselyXRepo implements XPort` + `makeXRepo(db)` shell factories, ID-only BullMQ payloads, compare-and-set claims with fencing tokens, and an `index.ts` barrel exporting only what `build-app.ts` needs.

## 1. Module layout

One module: `src/modules/notification-platform/`. Domain adapters (parliament vote ingestion, budget newsletter evaluator, subject authorizers) live in their own modules and are wired at the composition root — this module only defines the ports they implement.

```
src/modules/notification-platform/
├── index.ts                                  # Barrel: make* factories, runtime factory, ports, errors, route factories, kind registry
├── core/
│   ├── shared/
│   │   ├── types.ts                          # Channel, Cadence, Locale, PreferenceClass, SenderMode, Page<T>
│   │   ├── schemas.ts                        # ChannelSchema, CadenceSchema, CursorQuerySchema, shared TypeBox atoms
│   │   ├── errors.ts                         # Cross-concern errors + create* factories + isRetryableError
│   │   └── ports.ts                          # LoggerPort (pino subset); re-exports Clock/IdGenerator from @/common/ports
│   ├── registry/
│   │   ├── kind-definition.ts                # KindDefinition<TEvent,TConfig>, ContentProjection, OrderingPolicy, RedactionPolicy
│   │   ├── registry.ts                       # KindRegistry + makeKindRegistry (validates 1:1 event-type↔kind, coherence)
│   │   └── kinds/
│   │       ├── index.ts                      # ALL_NOTIFICATION_KINDS: readonly KindDefinition[] (empty in Phase 1)
│   │       ├── parliament-initiative-vote.ts # Phase 3
│   │       └── budget-entity-newsletter.ts   # Phase 4
│   ├── events/
│   │   ├── types.ts / schemas.ts / errors.ts / ports.ts
│   │   ├── hash-event-payload.ts             # PURE deterministic payload hash (canonical JSON + sha256)
│   │   └── usecases/
│   │       ├── record-notification-event.ts
│   │       └── run-ingestion-scan.ts
│   ├── subscriptions/
│   │   ├── types.ts / schemas.ts / errors.ts / ports.ts
│   │   ├── normalized-key.ts                 # PURE buildNormalizedSubscriptionKey(...)
│   │   └── usecases/
│   │       ├── create-subscription.ts
│   │       ├── set-subscription-state.ts     # pause / resume / remove
│   │       └── list-subscriptions.ts
│   ├── preferences/
│   │   ├── types.ts / schemas.ts / errors.ts / ports.ts
│   │   ├── evaluate-eligibility.ts           # PURE policy, used at resolution AND pre-send
│   │   └── usecases/
│   │       ├── get-preferences.ts
│   │       ├── set-global-preference.ts
│   │       └── set-channel-preference.ts
│   ├── inbox/
│   │   ├── types.ts / schemas.ts / errors.ts / ports.ts
│   │   └── usecases/
│   │       ├── resolve-event-recipients.ts   # THE fan-out usecase
│   │       ├── list-inbox.ts / get-unread-count.ts
│   │       ├── set-read-state.ts / mark-all-read.ts / set-archived-state.ts
│   ├── delivery/
│   │   ├── types.ts / schemas.ts / errors.ts / ports.ts
│   │   ├── state-machine.ts                  # PURE monotonic transition table
│   │   ├── retry-policy.ts                   # PURE computeNextAttemptAt
│   │   ├── delivery-keys.ts                  # PURE key builders
│   │   └── usecases/
│   │       ├── plan-channel-deliveries.ts
│   │       ├── render-delivery.ts
│   │       ├── dispatch-delivery.ts
│   │       ├── apply-provider-outcome.ts
│   │       ├── cancel-pending-external-for-user.ts
│   │       ├── expire-due-deliveries.ts
│   │       ├── recover-platform-work.ts
│   │       ├── resolve-ambiguous-outcome.ts
│   │       └── requeue-dead-letter.ts
│   ├── digest/
│   │   ├── types.ts / schemas.ts / errors.ts / ports.ts
│   │   ├── windowing.ts                      # PURE computeDigestWindow (DST-safe)
│   │   └── usecases/
│   │       ├── assign-to-digest.ts
│   │       ├── materialize-due-digests.ts
│   │       └── cancel-digest-batch.ts
│   ├── audit/
│   │   ├── types.ts / ports.ts / errors.ts
│   └── admin/
│       ├── types.ts / schemas.ts
│       └── usecases/
│           ├── trace-event.ts
│           ├── search-dead-letters.ts
│           ├── reveal-delivery-content.ts
│           ├── list-suppressions.ts
│           └── get-shadow-comparison.ts
├── shell/
│   ├── repo/                                 # 10 Kysely repos (one per port, §5.1)
│   ├── channel/
│   │   ├── email-channel-adapter.ts
│   │   └── destination-fingerprint.ts        # HMAC fingerprint of normalized email
│   ├── webhook/
│   │   └── resend-platform-side-effect.ts
│   ├── queue/
│   │   ├── platform-runtime.ts               # startNotificationPlatformRuntime
│   │   ├── schedulers.ts                     # scheduler adapters + repeatable-job registration
│   │   └── workers/                          # 7 workers (§5.3)
│   ├── rest/
│   │   ├── schemas.ts
│   │   ├── inbox-routes.ts / subscription-routes.ts / preference-routes.ts
│   │   └── admin-routes.ts
│   ├── anonymization/
│   │   └── platform-anonymizer.ts
│   └── retention/
│       └── apply-retention.ts
```

Cross-cutting determinism ports live **outside** the module so every module can use them and lint enforces purity:

- `src/common/ports/clock.ts` — `interface Clock { now(): Date }` (core may import common)
- `src/common/ports/id-generator.ts` — `interface IdGenerator { newId(): string }`
- `src/infra/clock/index.ts` — `systemClock: Clock` (wraps `new Date()`)
- `src/infra/ids/index.ts` — `uuidIds: IdGenerator` (wraps `crypto.randomUUID()`)

Core cannot import infra (ESLint boundary rule), so accidental use of the impure adapters inside core fails CI. The shell composes `systemClock`/`uuidIds` into core deps.

Domain adapters (outside this module):

- `src/modules/parliament/shell/notifications/vote-event-source.ts` + `initiative-subject-authorizer.ts`
- `src/modules/budget-newsletter-events/` (new thin module) — the scheduled evaluator implementing `EventSourcePort`
- Email JSX templates for new kinds go in `src/modules/email-templates/shell/templates/` + `registry/registrations/` as today.

## 2. Core contracts

### 2.1 Shared types (`core/shared/`)

```ts
// types.ts
export const CHANNELS = ['inbox', 'email'] as const; // 'push' added later; contracts already generic
export type Channel = (typeof CHANNELS)[number];
export type ExternalChannel = 'email'; // channels with delivery rows
export type Cadence = 'immediate' | 'daily' | 'weekly' | 'off';
export type Locale = 'ro';
export type PreferenceClass = 'subscription-required' | 'opt-out' | 'required';
export type SenderMode = 'legacy' | 'shadow' | 'active';
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ports.ts
export type { Clock } from '@/common/ports/clock.js';
export type { IdGenerator } from '@/common/ports/id-generator.js';
export interface LoggerPort {
  child(bindings: Record<string, unknown>): LoggerPort;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

// errors.ts — shared members mixed into each concern's union
export interface DatabaseError {
  type: 'DatabaseError';
  message: string;
  retryable: boolean;
}
export interface ValidationError {
  type: 'ValidationError';
  message: string;
  field?: string;
}
export interface QueueError {
  type: 'QueueError';
  message: string;
  retryable: boolean;
}
export interface NotFoundError {
  type: 'NotFound';
  entity: string;
  id: string;
}
export interface ForbiddenError {
  type: 'Forbidden';
  reason: string;
}
// + createDatabaseError(...), createValidationError(...), etc., and isRetryableError(e)
```

### 2.2 Kind registry (`core/registry/`)

The registry is the single place a feature declares itself. Adding a notification kind = one reviewed file in `kinds/` plus templates.

```ts
// kind-definition.ts
export interface ContentProjection {
  inbox: { title: string; body: string; actionUrl: string | null };
  email: { templatePayload: Record<string, unknown> }; // validated against email-templates payload schema at render
  digestItem: { title: string; summary: string; actionUrl: string | null };
}

export interface KindDefinition<
  TEventFacts extends TSchema = TSchema,
  TSubscriptionConfig extends TSchema = TSchema,
> {
  kindId: string; // 'parliament.initiative-vote'
  kindVersion: number;
  eventType: string; // 'parliament.vote.created' — strictly 1:1 with kindId
  eventSchemaVersion: number;
  eventFactsSchema: TEventFacts; // TypeBox; no floats (integer bani / string decimals)
  recipientResolution:
    | {
        strategy: 'subscription';
        subscription: {
          configSchema: TSubscriptionConfig;
          allowedSubjectTypes: readonly string[];
          subjectFromFacts(facts: Static<TEventFacts>): { subjectType: string; subjectId: string };
        };
      }
    | { strategy: 'policy'; policyResolverId: string }; // reviewed paginated resolver, bound at composition root
  preferenceClass: PreferenceClass;
  supportedChannels: readonly Channel[];
  cadence: { allowed: readonly Cadence[]; defaultByChannel: Partial<Record<Channel, Cadence>> };
  deliveryExpiryHours: number | null; // per-kind external expiry; null = no expiry
  ordering: {
    streamKey(facts: Static<TEventFacts>): string;
    streamSequence(facts: Static<TEventFacts>): number; // monotonic integer
  } | null;
  projectContent(input: {
    facts: Static<TEventFacts>;
    locale: Locale;
    recipient: { userId: string; recipientFacts?: Record<string, unknown> };
    links: { platformBaseUrl: string };
  }): Result<ContentProjection, ValidationError>; // PURE
  redaction: {
    redactedFactPaths: readonly string[];
    redactedRecipientFactPaths: readonly string[];
  };
  templates: {
    inbox: { templateId: string; version: string }; // pinned; persisted on logical notification
    email: { templateId: string; version: string }; // must exist in email-templates registry
  };
  activeSender: SenderMode; // reviewed constant; cutover/rollback = deploy (spec §21)
}

// registry.ts
export interface KindRegistry {
  getByKindId(kindId: string): KindDefinition | undefined;
  getByEventType(eventType: string): KindDefinition | undefined;
  list(): readonly KindDefinition[];
}
export const makeKindRegistry = (
  kinds: readonly KindDefinition[]
): Result<KindRegistry, ValidationError>;
// Boot-time validation: unique kindId; unique eventType (enforces the 1:1 rule);
// templates/cadence/channel coherence; ordering ⇒ both streamKey and streamSequence present.
```

### 2.3 Events (`core/events/`)

```ts
// types.ts
export type EventStatus = 'pending' | 'resolving' | 'resolved' | 'conflicted' | 'failed';
export interface NotificationEvent {
  id: string;
  source: string;
  eventType: string;
  eventSchemaVersion: number;
  occurrenceKey: string;
  occurredAt: Date;
  facts: Record<string, unknown>;
  payloadHash: string;
  correlationId: string | null;
  causationId: string | null;
  streamKey: string | null;
  streamSequence: number | null;
  status: EventStatus;
  resolutionCursor: string | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
  retentionExpiresAt: Date;
}
export interface CreateNotificationEventInput {
  source: string;
  eventType: string;
  eventSchemaVersion: number;
  occurrenceKey: string;
  occurredAt: Date;
  facts: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
}
export type RecordEventOutcome =
  | { outcome: 'created'; event: NotificationEvent }
  | { outcome: 'duplicate'; event: NotificationEvent };

// ports.ts
export interface NotificationEventRepo {
  insertOrFind(
    input: CreateNotificationEventInput & {
      id: string;
      payloadHash: string;
      streamKey: string | null;
      streamSequence: number | null;
      retentionExpiresAt: Date;
    }
  ): Promise<
    Result<{ event: NotificationEvent; created: boolean; payloadConflict: boolean }, EventError>
  >;
  findById(eventId: string): Promise<Result<NotificationEvent | null, EventError>>;
  claimForResolution(input: {
    eventId: string;
    claimToken: string;
    leaseSeconds: number;
    now: Date;
  }): Promise<Result<NotificationEvent | null, EventError>>; // CAS: pending | resolving(expired lease) → resolving
  saveResolutionCursor(input: {
    eventId: string;
    cursor: string;
    expectedClaimToken: string;
  }): Promise<Result<boolean, EventError>>;
  markResolved(input: {
    eventId: string;
    expectedClaimToken: string;
    now: Date;
  }): Promise<Result<boolean, EventError>>;
  markConflicted(eventId: string): Promise<Result<void, EventError>>;
  findUnresolvedOlderThan(input: {
    olderThan: Date;
    limit: number;
  }): Promise<Result<NotificationEvent[], EventError>>; // recovery scan
}

export interface SourceWatermarkRepo {
  get(sourceId: string): Promise<Result<string | null, EventError>>;
  compareAndSet(input: {
    sourceId: string;
    expected: string | null;
    next: string;
  }): Promise<Result<boolean, EventError>>;
}

/** Implemented by domain modules (parliament, budget-newsletter). The watermark
 *  is an opaque string owned by the adapter; the platform never interprets it. */
export interface EventSourcePort {
  readonly sourceId: string; // 'parliament-votes' | 'budget-newsletter'
  readOccurrences(input: {
    watermark: string | null;
    limit: number;
  }): Promise<
    Result<{ occurrences: SourceOccurrence[]; nextWatermark: string | null }, EventSourceError>
  >;
}
export interface SourceOccurrence {
  eventType: string;
  occurrenceKey: string;
  occurredAt: Date;
  facts: Record<string, unknown>;
  correlationId?: string;
}

export interface EventFanOutScheduler {
  enqueue(payload: EventFanOutJobPayload): Promise<Result<void, QueueError>>;
}

// schemas.ts (ID-only queue payloads)
export const IngestionScanJobPayloadSchema = Type.Object({
  sourceId: Type.String({ minLength: 1 }),
});
export const EventFanOutJobPayloadSchema = Type.Object({ eventId: Type.String({ minLength: 1 }) });
```

### 2.4 Subscriptions (`core/subscriptions/`)

```ts
export type SubscriptionState = 'active' | 'paused' | 'removed';
export interface Subscription {
  id: string;
  userId: string;
  kindId: string;
  subjectType: string;
  subjectId: string;
  config: Record<string, unknown>;
  normalizedKey: string;
  state: SubscriptionState;
  createdAt: Date;
  updatedAt: Date;
  removedAt: Date | null;
}

export interface SubscriptionRepo {
  createOrReactivate(input: {
    id: string;
    userId: string;
    kindId: string;
    subjectType: string;
    subjectId: string;
    config: Record<string, unknown>;
    normalizedKey: string;
    now: Date;
  }): Promise<Result<Subscription, SubscriptionError>>; // race-safe upsert on (user, kind, normalized_key)
  findByIdForUser(
    id: string,
    userId: string
  ): Promise<Result<Subscription | null, SubscriptionError>>;
  listByUser(input: {
    userId: string;
    kindId?: string;
    cursor?: string;
    limit: number;
  }): Promise<Result<Page<Subscription>, SubscriptionError>>;
  listActiveByKindAndSubject(input: {
    kindId: string;
    subjectType: string;
    subjectId: string;
    afterId: string | null;
    limit: number;
  }): Promise<Result<Subscription[], SubscriptionError>>; // keyset, drives fan-out
  setState(input: {
    id: string;
    userId: string;
    state: SubscriptionState;
    now: Date;
  }): Promise<Result<boolean, SubscriptionError>>;
}

/** Implemented per-kind by the owning domain module; supplied as a map keyed by kindId. */
export interface SubjectAuthorizationPort {
  authorizeSubject(input: {
    userId: string;
    kindId: string;
    subjectType: string;
    subjectId: string;
  }): Promise<Result<{ allowed: boolean; denyReason?: string }, SubscriptionError>>;
}

// normalized-key.ts — PURE
export function buildNormalizedSubscriptionKey(
  kindId: string,
  subjectType: string,
  subjectId: string,
  config: Record<string, unknown>
): string; // deterministic; canonical-JSON config
```

### 2.5 Preferences (`core/preferences/`)

```ts
export interface ChannelPreference {
  enabled: boolean;
  cadence: Cadence;
}
export interface UserNotificationPreferences {
  userId: string;
  globalOptionalEnabled: boolean; // default true
  channels: Record<Channel, ChannelPreference>; // defaults from platform constants
}
export interface PreferenceRepo {
  getForUser(userId: string): Promise<Result<UserNotificationPreferences, PreferenceError>>; // materializes defaults
  upsertGlobal(input: {
    userId: string;
    enabled: boolean;
    now: Date;
  }): Promise<Result<void, PreferenceError>>;
  upsertChannel(input: {
    userId: string;
    channel: Channel;
    enabled: boolean;
    cadence: Cadence;
    now: Date;
  }): Promise<Result<void, PreferenceError>>;
}

// evaluate-eligibility.ts — PURE; evaluated at resolution AND re-run before external send
export type SkipReason =
  | 'global_paused'
  | 'all_channels_disabled'
  | 'no_active_subscription'
  | 'channel_disabled'
  | 'cadence_off'
  | 'destination_suppressed'
  | 'destination_changed'
  | 'user_anonymized'
  | 'expired';
export interface ChannelPlanEntry {
  channel: Channel;
  cadence: Cadence;
}
export type EligibilityDecision =
  | { eligible: true; channelPlan: ChannelPlanEntry[] }
  | { eligible: false; reason: SkipReason };
export function evaluateEligibility(input: {
  kind: KindDefinition;
  preferences: UserNotificationPreferences;
  hasActiveSubscription: boolean;
}): EligibilityDecision;
```

### 2.6 Inbox / logical notifications (`core/inbox/`)

The inbox rendering lives on the logical notification; there is **no delivery row for the inbox channel**. Delivery rows exist only for external channels.

```ts
export interface LogicalNotification {
  id: string;
  eventId: string;
  kindId: string;
  kindVersion: number;
  userId: string;
  eligibilityReason: string;
  locale: Locale;
  recipientFacts: Record<string, unknown> | null;
  inboxTemplateId: string;
  inboxTemplateVersion: string;
  inboxTitle: string;
  inboxBody: string;
  inboxActionUrl: string | null;
  inboxVisible: boolean;
  readAt: Date | null;
  archivedAt: Date | null;
  streamKey: string | null;
  streamSequence: number | null;
  createdAt: Date;
  retentionExpiresAt: Date;
}
export type InboxView = 'all' | 'unread' | 'archived';

export interface LogicalNotificationRepo {
  insertBatchIdempotent(
    rows: CreateLogicalNotificationInput[]
  ): Promise<Result<{ createdIds: string[]; duplicateCount: number }, InboxError>>; // ON CONFLICT (event,kind,user) DO NOTHING
  findByIdForUser(
    id: string,
    userId: string
  ): Promise<Result<LogicalNotification | null, InboxError>>;
  listForUser(input: {
    userId: string;
    view: InboxView;
    cursor: string | null;
    limit: number;
  }): Promise<Result<Page<LogicalNotification>, InboxError>>; // keyset (created_at, id) DESC
  countUnread(userId: string): Promise<Result<number, InboxError>>;
  setReadState(input: {
    id: string;
    userId: string;
    readAt: Date | null;
  }): Promise<Result<boolean, InboxError>>;
  markAllRead(input: { userId: string; now: Date }): Promise<Result<number, InboxError>>;
  setArchivedState(input: {
    id: string;
    userId: string;
    archivedAt: Date | null;
  }): Promise<Result<boolean, InboxError>>;
  listByEvent(eventId: string): Promise<Result<LogicalNotification[], InboxError>>; // admin trace / shadow comparison
}
```

### 2.7 Delivery (`core/delivery/`)

```ts
export type DeliveryState =
  | 'pending_render'
  | 'scheduled'
  | 'ready'
  | 'sending'
  | 'retry_wait'
  | 'accepted'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'suppressed'
  | 'cancelled'
  | 'expired'
  | 'permanent_failed'
  | 'dead_letter'
  | 'unknown';
export const TERMINAL_DELIVERY_STATES: readonly DeliveryState[] = [
  'delivered',
  'bounced',
  'complained',
  'suppressed',
  'cancelled',
  'expired',
  'permanent_failed',
  'dead_letter',
  'unknown',
];

// state-machine.ts — PURE monotonic transition table
export function canTransition(from: DeliveryState, to: DeliveryState): boolean;

// retry-policy.ts — PURE: ≤5 attempts / 24h window, capped exponential backoff with
// jitter, provider retry-after honored, per-kind expiry takes precedence.
export function computeNextAttemptAt(input: {
  attemptNumber: number;
  now: Date;
  retryAfterMs?: number;
  expiresAt?: Date | null;
  jitterSeed: number; // injected — no ambient Math.random in core
}): { nextAttemptAt: Date } | { exhausted: true };

// delivery-keys.ts — PURE
export function buildImmediateDeliveryKey(
  logicalNotificationId: string,
  channel: ExternalChannel,
  destinationGeneration: number
): string; // `logical:{id}:{channel}:{gen}`
export function buildDigestDeliveryKey(batchId: string): string; // `digest:{batchId}`

export interface Delivery {
  id: string;
  deliveryKey: string;
  logicalNotificationId: string | null;
  digestBatchId: string | null; // exactly one parent set (DB CHECK)
  kindId: string;
  userId: string;
  channel: ExternalChannel;
  destinationFingerprint: string | null;
  destinationGeneration: number | null;
  templateId: string | null;
  templateVersion: string | null;
  renderedSubject: string | null;
  renderedHtml: string | null;
  renderedText: string | null;
  contentHash: string | null;
  status: DeliveryState;
  notBefore: Date | null;
  expiresAt: Date | null;
  streamKey: string | null;
  streamSequence: number | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  providerIdempotencyKey: string | null;
  providerRef: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  senderMode: Exclude<SenderMode, 'legacy'>; // 'shadow' rows render but are never claimable for send
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
  terminalAt: Date | null;
  retentionExpiresAt: Date;
}

export type AttemptResult = 'accepted' | 'transient_failure' | 'permanent_failure' | 'ambiguous';
export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  startedAt: Date;
  completedAt: Date | null;
  providerIdempotencyKey: string;
  requestCorrelationId: string | null;
  destinationFingerprint: string | null;
  result: AttemptResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  providerRef: string | null;
  latencyMs: number | null;
  retryAfterMs: number | null;
}

export interface DeliveryRepo {
  insertIdempotent(
    input: CreateDeliveryInput
  ): Promise<Result<{ delivery: Delivery; created: boolean }, PlatformDeliveryError>>;
  findById(id: string): Promise<Result<Delivery | null, PlatformDeliveryError>>;
  findByProviderRef(providerRef: string): Promise<Result<Delivery | null, PlatformDeliveryError>>;
  claimForRender(input: {
    deliveryId: string;
    claimToken: string;
    leaseSeconds: number;
    now: Date;
  }): Promise<Result<Delivery | null, PlatformDeliveryError>>;
  /** Stream-gated CAS claim: claimable only when due, active-sender, and stream predecessor terminal. */
  claimForSending(input: {
    deliveryId: string;
    claimToken: string;
    leaseSeconds: number;
    now: Date;
  }): Promise<Result<Delivery | null, PlatformDeliveryError>>;
  saveRenderedContent(input: {
    deliveryId: string;
    expectedClaimToken: string;
    subject: string | null;
    html: string | null;
    text: string | null;
    contentHash: string;
    templateId: string;
    templateVersion: string;
    nextStatus: 'scheduled' | 'ready';
  }): Promise<Result<boolean, PlatformDeliveryError>>;
  transition(input: {
    deliveryId: string;
    from: readonly DeliveryState[];
    to: DeliveryState;
    expectedClaimToken?: string;
    patch?: DeliveryPatch;
    now: Date;
  }): Promise<Result<boolean, PlatformDeliveryError>>;
  cancelPendingForUser(input: {
    userId: string;
    channels?: readonly ExternalChannel[];
    onlyOptionalKinds: boolean;
    reason: string;
    now: Date;
  }): Promise<Result<number, PlatformDeliveryError>>;
  findDueUnqueued(input: {
    olderThan: Date;
    limit: number;
  }): Promise<Result<Delivery[], PlatformDeliveryError>>;
  findExpiredClaims(input: {
    now: Date;
    limit: number;
  }): Promise<Result<Delivery[], PlatformDeliveryError>>;
  findDueForExpiry(input: {
    now: Date;
    limit: number;
  }): Promise<Result<Delivery[], PlatformDeliveryError>>;
  searchDeadLetters(
    input: DeadLetterSearchFilter & { cursor: string | null; limit: number }
  ): Promise<Result<Page<Delivery>, PlatformDeliveryError>>;
}

export interface DeliveryAttemptRepo {
  create(input: {
    id: string;
    deliveryId: string;
    attemptNumber: number;
    startedAt: Date;
    providerIdempotencyKey: string;
    destinationFingerprint: string | null;
    requestCorrelationId: string | null;
  }): Promise<Result<DeliveryAttempt, PlatformDeliveryError>>; // unique (delivery, attempt_number); created BEFORE provider contact
  complete(input: {
    attemptId: string;
    completedAt: Date;
    result: AttemptResult;
    errorCode?: string;
    errorMessage?: string;
    providerRef?: string;
    latencyMs?: number;
    retryAfterMs?: number;
  }): Promise<Result<void, PlatformDeliveryError>>;
  listByDelivery(deliveryId: string): Promise<Result<DeliveryAttempt[], PlatformDeliveryError>>;
}
```

**Channel destinations — fingerprint only, no persisted address.** The platform never stores a plaintext destination. The address is resolved from the identity provider (Clerk) at send time; the platform persists only an HMAC fingerprint of the normalized address plus a generation counter and suppression state.

```ts
export interface ChannelDestination {
  id: string;
  userId: string;
  channel: ExternalChannel;
  fingerprint: string; // HMAC(normalized address); the only persisted identity
  generation: number;
  isCurrent: boolean;
  suppressedAt: Date | null;
  suppressionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface ChannelDestinationRepo {
  getCurrent(input: {
    userId: string;
    channel: ExternalChannel;
  }): Promise<Result<ChannelDestination | null, PlatformDeliveryError>>;
  ensureCurrent(input: {
    userId: string;
    channel: ExternalChannel;
    fingerprint: string;
    now: Date;
  }): Promise<Result<ChannelDestination, PlatformDeliveryError>>; // new fingerprint ⇒ generation+1, previous is_current=false
  suppressByFingerprint(input: {
    fingerprint: string;
    channel: ExternalChannel;
    reason: string;
    now: Date;
  }): Promise<Result<number, PlatformDeliveryError>>;
  listSuppressed(input: {
    userId?: string;
    cursor: string | null;
    limit: number;
  }): Promise<Result<Page<ChannelDestination>, PlatformDeliveryError>>;
}

/** One per external channel; v1: email. Push later implements the same contract. */
export interface ChannelAdapterPort {
  readonly channel: ExternalChannel;
  /** Live lookup (Clerk for email). Returns fingerprint + destination handle held
   *  only in memory for this call chain; the plaintext never reaches a repo. */
  resolveDestination(
    userId: string
  ): Promise<
    Result<{ fingerprint: string; destination: ResolvedDestination } | null, PlatformDeliveryError>
  >;
  render(input: {
    delivery: Delivery;
    kind: KindDefinition;
    projection: ContentProjection;
    unsubscribeContext: { userId: string; kindId: string };
  }): Promise<
    Result<
      { subject: string; html: string; text: string; contentHash: string },
      PlatformDeliveryError
    >
  >;
  send(input: {
    delivery: Delivery;
    attempt: DeliveryAttempt;
    destination: ResolvedDestination; // in-memory only
  }): Promise<
    Result<
      | { classification: 'accepted'; providerRef: string }
      | {
          classification: 'transient_failure' | 'permanent_failure' | 'ambiguous';
          errorCode: string;
          errorMessage: string;
          retryAfterMs?: number;
        },
      PlatformDeliveryError
    >
  >;
  reconcile(input: {
    providerIdempotencyKey: string;
    providerRef: string | null;
  }): Promise<
    Result<{ known: boolean; state?: 'accepted' | 'delivered' | 'bounced' }, PlatformDeliveryError>
  >;
}
export interface ResolvedDestination {
  address: string; // plaintext, in-memory only — never persisted, never logged unredacted
}

export interface SendJobScheduler {
  enqueue(p: SendJobPayload, opts?: { delayMs?: number }): Promise<Result<void, QueueError>>;
}
export interface RenderJobScheduler {
  enqueue(p: RenderJobPayload): Promise<Result<void, QueueError>>;
}
```

Destination-change semantics (consequence of send-time resolution): `dispatchDelivery` re-resolves the address after claiming. If the recomputed fingerprint differs from the delivery's pinned `destinationFingerprint`, the delivery is cancelled with reason `destination_changed` — the destination generation is part of the delivery's idempotency identity, so a changed address means this delivery no longer targets a valid destination. Recipient re-planning (a fresh delivery against the new generation) is not automatic in v1; the inbox item is unaffected.

### 2.8 Digest (`core/digest/`)

```ts
export type DigestBatchStatus = 'open' | 'materializing' | 'rendered' | 'cancelled';
export interface DigestBatch {
  id: string;
  userId: string;
  channel: ExternalChannel;
  cadence: 'daily' | 'weekly';
  windowStartUtc: Date;
  windowEndUtc: Date;
  dispatchAtUtc: Date;
  status: DigestBatchStatus;
  renderedItemIds: string[] | null;
  overflowCount: number | null;
  deliveryId: string | null;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface DigestBatchRepo {
  findOrCreateOpen(input: {
    id: string;
    userId: string;
    channel: ExternalChannel;
    cadence: 'daily' | 'weekly';
    window: DigestWindow;
    now: Date;
  }): Promise<Result<DigestBatch, DigestError>>; // unique (user, channel, cadence, window_start)
  addMemberIdempotent(input: {
    batchId: string;
    logicalNotificationId: string;
    now: Date;
  }): Promise<Result<'added' | 'duplicate', DigestError>>;
  claimDue(input: {
    now: Date;
    limit: number;
    claimToken: string;
    leaseSeconds: number;
  }): Promise<Result<DigestBatch[], DigestError>>; // open + dispatch_at <= now
  listMembersNewestFirst(input: {
    batchId: string;
    limit: number;
  }): Promise<Result<{ items: LogicalNotification[]; totalCount: number }, DigestError>>;
  markRendered(input: {
    batchId: string;
    expectedClaimToken: string;
    renderedItemIds: string[];
    overflowCount: number;
    deliveryId: string;
    now: Date;
  }): Promise<Result<boolean, DigestError>>;
  cancelWholeBatch(input: {
    batchId: string;
    reason: string;
    now: Date;
  }): Promise<Result<boolean, DigestError>>;
}

// windowing.ts — PURE, DST-safe: Europe/Bucharest 08:00 daily / Monday 08:00 weekly,
// computed and persisted as UTC so daylight-saving transitions are reproducible.
export function computeDigestWindow(
  cadence: 'daily' | 'weekly',
  at: Date
): { windowStartUtc: Date; windowEndUtc: Date; dispatchAtUtc: Date };
export const DIGEST_EMAIL_MAX_ITEMS = 20;
```

### 2.9 Audit (`core/audit/`)

```ts
export type AuditAction =
  | 'event.accepted'
  | 'event.duplicate'
  | 'event.conflict'
  | 'recipient.included'
  | 'recipient.skipped'
  | 'logical.created'
  | 'delivery.created'
  | 'delivery.terminal'
  | 'destination.suppressed'
  | 'destination.restored'
  | 'digest.batch_cancelled'
  | 'admin.content_revealed'
  | 'admin.destination_revealed'
  | 'admin.requeued'
  | 'admin.ambiguous_acknowledged'
  | 'user.anonymized';
export interface AuditEntryInput {
  action: AuditAction;
  occurredAt: Date;
  actor: string; // 'system' | Clerk admin user id
  userId?: string;
  eventId?: string;
  logicalNotificationId?: string;
  deliveryId?: string;
  batchId?: string;
  subscriptionId?: string;
  reason?: string;
  details?: Record<string, unknown>; // redacted by construction
}
export interface AuditLedgerPort {
  append(entry: AuditEntryInput): Promise<Result<void, AuditError>>;
  listByEntity(input: {
    eventId?: string;
    deliveryId?: string;
    userId?: string;
    cursor: string | null;
    limit: number;
  }): Promise<Result<Page<AuditEntry>, AuditError>>;
}
```

### 2.10 Usecase inventory

Every usecase has the shape `export const name = async (deps: NameDeps, input: NameInput): Promise<Result<NameResult, NameError>>`. All deps include `clock: Clock`, `ids: IdGenerator`, `logger: LoggerPort`; the table lists distinctive deps only.

| Usecase                                                                              | Distinctive deps → input → Result                                                                                                                                               | Behavior                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordNotificationEvent`                                                            | `{events, registry, audit, fanOutScheduler}` → `CreateNotificationEventInput` → `RecordEventOutcome`                                                                            | Validate facts vs kind schema; compute payload hash + stream key/seq via kind ordering; insertOrFind. Duplicate ⇒ ok. Hash mismatch ⇒ audit `event.conflict` + err. Created ⇒ enqueue fan-out. Optional `trx` seam kept for future same-DB producers (spec §17.1); no v1 caller uses it.                                                                                                                               |
| `runIngestionScan`                                                                   | `{source: EventSourcePort, watermarks, ...recordDeps}` → `{batchLimit}` → `{recorded, duplicates, watermarkAdvanced}`                                                           | Get watermark → `readOccurrences` → record each idempotently → CAS-advance watermark only after all covered events are durably recorded.                                                                                                                                                                                                                                                                               |
| `resolveEventRecipients`                                                             | `{events, registry, subscriptions, preferences, logicalNotifications, deliveries, digests, renderScheduler, audit}` → `{eventId, pageSize?}` → `{created, skipped, resumed}`    | Claim event (lease); page subscribers 500/keyset from persisted cursor; `evaluateEligibility` per user; `projectContent` for the inbox snapshot; idempotent logical inserts; `planChannelDeliveries` per created logical; persist cursor per page; mark resolved. Skips audited, redacted.                                                                                                                             |
| `planChannelDeliveries`                                                              | `{deliveries, digests, destinations, channelAdapters, renderScheduler, audit}` → `{logical, kind, channelPlan}` → `{immediate, digested}`                                       | Per external channel: immediate ⇒ resolve destination fingerprint, insert delivery `pending_render` (key = logical:channel:destGeneration; senderMode from kind constant) + enqueue render; daily/weekly ⇒ `assignToDigest`.                                                                                                                                                                                           |
| `renderDelivery`                                                                     | `{deliveries, registry, events, channelAdapters}` → `{deliveryId}` → `{rendered}`                                                                                               | Claim `pending_render`; re-project content from persisted facts; adapter.render with pinned template; save snapshot + hash; → `scheduled` (not_before in future) else `ready` + enqueue send (active mode only).                                                                                                                                                                                                       |
| `dispatchDelivery`                                                                   | `{deliveries, attempts, destinations, preferences, registry, channelAdapters, sendScheduler, audit}` → `{deliveryId}` → `DispatchOutcome`                                       | Stream-gated claim; pre-send recheck (spec §6.3): preferences, suppression, expiry, and re-resolved destination fingerprint — mismatch ⇒ cancel `destination_changed`; create attempt row BEFORE provider call; adapter.send; accepted → `accepted`; transient → `retry_wait` + `computeNextAttemptAt` + delayed re-enqueue; permanent → `permanent_failed` + dead letter; ambiguous → `resolveAmbiguousOutcome` path. |
| `applyProviderOutcome`                                                               | `{deliveries, destinations, audit}` → `{providerRef?/idempotencyKey?, outcome: 'delivered'\|'bounced'\|'complained'\|'delayed', occurredAt, destinationAddress?}` → `{applied}` | Monotonic transition via state machine; bounce/complaint ⇒ compute fingerprint from webhook address, suppress by (channel, fingerprint) — never rewrites preference; duplicates/out-of-order are no-ops.                                                                                                                                                                                                               |
| `resolveAmbiguousOutcome`                                                            | `{deliveries, attempts, channelAdapters, audit}` → `{deliveryId}` → `{resolution: 'accepted'\|'retried'\|'unknown'}`                                                            | Reuse idempotency key inside window → adapter.reconcile → persisted webhooks → else `unknown` + dead letter (no auto-resend).                                                                                                                                                                                                                                                                                          |
| `cancelPendingExternalForUser`                                                       | `{deliveries, digests, audit}` → `{userId, channels?, reason}` → `{cancelled}`                                                                                                  | Cancels non-terminal optional external work; inbox items untouched. Used by preference-off, global pause, deletion.                                                                                                                                                                                                                                                                                                    |
| `expireDueDeliveries`                                                                | `{deliveries, audit}` → `{limit}` → `{expired}`                                                                                                                                 | Per-kind expiry sweep.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `recoverPlatformWork`                                                                | `{events, deliveries, digests, fanOutScheduler, renderScheduler, sendScheduler}` → `{thresholdMinutes, limit}` → `RecoverySummary`                                              | The 2-minute scan: unresolved events, due-unqueued deliveries, expired claims, due digest batches, stuck `sending` → ambiguous path.                                                                                                                                                                                                                                                                                   |
| `requeueDeadLetter`                                                                  | `{deliveries, sendScheduler, audit}` → `{deliveryId, adminUserId, reason, acknowledgeDuplicateRisk}` → `{requeued}`                                                             | Audited; `unknown` state requires the explicit ack flag.                                                                                                                                                                                                                                                                                                                                                               |
| `assignToDigest`                                                                     | `{digests}` → `{logicalNotificationId, userId, channel, cadence}` → `{batchId, membership}`                                                                                     | `computeDigestWindow(clock.now())` → findOrCreateOpen → idempotent membership.                                                                                                                                                                                                                                                                                                                                         |
| `materializeDueDigests`                                                              | `{digests, deliveries, destinations, channelAdapters, renderScheduler, audit}` → `{limit}` → `{materialized}`                                                                   | Claim due open batches → snapshot newest 20 + overflowCount → create digest delivery (`pending_render`, key = `digest:{batchId}`) → batch `rendered` (immutable thereafter).                                                                                                                                                                                                                                           |
| `cancelDigestBatch`                                                                  | `{digests, deliveries, audit}` → `{batchId, adminUserId, reason}` → `{cancelled}`                                                                                               | Whole batch + its delivery; legal/redaction trigger only (spec §6.8).                                                                                                                                                                                                                                                                                                                                                  |
| `createSubscription`                                                                 | `{subscriptions, registry, subjectAuthorizers: ReadonlyMap<string, SubjectAuthorizationPort>, audit}` → `{userId, kindId, subjectType, subjectId, config}` → `Subscription`     | Registry + config-schema validation, domain authorization, normalized key, race-safe create-or-reactivate.                                                                                                                                                                                                                                                                                                             |
| `setSubscriptionState`                                                               | `{subscriptions, audit}` → `{userId, subscriptionId, state}` → `Subscription`                                                                                                   | pause/resume/remove; never touches history.                                                                                                                                                                                                                                                                                                                                                                            |
| `listSubscriptions`                                                                  | `{subscriptions}` → `{userId, kindId?, cursor?, limit?}` → `Page<Subscription>`                                                                                                 | Cursor list.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `getPreferences`                                                                     | `{preferences}` → `{userId}` → `UserNotificationPreferences`                                                                                                                    | Defaults materialized.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `setGlobalPreference`                                                                | `{preferences, + cancelPendingExternalForUser deps}` → `{userId, enabled}` → `UserNotificationPreferences`                                                                      | Disable ⇒ cancel pending optional external work.                                                                                                                                                                                                                                                                                                                                                                       |
| `setChannelPreference`                                                               | same shape → `{userId, channel, enabled, cadence}` → `UserNotificationPreferences`                                                                                              | Validates cadence against kind-allowed set; off ⇒ cancel that channel's pending work.                                                                                                                                                                                                                                                                                                                                  |
| `listInbox` / `getUnreadCount` / `setReadState` / `markAllRead` / `setArchivedState` | `{logicalNotifications}` → per-op input, always `userId`-scoped → per-op result                                                                                                 | Cursor-stable pagination; ownership enforced in repo predicates, not route code.                                                                                                                                                                                                                                                                                                                                       |
| `traceEvent`                                                                         | `{events, logicalNotifications, deliveries, attempts, audit}` → `{eventId} \| {source, eventType, occurrenceKey}` → `EventTrace`                                                | Redacted tree: event → logicals → deliveries → attempts.                                                                                                                                                                                                                                                                                                                                                               |
| `searchDeadLetters`                                                                  | `{deliveries}` → filter + page → `Page<Delivery>`                                                                                                                               | Redacted rows.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `revealDeliveryContent`                                                              | `{deliveries, audit}` → `{deliveryId, adminUserId, reason}` → `RevealedDeliveryContent`                                                                                         | Rendered content only; requires reason; audits `admin.content_revealed`. Destination reveal is a separate live Clerk lookup auditing `admin.destination_revealed` — never a DB read.                                                                                                                                                                                                                                   |
| `listSuppressions`                                                                   | `{destinations}` → `{userId?, cursor?, limit?}` → `Page<SuppressionView>`                                                                                                       | Fingerprint-only.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `getShadowComparison`                                                                | `{deliveries, logicalNotifications, legacyOutboxReader}` → `{kindId, periodKey?}` → `ShadowComparisonSummary`                                                                   | Recipient set + content-hash parity vs the legacy outbox.                                                                                                                                                                                                                                                                                                                                                              |
| `anonymizeUserNotificationData`                                                      | `{anonymizer port, audit}` → `{userId, anonymizedUserId}` → `AnonymizationSummary`                                                                                              | Cancels pending work, scrubs every user-linked table, tombstones audit identity.                                                                                                                                                                                                                                                                                                                                       |
| `applyRetention`                                                                     | `{retention repos}` → `{batchLimit}` → `RetentionSummary`                                                                                                                       | 90d attempts/webhooks, 2y content, redacted audit kept; restartable batches.                                                                                                                                                                                                                                                                                                                                           |

## 3. Database tables

All tables live in the **user database** (`src/infra/database/user/schema.sql` + one migration `2026MMDDHHMM_add_notification_platform_tables.sql`), coexisting with legacy `Notifications`/`NotificationsOutbox`. Sketch DDL:

```sql
CREATE TABLE notification_events (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_schema_version INT NOT NULL,
  occurrence_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  facts JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  correlation_id TEXT, causation_id TEXT,
  stream_key TEXT, stream_sequence BIGINT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','resolving','resolved','conflicted','failed')),
  resolution_cursor TEXT,
  claim_token UUID, claim_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ, retention_expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (source, event_type, occurrence_key)
);
CREATE INDEX idx_np_events_unresolved ON notification_events (created_at)
  WHERE status IN ('pending','resolving');
CREATE INDEX idx_np_events_correlation ON notification_events (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE notification_source_watermarks (
  source_id TEXT PRIMARY KEY,
  watermark TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notification_subscriptions (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind_id TEXT NOT NULL,
  subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  normalized_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  UNIQUE (user_id, kind_id, normalized_key)
);
CREATE INDEX idx_np_subs_fanout ON notification_subscriptions (kind_id, subject_type, subject_id, id)
  WHERE state = 'active';
CREATE INDEX idx_np_subs_user ON notification_subscriptions (user_id, state);

CREATE TABLE notification_global_preferences (
  user_id TEXT PRIMARY KEY,
  optional_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE notification_channel_preferences (
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('inbox','email')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cadence TEXT NOT NULL DEFAULT 'immediate' CHECK (cadence IN ('immediate','daily','weekly','off')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel)
);

CREATE TABLE logical_notifications (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES notification_events(id),
  kind_id TEXT NOT NULL, kind_version INT NOT NULL,
  user_id TEXT NOT NULL,
  eligibility_reason TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'ro',
  recipient_facts JSONB,
  inbox_template_id TEXT NOT NULL, inbox_template_version TEXT NOT NULL,
  inbox_title TEXT NOT NULL, inbox_body TEXT NOT NULL, inbox_action_url TEXT,
  inbox_visible BOOLEAN NOT NULL DEFAULT TRUE,
  read_at TIMESTAMPTZ, archived_at TIMESTAMPTZ,
  stream_key TEXT, stream_sequence BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), retention_expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (event_id, kind_id, user_id)
);
CREATE INDEX idx_np_logical_inbox_cursor ON logical_notifications (user_id, created_at DESC, id DESC)
  WHERE inbox_visible;
CREATE INDEX idx_np_logical_unread ON logical_notifications (user_id)
  WHERE read_at IS NULL AND archived_at IS NULL AND inbox_visible;
CREATE INDEX idx_np_logical_event ON logical_notifications (event_id);

-- Fingerprint + generation only; NO destination_snapshot / plaintext address column.
CREATE TABLE notification_channel_destinations (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  fingerprint TEXT NOT NULL,               -- HMAC(normalized address)
  generation INT NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  suppressed_at TIMESTAMPTZ, suppression_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, fingerprint)
);
CREATE UNIQUE INDEX idx_np_dest_current ON notification_channel_destinations (user_id, channel) WHERE is_current;
CREATE INDEX idx_np_dest_fingerprint ON notification_channel_destinations (channel, fingerprint);

CREATE TABLE notification_deliveries (
  id UUID PRIMARY KEY,
  delivery_key TEXT NOT NULL UNIQUE,       -- logical:{id}:{channel}:{destGen} | digest:{batchId}
  logical_notification_id UUID REFERENCES logical_notifications(id),
  digest_batch_id UUID,                    -- FK added after digest table exists
  kind_id TEXT NOT NULL, user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  destination_fingerprint TEXT, destination_generation INT,
  template_id TEXT, template_version TEXT,
  rendered_subject TEXT, rendered_html TEXT, rendered_text TEXT,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending_render' CHECK (status IN (
    'pending_render','scheduled','ready','sending','retry_wait','accepted','delivered',
    'bounced','complained','suppressed','cancelled','expired','permanent_failed','dead_letter','unknown')),
  not_before TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  stream_key TEXT, stream_sequence BIGINT,
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  claim_token UUID, claim_expires_at TIMESTAMPTZ,
  provider_idempotency_key TEXT, provider_ref TEXT,
  last_error_code TEXT, last_error_message TEXT,
  sender_mode TEXT NOT NULL DEFAULT 'active' CHECK (sender_mode IN ('active','shadow')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ, terminal_at TIMESTAMPTZ, retention_expires_at TIMESTAMPTZ NOT NULL,
  CHECK ((logical_notification_id IS NULL) <> (digest_batch_id IS NULL))
);
CREATE INDEX idx_np_deliv_due ON notification_deliveries (COALESCE(next_attempt_at, not_before, created_at))
  WHERE status IN ('ready','retry_wait','scheduled') AND sender_mode = 'active';
CREATE INDEX idx_np_deliv_render ON notification_deliveries (created_at) WHERE status = 'pending_render';
CREATE INDEX idx_np_deliv_stuck ON notification_deliveries (claim_expires_at) WHERE status = 'sending';
CREATE INDEX idx_np_deliv_stream ON notification_deliveries (user_id, channel, stream_key, stream_sequence)
  WHERE stream_key IS NOT NULL;
CREATE INDEX idx_np_deliv_dead ON notification_deliveries (status, terminal_at)
  WHERE status IN ('dead_letter','unknown','permanent_failed');
CREATE INDEX idx_np_deliv_user_pending ON notification_deliveries (user_id)
  WHERE status IN ('pending_render','scheduled','ready','sending','retry_wait');
CREATE INDEX idx_np_deliv_provider_ref ON notification_deliveries (provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX idx_np_deliv_expiry ON notification_deliveries (expires_at)
  WHERE expires_at IS NOT NULL AND status IN ('pending_render','scheduled','ready','retry_wait');

CREATE TABLE notification_delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES notification_deliveries(id),
  attempt_number INT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ,
  provider_idempotency_key TEXT NOT NULL, request_correlation_id TEXT,
  destination_fingerprint TEXT,
  result TEXT CHECK (result IN ('accepted','transient_failure','permanent_failure','ambiguous')),
  error_code TEXT, error_message TEXT,
  provider_ref TEXT, latency_ms INT, retry_after_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, attempt_number)
);
CREATE INDEX idx_np_attempts_retention ON notification_delivery_attempts (created_at);

CREATE TABLE notification_digest_batches (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly')),
  window_start_utc TIMESTAMPTZ NOT NULL, window_end_utc TIMESTAMPTZ NOT NULL,
  dispatch_at_utc TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','materializing','rendered','cancelled')),
  rendered_item_ids JSONB, overflow_count INT,
  delivery_id UUID,
  claim_token UUID, claim_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, cadence, window_start_utc)
);
CREATE INDEX idx_np_digest_due ON notification_digest_batches (dispatch_at_utc) WHERE status = 'open';

CREATE TABLE notification_digest_members (
  batch_id UUID NOT NULL REFERENCES notification_digest_batches(id),
  logical_notification_id UUID NOT NULL REFERENCES logical_notifications(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, logical_notification_id)
);

CREATE TABLE notification_audit_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  user_id TEXT,                            -- tombstoned on anonymization
  event_id UUID, logical_notification_id UUID, delivery_id UUID,
  batch_id UUID, subscription_id UUID,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_np_audit_event ON notification_audit_log (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX idx_np_audit_delivery ON notification_audit_log (delivery_id) WHERE delivery_id IS NOT NULL;
CREATE INDEX idx_np_audit_user_time ON notification_audit_log (user_id, occurred_at);
CREATE INDEX idx_np_audit_action_time ON notification_audit_log (action, occurred_at);
```

### Idempotency identity → constraint mapping (spec §12)

| Identity (spec)                                                 | Backing constraint                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Event = (source, event type, occurrence key)                    | `notification_events UNIQUE (source, event_type, occurrence_key)`                  |
| Subscription = (user, kind, normalized key)                     | `notification_subscriptions UNIQUE (user_id, kind_id, normalized_key)`             |
| Logical = (event, kind, user)                                   | `logical_notifications UNIQUE (event_id, kind_id, user_id)`                        |
| Immediate delivery = (logical, channel, destination generation) | `notification_deliveries.delivery_key UNIQUE` (`logical:{id}:{channel}:{gen}`)     |
| Digest batch = (user, channel, cadence, window)                 | `notification_digest_batches UNIQUE (user_id, channel, cadence, window_start_utc)` |
| Digest membership = (batch, logical)                            | `notification_digest_members PRIMARY KEY (batch_id, logical_notification_id)`      |
| Attempt = (delivery, attempt number)                            | `notification_delivery_attempts UNIQUE (delivery_id, attempt_number)`              |

### The load-bearing query: stream-gated send claim

The ordering guarantee (spec §11.3) is enforced here, not by queue topology. A delivery in an ordered stream is claimable only when every lower-sequence delivery in the same `(user, channel, stream)` is terminal:

```sql
UPDATE notification_deliveries d
SET status = 'sending', claim_token = $1, claim_expires_at = $2, updated_at = now()
WHERE d.id = $3
  AND d.status IN ('ready', 'retry_wait')
  AND d.sender_mode = 'active'
  AND (d.not_before IS NULL OR d.not_before <= now())
  AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= now())
  AND (d.stream_key IS NULL OR NOT EXISTS (
        SELECT 1 FROM notification_deliveries p
        WHERE p.user_id = d.user_id AND p.channel = d.channel
          AND p.stream_key = d.stream_key AND p.stream_sequence < d.stream_sequence
          AND p.status NOT IN ('delivered','bounced','complained','suppressed','cancelled',
                               'expired','permanent_failed','dead_letter','unknown')))
RETURNING *;
```

A not-yet-eligible delivery simply fails to claim (no-op job); the recovery scan and the predecessor's terminal transition re-dispatch it.

## 4. Queues and workers

Queue names added to `QUEUE_NAMES` in `src/infra/queue/client.ts`; all payloads ID-only and TypeBox-validated:

| Const          | Queue name              | Payload              | Cadence                                                                           |
| -------------- | ----------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `NP_INGESTION` | `np-ingestion-scan`     | `{sourceId}`         | repeatable **60s** per source (`upsertJobScheduler` id `np-ingestion:{sourceId}`) |
| `NP_FANOUT`    | `np-event-fanout`       | `{eventId}`          | on demand                                                                         |
| `NP_RENDER`    | `np-delivery-render`    | `{deliveryId}`       | on demand                                                                         |
| `NP_SEND`      | `np-delivery-send`      | `{deliveryId}`       | on demand + delayed (retry / not_before)                                          |
| `NP_DIGEST`    | `np-digest-materialize` | `{limit}`            | repeatable 5 min (DB `dispatch_at_utc` is authoritative; the sweep is idempotent) |
| `NP_RECOVERY`  | `np-platform-recovery`  | `{thresholdMinutes}` | repeatable **2 min**                                                              |
| `NP_RETENTION` | `np-retention`          | `{batchLimit}`       | repeatable daily                                                                  |

Seven workers, each validating its payload and calling exactly one usecase: `ingestion-scan-worker` (maps sourceId → `EventSourcePort` → `runIngestionScan`), `fanout-worker` (`resolveEventRecipients`), `render-worker` (`renderDelivery`), `send-worker` (`dispatchDelivery`, BullMQ limiter `{max: maxRps, duration: 1000}`), `digest-worker` (`materializeDueDigests`), `recovery-worker` (`recoverPlatformWork` + `expireDueDeliveries`), `retention-worker` (`applyRetention`).

### Runtime factory (`shell/queue/platform-runtime.ts`)

```ts
export interface NotificationPlatformWorkerDeps {
  events: NotificationEventRepo;
  watermarks: SourceWatermarkRepo;
  subscriptions: SubscriptionRepo;
  preferences: PreferenceRepo;
  logicalNotifications: LogicalNotificationRepo;
  deliveries: DeliveryRepo;
  attempts: DeliveryAttemptRepo;
  destinations: ChannelDestinationRepo;
  digests: DigestBatchRepo;
  audit: AuditLedgerPort;
  registry: KindRegistry;
  channelAdapters: ReadonlyMap<ExternalChannel, ChannelAdapterPort>;
  eventSources: readonly EventSourcePort[];
  clock: Clock;
  ids: IdGenerator;
  maxSendRps?: number;
}
export interface NotificationPlatformRuntimeConfig {
  redisUrl: string;
  redisPassword?: string;
  bullmqPrefix: string;
  logger: Logger;
  concurrency?: number;
  ingestionScanIntervalSeconds: number; // 60
  recoveryScanIntervalMinutes: number; // 2
  digestSweepIntervalMinutes: number; // 5
  recoveryThresholdMinutes: number;
  workerDeps?: NotificationPlatformWorkerDeps; // absent ⇒ producer-only process
  redisFactory?: QueueRedisFactory;
}
export interface NotificationPlatformRuntime {
  fanOutScheduler: EventFanOutScheduler;
  renderScheduler: RenderJobScheduler;
  sendScheduler: SendJobScheduler;
  stop(): Promise<void>;
}
export type NotificationPlatformRuntimeFactory = (
  config: NotificationPlatformRuntimeConfig
) => Promise<NotificationPlatformRuntime>;
export const startNotificationPlatformRuntime: NotificationPlatformRuntimeFactory;
// Mirrors src/modules/notification-delivery/shell/queue/delivery-runtime.ts + worker-manager.ts.
```

## 5. Shell contracts

### 5.1 Repos

Ten Kysely repos, one per port: `KyselyNotificationEventRepo`, `KyselySourceWatermarkRepo`, `KyselySubscriptionRepo`, `KyselyPreferenceRepo`, `KyselyLogicalNotificationRepo`, `KyselyDeliveryRepo` (owns the stream-gated claim), `KyselyDeliveryAttemptRepo`, `KyselyChannelDestinationRepo`, `KyselyDigestBatchRepo`, `KyselyAuditLedgerRepo`. Each exports `makeXRepo(db: UserDbClient): XPort`. Claims use conditional `UPDATE … WHERE status IN (…) RETURNING *` compare-and-set with `claim_token` fencing, following the verified pattern in `src/modules/notification-delivery/shell/repo/delivery-repo.ts`.

### 5.2 Email channel adapter (`shell/channel/`)

```ts
export const makeEmailChannelAdapter = (config: {
  emailClient: EmailClient;            // src/infra/email/client.ts — Resend idempotencyKey = delivery id
  emailRenderer: EmailRenderer;        // src/modules/email-templates
  tokenSigner: UnsubscribeTokenSigner; // src/infra/unsubscribe/token.ts
  userEmailFetcher: UserEmailFetcher;  // reused Clerk fetcher — the live address source
  fingerprintSecret: string;           // HMAC key for destination-fingerprint.ts
  fromAddress: string;
  platformBaseUrl: string;
  apiBaseUrl: string;
}): ChannelAdapterPort;
```

`resolveDestination` fetches the address from Clerk, normalizes it, computes the HMAC fingerprint, and returns the plaintext only inside `ResolvedDestination` (in-memory). Error classification mirrors the existing client mapping: timeout/429/5xx → transient, 4xx validation → permanent, socket-failure-after-write → ambiguous.

### 5.3 Webhook side effect (`shell/webhook/`)

`makeResendPlatformWebhookSideEffect(deps)` is registered **alongside** the legacy side effect in `src/modules/resend-webhooks/shell/combine-side-effects.ts` (persist-first ingestion is already done by that module). It matches `provider_ref` to platform deliveries and calls `applyProviderOutcome`; bounce/complaint events carry the address, from which the fingerprint is computed for suppression.

### 5.4 REST routes

**Unversioned paths, additive evolution** (decision this round): no version segment; breaking changes are avoided through additive evolution, and Stripe-style date-header pinning is the future escape hatch if third-party consumers ever appear. Legacy `/api/v1/notifications/*` remains untouched until retired.

User routes (`preHandler: requireAuthHandler`, Clerk user from `request.auth`):

| Method | Path                                               | Schemas (req → res)                                               |
| ------ | -------------------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/api/notifications/inbox`                         | `InboxListQuerySchema` → `InboxListResponseSchema`                |
| GET    | `/api/notifications/inbox/unread-count`            | — → `UnreadCountResponseSchema`                                   |
| POST   | `/api/notifications/inbox/:id/read`                | `InboxIdParamsSchema` → `OkResponseSchema`                        |
| POST   | `/api/notifications/inbox/:id/unread`              | 〃                                                                |
| POST   | `/api/notifications/inbox/read-all`                | — → `MarkAllReadResponseSchema`                                   |
| POST   | `/api/notifications/inbox/:id/archive`             | `InboxIdParamsSchema` → `OkResponseSchema`                        |
| POST   | `/api/notifications/inbox/:id/unarchive`           | 〃                                                                |
| GET    | `/api/notifications/subscriptions`                 | `SubscriptionListQuerySchema` → `SubscriptionListResponseSchema`  |
| POST   | `/api/notifications/subscriptions`                 | `CreateSubscriptionBodySchema` → `SubscriptionResponseSchema`     |
| POST   | `/api/notifications/subscriptions/:id/pause`       | `SubscriptionIdParamsSchema` → `SubscriptionResponseSchema`       |
| POST   | `/api/notifications/subscriptions/:id/resume`      | 〃                                                                |
| DELETE | `/api/notifications/subscriptions/:id`             | 〃 → `OkResponseSchema`                                           |
| GET    | `/api/notifications/preferences`                   | — → `PreferencesResponseSchema`                                   |
| PUT    | `/api/notifications/preferences/global`            | `UpdateGlobalPreferenceBodySchema` → `PreferencesResponseSchema`  |
| PUT    | `/api/notifications/preferences/channels/:channel` | `UpdateChannelPreferenceBodySchema` → `PreferencesResponseSchema` |

Admin routes (`makePlatformAdminRoutes`; Clerk auth + admin-authorization port, campaign-admin pattern; responses redacted by default):

| Method | Path                                                 | Purpose                                                                       |
| ------ | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/api/admin/notifications/events/:id/trace`          | `traceEvent`                                                                  |
| GET    | `/api/admin/notifications/dead-letters`              | `searchDeadLetters` (filters: kind, channel, status, eventId, userId, cursor) |
| POST   | `/api/admin/notifications/deliveries/:id/requeue`    | `requeueDeadLetter` (body: reason, acknowledgeDuplicateRisk)                  |
| POST   | `/api/admin/notifications/deliveries/:id/reveal`     | `revealDeliveryContent` (body: reason) — rendered content only                |
| GET    | `/api/admin/notifications/suppressions`              | `listSuppressions` (fingerprints only)                                        |
| GET    | `/api/admin/notifications/shadow-comparison/:kindId` | `getShadowComparison`                                                         |
| POST   | `/api/admin/notifications/digest-batches/:id/cancel` | `cancelDigestBatch` (body: reason)                                            |

### 5.5 Anonymization

`makeNotificationPlatformAnonymizer(db: UserDbClient)` covers every new user-linked table (subscriptions, preferences, logical notifications, deliveries, attempts, destinations, digest batches/members, audit user tombstone) plus cancellation of queued user work; wired into the existing Clerk `user.deleted` handler. The per-field treatment must be documented in `docs/USER-DATA-ANONYMIZATION.md` before any table reaches production (spec §15.3).

## 6. Wiring and configuration

### 6.1 `index.ts` barrel exports

`makeKindRegistry`, `ALL_NOTIFICATION_KINDS`, all `make*Repo` factories, `makeEmailChannelAdapter`, `makeResendPlatformWebhookSideEffect`, `startNotificationPlatformRuntime` + runtime types, route factories (`makeInboxRoutes`, `makeSubscriptionRoutes`, `makePreferenceRoutes`, `makePlatformAdminRoutes`), `makeNotificationPlatformAnonymizer`, port types (`EventSourcePort`, `SubjectAuthorizationPort`, `ChannelAdapterPort`, repo ports), error types + `create*` factories, and `recordNotificationEvent` (for future same-DB producers).

### 6.2 Composition root (`src/app/build-app.ts` / `build-plan.ts`)

- `AppDeps` gains `notificationPlatformRuntimeFactory?: NotificationPlatformRuntimeFactory` (the test seam, mirroring existing runtime factories at `src/app/build-plan.ts:25`).
- Feature gate: `shouldInitializeNotificationPlatform = config.notificationPlatform.enabled && hasBullmqRedisConfig && userDb present`; boot validation requires Clerk + Resend + fingerprint secret when enabled.
- DI block (sketch): build registry (`makeKindRegistry(ALL_NOTIFICATION_KINDS)` — fail fast at boot), `systemClock`/`uuidIds` from infra, ten repos, email adapter, event sources (`makeParliamentVoteEventSource`, `makeBudgetNewsletterEventSource`), runtime via injected factory or `startNotificationPlatformRuntime`, route registration, webhook side-effect registration in combine-side-effects, anonymizer registration in the user-deleted handler, `onClose` → `runtime.stop()`.

### 6.3 Environment / config (`src/infra/config/env.ts` → `config.notificationPlatform`)

| Env                                 | Config key                     | Default                  |
| ----------------------------------- | ------------------------------ | ------------------------ |
| `NOTIFICATION_PLATFORM_ENABLED`     | `enabled`                      | `false` (master gate)    |
| `NP_INGESTION_SCAN_SECONDS`         | `ingestionScanSeconds`         | `60`                     |
| `NP_RECOVERY_SCAN_MINUTES`          | `recoveryScanMinutes`          | `2`                      |
| `NP_DIGEST_SWEEP_MINUTES`           | `digestSweepMinutes`           | `5`                      |
| `NP_RECOVERY_THRESHOLD_MINUTES`     | `recoveryThresholdMinutes`     | `10`                     |
| `NP_MAX_SEND_RPS`                   | `maxSendRps`                   | inherit `RESEND_MAX_RPS` |
| `NP_DESTINATION_FINGERPRINT_SECRET` | `destinationFingerprintSecret` | required when enabled    |

Per-kind sender switching is deliberately **not** configuration: it is the `activeSender` constant in each kind file, flipped by a reviewed deploy (spec §21).

## 7. Domain adapter plug-in points

Both adapters implement `EventSourcePort` and are passed into `workerDeps.eventSources` at the composition root. The 60-second repeatable `np-ingestion-scan` job (one scheduler per `sourceId`) drives them: the worker looks up the port by `sourceId` and calls `runIngestionScan`, which reads past the persisted watermark, records events idempotently, and CAS-advances the watermark.

- **Parliament votes** — `src/modules/parliament/shell/notifications/vote-event-source.ts`: `makeParliamentVoteEventSource({ parliamentDb })`, `sourceId: 'parliament-votes'`; watermark = JSON `{lastVoteId, lastRevision}`; emits `parliament.vote.created` with occurrence key `vote-{id}:created:v1` and snapshotted public facts (vote id/time, initiative id/title, result, URL). Companion `makeInitiativeSubjectAuthorizer({ parliamentDb }): SubjectAuthorizationPort` validates `legislative-initiative` subjects for `createSubscription`. Builds on the existing `ParliamentRepo` keyset vote listing and `loaderWatermark()`.
- **Budget newsletter** — new thin module `src/modules/budget-newsletter-events/`: `makeBudgetNewsletterEventSource({ budgetDb })`, `sourceId: 'budget-newsletter'`; watermark = last emitted `(entityCui, newsletterKind, periodKey)` frontier; `readOccurrences` detects newly closed reporting periods, **materializes the report-facts snapshot at read time** (spec §22.2), and emits `budget.newsletter.period.closed` keyed `newsletter:{cui}:{kind}:{periodKey}:v1`. Most 60-second ticks return zero occurrences cheaply.

## 8. Migration-phase file mapping (spec §21)

- **Phase 1 — foundation:** migration + all §3 tables; `core/shared`, `core/registry` (contracts + empty kinds list), `core/events`, `core/preferences/evaluate-eligibility.ts`, all of `core/delivery`, `core/digest`, `core/audit`; all `shell/repo`, `shell/queue`, `shell/channel`, `shell/webhook`, `shell/anonymization`, `shell/retention`; admin usecases/routes for trace/dead-letter/requeue/reveal/suppressions; `QUEUE_NAMES` additions, config, build-app gating; `src/common/ports/` + `src/infra/clock|ids`. No producer changes.
- **Phase 2 — inbox & user controls:** `core/inbox` user usecases, `core/preferences` usecases, all of `core/subscriptions`; `shell/rest/` user routes + schemas. Legacy settings facade stays in `src/modules/notifications`.
- **Phase 3 — parliament proof:** `core/registry/kinds/parliament-initiative-vote.ts` (shadow → active flipped by deploy); parliament adapter files; new inbox/email templates in `email-templates`; shadow comparison wired for the kind.
- **Phase 4 — budget newsletter proof:** `core/registry/kinds/budget-entity-newsletter.ts`; `src/modules/budget-newsletter-events/`; one-off legacy subscription migration script under `scripts/`; shadow parity against `NotificationsOutbox` via a `legacyOutboxReader` port.

## 9. Test design

Test infrastructure comes from the shared kit (`docs/TEST-SUPPORT-KIT-DESIGN.md`): injected `Clock`/`IdGenerator`, `makeKeyedStore`-composed fakes in `tests/fixtures/notification-platform/`, `expectOk/expectErr`, the in-memory job runtime, and `describePortContract`.

Mapping the spec's §23 acceptance criteria to tiers:

| §23 group                   | Tier and approach                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idempotency & concurrency   | **Contract suites** (`tests/contracts/notification-platform/*.contract.ts`) run against fake (unit) and real Postgres (e2e via Testcontainers): concurrent identical event insert creates one row; payload-conflict detection; logical-insert replay; subscription delete/recreate cannot bypass event dedup; delivery claim exclusion + fencing monotonicity. The real-backend run is the authority for locking semantics. |
| Durability & recovery       | Unit: `runIngestionScan` watermark correctness across restart/overlap (test clock + fault plan); `recoverPlatformWork` finder→re-enqueue behavior via the in-memory job runtime. E2E: recovery finder SQL against real rows.                                                                                                                                                                                                |
| Preferences & authorization | Unit: `evaluateEligibility` table-driven over the full precedence matrix (global pause, channel off, required kinds, cadence off); `createSubscription` denial via a fake `SubjectAuthorizationPort`. Integration: route-level ownership checks (user A cannot read user B) via `createApp({deps})` + inject.                                                                                                               |
| Content & inbox             | Unit: `projectContent` purity/reproducibility per kind; cursor pagination stability under interleaved inserts (fake repo); concurrent read/archive unread-count correctness (contract case).                                                                                                                                                                                                                                |
| Digest & scheduling         | Unit: `computeDigestWindow` table-driven across Europe/Bucharest DST transitions (the four boundary days each year); 20-item cap + overflow count in `materializeDueDigests`; batch immutability after `rendered`; whole-batch cancel. All on `makeTestClock`.                                                                                                                                                              |
| Provider failures           | Unit: `dispatchDelivery` with a fake `ChannelAdapterPort` driven through every classification; attempt-before-provider ordering asserted via fake call sequence; `computeNextAttemptAt` table-driven (backoff caps, jitter bounds via injected seed, retry-after, expiry precedence); `canTransition` full-matrix table test; webhook regression tests (duplicate/out-of-order no-ops).                                     |
| Privacy & administration    | Unit: redaction defaults in trace/search results; reveal requires reason + emits audit. Integration: admin route authorization. E2E: anonymizer covers every table (assert no user-linked rows survive).                                                                                                                                                                                                                    |
| Scale                       | E2E (Docker-gated): 10k-recipient fan-out completes with bounded memory via paging (assert page-count and cursor persistence, not wall-clock).                                                                                                                                                                                                                                                                              |
| Migration                   | Unit: registry rejects duplicate event types; shadow rows never claimable (contract case on the claim query); `getShadowComparison` parity math on fixed fixtures.                                                                                                                                                                                                                                                          |

Naming: pure-logic tests in `tests/unit/notification-platform/`, contract cases in `tests/contracts/notification-platform/`, integration in `tests/integration/notification-platform/`, e2e runners in `tests/e2e/notification-platform/`.

## 10. Design decisions made in this document (flagged for review)

1. **Inbox has no delivery row** — inbox rendering lives on `logical_notifications`; delivery rows are external-channel only. `Channel` still includes `inbox` for preferences.
2. **Shadow mechanics** — shadow deliveries are fully rendered rows with `sender_mode='shadow'`, structurally excluded from the send-claim query/index; comparison reads recipients + content hashes. This maximizes parity checking under "shadow generation without delivery" (spec §21).
3. **Preferences as two typed tables** (global + per-channel rows) rather than one JSONB row — typed cadence constraints, simpler upserts.
4. **Digest sweep every 5 minutes** against authoritative `dispatch_at_utc`, rather than per-batch delayed jobs — idempotent and recoverable.
5. **Digest batch materialization creates a normal delivery row**, reusing render/send/retry/dead-letter machinery unchanged; whole-batch cancel = cancel batch + its delivery.
6. **Watermarks are opaque adapter-owned strings** with CAS advance; the platform never interprets them.
7. **Error union named `PlatformDeliveryError`** to avoid clashing with the legacy module's `DeliveryError` in build-app imports.
8. **No plaintext destination anywhere in platform tables** (user decision this round): send-time Clerk resolution, fingerprint-only storage, `destination_changed` cancellation on mismatch, live audited lookup for destination reveal.
9. **Stream-gated ordering via the claim query**, not queue topology (spec §11.3) — accepts no-op dispatches for not-yet-eligible deliveries.
