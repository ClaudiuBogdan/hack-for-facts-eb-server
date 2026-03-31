# User Events Module

**Status**: Draft  
**Date**: 2026-03-31  
**Author**: Codex

## Problem

The server needed a dedicated path for asynchronous user-event side effects
coming from learning-progress sync, but the first implementation left several
important behaviors implicit:

- the route could publish all submitted events instead of only the events that
  were actually applied
- publish failure ownership was split between the hook and the route
- the worker supported multiple handlers in shape, but behaved like a
  fail-fast single-handler pipeline
- retry behavior for public-debate dispatch did not distinguish retryable and
  non-retryable correspondence failures

Without a written spec, those contracts are easy to regress because the module
crosses route, queue, and handler boundaries.

## Context

- Source scope is intentionally narrow in v1: learning-progress sync is the
  only producer.
- Queue delivery remains best-effort in this phase. There is no DB outbox or
  transactional replay mechanism yet.
- `syncEvents()` already supports partial success through `failedEvents`, so the
  user-event publishing contract must preserve that behavior rather than revert
  to fail-fast semantics.
- Handlers act on authoritative current state by re-reading from the database,
  not by trusting queue payload snapshots.

## Decision

### 1. Publish only applied events

`syncEvents()` returns:

- `newEventsCount`
- `failedEvents`
- `appliedEvents`

`appliedEvents` contains only the original input events that were actually
applied:

- applied `progress.reset`
- applied `interactive.updated` where `upsertResult.value.applied === true`

The learning-progress route forwards only `appliedEvents` to the post-sync hook.

### 2. Best-effort publish has one owner

The user-event sync hook builds jobs and calls `publisher.publishMany(...)`
without its own rescue path.

The learning-progress route remains the single owner of best-effort behavior:

- it fires the hook asynchronously
- it logs hook failure once
- it still returns `200` for the sync request

This keeps the current operational contract explicit while avoiding double
suppression in two layers.

### 3. Worker dispatch is “attempt all, then fail”

The worker:

- validates the job payload structurally
- validates `occurredAt` explicitly at runtime
- finds all matching handlers
- runs every matched handler, even if one fails
- rethrows the single failure directly, or throws `AggregateError` when
  multiple handlers fail

This preserves visibility into all handler failures while keeping BullMQ retry
semantics.

### 4. Handler retryability is explicit

The public-debate handler maps correspondence errors as follows:

- database errors: retryable
- email send errors: use provider retryable flag
- validation / conflict / not-found: unrecoverable

Non-retryable correspondence failures are thrown as `UnrecoverableError` so the
queue does not spend retries on known terminal cases.

### 5. Queue identity stays source-derived

Job ids use a normalized `source` prefix rather than a hardcoded
`learning-progress` string. This keeps the current single-source model intact
while preventing unnecessary collisions if another source is added later.

## Consequences

### Positive

- route publishing now matches the real sync outcome
- retry ownership is clearer between route, hook, worker, and handler
- multiple matched handlers no longer hide later failures
- public-debate retries are more accurate

### Trade-offs

- reliability is still best-effort until an outbox exists
- successful handlers may run again if a later matched handler fails and BullMQ
  retries the job, so idempotency remains a hard requirement
- `appliedEvents` increases the internal `syncEvents()` return surface, though
  the public HTTP response stays unchanged

## Compatibility

- public learning-progress REST success responses remain `200`
- the route still returns `newEventsCount` and `failedEvents`
- the module still supports only learning-progress as a source in this phase

## References

- `src/modules/user-events/index.ts`
- `src/modules/user-events/shell/queue/worker.ts`
- `src/modules/user-events/shell/handlers/public-debate-request-handler.ts`
- `src/modules/learning-progress/core/usecases/sync-events.ts`
- `src/modules/learning-progress/shell/rest/routes.ts`
