# Public Debate Notification Orchestrator

**Status**: Draft
**Date**: 2026-04-05
**Author**: Codex

## Problem

The public-debate notification flow is currently coordinated directly inside
`build-app.ts`.

That composition root now contains business logic for:

- resolving entity names
- enqueueing user-facing entity updates
- enqueueing admin-only failed-send alerts
- enforcing the compose-scheduler invariant
- ensuring subscriptions and publishing snapshot backfills
- aggregating publish results and log messages

This makes the correspondence behavior harder to reason about, harder to test in
isolation, and more fragile to future changes because application wiring and
campaign behavior are mixed in one place.

## Context

- `institution-correspondence` already defines the two ports that the rest of
  the app consumes:
  - `PublicDebateEntityUpdatePublisher`
  - `PublicDebateEntitySubscriptionService`
- The current implementation in `build-app.ts` depends on multiple shell-layer
  collaborators:
  - correspondence repository
  - notifications repositories
  - delivery repository
  - compose scheduler
  - entity repository
  - logger
- The notification flow must preserve the current API contract. Routes, handlers,
  and webhooks should continue to depend on the same ports after the refactor.
- The recent late-subscriber fix introduced `publishCurrentPlatformSendUpdate`,
  which is now part of the subscription flow and should remain reusable.

## Decision

Move public-debate notification coordination into one dedicated shell factory
owned by `institution-correspondence`.

### 1. Add one shell orchestrator factory

Create a new file:

- `src/modules/institution-correspondence/shell/public-debate-notification-orchestrator.ts`

Export:

```ts
makePublicDebateNotificationOrchestrator(...)
```

The factory returns:

```ts
{
  updatePublisher: PublicDebateEntityUpdatePublisher;
  subscriptionService: PublicDebateEntitySubscriptionService;
}
```

### 2. The orchestrator constructor owns the full dependency set

The factory receives concrete shell dependencies instead of reaching into
`build-app.ts` closures:

- `repo: InstitutionCorrespondenceRepository`
- `notificationsRepo: NotificationsRepository`
- `extendedNotificationsRepo: ExtendedNotificationsRepository`
- `deliveryRepo: DeliveryRepository`
- `composeJobScheduler: ComposeJobScheduler`
- `entityRepo: EntityRepository`
- `hasher: Hasher`
- `campaignAuditCcRecipients: string[]`
- `logger: Logger`

The scheduler is required in the type signature. The orchestrator does not
accept an optional compose scheduler.

### 3. `updatePublisher` becomes orchestrator-owned behavior

The returned `updatePublisher.publish(...)` implementation is responsible for:

- resolving the human-readable entity name
- building the deterministic run id parts
- enqueueing user-facing entity updates through
  `enqueuePublicDebateEntityUpdateNotifications`
- enqueueing admin failure alerts through
  `enqueuePublicDebateAdminFailureNotifications` only when:
  - `eventType === 'thread_failed'`
  - `failureMessage` is present
- aggregating one `PublicDebateEntityUpdatePublishResult`
- emitting the current warning/error logs for queue or DB failures

The helper that derives `replyTextPreview` also moves into this shell module.

### 4. `subscriptionService` becomes orchestrator-owned behavior

The returned `subscriptionService.ensureSubscribed(...)` implementation is
responsible for:

- calling `ensurePublicDebateAutoSubscriptions`
- returning `ok(undefined)` immediately when the entity subscription is inactive
- calling `publishCurrentPlatformSendUpdate` for active subscriptions
- logging the snapshot result
- preserving the current non-fatal behavior for snapshot publish failures:
  - warn
  - return `ok(undefined)`

### 5. `build-app.ts` becomes wiring only

`build-app.ts` should only:

- construct concrete repos, queue scheduler, and logger
- call `makePublicDebateNotificationOrchestrator(...)`
- pass the returned ports into:
  - user event handlers
  - review side effects
  - resend webhook side effects
  - correspondence recovery runtime

The composition root should no longer contain direct public-debate notification
fanout logic.

### 6. Export surface

Export the new factory and its config type from
`src/modules/institution-correspondence/index.ts`.

No route contract, webhook contract, or event payload changes are part of this
spec.

## Alternatives Considered

### Keep the logic in `build-app.ts`

Rejected because it preserves the current coupling between application wiring and
campaign behavior. The current logic is already large enough to justify a
module-owned shell abstraction.

### Split into two unrelated shell services

Rejected because the update-publish and subscription-snapshot behaviors share
the same collaborators and logging context. Splitting them immediately would add
more wiring without reducing real complexity.

### Move the behavior into `core/`

Rejected because the orchestration depends on shell concerns:

- repositories
- queue scheduler
- logger
- entity lookup

Keeping the coordination in shell preserves the intended core/shell boundary.

## Consequences

**Positive**

- Public-debate notification behavior has one module-owned entry point.
- `build-app.ts` becomes smaller and easier to audit.
- Future changes to snapshot publish, admin alerts, or publish aggregation can
  be tested without rebuilding the whole app factory.
- The existing ports remain stable for callers.

**Negative**

- `institution-correspondence` gains a shell-level coordinator that depends on
  notification-delivery and notifications modules.
- One more exported factory must be wired and maintained.
- The refactor should land before additional public-debate recovery work, or the
  same coordination logic will be duplicated in two places.

## References

- `src/app/build-app.ts`
- `src/modules/institution-correspondence/core/ports.ts`
- `src/modules/institution-correspondence/core/usecases/publish-current-platform-send-update.ts`
- `src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts`
- `src/modules/notification-delivery/core/usecases/enqueue-public-debate-admin-failure-notifications.ts`
- `docs/specs/specs-202604032345-public-debate-send-hardening.md`
