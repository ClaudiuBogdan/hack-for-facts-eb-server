# Public Debate App-Boundary Test Expansion

**Status**: Draft
**Date**: 2026-04-05
**Author**: Codex

## Problem

The new public-debate behavior now spans multiple modules and shell boundaries,
but most of the safety net still lives in unit tests around individual use
cases.

That leaves several integration-sensitive behaviors easy to regress:

- request-flow late-subscriber backfill
- failed-thread behavior for end users versus admins
- reviewed-thread snapshot mapping
- `sending` and `closed_no_response` skip behavior
- terms-accepted remaining explicitly out of scope

Without focused app-boundary coverage, these behaviors can drift even when unit
tests still pass.

## Context

- The repo already uses fast integration tests with fake repos and schedulers.
- The public-debate flow touches:
  - `institution-correspondence`
  - `notifications`
  - `notification-delivery`
  - `user-events`
  - app wiring in `build-app.ts`
- The goal is not to add Redis-backed end-to-end tests. The goal is to verify
  orchestration boundaries with real module wiring and deterministic fakes.

## Decision

Add a reusable public-debate notification test harness plus targeted integration
coverage for the orchestrated boundaries.

### 1. Add one reusable harness

Create:

- `tests/fixtures/public-debate-notification-harness.ts`

The harness builds:

- in-memory correspondence repo
- shared notifications store usable through both notification repo interfaces
- delivery repo
- fake compose scheduler
- fake entity repo
- orchestrator instance from spec 1
- helper methods for invoking:
  - request-flow subscription behavior
  - direct publisher calls
  - terms-accepted paths when needed

### 2. Expand the existing snapshot integration test

Keep and expand:

- `tests/integration/public-debate-request-notification-snapshot.test.ts`

Required scenarios:

- existing awaiting-reply thread triggers one snapshot outbox for a late subscriber
- repeated request-flow subscribe reuses the existing outbox row
- reviewed thread maps to `reply_reviewed`
- `sending` thread produces no snapshot publish

### 3. Add one failed-thread boundary integration test file

Create:

- `tests/integration/public-debate-failed-thread-notifications.test.ts`

Required scenarios:

- late subscriber to a failed thread receives the user-facing `thread_failed`
  update
- the same late-subscriber recovery path does not create admin failure alerts
- immediate `thread_failed` publish with `failureMessage` creates:
  - user-facing update outbox rows
  - admin failure outbox rows

### 4. Add one explicit out-of-scope integration test

Create:

- `tests/integration/public-debate-notification-boundaries.test.ts`

Required scenario:

- the entity-terms-accepted flow creates or enables subscriptions but does not
  publish the current thread snapshot

This test must use the real orchestrator or app-boundary wiring, not direct
calls to `publishCurrentPlatformSendUpdate`.

### 5. Verification contract

Each integration test should assert:

- publish status
- outbox row counts
- outbox notification types
- reuse behavior on duplicates
- absence of unintended outbox rows

The tests should not rely on Redis or real BullMQ workers.

## Alternatives Considered

### Rely on unit tests only

Rejected because the regressions at risk here are mainly wiring and boundary
regressions, not pure use-case logic bugs.

### Add full Redis-backed end-to-end tests

Rejected because they are slower, noisier, and unnecessary for the current goal.
Deterministic fake-backed integration tests are sufficient.

### Fold all scenarios into one huge integration file

Rejected because the boundary behaviors will become harder to read and maintain.
Small focused files keep intent clear.

## Consequences

**Positive**

- Regressions in the orchestrated public-debate flow become much easier to catch.
- The most product-sensitive notification boundaries are documented in tests.
- The new orchestrator from spec 1 gets a stable integration harness.

**Negative**

- The integration suite grows and will require shared fixture maintenance.
- Some test setup code will duplicate repository wiring unless the harness stays
  disciplined.

## References

- `tests/integration/public-debate-request-notification-snapshot.test.ts`
- `src/app/build-app.ts`
- `src/modules/institution-correspondence/core/usecases/publish-current-platform-send-update.ts`
- `docs/specs/specs-202604051206-public-debate-notification-orchestrator.md`
- `docs/specs/specs-202604051207-public-debate-snapshot-backfill-retry.md`
