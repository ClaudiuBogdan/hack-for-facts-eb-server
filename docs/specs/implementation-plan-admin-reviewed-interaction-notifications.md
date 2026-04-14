# Implementation Plan: Admin Reviewed Interaction Notifications

**Status**: Draft
**Date**: 2026-04-13
**Author**: Codex
**Spec**: [Admin Reviewed Interaction Notifications](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604131605-admin-reviewed-interaction-notifications.md)

## Goal

Implement the first reusable `NotificationFamily` in `funky`:
`admin_reviewed_interaction`.

The implementation must:

- preserve currently deployed approved `public_debate_request` behavior
- support admin single replay and admin bulk replay
- keep review submission notifications behind explicit
  `send_notification = true` opt-in, with default `false`
- stay compatible with future trigger mechanisms such as cron and scheduled
  jobs
- keep dedup in the outbox only
- introduce reusable family-running primitives without breaking existing
  notification families

## Non-Breaking Rollout Rules

These are hard constraints for implementation:

- do not replace the existing approved `public_debate_request` preparation path
  in [src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts:390)
- do not change the behavior of existing trigger routes for already-live
  families
- do not change delivery keys or outbox types of already-live families
- do not auto-dispatch notifications from the admin review POST unless the
  request explicitly sets `send_notification = true`
- do not make `dryRun` mutate notification preferences or other state
- add the new family and its adapters on top of the current architecture

## Confirmed Decisions

- Dedup authority remains only `notificationsoutbox.delivery_key`.
- The reviewed-interaction delivery key format becomes:
  `reviewed_interaction:<campaignKey>:<userId>:<interactionId>:<recordKey>:<reviewedAt>:<status>`.
- V1 single replay targets the latest reviewed occurrence currently stored for
  `{ userId, recordKey }`.
- Under the current review model, `reviewedAt + status` is sufficient for
  latest-occurrence repair because reviews are not edited in place after
  resolution.
- If historical replay or editable review revisions are added later, migrate the
  family occurrence identity to an explicit `reviewEventId` or
  `reviewVersion`.
- V1 reviewed-interaction family covers:
  - `budget_document` approved
  - `budget_document` rejected
  - `public_debate_request` rejected
- `public_debate_request` approved remains outside the family and continues to
  use the existing correspondence-owned branch.
- `review.reviewSource = campaign_admin_api` is required for every direct
  reviewed-interaction notification candidate.
- Reuse `funky:notification:entity_updates` as the v1 eligibility boundary, but
  treat that as an explicit product-semantic broadening.
- V1 keeps the current post-commit review side-effect seam; same-transaction
  review-write + outbox insertion is deferred.
- The campaign-admin review POST gains `send_notification?: boolean` with
  default `false`.
- The reviewed-interaction post-commit branch only runs when
  `send_notification = true`.
- Replay means repair of the same logical occurrence; explicit resend is out of
  scope.
- `dryRun` is a read-only simulation of planner plus executor checks.
- Bulk execution captures a stable upper watermark before paging.
- Bulk execution is generic at the family-runner level, not at the family
  business-rules level.

## Existing Code Seams

### Review write path and side-effect seam

- The campaign-admin review POST is in
  [src/modules/learning-progress/shell/rest/campaign-admin-routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts:1914).
- The route currently depends on `prepareApproveReviews` in
  [campaign-admin-routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts:136),
  prepares side effects before `submitInteractionReviews(...)`, and executes
  `afterCommit()` in
  [campaign-admin-routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts:1953).
- That seam is wired from
  [src/app/build-app.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/app/build-app.ts:1596)
  to the approved public debate dispatch planner in
  [src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts:390).

**Implementation decision**

- Keep the existing approved-debate preparation branch as-is.
- Extend the review POST contract with `send_notification?: boolean`.
- Default `send_notification` to `false`.
- Add a second branch for reviewed-interaction notifications after commit, but
  execute it only when `send_notification = true`.
- Rename the route/build-app dependency from approve-only wording to generic
  review-side-effects wording, but keep both branches explicit.
- Do not claim atomic review-write + outbox insertion in v1 for the new family.
- Treat admin single replay and admin bulk replay as the repair path for missed
  post-commit enqueue attempts.

### Canonical review state

- Canonical review fields live in
  [src/modules/learning-progress/core/types.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/types.ts:43).
- Review writes are performed in
  [src/modules/learning-progress/core/usecases/update-interaction-review.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/update-interaction-review.ts:198).

Important nuance:

- the latest learning-progress row is enough for direct reviewed-interaction
  cases
- the latest row is not enough for the delegated approved-debate branch because
  that branch may require audit-derived override context such as
  `approvalRiskAcknowledged`

**Implementation decision**

- define direct family candidates from canonical learning-progress state
- allow family-specific enrichment to load audit-derived extras only where
  needed

### Trigger surface

- Existing admin triggers are defined in
  [src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts:418)
  and executed through
  [src/modules/campaign-admin-notifications/shell/rest/routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/rest/routes.ts:394).
- The current port in
  [src/modules/campaign-admin-notifications/core/ports.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/core/ports.ts:33)
  is single-trigger-oriented.

**Implementation decision**

- keep the existing trigger surface working
- introduce a new family runner below it
- let the reviewed-interaction admin trigger become a thin adapter to the
  family runner
- add a new bulk route backed by the same family runner
- keep single-record and bulk result types separate

### Outbox create/reuse and dedup

- Outbox create-or-reuse helper:
  [src/modules/notification-delivery/core/usecases/enqueue-created-or-reused-outbox.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/enqueue-created-or-reused-outbox.ts:76)
- Delivery repository create/find:
  [src/modules/notification-delivery/shell/repo/delivery-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/repo/delivery-repo.ts:86)
  and
  [src/modules/notification-delivery/shell/repo/delivery-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/repo/delivery-repo.ts:158)
- Unique DB constraint:
  [src/infra/database/user/migrations/202604021100_unify_production_user_schema.sql](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/infra/database/user/migrations/202604021100_unify_production_user_schema.sql:142)

Current limitation:

- `enqueueCreatedOrReusedOutbox(...)` supports only:
  - `always_enqueue_compose`
  - `skip_terminal_compose`
- terminal statuses include both successful and failed terminal states

**Implementation decision**

- narrow the reviewed-interaction replay promise in v1 to states the current
  helper can support safely
- do not document replay of failed terminal rows unless a dedicated reset path
  is added
- do not use replay to mean resend; the same occurrence must not intentionally
  materialize a second direct notification in v1

### Eligibility boundary

- Current entity-scoped campaign fan-out filtering happens in
  [src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts:237).

Current limitation:

- the fan-out API shape is right for "notify every subscriber of this entity"
- it is not the right shape for "is this specific user eligible for this
  specific entity-scoped notification occurrence?"

**Implementation decision**

- add a targeted eligibility contract for one user + one notification type +
  one entity
- keep fan-out APIs for families that really fan out

### Step-link resolution

- Campaign interaction step metadata already exists in
  [src/modules/learning-progress/core/campaign-admin-config.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/campaign-admin-config.ts:31).
- The current path builder is private to
  [src/modules/learning-progress/shell/rest/campaign-admin-routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts:610).

**Implementation decision**

- extract the step-link builder into shared shell code
- keep URL generation outside the pure planner

## Target Architecture

### 1. `NotificationFamily` registration

Add a reusable family registration layer in a shared notification-admin or
campaign-notification core package.

Each family registration should contain:

- `campaignKey`
- `familyId`
- `outboxType`
- `templateId`
- `candidateSource`
- optional `shellEnricher`
- `planner`
- `outboxAssembler`
- `executor`
- `auditProjector`
- trigger-adapter metadata

It should also describe capabilities such as:

- supports admin single replay
- supports admin bulk replay
- supports dry-run
- supports scheduled window execution

This registration object is the reusable "one place to wire a family" seam.

It should not:

- own Fastify route registration directly
- hide non-notification side effects that belong to another module

### 2. `CandidateSource`

Add a family-specific candidate source for reviewed interactions.

It should support:

- `getByIdentity({ userId, recordKey })`
  - semantics: load the latest reviewed occurrence currently stored for that
    record
- `listByAdminFilters(filters, page)`
- future extension point:
  - `listByScheduleWindow(windowStart, windowEnd)` for families that need time
    windows

Reviewed-interaction source rules:

- source of truth is learning-progress
- only entity-scoped records are candidates
- only reviewable interaction ids configured for the family are candidates
- `reviewSource` must be queryable or at least explicitly checked before
  planning

Candidate source should not:

- check notification preferences
- assemble outbox metadata
- decide next-step suggestions
- decide duplicate or existing-outbox behavior

### 3. `ShellEnricher`

Add a read-only enrichment step between candidate loading and planning.

Reviewed-interaction enrichment should provide:

- interaction label
- entity display name
- shared step-link resolution helpers
- started-state lookup for `public_debate_request`

Rules:

- enrichment is allowed to load additional read-only context
- enrichment is not allowed to mutate preferences or create subscriptions
- audit-derived extras are loaded only for branches that need them

### 4. `Planner`

Add a pure planner for `admin_reviewed_interaction`.

Planner input should contain:

- candidate identity
- canonical row
- enriched read-only context
- trigger metadata that does not affect dedup identity

Planner output should be one of:

- `queue_direct_notification`
- `skip_not_supported`
- `skip_not_admin_reviewed`
- `delegate_to_external_flow`

Planner responsibilities:

- require entity scope
- require supported interaction id
- require `review.status`
- require `review.reviewedAt`
- require `review.reviewSource = campaign_admin_api`
- evaluate next-step suggestions
- classify approved debate requests as delegated / unsupported for direct family
  execution

Planner should not:

- query repositories
- call the delivery repo
- format template payloads
- build URLs directly
- decide runtime eligibility
- decide duplicate or existing-outbox behavior
- decide stale/superseded occurrence suppression

### 5. `OutboxAssembler`

Add an assembler that converts `queue_direct_notification` into direct-outbox
input.

Assembler output should contain:

- `deliveryKey`
- `notificationType = funky:outbox:admin_reviewed_interaction`
- `templateId = admin_reviewed_user_interaction`
- typed metadata / payload
- compose strategy

Metadata contract should include:

- `campaignKey`
- `familyId`
- `recordKey`
- `interactionId`
- `interactionLabel`
- `reviewStatus`
- `reviewedAt`
- optional `feedbackText`
- `userId`
- `entityCui`
- `entityName`
- `nextStepLinks`
- `triggerSource`
- optional `triggeredByUserId`

Important detail:

- approved reviews may not have `feedbackText`
- rejected reviews require it by current review validation rules

Implementation detail:

- define a typed metadata DTO and one parser shared by assembler, compose, and
  audit
- do not rely on ad hoc `Record<string, unknown>` parsing in three different
  places

### 6. `Executor`

Add a reviewed-interaction executor built on:

- targeted eligibility check
- `enqueueCreatedOrReusedOutbox(...)`

Targeted eligibility contract should answer:

- is this user eligible for `funky:notification:entity_updates` on this entity
  right now?

It must include:

- active entity preference
- global unsubscribe state
- campaign-global disable state if applicable

Executor responsibilities:

- authoritative runtime eligibility decision
- authoritative duplicate / existing-outbox decision
- authoritative replayability decision based on current outbox state
- live execution
- read-only simulation of the same checks during `dryRun`

Executor behavior in v1:

- create new outbox row when none exists
- reuse and requeue only safely replayable states
- skip rows in terminal states when v1 cannot safely recover them
- return explicit reasons such as:
  - `eligible_now`
  - `ineligible_now`
  - `existing_sent`
  - `existing_pending`
  - `existing_not_replayable`
  - `enqueue_failed`

The executor must not promise stronger replay semantics than the current
delivery state machine supports.

The executor is also responsible for send-time stale suppression through the
reviewed-interaction delivery path.

### 7. `FamilyRunner`

Add a generic runner that orchestrates:

- candidate loading
- enrichment
- planning
- optional execution
- aggregate result shaping

This runner is the reusable mechanism for:

- admin single replay
- admin bulk replay
- future cron / scheduled execution
- future opt-in post-commit family execution helpers

Two variants are enough:

- `runFamilySingle(...)`
- `runFamilyBulk(...)`

`runFamilyBulk(...)` should:

- capture a stable upper watermark before the first page
- page only candidates at or below that watermark
- page candidates internally
- stop at bounded limits
- support `dryRun`
- return aggregate counts

V1 operating mode:

- synchronous and bounded for small to moderate repair runs
- not intended as an unbounded historical reprocessing tool

### 8. `TriggerAdapter`s

Build thin adapters over the shared family runner.

V1 adapters:

- review-submit opt-in adapter
- admin single replay adapter
- admin bulk replay adapter

Future adapters:

- cron / scheduled window adapter
- other system-event adapters

Trigger adapters should:

- validate input
- translate input into source selection
- call the family runner
- record `triggerSource`

Trigger adapters should not:

- reimplement planning logic
- bypass the executor
- create different dedup identities for the same business occurrence

Replay adapters should also not:

- create a second direct-notification occurrence for the same reviewed outcome
- act as an implicit resend endpoint

## V1 Reviewed-Interaction Rules

### Supported interaction ids

- `funky:interaction:budget_document`
- `funky:interaction:public_debate_request`

### Direct family behavior

`budget_document`

- require entity scope
- require `reviewSource = campaign_admin_api`
- approved:
  - when invoked, send reviewed notification
  - suggest `public_debate_request` only when that interaction is not yet
    started for the same user/entity under the explicit "latest matching row"
    rule
- rejected:
  - when invoked, send reviewed notification
  - include retry link to budget-document step

`public_debate_request`

- require entity scope
- require `reviewSource = campaign_admin_api`
- rejected:
  - when invoked, send reviewed notification
  - include retry link to debate-request step
- approved:
  - do not use the direct reviewed-interaction family
  - continue using the dedicated correspondence-owned branch

### Started-state definition for debate-request suggestion

Use:

- latest matching `public_debate_request` row by `updatedAt`
- same `userId`
- same `entityCui`
- same `interactionId`

Interpretation:

- `idle` / `draft` -> suggestion allowed
- `pending` / `resolved` / `failed` -> suggestion suppressed

## API and Adapter Surface

### Existing single trigger route

Keep:

- `POST /api/v1/admin/campaigns/:campaignKey/notifications/triggers/:triggerId`

Add a new trigger adapter id:

- `admin_reviewed_user_interaction`

Payload shape:

- `userId`
- `recordKey`

Semantic note:

- this identifies the record whose latest reviewed occurrence should be repaired
- it does not identify an arbitrary historical reviewed occurrence

### New bulk route

Add:

- `POST /api/v1/admin/campaigns/:campaignKey/notifications/triggers/:triggerId/bulk`

This route is a trigger adapter over `runFamilyBulk(...)`, not a family-owned
business abstraction.

Request shape:

- `filters`
- `dryRun?: boolean`
- `limit?: number`

V1 reviewed-interaction filter shape:

- `reviewStatus?`
- `interactionId?`
- `interactionIds?`
- `entityCui?`
- `userId?`
- `recordKey?`
- `recordKeyPrefix?`
- `updatedAtFrom?`
- `updatedAtTo?`
- `submittedAtFrom?`
- `submittedAtTo?`
- `submissionPath?`
- `threadPhase?`
- `reviewSource?`

Implementation note:

- the family-specific admin filter contract may be narrower than the full
  learning-progress admin query surface
- do not expose filters that are meaningless for this family just because the
  source module happens to support them

### Bulk response counts

Return:

- `candidateCount`
- `plannedCount`
- `eligibleCount`
- `queuedCount`
- `reusedCount`
- `skippedCount`
- `delegatedCount`
- `ineligibleCount`
- `notReplayableCount`
- `staleCount`
- `enqueueFailedCount`

Keep single-record result shape separate from bulk result shape.

## Dry-Run Rules

`dryRun` must not mutate state.

That means:

- allowed:
  - load candidates
  - load read-only enrichment
  - run planner
  - run read-only executor checks for eligibility, duplicate, and replayability
  - compute aggregate counts
- not allowed:
  - create or update notification preferences
  - create outbox rows
  - enqueue compose jobs
  - perform any side effect outside read-only loading

This matters because some existing helper paths currently create preferences as
part of "setup" and cannot simply be reused under a generic dry-run promise.

## Delivery and Queue Processing Constraints

The DB outbox remains authoritative.

Queue/runtime rules for this family:

- queue jobs should reference durable outbox rows, not carry full notification
  payloads
- workers should re-read the outbox row before acting
- send-time logic should re-read current canonical review state and suppress
  stale occurrences
- transient failures should use bounded retry with backoff
- permanent failures should end in a durable terminal state with structured
  reason metadata

Recommended stage model:

- outbox row lifecycle remains authoritative
- queue jobs should be small and stable, e.g. "compose this outbox row" or
  "send this outbox row"
- any queue-level dedup is an optimization only; the DB outbox key remains the
  source of truth

## Deferred / Out Of Scope

These items are intentionally not solved in v1 because they would expand the
scope beyond the current feature and production-safe rollout.

### Immutable historical review occurrence ids

Deferred.

Why:

- v1 replay repairs the latest occurrence only
- the current review model does not support post-resolution review edits

Future options:

- add immutable `reviewEventId`
- add monotonic `reviewVersion`
- expose historical occurrence identity in admin APIs

### Same-transaction review write + outbox insertion

Deferred.

Why:

- the current review side-effect seam is already post-commit and deployed
- replacing it would be a larger cross-module behavior change

Future options:

- insert direct outbox rows in the same DB transaction as the canonical review
  write
- or persist a durable pending-side-effect record drained by a worker

### Persisted async bulk-run resource

Deferred.

Why:

- v1 bulk runs are intentionally bounded and synchronous
- adding `202 Accepted` bulk resources, progress tracking, and resumption is a
  separate operational feature

Future option:

- add `bulkRun` persistence with status resources for large backfills

### Dedicated stale delivery status

Deferred.

Why:

- v1 can record stale suppression through structured reason metadata without
  expanding the delivery-status taxonomy immediately

Future option:

- add a dedicated `skipped_stale` status if stale suppression becomes
  operationally important across multiple families

### Union-accurate preview field descriptors

Deferred.

Why:

- the reviewed-interaction delivery contract distinguishes approved and rejected
  payload shapes
- current preview field-descriptor generation is object-shaped and not good at
  describing discriminated unions cleanly

Current v1 behavior:

- delivery metadata stays stricter than template preview descriptors
- preview remains useful, but it does not fully express conditional
  `feedbackText` requirements for rejected outcomes

Future option:

- upgrade preview field extraction to understand discriminated unions and then
  align preview/documented required fields exactly with the delivery contract

### Explicit resend capability

Deferred.

Why:

- replay/repair and resend are operationally different actions
- combining them in one endpoint would create ambiguity for operators

Future option:

- add an audited resend feature that intentionally creates a new occurrence with
  a separate resend reason

## Registration Surface

Adding `funky:outbox:admin_reviewed_interaction` requires more than one file.

At minimum, wire:

- common campaign outbox constants
- notification-delivery outbox type union
- compose-outbox branch
- sender classification for campaign sender selection
- email template payload type
- email template schema
- email template registration
- email template component
- admin template preview catalog
- family registration
- audit projection registration
- REST response schema registration

If possible, consolidate these under one family registration object plus one
template registration object to reduce drift.

## Workstreams

### Workstream A: family core and runner

Suggested ownership:

- `src/modules/campaign-admin-notifications/core/*`

Changes:

- add family registration types
- add single and bulk family runners
- add single-result and bulk-result types
- add capability metadata for admin and future schedule adapters

Reasoning:

- this is the reusable substrate for future reminder and calendar families

### Workstream B: reviewed-interaction source, enrichment, and planner

Suggested ownership:

- `src/modules/campaign-admin-notifications/core/*`
- `src/modules/learning-progress/*`

Changes:

- add reviewed-interaction candidate source
- expose or support `reviewSource` filtering
- extract shared step-link builder
- add read-only enrichment
- add pure reviewed-interaction planner

Reasoning:

- keeps business classification separate from transport concerns

### Workstream C: review hook wiring

Suggested ownership:

- `src/modules/learning-progress/shell/rest/campaign-admin-routes.ts`
- `src/app/build-app.ts`
- `src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts`

Changes:

- rename approve-only wiring to generic review-side-effects wording
- keep existing approved-debate preparation branch untouched
- add `send_notification?: boolean` to the review POST contract with default
  `false`
- add new after-commit reviewed-interaction branch gated by
  `send_notification = true`

Reasoning:

- preserves deployed semantics while adding the new family

### Workstream D: eligibility and executor

Suggested ownership:

- `src/modules/notification-delivery/*`
- `src/modules/notifications/*`

Changes:

- add targeted eligibility API
- add reviewed-interaction executor
- document/narrow replayable states
- add new outbox type and direct enqueue helper

Reasoning:

- the targeted reviewed-interaction case needs a different eligibility shape
  than existing fan-out flows

### Workstream E: templates, compose, and audit

Suggested ownership:

- `src/modules/email-templates/*`
- `src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts`
- `src/modules/campaign-admin-notifications/shell/repo/outbox-audit-repo.ts`

Changes:

- add reviewed-interaction template payload, schema, registration, component
- add compose branch using a shared metadata parser
- register audit projection for the new outbox type
- include new template in preview catalog

Reasoning:

- keeps template logic presentation-only and audit projection safe

### Workstream F: admin adapters

Suggested ownership:

- `src/modules/campaign-admin-notifications/shell/rest/*`
- `src/modules/campaign-admin-notifications/shell/registry/*`

Changes:

- add single-record adapter trigger
- add bulk adapter route
- add trigger capability descriptors
- keep current triggers compatible while allowing new family-backed execution

Reasoning:

- admin is one adapter over the family runner, not the definition of the family

## Test Strategy

### Unit tests

Family runner:

- single execution
- bulk execution
- dry-run with no writes
- aggregate counting with mixed outcomes
- watermark-bounded bulk paging

Reviewed-interaction source and enrichment:

- loads candidate by `{ userId, recordKey }`
- filters by `reviewSource`
- resolves entity and step-link context
- latest-row "started" detection for debate request

Planner:

- supported interaction detection
- approved `budget_document` with debate-request next step
- approved `budget_document` without next step when debate request already
  started
- rejected `budget_document`
- rejected `public_debate_request`
- approved `public_debate_request` classified out of direct family execution

Executor:

- create new reviewed-interaction outbox
- targeted eligibility pass/fail
- reuse pending or failed-transient row
- skip unsupported terminal duplicate in v1
- dry-run read-only outcomes for duplicate and replayability states

### Integration tests

Review POST:

- rejected `budget_document` with `send_notification = false` does not produce
  reviewed-interaction outbox
- rejected `budget_document` with `send_notification = true` produces
  reviewed-interaction outbox
- approved `budget_document` with `send_notification = false` does not produce
  reviewed-interaction outbox
- approved `budget_document` with `send_notification = true` produces
  reviewed-interaction outbox
- rejected `public_debate_request` with `send_notification = false` does not
  produce reviewed-interaction outbox
- rejected `public_debate_request` with `send_notification = true` produces
  reviewed-interaction outbox
- approved `public_debate_request` keeps existing thread lifecycle behavior and
  does not create direct reviewed-interaction outbox

Admin adapters:

- single replay by `{ userId, recordKey }`
- bulk replay by filters
- dry-run returns counts and does not write
- `reviewSource` filter excludes worker-reviewed rows
- single replay repairs latest occurrence only

Audit and preview:

- new template listed in preview catalog
- new outbox kind visible through campaign-admin audit projection
- safe projection uses the shared metadata parser

Delivery behavior:

- stale reviewed-interaction outbox row is suppressed before send when a newer
  review occurrence supersedes it

### Regression tests

- existing public-debate approved-review path remains unchanged
- existing campaign-admin notification triggers still work
- existing outbox sender selection still routes funky campaign outbox types

## Key Trade-offs

### Family runner vs admin-trigger-centric design

Chosen:

- family runner with admin as an adapter

Why:

- supports future cron and scheduled families without redesign
- keeps business logic owned by the family instead of the route

Accepted downside:

- more named concepts in the architecture

### Pure planner plus shell enrichment vs route-owned assembly

Chosen:

- source + enrichment + pure planner + assembler + executor

Why:

- keeps business rules testable
- avoids pushing too much object wiring back into route code

Accepted downside:

- more explicit seams and DTOs

### Outbox-only dedup vs second dedup store

Chosen:

- outbox-only dedup

Why:

- one durable DB authority
- already matches the delivery layer

Accepted downside:

- replay decisions still inspect outbox state

### Narrow replay promise vs admin reset path in v1

Chosen:

- narrow replay promise to safely supported states

Why:

- matches current outbox state machine
- avoids inventing unsafe recovery semantics for production

Accepted downside:

- some historical failed terminal rows remain non-replayable until a dedicated
  reset feature exists

### Latest-occurrence repair vs immutable historical review ids

Chosen:

- latest-occurrence repair in v1

Why:

- matches the current review model without expanding storage or APIs
- avoids adding historical resend semantics prematurely

Accepted downside:

- v1 cannot target an arbitrary historical review occurrence by id

## References

- Review route and side-effect seam:
  [src/modules/learning-progress/shell/rest/campaign-admin-routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts)
- Learning-progress selector input:
  [src/modules/learning-progress/core/types.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/types.ts:333)
- Current learning-progress admin filter schema:
  [src/modules/learning-progress/shell/rest/campaign-admin-schemas.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-schemas.ts:40)
- Existing approved public debate review side effect planner:
  [src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts:390)
- Existing direct outbox compose branches:
  [src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts:731)
- Existing campaign-admin notification admin spec:
  [docs/specs/specs-202604120912-funky-campaign-notification-admin.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604120912-funky-campaign-notification-admin.md)
