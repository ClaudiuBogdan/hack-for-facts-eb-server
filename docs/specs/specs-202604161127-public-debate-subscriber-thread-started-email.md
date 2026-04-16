# Public Debate Subscriber Thread-Started Email

**Status**: Draft
**Date**: 2026-04-16
**Author**: Codex

## Problem

The current public-debate notification work mixed two concerns:

- `eventType`, which should describe the thread lifecycle event
- recipient audience, which should describe why a specific person received that
  delivery

The current in-progress change introduced a "neutral non-owner" branch for
`thread_started`. That fixes copy symptoms, but it leaves the model ambiguous:
audience is inferred from missing or mismatched owner data instead of being
represented explicitly.

That ambiguity makes the enqueue contract harder to reason about, leaves replay
and recovery paths inconsistent, and encourages template selection to rely on
implicit fallbacks instead of a clear delivery role.

## Context

- One public-debate thread can fan out to multiple recipients for the same
  entity.
- The person who triggered the original institution request is one recipient of
  `thread_started`, but entity subscribers may also receive the same lifecycle
  event.
- The same `thread_started` lifecycle event is reused for:
  - the original orchestrator publish
  - late-subscriber snapshot backfill
  - campaign-admin replay of current snapshot state
  - recovery flows that republish current snapshots
- The platform already has the challenge/entity CTA helper:
  `buildCampaignEntityUrl(platformBaseUrl, entityCui)`.
- The task must keep existing notification types, delivery keys, and lifecycle
  events.
- The task must not persist raw requester identity in outbox metadata.

## Decision

Keep lifecycle and audience separate:

- `eventType` models the thread lifecycle event
- `recipientRole` models the audience for one delivery of that event

### 1. `thread_started` stays one event type

Do not split requester and subscriber deliveries into different event types.

The event remains:

- `eventType = 'thread_started'`

Every `thread_started` delivery must also persist:

- `recipientRole = 'requester' | 'subscriber'`

`recipientRole` is per delivery, not per permanent user identity. The same user
may be a requester in one thread and a subscriber in another.

### 2. `recipientRole` drives `thread_started` copy

For `thread_started`:

- `recipientRole = 'requester'` uses the existing confirmation-style copy:
  "your request was sent"
- `recipientRole = 'subscriber'` uses subscriber-specific copy that says:
  - the institution request is already in progress
  - the email was sent because the recipient follows that entity
  - the recipient can follow updates or continue their own challenge steps from
    the entity page
  - the recipient should not send another institution request

The subscriber delivery must:

- avoid requester-only wording
- avoid requester identity or requester organization disclosure
- link to the entity page with `buildCampaignEntityUrl`
- avoid implying that the CTA sends or resends another institution request

### 3. `thread_started` enqueue intent must be explicit

Every `thread_started` enqueue path must explicitly pass the requester identity
used to derive `recipientRole`.

This applies to:

- normal orchestrator publish
- publish-current snapshot backfill
- campaign-admin thread replay
- recovery paths that republish current snapshots

Do not rely on:

- omitted requester identity
- missing requester identity
- compose-time owner comparison

to decide requester versus subscriber wording.

### 4. Persist only delivery audience metadata

Do not persist raw requester identity in outbox metadata.

Persist only the explicit delivery audience needed at compose time:

- `recipientRole: 'requester' | 'subscriber'`

For `thread_started`, compose-time template selection must require valid
`recipientRole` metadata:

- `thread_started + requester` -> existing
  `public_debate_entity_update` template
- `thread_started + subscriber` -> subscriber-specific
  `thread_started` template
- missing or invalid `recipientRole` -> fail clearly

### 5. Keep other lifecycle events shared

This task does not add new lifecycle events.

For now:

- `thread_failed` remains one shared event and keeps neutral/shared copy
- `reply_received` remains unchanged
- `reply_reviewed` remains unchanged

Future lifecycle events such as registration-received or completed-successfully
are out of scope for implementation here. If they are added later, they must
follow the same modeling rule:

- add a new lifecycle `eventType` only when the lifecycle itself changes
- keep audience semantics orthogonal as `recipientRole` or equivalent delivery
  metadata

### 6. Test the decision boundaries

Add coverage for:

- requester `thread_started` delivery uses requester-facing copy
- subscriber `thread_started` delivery uses subscriber-facing copy
- late-subscriber snapshot publish persists `recipientRole = 'subscriber'`
- reused unrendered `thread_started` outboxes refresh to explicit
  `recipientRole`
- missing or invalid `recipientRole` fails clearly at compose time
- missing requester identity is not treated as an implicit subscriber fallback
- `thread_failed` remains neutral/shared and does not add audience branching

## Alternatives Considered

### Split requester and subscriber into separate event types

Rejected because requester versus subscriber is delivery audience, not thread
lifecycle. Splitting it into separate event types would blur the lifecycle model
and make future event growth harder to reason about.

### Keep the current neutral non-owner metadata branch

Rejected because it still encodes audience indirectly. The system should persist
the explicit audience semantics it actually needs at compose time.

### Infer audience only at compose time from requester identity

Rejected because compose should not need raw requester identity and should not
derive audience from missing or legacy data. Audience must be resolved before
outbox persistence.

## Consequences

**Positive**

- `thread_started` keeps a clean lifecycle model.
- Delivery audience becomes explicit and testable.
- Replay and recovery paths use the same contract as the normal publish path.
- Subscriber copy is clear without leaking requester identity.

**Negative**

- `thread_started` callers must now pass requester identity explicitly.
- One subscriber-specific template remains necessary alongside the existing
  requester-facing template.
- Legacy `thread_started` publishes without requester identity will now surface
  as invalid input instead of silently choosing subscriber copy.

## References

- `src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts`
- `src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts`
- `src/modules/institution-correspondence/core/ports.ts`
- `src/modules/institution-correspondence/core/usecases/derive-current-platform-send-snapshot.ts`
- `src/modules/institution-correspondence/core/usecases/publish-current-platform-send-update.ts`
- `src/modules/institution-correspondence/shell/public-debate-notification-orchestrator.ts`
- `src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts`
- `src/modules/email-templates/shell/templates/public-debate-entity-update.tsx`
- `src/common/utils/build-campaign-entity-url.ts`
