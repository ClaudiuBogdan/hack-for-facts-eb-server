# Shared Public Debate Outbox Enqueue Helper

**Status**: Draft
**Date**: 2026-04-05
**Author**: Codex

## Problem

The public-debate direct-enqueue use cases in `notification-delivery` duplicate
the same control flow:

- try to create an outbox row
- handle `DuplicateDelivery`
- reload the existing row
- enqueue a compose job
- record whether the compose enqueue failed
- aggregate created/reused/queued ids

This duplication exists in both:

- entity update enqueue
- admin failure enqueue

Any later change to duplicate handling, compose enqueue behavior, or failure
accounting now has to be repeated in both files.

## Context

- The two use cases differ in how they derive recipients and metadata, but not
  in how they create/reuse outbox rows.
- The existing result contracts must stay unchanged because higher-level code in
  `build-app.ts` already aggregates and logs these arrays.
- This refactor should remain narrowly scoped and must not absorb unrelated
  delivery paths such as:
  - `terms_accepted`
  - subscription collect/compose
  - welcome notifications

## Decision

Extract one internal helper for “create or reuse outbox row, then enqueue
compose”.

### 1. Add one internal helper

Create:

- `src/modules/notification-delivery/core/usecases/enqueue-created-or-reused-outbox.ts`

Export an internal helper with this shape:

```ts
enqueueCreatedOrReusedOutbox(...)
```

Inputs:

- `deliveryRepo`
- `composeJobScheduler`
- `runId`
- `deliveryKey`
- `createInput`

Output:

```ts
{
  outboxId: string;
  source: 'created' | 'reused';
  composeEnqueued: boolean;
}
```

### 2. Duplicate reload failure becomes an explicit error

If `deliveryRepo.create(...)` returns `DuplicateDelivery` and
`findByDeliveryKey(...)` returns `null`, the helper returns a `DatabaseError`
instead of silently skipping the row.

That state is inconsistent and should fail loudly.

### 3. Public-debate enqueue use cases become thin loops

Update:

- `enqueue-public-debate-entity-update-notifications.ts`
- `enqueue-public-debate-admin-failure-notifications.ts`

Each use case remains responsible for:

- deriving recipients
- building `scopeKey`
- building `deliveryKey`
- building notification-specific metadata
- filling the existing result arrays

The shared helper owns the outbox create/reuse/compose-enqueue branch logic.

### 4. No public API changes

The exported use case names, dependencies, and result shapes remain unchanged.

This spec does not introduce a new public module export outside
`notification-delivery` internals.

### 5. Test approach

Keep the current use-case tests as the primary contract tests.

Add one focused helper test file only because the helper introduces a new
explicit inconsistency branch:

- create path
- duplicate reuse path
- duplicate with missing reload target -> error
- compose enqueue failure -> `composeEnqueued: false`

## Alternatives Considered

### Leave the duplication in place

Rejected because the two flows are already structurally the same, and drift is
more likely than useful divergence.

### Extract a fully generic delivery orchestration framework

Rejected because that would broaden the change beyond the two current public
debate use cases and risks mixing unrelated delivery semantics.

### Fold the duplication into repository methods

Rejected because create/reuse plus compose enqueue is not purely a persistence
concern. It spans repository and queue behavior.

## Consequences

**Positive**

- Duplicate-delivery behavior is defined once.
- Future changes to compose enqueue semantics touch one helper.
- The two public-debate enqueue files become easier to read and maintain.

**Negative**

- One more internal abstraction exists in `notification-delivery`.
- The helper must stay narrowly scoped to avoid turning into a catch-all
  delivery orchestration utility.

## References

- `src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts`
- `src/modules/notification-delivery/core/usecases/enqueue-public-debate-admin-failure-notifications.ts`
- `src/modules/notification-delivery/core/ports.ts`
- `src/modules/notification-delivery/shell/repo/delivery-repo.ts`
