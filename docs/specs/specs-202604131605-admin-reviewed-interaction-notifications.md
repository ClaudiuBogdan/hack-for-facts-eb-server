# Admin Reviewed Interaction Notifications

**Status**: Draft
**Date**: 2026-04-13
**Author**: Codex

## Problem

Users currently do not receive a consistent, targeted notification when a
campaign admin reviews a high-value user interaction.

Today:

- campaign admins can approve or reject reviewable interactions through the
  campaign admin API
- the canonical review state is stored in learning-progress
- some downstream flows send user notifications, but only for specific cases
- there is no reusable notification model for "an important campaign event
  happened and a user should be notified"

That creates three gaps:

- users do not reliably learn the review outcome and feedback for reviewed
  interactions such as budget document submission
- admins cannot re-run or bulk-run reviewed-interaction notifications through a
  campaign-scoped notification surface
- the system does not yet have one reusable model that can later support other
  notification families such as action reminders, deadline reminders, or
  calendar-based nudges triggered by admin, post-commit hooks, or scheduled
  jobs

## Context

- Campaign-admin reviews are persisted through the learning-progress review API
  and already support side-effect preparation and post-commit execution.
- Admin review submission must opt in with `send_notification = true` before it
  dispatches reviewed-interaction notifications from that write path. The
  default is `false`.
- The notification system already uses a durable outbox with unique
  `delivery_key` values for deduplication, compose/send lifecycle, and audit.
- The existing `funky:notification:entity_updates` preference row already
  represents the current campaign/entity eligibility boundary for user
  notifications.
- Approved public debate requests already enter the institution-correspondence
  flow and can trigger the existing `thread_started` notification. That flow is
  already deployed and remains authoritative for approved
  `public_debate_request` behavior.
- Campaign admins need replay and bulk-trigger capabilities today, and future
  product work is expected to need additional trigger mechanisms such as
  scheduled jobs and cron-driven time windows.

## Decision

Introduce a reusable `NotificationFamily` model for campaign-scoped
notifications, and implement admin-reviewed interaction notifications as the
first family built on that model.

The reviewed-interaction family is the first adopter, but the model is intended
to support future families such as:

- reminders for unfinished actions
- reminders for specific user interactions
- deadline reminders
- calendar-based event notifications
- other campaign lifecycle notifications that can be triggered from admin,
  system events, or scheduled runners

## Non-Breaking Constraint

This design must preserve currently deployed behavior.

Specifically:

- approved `public_debate_request` reviews continue to use the existing
  correspondence preparation and dispatch path
- existing admin trigger routes keep their current behavior and response
  semantics
- existing outbox types, delivery keys, and replay semantics for already-live
  notification families do not change
- the new reusable model is introduced additively and adopted first by the new
  reviewed-interaction family

## Core Model

### `NotificationFamily`

A `NotificationFamily` is one business notification capability.

Examples:

- `admin_reviewed_interaction`
- `action_reminder`
- `deadline_reminder`
- `calendar_event_reminder`

A family owns:

- `campaignKey`
- `familyId`
- candidate shape
- rule evaluation logic
- outbox type
- template id
- metadata schema / parser
- audit projection
- supported trigger adapters

A family does not own:

- HTTP route wiring
- cron wiring
- queue runtime startup
- unrelated side effects outside notification delivery

### `CandidateSource`

A `CandidateSource` is the canonical loader for one family.

Its job is to load notification candidates from the owning domain module.

It should:

- load one candidate by stable identity for single replay
- list canonical candidates for admin bulk execution
- list canonical candidates for scheduled windows when needed
- return source data that is authoritative for that family

It should not:

- decide notification eligibility
- build URLs for email payloads
- enqueue outbox rows
- send emails
- hide important ownership boundaries by loading data from unrelated modules
  unless that data is part of source truth

Examples:

- reviewed interaction family:
  - source module: `learning-progress`
  - single replay key: `{ userId, recordKey }`
  - semantics: load the latest review occurrence currently stored for that
    record
  - bulk filters: `interactionIds`, `entityCui`, `userId`, `reviewStatus`,
    `reviewSource`, `reviewedAt`
- action reminder family:
  - source module: task/action module
  - single key: `{ actionId }`
  - scheduled query: actions due within `windowStart..windowEnd`
- calendar reminder family:
  - source module: schedule/calendar module
  - single key: `{ occurrenceId }`
  - scheduled query: event occurrences matching reminder offset

### `ShellEnricher`

A `ShellEnricher` loads additional read-only data that the planner or outbox
assembler needs but that does not belong in the canonical source row.

It should:

- load entity names
- load safe step-link context
- load audit-derived extras needed for delegated paths
- load other read-only supporting context

It should not:

- mutate state
- enqueue outbox rows
- contain branching business policy that belongs in the planner

Example:

- the reviewed-interaction family may need entity display name and a shared step
  link builder
- the delegated approved-debate branch may need audit-derived
  `approvalRiskAcknowledged` context

### `Planner`

The `Planner` is the pure business-rule engine for the family.

It should:

- classify a candidate as `queue`, `skip`, or `delegate`
- apply supported interaction rules
- decide whether a next-step suggestion exists
- express why something is skipped or delegated

It should not:

- talk to the database
- call the outbox repository
- schedule compose jobs
- perform non-notification side effects
- depend on Fastify route helpers

Example planner outputs:

- `queue_direct_notification`
- `skip_unsupported`
- `skip_not_admin_reviewed`
- `delegate_to_external_flow`

### `OutboxAssembler`

The `OutboxAssembler` turns a planned notification into delivery-ready data.

It should:

- compute a deterministic delivery key
- build typed outbox metadata or template payload
- choose outbox type and compose strategy
- isolate delivery-specific shaping from business classification

It should not:

- re-decide business rules
- re-load canonical source rows
- embed trigger-source-specific semantics into dedup identity

### `Executor`

The `Executor` applies the assembled plan to the delivery layer.

It should:

- perform targeted eligibility checks
- perform duplicate / existing-outbox checks
- create or reuse outbox rows
- enqueue compose when allowed
- suppress stale occurrences when canonical state no longer matches the
  occurrence being delivered
- return execution outcomes for single or bulk runs

It should not:

- contain family-specific classification logic
- create hidden side effects during dry-run
- change behavior based on whether the caller was admin or cron, except for
  audit metadata such as `triggerSource`

### `TriggerAdapter`

A `TriggerAdapter` is an entrypoint-specific wrapper around the same family
runner.

Supported trigger adapters may include:

- admin single replay
- admin bulk replay
- opt-in post-commit hook after a canonical write
- cron job
- scheduled time-window job
- future webhook or system-event adapters

An adapter should:

- validate adapter-specific input
- translate that input to source selection criteria
- call the shared family runner
- record the trigger source in audit metadata

An adapter should not:

- reimplement planner logic
- bypass the outbox executor
- change dedup identity

## Trigger-Source Independence

The same logical notification occurrence must deduplicate the same way no
matter how it was triggered.

Therefore:

- business occurrence identity belongs in `delivery_key`
- `triggerSource` belongs in metadata and audit
- `triggeredByUserId` belongs in metadata and audit when relevant
- admin bulk, admin single, explicit review-submit follow-up, and cron should
  all converge on the same family runner and the same delivery identity

## Family Identity and Dedup

Dedup identity must be based on the business occurrence, not the trigger
mechanism.

For reviewed interactions, the delivery key must be namespaced and future-safe.

Chosen format:

`reviewed_interaction:<campaignKey>:<userId>:<interactionId>:<recordKey>:<reviewedAt>:<status>`

Why:

- `campaignKey` avoids cross-campaign collisions
- `interactionId` makes the key self-descriptive and safer if record-key
  conventions evolve
- `recordKey`, `reviewedAt`, and `status` identify one concrete review outcome

## Review Occurrence Identity In V1

The reviewed-interaction family distinguishes between:

- candidate identity:
  - how an operator or adapter addresses a record today
  - in v1 single replay this is `{ userId, recordKey }`
- occurrence identity:
  - the specific review outcome currently represented by that record
  - in v1 this is derived from `campaignKey + interactionId + recordKey +
reviewedAt + status`

V1 decision:

- single replay repairs the latest occurrence currently stored for a record
- it does not target arbitrary historical review occurrences
- `reviewedAt + status` is sufficient for latest-occurrence repair under the
  current review model because:
  - reviews are not edited in place after resolution
  - a new review cycle produces a new `reviewedAt`
  - exact idempotent retries reuse the same reviewed state

Out of scope in v1:

- replaying a selected historical review occurrence
- editable review revisions after resolution
- resend of the same occurrence as a second user-visible notification

Future option:

- if the product later needs historical replay, editable review revisions, or
  explicit resend semantics, introduce an immutable `reviewEventId` or monotonic
  `reviewVersion` and promote that to the family occurrence key

## Trigger Adapters In Scope

The reviewed-interaction family should support these adapters:

- explicit execution after the canonical review write commits when the review
  request sets `send_notification = true`
- manual single-record replay from the campaign-admin notification surface
- manual bulk replay from the campaign-admin notification surface

The reusable model must also remain compatible with future adapters such as:

- cron-driven reminder windows
- scheduled event occurrence runners
- other platform-side batch or event-driven mechanisms

## Eligibility Boundary

For v1, reviewed-interaction notifications reuse
`funky:notification:entity_updates`.

That means:

- the family uses the existing entity-scoped opt-in boundary
- the design does not add a new preference type in v1
- the product meaning of that preference must be broadened intentionally if this
  change ships

The reusable model must use a targeted eligibility contract rather than only
fan-out APIs. A single reviewed-interaction notification needs the answer to:

- is this user eligible for this entity-scoped notification family right now?

That targeted check must include:

- active entity preference
- global unsubscribe state
- campaign-global disable state if applicable

## V1 Reviewed-Interaction Family

### Family Id

- `campaignKey = funky`
- `familyId = admin_reviewed_interaction`

### Supported direct-notification cases

- `budget_document` approved
- `budget_document` rejected
- `public_debate_request` rejected

### Explicitly excluded from direct family execution

- `public_debate_request` approved

That case remains outside the family because it already owns additional
institution-correspondence side effects and deployed failure semantics.

### V1 Business Behavior

When the reviewed-interaction family is invoked, either because:

- an admin review request explicitly set `send_notification = true`, or
- an operator later used replay / bulk repair,

the family applies these direct-notification rules:

- `budget_document` approved:
  - send reviewed-interaction notification
  - include review feedback when present
  - include a next-step link to `public_debate_request` only when that
    interaction has not already started for the same user and entity
- `budget_document` rejected:
  - send reviewed-interaction notification
  - include review feedback
  - include retry link back to the budget document step
- `public_debate_request` rejected:
  - send reviewed-interaction notification
  - include review feedback
  - include retry link back to the public debate request step
- `public_debate_request` approved:
  - do not send the new reviewed-interaction notification
  - continue using the existing institution-correspondence lifecycle flow and
    its existing user notification path

### Explicit source rules

The direct reviewed-interaction family must only treat records as
admin-reviewed when `review.reviewSource = campaign_admin_api`.

That rule applies to every supported interaction, including
`public_debate_request`, because the codebase already has worker-owned review
paths.

### Started-state rule for `budget_document -> public_debate_request`

The notion of "started" must be explicit.

V1 definition:

- inspect the latest matching `public_debate_request` row by `updatedAt` for the
  same `userId + entityCui + interactionId`
- if the latest row is `idle` or `draft`, the next-step suggestion may be shown
- if the latest row is `pending`, `resolved`, or `failed`, the suggestion is
  suppressed

## Replay and Bulk Behavior

### Single replay

Single replay uses the same family runner as automatic execution, but it starts
from a single candidate identity rather than from a post-commit hook.

Single replay in v1 means:

- repair the latest reviewed occurrence currently stored for `{ userId,
recordKey }`
- do not intentionally create a second occurrence for that same review outcome

### Bulk replay

Bulk replay is a generic family-runner capability, not a one-off reviewed
interaction endpoint.

Bulk execution:

- validates family-specific filters
- captures a stable upper watermark before paging starts
- pages only candidates at or below that watermark
- pages candidates through the family source
- enriches and plans each candidate
- executes only when not in dry-run mode
- returns aggregate counts

V1 operational scope:

- bounded synchronous execution for small to moderate repair runs
- not intended to be an unbounded background export or campaign-wide historical
  resend tool

### Dry-run

`dryRun` must be read-only.

That means:

- candidate loading is allowed
- enrichment is allowed only if it is read-only
- planner evaluation is allowed
- read-only executor checks are allowed
- outbox writes are not allowed
- subscription auto-creation or other setup mutations are not allowed

`dryRun` is therefore a read-only simulation of:

- business planning
- current eligibility checks
- current duplicate / existing-outbox checks

It is not a guarantee that a later live execution will send, because eligibility
and stale/currentness checks may change before compose or send.

## Replay vs Resend

These terms are intentionally separate.

`replay` or `repair` means:

- re-run processing for the same logical occurrence
- reuse the same occurrence identity
- avoid creating a second user-visible notification when that occurrence has
  already been fully processed

`resend` means:

- intentionally create a new user-visible occurrence
- record a separate audited reason for doing so
- use a different occurrence identity

V1 supports replay/repair only.

Explicit resend is out of scope.

## Delivery Guarantee and Transaction Boundary

V1 uses the existing post-commit side-effect seam.

That means:

- the canonical review write remains authoritative
- reviewed-interaction outbox creation happens after the review commit through
  the family adapter only when the originating review request explicitly set
  `send_notification = true`
- the default review-submit behavior is to save the review without creating a
  reviewed-interaction outbox row
- v1 does not claim a same-transaction transactional-outbox guarantee for this
  family

V1 guarantee:

- if the canonical review commit succeeds, the system attempts to materialize
  exactly one outbox occurrence for the latest reviewed occurrence
- if post-commit outbox creation is missed or fails, admin single replay and
  admin bulk replay act as repair paths for that occurrence

Deferred stronger options:

- create the direct outbox row in the same DB transaction as the review write
- or persist a durable pending-side-effect record that is drained separately

## Stale Occurrence Suppression

Older occurrences must not send after a newer review supersedes them.

Therefore, reviewed-interaction delivery requires a currentness check before
send:

- re-read current canonical review state for the record
- compare it against the occurrence identity stored in the outbox row
- if the current review no longer matches the outbox occurrence, suppress the
  send as stale

V1 implementation guidance:

- the stale check belongs to execution/send-time logic, not to the pure planner
- a structured suppression reason such as `stale_occurrence` is required in
  audit or failure metadata

Status-model options:

- minimal v1:
  - keep the current delivery-status taxonomy and use an existing terminal state
    plus structured stale reason metadata
- cleaner future option:
  - add a dedicated `skipped_stale` delivery status

## Alternatives Considered

### Keep the design admin-trigger-centric

Rejected.

- It models the entrypoint instead of the business capability.
- It makes cron and scheduled runners second-class additions later.
- It encourages duplicate logic across admin, system, and schedule adapters.

### Fold approved `public_debate_request` into the family

Rejected.

- It would blur ownership between notification delivery and
  institution-correspondence side effects.
- It would change already-deployed preparation and failure semantics.

### Create a separate bulk API per family

Rejected.

- It would duplicate selection, dry-run, and aggregate-result behavior.
- The reusable concept is family execution, not per-family route mechanics.

## Consequences

**Positive**

- The reviewed-interaction feature becomes the first concrete `NotificationFamily`
  instead of a one-off admin feature.
- Future families such as reminders and calendar-based events can reuse the
  same model.
- Admin single replay, admin bulk replay, explicit review-submit follow-up, and
  future cron jobs all converge on the same business runner.
- Existing approved-debate behavior remains stable.

**Negative**

- The architecture is more explicit and introduces more named concepts.
- The codebase will need new family registration and targeted eligibility
  contracts.
- Some existing notification module contracts are too single-trigger-oriented
  and will need additive extension.

## References

- Campaign-admin review write path:
  [src/modules/learning-progress/shell/rest/campaign-admin-routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts)
- Canonical review update logic:
  [src/modules/learning-progress/core/usecases/update-interaction-review.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/update-interaction-review.ts)
- Existing approved public debate review side effects:
  [src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts)
- Existing campaign-admin notification trigger surface:
  [src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts)
- Outbox create/reuse helper:
  [src/modules/notification-delivery/core/usecases/enqueue-created-or-reused-outbox.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/enqueue-created-or-reused-outbox.ts)
- Existing campaign/entity eligibility filtering:
  [src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts)
- Existing campaign-admin notification admin spec:
  [docs/specs/specs-202604120912-funky-campaign-notification-admin.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604120912-funky-campaign-notification-admin.md)
- Detailed implementation reference:
  [docs/specs/implementation-plan-admin-reviewed-interaction-notifications.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/implementation-plan-admin-reviewed-interaction-notifications.md)
