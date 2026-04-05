# Durable Public Debate Snapshot Backfill Retry

**Status**: Draft
**Date**: 2026-04-05
**Author**: Codex

## Problem

The current late-subscriber snapshot flow is synchronous and best-effort.

When `ensureSubscribed()` succeeds but snapshot publishing fails, the code logs
the error and returns success. That keeps the request flow resilient, but it
also means the subscriber may never receive the current-state email unless some
future correspondence event happens.

This leaves the system vulnerable to transient failures in:

- entity update enqueueing
- outbox writes
- compose job scheduling
- publisher dependencies

## Context

- Public-debate correspondence already has a BullMQ-backed recovery runtime for
  provider success confirmation.
- Current-state mapping already exists in
  `publishCurrentPlatformSendUpdate(...)`.
- Delivery deduplication is already deterministic through:
  - event scope keys
  - `generateDeliveryKey(...)`
  - unique `delivery_key` persistence
- The explicit product direction for this iteration is:
  - snapshot publish stays tied to request-flow subscription behavior
  - no new queue
  - no new table

## Decision

Add a durable recovery pass for missing current-state snapshots by extending the
existing correspondence recovery runtime.

### 1. Extract reusable snapshot derivation

Split the current thread-to-event mapping out of
`publishCurrentPlatformSendUpdate(...)` into one reusable core helper:

- `src/modules/institution-correspondence/core/usecases/derive-current-platform-send-snapshot.ts`

It returns either:

- a fully derived snapshot payload
- or a skip reason:
  - `no_thread`
  - `skipped_phase`
  - `skipped_missing_reply`
  - `skipped_missing_review`

Both the immediate subscription flow and the recovery pass must use the same
derivation helper.

### 2. Add notification repo support for scanning active entity subscriptions

Extend `ExtendedNotificationsRepository` with:

```ts
findActiveByType(notificationType: NotificationType): Promise<Result<Notification[], DeliveryError>>
```

Implementation requirements:

- include only active rows
- honor `global_unsubscribe`
- honor disabled `funky:notification:global` preferences for
  `funky:notification:entity_updates`

The recovery use case will deduplicate these rows by entity CUI before checking
threads.

### 3. Add one shared entity-update key helper

Create:

- `src/modules/notification-delivery/core/usecases/public-debate-entity-update-keys.ts`

Export:

- `buildPublicDebateEntityUpdateScopeKey(...)`
- `buildPublicDebateEntityUpdateDeliveryKey(...)`

These helpers become the single source of truth for the dedupe keys used by:

- direct enqueue
- snapshot recovery

### 4. Add the recovery use case

Create:

- `src/modules/institution-correspondence/core/usecases/recover-missing-public-debate-snapshots.ts`

The use case:

1. loads all active `funky:notification:entity_updates` subscriptions
2. groups them by `entityCui`
3. loads the latest `platform_send` thread for each entity
4. derives the current snapshot payload with the shared derivation helper
5. computes the expected per-notification delivery key for that snapshot
6. checks `deliveryRepo.existsByDeliveryKey(...)`
7. calls `updatePublisher.publish(...)` only when at least one expected outbox is
   missing for that entity snapshot

The use case returns counts for:

- entities scanned
- entities with snapshots derived
- entities published
- entities skipped because already materialized
- errors by entity CUI

### 5. Extend the correspondence recovery runtime

Extend:

- `CorrespondenceRecoveryRuntimeConfig`
- `CorrespondenceRecoveryWorkerDeps`

Add required dependencies for snapshot recovery:

- `notificationsRepo: ExtendedNotificationsRepository`
- `deliveryRepo: DeliveryRepository`

Worker sequencing:

1. run `recoverPlatformSendSuccessConfirmation(...)`
2. run `recoverMissingPublicDebateSnapshots(...)`
3. log both result sets in one structured recovery log

This recovery pass reuses the existing schedule and threshold cadence. It does
not introduce a new runtime or queue.

### 6. Guardrail for admin failure alerts

Recovery-only snapshot republishing must never emit admin failure alerts.

To enforce that, the derived snapshot payload for failed threads calls
`updatePublisher.publish(...)` without a `failureMessage`.

That preserves:

- user-facing `thread_failed` backfill
- no repeated admin alert fanout during recovery

## Alternatives Considered

### Keep snapshot publish best-effort only

Rejected because it permanently loses the current-state email on transient
failures.

### Add a dedicated snapshot queue

Rejected because the existing correspondence recovery runtime already provides
the right execution model and schedule. A new queue would add operational
complexity without new product value.

### Add a `missing_snapshots` table

Rejected for this pass because the repo already has deterministic outbox dedupe
and a periodic recovery loop. A new table would add state duplication and a
migration that this iteration explicitly does not need.

## Consequences

**Positive**

- Snapshot publish becomes eventually consistent instead of purely best-effort.
- Missing current-state emails can recover without a new institution event.
- Dedupe remains deterministic and outbox-driven.
- The same derivation logic drives both immediate and recovery snapshot publish.

**Negative**

- The correspondence recovery worker now depends on notification-delivery
  repositories in addition to correspondence repos.
- Recovery logs and result types become larger.
- A shared key helper must be maintained carefully because it becomes part of the
  dedupe contract.

## References

- `src/modules/institution-correspondence/core/usecases/publish-current-platform-send-update.ts`
- `src/modules/institution-correspondence/shell/queue/recovery-runtime.ts`
- `src/modules/institution-correspondence/shell/queue/workers/recovery-worker.ts`
- `src/modules/notification-delivery/core/ports.ts`
- `src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts`
- `src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts`
- `docs/specs/specs-202604051206-public-debate-notification-orchestrator.md`
