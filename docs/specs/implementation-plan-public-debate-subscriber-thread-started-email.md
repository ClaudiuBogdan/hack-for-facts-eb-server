# Implementation Plan: Public Debate Subscriber Thread-Started Email

**Status**: Draft
**Date**: 2026-04-16
**Author**: Codex
**Spec**: [Public Debate Subscriber Thread-Started Email](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604161127-public-debate-subscriber-thread-started-email.md)

## Goal

Align the current in-progress `thread_started` notification change to the
explicit model from the spec:

- `eventType` describes thread lifecycle
- `recipientRole` describes delivery audience

The implementation must keep the existing outbox type, delivery key semantics,
and `thread_started` lifecycle event while replacing the current
`neutral_non_owner` framing with explicit requester/subscriber semantics.

## Hard Constraints

- do not add new lifecycle events in this task
- do not change subscription eligibility rules
- do not change outbox types
- do not change delivery key semantics
- do not persist raw requester identity in outbox metadata
- keep `thread_failed` shared and neutral
- require explicit requester identity on every `thread_started` enqueue path

## Confirmed Decisions

- `thread_started` remains a single lifecycle event.
- `recipientRole` is persisted only for `thread_started` deliveries.
- `recipientRole` values are:
  - `requester`
  - `subscriber`
- `thread_started + requester` uses the existing
  `public_debate_entity_update` template.
- `thread_started + subscriber` uses a subscriber-specific template.
- Missing or invalid `recipientRole` must fail clearly at compose time.
- Missing requester identity is invalid for `thread_started` enqueue; it is not
  a subscriber fallback.
- Future lifecycle events such as registration-received or
  completed-successfully are out of scope here, but must keep lifecycle and
  audience orthogonal if implemented later.

## Existing Code Seams

### `thread_started` enqueue and metadata assembly

- `src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts`
- `src/modules/notification-delivery/core/usecases/enqueue-created-or-reused-outbox.ts`
- `src/modules/notification-delivery/shell/repo/delivery-repo.ts`

Current issue:

- the staged change persists `threadStartedAudience = neutral_non_owner`
- requester-versus-subscriber is inferred from `ownerUserId`
- requester identity is not an explicit caller contract

Implementation decision:

- make `thread_started` input explicitly carry `requesterUserId`
- derive `recipientRole` before outbox persistence
- persist only `recipientRole`
- refresh reused unrendered `thread_started` outboxes with explicit
  `recipientRole`

### Thread-derived publish callers

- `src/modules/institution-correspondence/shell/public-debate-notification-orchestrator.ts`
- `src/modules/institution-correspondence/core/usecases/derive-current-platform-send-snapshot.ts`
- `src/modules/institution-correspondence/core/usecases/publish-current-platform-send-update.ts`
- `src/modules/institution-correspondence/core/usecases/reconcile-platform-send-success.ts`
- `src/modules/institution-correspondence/shell/webhook/resend-side-effect.ts`
- `src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts`

Current issue:

- some `thread_started` publishes depend only on thread data and do not expose
  requester identity as an explicit part of the publish intent

Implementation decision:

- update `PublicDebateEntityUpdateNotification` so `thread_started` explicitly
  carries `requesterUserId`
- pass that value through every thread-derived caller consistently
- keep `thread_failed`, `reply_received`, and `reply_reviewed` unchanged

### Compose-time template selection

- `src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts`
- `src/modules/email-templates/core/types.ts`
- `src/modules/email-templates/core/schemas.ts`
- `src/modules/email-templates/shell/registry/index.ts`
- `src/modules/email-templates/shell/registry/registrations/`
- `src/modules/email-templates/shell/templates/`

Current issue:

- the staged compose worker chooses a "neutral" template only when a
  `threadStartedAudience` marker exists
- requester behavior is still implicit in the absence of that marker

Implementation decision:

- require `recipientRole` on every `thread_started` compose path
- route requester deliveries to the existing template
- route subscriber deliveries to a renamed subscriber-specific template
- fail clearly for missing or invalid `recipientRole`

## Implementation Steps

### 1. Rewrite the spec wording and add this implementation plan

- replace neutral/non-owner wording with requester/subscriber wording
- document lifecycle versus audience explicitly
- document future-event modeling guidance without implementing those events

### 2. Tighten `thread_started` publish contracts

- update correspondence notification types so `thread_started` includes
  `requesterUserId`
- update snapshot derivation and direct publish callers to pass it explicitly
- update campaign-admin replay and recovery paths to forward it

### 3. Persist explicit `recipientRole`

- remove `threadStartedAudience`
- persist `recipientRole` for every `thread_started` outbox
- validate requester identity before fanout so audience is derived explicitly

### 4. Rename the subscriber template surface

- rename "neutral" template/types/registration/tests to "subscriber"
- keep subscriber copy focused on:
  - request already in progress
  - recipient follows that entity
  - continue challenge steps from the entity page
  - do not send another institution request

### 5. Update focused tests

- notification-delivery unit tests for requester/subscriber metadata and compose
  selection
- email-template registry and renderer tests for renamed subscriber template
- institution-correspondence unit tests for explicit `requesterUserId` propagation
- integration snapshot tests for subscriber `recipientRole`
- failed-thread tests to confirm no audience branching there

## Validation

Run:

- `pnpm typecheck`
- targeted `pnpm vitest run` for touched notification-delivery, email-template,
  and institution-correspondence tests

At minimum, the final validation set should prove:

- requester and subscriber `thread_started` flows both work
- compose fails clearly for invalid `recipientRole`
- replay and recovery paths use the explicit requester-aware contract
- `thread_failed` remains audience-neutral
