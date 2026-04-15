# Template-First Campaign Admin Notification Runs

**Status**: Draft
**Date**: 2026-04-14
**Author**: Codex

## Problem

The current campaign-admin bulk notification flow is trigger-first, fixed to one
template per trigger, and shaped around trigger-specific filter payloads.

Today:

- campaign admins can preview templates and execute manual notification triggers
- the only current bulk flow is `admin_reviewed_user_interaction`
- bulk execution accepts a flat filter object and returns aggregate counts only
- template selection is implicit in the trigger definition instead of explicit
  in the admin workflow

That creates four gaps:

- admins cannot choose a notification template first and then preview the exact
  notification occurrences that would be sent
- the system incorrectly treats "no filters" as invalid even when omitting
  selector fields should expand to the full candidate universe for that
  template
- dry run does not return the row-level send plan needed to understand which
  users and entities are affected and why some rows will be skipped
- the current trigger contract couples payload construction, candidate
  selection, and template choice too tightly for future notification families

This matters because the next notification admin surface should be simple,
secure, and predictable:

- template is the first-class admin choice
- selectors and filters only narrow or expand candidate discovery
- dry run creates the authoritative review snapshot before sending
- single-occurrence notifications remain deduplicated by stable delivery keys

## Context

- Campaign-admin notifications are implemented under
  [`src/modules/campaign-admin-notifications/`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications).
- The current admin route family is specified in
  [`docs/specs/specs-202604120912-funky-campaign-notification-admin.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604120912-funky-campaign-notification-admin.md).
- The current reviewed-interaction bulk trigger:
  - exposes flat bulk filters in
    [`src/modules/campaign-admin-notifications/shell/registry/admin-reviewed-interaction-trigger.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/registry/admin-reviewed-interaction-trigger.ts)
  - uses the learning-progress repo to enumerate candidates
  - returns counts only from the family bulk runner
- The email template registry already provides template identity, previewability,
  payload schema, and example props through
  [`src/modules/email-templates/`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/email-templates).
- Template payload requirements differ by template:
  - `public_debate_campaign_welcome` needs `campaignKey`, `entityCui`,
    `entityName`, `acceptedTermsAt`
  - `public_debate_entity_update` needs thread-specific fields such as
    `threadId`, `threadKey`, `phase`, `institutionEmail`, and `subjectLine`
  - `admin_reviewed_user_interaction` needs interaction-specific fields such as
    `interactionId`, `interactionLabel`, `reviewStatus`, and `reviewedAt`
- The delivery layer already uses durable outbox rows with `scopeKey` and
  `deliveryKey` for deduplication and replay safety.
- Existing single-occurrence families already have stable delivery-key rules,
  such as reviewed interaction keys in
  [`src/modules/notification-delivery/core/usecases/admin-reviewed-interaction-keys.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/admin-reviewed-interaction-keys.ts).
- The notification delivery module also contains a collection-style digest
  implementation, but collection notifications are intentionally out of scope
  for the first version of this feature.

## Decision

Introduce a template-first campaign-admin run model for **single-occurrence
notifications only**.

Admins choose a runnable template, optionally provide selector values and flat
filters, run a dry run that returns row-level results, and only then execute
send using the stored dry-run plan id.

### Scope

In scope:

- template-first dry runs and sends for single-occurrence notifications
- row-level dry-run preview
- zero-filter execution when omitted selectors expand the template's candidate
  universe
- server-side stored dry-run plans with opaque plan ids
- reusable runnable-template definitions
- stable delivery-key based deduplication for single-item notifications

Out of scope for the first version:

- collection notifications where one email contains an array of items
- nested `AND` / `OR` rule trees
- arbitrary user-defined joins or ad hoc filter fields
- exposing raw email addresses, outbox metadata, or rendered content in dry run

Collection notifications remain a documented future extension. They are not
implemented in this spec.

### Core Model

#### Runnable Template Definition

Add a new server-side definition model under
`campaign-admin-notifications`:

- `runnableId`
- `templateId`
- `campaignKey`
- `targetKind`
- selector schema
- filter schema
- preview-row schema
- stable row ordering
- max plan row count
- default sort and page size
- dry-run row mapper
- dry-run candidate enumerator
- send executor

A runnable template definition is the server-side object that answers:

- how to enumerate candidate occurrences for this template
- which selector fields may expand or narrow the candidate universe
- which filter fields are supported
- which safe preview fields may be exposed
- how to evaluate the row status during dry run
- how to send the row if it is eligible

The runnable template definition is the internal replacement for "source" in
the admin mental model. The admin chooses a template; the definition knows how
to find and evaluate occurrences for that template.

Each runnable template definition must be read-only during dry run. Templates
whose current payload preparation mutates state remain preview-only until that
logic is split behind a read-only evaluator.

#### Selectors

Selectors are optional top-level fields that pin a portion of the candidate
universe for a runnable template.

Examples:

- `userId`
- `entityCui`
- `recordKey`

Omitting a selector does **not** make the request invalid. It expands the
candidate universe along that dimension.

Examples:

- if a runnable template can evaluate `userId + entityCui` pairs and neither is
  provided, dry run enumerates all valid pairs in that template's candidate
  universe at the chosen watermark
- if only `userId` is provided, dry run enumerates all valid occurrences for
  that user
- if only `entityCui` is provided, dry run enumerates all valid occurrences for
  that entity

The server must define what "valid candidate universe" means for each runnable
template. It must never infer an unbounded Cartesian product from unrelated
tables.

Each runnable template definition must also declare a hard
`maxPlanRowCount`. Dry run fails closed when the expanded candidate universe
would exceed that bound.

#### Filters

Filters are optional narrowing predicates. They are always template-specific and
allowlisted.

Initial version rules:

- filters are flat and combined as `AND`
- no nested groups
- no arbitrary JSON fields
- each field must have an explicit resolver owned by the runnable template

Examples for a reviewed-interaction runnable template:

- `reviewStatus`
- `interactionId`
- `updatedAtFrom`
- `updatedAtTo`

A field may be a selector or a filter for a runnable template, never both.

### Dry Run First

Add a mandatory dry-run-first workflow:

1. admin selects a runnable template
2. admin submits selectors and optional filters
3. server computes the **full** dry-run plan under a server-generated watermark
4. server persists that plan server-side with an opaque random `planId`
5. server returns summary counts plus the first page of rows
6. admin pages through rows by reading the stored plan
7. admin sends using that stored plan id

Send without a prior dry run is not supported by this new flow.

The admin UI must state clearly that send applies to **all** `will_send` rows
in the stored plan, not just the current visible page.

### Dry-Run Evaluation Semantics

Each dry-run row represents one candidate notification occurrence.

Each row is evaluated into one status:

- `will_send`
- `already_sent`
- `already_pending`
- `ineligible`
- `missing_data`

The dry-run response must include:

- runnable id
- template id
- watermark
- opaque plan id
- summary counts by status
- paginated rows

Each row must include safe fields only:

- stable row key
- `userId`
- `entityCui` when available
- `entityName` when available
- template-specific summary fields
- row status
- reason code
- whether a delivery already exists
- optional existing delivery status
- optional send mode hint such as `create` or `reuse_claimable`

Dry run must not expose:

- recipient email address
- raw outbox metadata
- raw provider ids or provider errors
- rendered subject/html/text
- unsubscribe tokens or URLs
- unbounded or unsanitized free text

Each runnable template definition must declare a separate `previewRowSchema`
with safe primitive fields only. Preview rows are default-deny with respect to
render payload fields and raw metadata.

Rows that are already sent or already pending must remain visible in dry run so
the admin can understand why they will not be sent again.

### Stored Plan

Dry run stores a server-side plan record and plan rows in the user database.

The stored plan uses a SQL table instead of the queue deliberately.

Reasoning:

- a dry-run plan is a user-reviewed snapshot, not background work
- the admin must be able to read it back, page through rows, and then send it
  later
- the plan must be bound to actor, campaign, expiry, and single-use semantics
- the queue remains the correct primitive for async compose/send work after the
  plan is approved, but it is not a suitable read model for paginated preview
  and operator-controlled replay boundaries
- if the product later changes to immediate fire-and-forget bulk execution
  without stored preview/send separation, this table can be revisited, but it
  is the correct primitive for the current dry-run-first workflow

Each stored plan binds:

- `planId`
- `actorUserId`
- `campaignKey`
- `runnableId`
- `templateId`
- template-definition version
- selector/filter payload hash
- watermark
- summary counts
- ordered row snapshot
- created at / expires at
- consumed at

The `planId` must be an opaque random identifier. It must not encode selectors,
filters, or other sensitive payload details.

Stored plans must be:

- short-lived
- bound to the actor that created them
- single-use for send
- re-authorized on send
- rejected if expired, consumed, or mismatched to campaign/template/runnable id

### Send Semantics

`send` processes the full stored plan defined by `planId`.

For each stored row whose dry-run status is `will_send`:

- execute the template's existing single-occurrence enqueue path
- re-check authorization before execution
- re-check live eligibility and dedupe through the existing enqueue path

Dry-run status is advisory for preview, not authoritative for execution. Send
may queue fewer rows than dry run predicted because concurrent work can turn a
row into `already_sent`, `already_pending`, or `ineligible` before execution.

Rows whose stored dry-run status is not `will_send` are skipped and counted.

The send response must return aggregate counts at minimum:

- total rows evaluated
- queued count
- already sent count
- already pending count
- ineligible count
- missing data count
- enqueue failed count

Only one send may consume a stored plan. Repeated send attempts with the same
`planId` fail closed.

### Single-Occurrence Dedupe

The first version continues to use existing single-occurrence delivery-key
semantics.

For runnable templates backed by already-live families:

- existing `deliveryKey` builders remain authoritative
- existing `scopeKey` semantics remain unchanged
- dry run must reuse the same family-level evaluation path as send wherever
  possible instead of inferring row status from a `deliveryKey` lookup alone

For reviewed interaction notifications specifically, dry run must model the
current enqueue semantics:

- eligibility is checked against current subscriptions
- terminal outbox states map to `already_sent` or `already_pending`
- claimable `failed_transient` rows appear as `will_send` with
  `sendMode = reuse_claimable`

This keeps the design simple and avoids introducing new batch item-claim state
for the first version.

### First Runnable Template

The first runnable template in scope is:

- `admin_reviewed_user_interaction`

Reason:

- it already has a canonical candidate universe in learning-progress
- it already has stable single-occurrence delivery keys
- it already supports dry-run-like counting through the current bulk runner
- it is the current bulk-notification pain point

Initial implementation for this template:

- selectors:
  - `userId?`
  - `entityCui?`
  - `recordKey?`
- filters:
  - `reviewStatus?`
  - `interactionId?`
  - `updatedAtFrom?`
  - `updatedAtTo?`
  - `submittedAtFrom?`
  - `submittedAtTo?`
- dry-run row summary:
  - `interactionId`
  - `interactionLabel`
  - `reviewStatus`
  - `reviewedAt`

Excluded from the initial runnable candidate universe:

- approved public debate request rows that currently delegate into the existing
  correspondence flow instead of sending `admin_reviewed_user_interaction`
  directly

This initial implementation is allowed to reuse the existing reviewed
interaction source and enqueue helpers internally.

### Template Catalog Semantics

Keep template preview and runnable execution separate.

Template catalog states:

- preview-only
- runnable

Not every previewable template is runnable in the first version.

Expose runnable execution through a separate registry and route contract. Do not
overload the existing preview-template response schema.

The runnable-template catalog must expose enough metadata for the admin UI to
understand:

- runnable id
- template id
- whether the template is runnable
- what selectors are available
- what filters are available
- whether dry run is required before send
- max plan row count

### Route Contract

Add new additive campaign-admin routes:

- `GET /api/v1/admin/campaigns/:campaignKey/notifications/templates`
  - existing preview metadata remains unchanged
- `GET /api/v1/admin/campaigns/:campaignKey/notifications/runnable-templates`
- `POST /api/v1/admin/campaigns/:campaignKey/notifications/runnable-templates/:runnableId/dry-run`
- `GET /api/v1/admin/campaigns/:campaignKey/notifications/plans/:planId`
- `POST /api/v1/admin/campaigns/:campaignKey/notifications/plans/:planId/send`

`dry-run` request shape:

- `selectors`
- `filters`

`dry-run` response shape:

- `planId`
- `runnableId`
- `templateId`
- `watermark`
- `summary`
- `rows`
- `page`

`plan read` request shape:

- `cursor?`
- `limit?`

`send` request shape:

- empty body or optional confirmation fields only

The existing trigger routes remain additive and unchanged in behavior during the
first rollout.

### Failure-Closed Rules

- unknown runnable id: `404`
- preview-only template passed to runnable execution routes: not applicable;
  runnable routes are registry-backed only
- unknown selector or filter field: `400`
- invalid, mismatched, expired, or consumed plan id: `400`
- unsupported campaign or missing permission: existing campaign-admin auth
  behavior applies
- if the runnable template definition cannot guarantee a safe candidate universe,
  startup or request handling must fail closed instead of broadening the query
- if dry run would exceed `maxPlanRowCount`, fail closed instead of truncating
  silently
- page cursors for stored plans are opaque, plan-scoped, and server-validated
- server-enforced maximum page size applies to all plan reads

### Collection Notifications Future Path

Collection notifications are intentionally deferred.

When implemented later, they should not reuse this single-occurrence dedupe
model directly. They will need:

- explicit item occurrence identity
- grouped batch identity
- durable membership or item claims
- batch-level delivery keys separate from item-level dedupe

The existing digest implementation in `notification-delivery` is the reference
point for that future work, not part of this first implementation.

## Alternatives Considered

### Keep the Existing Trigger-First Bulk Endpoint

Rejected because:

- template remains implicit instead of explicit
- zero-filter execution still feels invalid even when expansion is correct
- dry run still returns counts only
- the design remains trigger-specific and harder to extend

### Implement Full Nested `AND` / `OR` Rules Now

Rejected for the first version because:

- it adds complexity before the template-first model is stable
- it increases the security surface for query and evaluation logic
- the current bulk problem can be solved with template-first dry run plus flat
  allowlisted filters

Nested rule groups remain future work.

### Implement Collection Notifications in the Same Change

Rejected because:

- collection notifications need item-level dedupe and batch membership rules
- the first version can stay simpler and safer by reusing existing
  single-occurrence delivery-key semantics
- the user explicitly prioritized simplicity and security

### Use Only the Queue and Skip Stored Plans

Rejected because:

- the queue is an execution primitive, not a durable admin preview/read model
- queue-only design makes it harder to support paginated review of the exact
  plan that will be sent
- actor-bound, single-use, expiring send approval is simpler and more auditable
  with a stored plan record than with queue payloads
- the current workflow explicitly separates dry run from send, which needs
  durable state between those two actions

## Consequences

**Positive**

- admins can start from the template they want to send
- omitting selectors is a valid way to expand the candidate universe
- dry run becomes an auditable, row-level preview instead of a count-only check
- the first version remains simple by reusing existing single-occurrence outbox
  semantics
- the model is extensible to more runnable templates without exposing internal
  source concepts in the UI

**Negative**

- the first version does not implement nested rule trees
- not every previewable template will be runnable immediately
- collection notifications remain deferred and need separate design later
- send requires a prior dry run, which adds one extra step to admin workflows

## References

- [`docs/specs/specs-202604120912-funky-campaign-notification-admin.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604120912-funky-campaign-notification-admin.md)
- [`docs/specs/specs-202604131605-admin-reviewed-interaction-notifications.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604131605-admin-reviewed-interaction-notifications.md)
- [`src/modules/campaign-admin-notifications/shell/registry/admin-reviewed-interaction-trigger.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/registry/admin-reviewed-interaction-trigger.ts)
- [`src/modules/campaign-admin-notifications/shell/rest/routes.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/rest/routes.ts)
- [`src/modules/email-templates/core/schemas.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/email-templates/core/schemas.ts)
- [`src/modules/notification-delivery/core/usecases/admin-reviewed-interaction-keys.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/admin-reviewed-interaction-keys.ts)
- [`src/modules/notification-delivery/core/usecases/materialize-anaf-forexebug-digests.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/materialize-anaf-forexebug-digests.ts)
