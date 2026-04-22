# Budget Phase Notifications From Campaign Entity Config

**Status**: Draft
**Date**: 2026-04-21
**Author**: Codex

## Problem

The budget campaign now has an admin-managed entity config store, but the budget
phase rules still live primarily in the client and are not yet usable as a
canonical notification source.

Today:

- the client computes the budget calendar locally from a static phase registry,
  a static per-UAT override file, and a user-submitted budget publication date
  fallback
- the server-side campaign entity config currently stores `budgetPublicationDate`
  and `officialBudgetUrl`, but it has no public read model for the client and no
  derived "budget phase" projection
- the notification system has thread-driven and review-driven families, but no
  family for budget calendar phases
- the manual notification planner can load runnable templates, but its stored
  preview rows are still shaped around reviewed interactions rather than generic
  entity-phase occurrences

That creates five gaps:

- the client and server can drift on budget phase rules because they do not
  share one canonical phase projection
- admins cannot trigger a budget-phase notification from the entity config data
- the system does not have a stable idempotency rule for "same user, same
  entity, same budget phase"
- the email layer has no dedicated template that can explain different budget
  phases without pretending every phase is a confirmed real-world event
- the planner UX would force budget-phase notifications into interaction-shaped
  preview rows unless it is broadened

## Context

- Client phase rules live in:
  - [timeline.json](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/content/campaigns/buget/timeline.json)
  - [use-campaign-timeline.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/hooks/use-campaign-timeline.ts)
  - [buget-calendar-page.tsx](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/components/calendar/buget-calendar-page.tsx)
  - [BudgetTimelineStrip.tsx](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/challenges/components/hub/BudgetTimelineStrip.tsx)
- The client currently merges phase inputs in this order:
  - static per-UAT override from `uat-calendar-overrides.json`
  - user custom interaction `funky:interaction:budget_publication_date`
  - default legal offsets from the global anchor date
- Server-side entity config is implemented in:
  - [config-record.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config/core/config-record.ts)
  - [types.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config/core/types.ts)
  - [routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config/shell/rest/routes.ts)
- The current persisted config values are only:
  - `budgetPublicationDate`
  - `officialBudgetUrl`
- The existing entity-scoped notification preference is
  `funky:notification:entity_updates`, already used for public-debate update
  emails and already filtered through global unsubscribe and campaign-disable
  rules in
  [extended-notifications-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts).
- Existing notification idempotency patterns are already stable and explicit:
  - `public_debate_entity_update` uses user/notification identity plus a
    thread-event scope key in
    [public-debate-entity-update-keys.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/public-debate-entity-update-keys.ts)
  - `admin_reviewed_interaction` uses a logical reviewed occurrence key in
    [admin-reviewed-interaction-keys.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/admin-reviewed-interaction-keys.ts)
- The campaign-admin runnable planner already supports:
  - runnable template catalogs
  - dry-run-first stored plans
  - plan paging and final send
- The current stored plan schema is not yet generic. It is persisted in
  [runnable-plan-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/repo/runnable-plan-repo.ts)
  and previewed in
  [CampaignAdminNotificationPlanTable.tsx](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/components/CampaignAdminNotificationPlanTable.tsx).
- The current field-descriptor contract only exposes `name`, `type`, and
  `required`, which is too weak for enum selectors like `phaseId`.

## Decision

Implement budget phase notifications as a new config-driven notification family
backed by one server-owned budget phase projection derived from campaign entity
config.

Phase 1 remains manual and planner-driven:

- saving entity config does not send mail
- admins preview candidates through the runnable planner
- send-time deduplication is controlled only by stable delivery keys

### 1. Server Owns The Budget Phase Projection

Add a server-side projection that derives the effective budget phase timeline
for one entity from:

- the campaign anchor date and phase rules
- the entity config values
- future optional explicit phase fields when they are added later

The phase ids must stay aligned with the current client ids:

- `publicare-proiect-buget-local`
- `inchidere-contestatii`
- `depunere-spre-aprobare`
- `vot-aprobare-buget-local`

`publicare-buget-de-stat` remains the global anchor milestone, but it is not a
per-entity notification candidate in v1.

The projection returns, for each phase:

- `phaseId`
- `effectiveAt`
- `timingMode`
- `isClosed`
- `isActionable`

`timingMode` is explicit:

- `confirmed`
  - the phase date is directly known from entity-config-backed data
- `estimated_from_publication`
  - the phase date is derived from a confirmed publication date and legal
    offsets
- `estimated_from_anchor`
  - the phase date is derived only from the global campaign anchor date

This distinction is mandatory because the client timeline is partly a legal
calendar, not a guaranteed record of real-world completion. The notification
system must not phrase a legal deadline as if it were a confirmed event.

### 2. Public Client Reads The Server Projection

Add a public read-only boundary for the client, separate from the admin
entity-config routes.

Recommended shape:

- `GET /api/v1/campaigns/:campaignKey/entities/:entityCui/budget-phase`

The public response should expose only safe fields:

- `entityCui`
- `entityName`
- `officialBudgetUrl`
- `budgetPublicationDate`
- projected phase array
- `currentPhaseId`

The client should move to this precedence order:

1. server phase projection
2. current local fallback logic when the server projection is unavailable during
   rollout

The existing local files stay valuable during rollout:

- `timeline.json` remains client-owned display copy
- `uat-calendar-overrides.json` remains a temporary fallback
- the user-submitted publication-date interaction remains a crowdsourcing input,
  not the long-term canonical public read source

### 3. Add A Dedicated Budget Phase Notification Family

Introduce a new family:

- family id: `budget_phase_update`
- template id: `budget_phase_update`
- runnable id: `budget_phase_update`
- outbox type: `funky:outbox:budget_phase_update`

Phase 1 does **not** require a separate single trigger. The runnable planner is
the authoritative manual entry point because it already supports dry run,
pagination, and send.

The family reuses the existing entity-scoped campaign preference:

- subscription type: `funky:notification:entity_updates`

This keeps entity following as a single opt-in concept for campaign entity
updates. If product later needs a separate budget-phase opt-out, that can be
introduced as a new preference family without changing the notification family
or delivery-key model.

### 4. One Template, Phase-Specific Copy

Add one email template that can render multiple budget phases without changing
template identity.

Required template props:

- `campaignKey`
- `cycleKey`
- `entityCui`
- `entityName`
- `phaseId`
- `phaseTitle`
- `effectiveAt`
- `timingMode`
- `officialBudgetUrl`
- `ctaUrl`

The template must branch on both `phaseId` and `timingMode`.

Examples:

- `publicare-proiect-buget-local` + `confirmed`
  - "The draft budget was published"
- `inchidere-contestatii` + `estimated_from_publication`
  - "The contestation deadline calculated from the published draft date is..."
- `vot-aprobare-buget-local` + `estimated_from_publication`
  - "The legal deadline for council vote/adoption is..."

The template must always offer at least one stable CTA to the client campaign
surface for that entity. `officialBudgetUrl` is optional secondary context, not
the only path.

### 5. Phase-Based Idempotency

The logical occurrence key for this family is:

- one campaign cycle
- one entity
- one phase

Recommended scope key:

- `budget_phase:<campaignKey>:<cycleKey>:<entityCui>:<phaseId>`

Recommended full delivery key:

- `generateDeliveryKey(userId, notificationId, scopeKey)`

This intentionally does **not** include:

- entity-config `updatedAt`
- payload hash
- exact effective date

Reason:

- the requirement is to prevent sending the same phase to the same user again
- minor config edits must not silently re-open a logically already-sent phase

If a future product decision requires a true resend of corrected content for the
same phase, that must be an explicit new revision mechanism. It must not happen
implicitly through config drift.

### 6. Candidate Eligibility Rules

For v1 planner candidates:

- the user must have an active `funky:notification:entity_updates`
  subscription for the entity
- the user must not be globally unsubscribed
- the campaign master preference must remain enabled
- the entity must project the requested phase
- `timingMode = estimated_from_anchor` is **not** eligible in v1

This means:

- a phase can be mailed when it is confirmed, or when it is derived from a
  confirmed publication date
- a phase derived only from the global campaign anchor is visible to the
  client timeline but is not yet a notification candidate

### 7. Runnable Planner Integration

Add a new runnable definition under `campaign-admin-notifications`.

Selectors:

- required: `phaseId`
- optional: `entityCui`
- optional: `userId`

Filters:

- `effectiveAtFrom`
- `effectiveAtTo`
- `timingMode`

Stable row ordering:

- `effectiveAt ASC`
- `entityCui ASC`
- `userId ASC`

Dry-run rows represent one user-entity-phase occurrence.

Send-time execution must:

1. reload the current entity config / budget phase projection
2. confirm the stored occurrence is still eligible for the same `phaseId`
3. compute the stable delivery key from `cycleKey + entityCui + phaseId`
4. create or reuse the outbox row

If the phase is no longer eligible, the stored row becomes `ineligible` at send
time. If the phase date changed but the logical phase did not, the same delivery
key still applies and the current projection data is used.

### 8. Broaden The Planner Preview Model

Do not force this new family into the existing
`interactionLabel/reviewStatus/reviewedAt` preview row contract.

Replace the stored-plan preview row with:

- common fields:
  - `rowKey`
  - `rowKind`
  - `userId`
  - `entityCui`
  - `entityName`
  - `status`
  - `reasonCode`
  - `statusMessage`
  - `hasExistingDelivery`
  - `existingDeliveryStatus`
  - `sendMode`
- row-kind-specific payload:
  - `reviewed_interaction`
  - `budget_phase`
  - `weekly_digest`

For `budget_phase`, the preview payload should include:

- `phaseId`
- `phaseTitle`
- `effectiveAt`
- `timingMode`
- `recordKey`

This refactor is justified now because the current preview model is already a
poor fit for `weekly_progress_digest`; budget-phase notifications would make the
mismatch explicit.

### 9. Add Structured Enum Field Descriptors

Extend the field descriptor contract so planner inputs can expose safe enum
choices.

Add optional descriptor metadata such as:

- `inputKind`
- `options`
  - `value`
  - `label`

Use this for:

- `phaseId`
- `timingMode`

The client run tab can already handle generic text and date fields, but phase
selection should not depend on admins typing raw ids manually.

### 10. Audit And Preview Registration

Add the new template to:

- the email template registry
- the template preview catalog
- the campaign-admin notifications audit projection

Add a new audit projection kind:

- `budget_phase_update`

It should expose:

- `entityCui`
- `entityName`
- `phase`
- `effectiveAt`
- `timingMode`
- `triggerSource`

## Alternatives Considered

- Reuse `public_debate_entity_update`.
  Rejected because that family is keyed to thread lifecycle events and its
  template contract requires thread metadata such as `threadId`, `threadKey`,
  and reply details.

- Build delivery keys from `entityCui + phaseId + configUpdatedAt` or from a
  payload hash.
  Rejected because it would resend the same logical phase after harmless config
  edits, which violates the explicit idempotency requirement.

- Keep the current planner preview row schema and map budget phases into
  `interactionLabel` and `reviewedAt`.
  Rejected because it would further entrench an interaction-specific model that
  already fits non-interaction runnables poorly.

- Make budget-phase notifications automatic as soon as entity config changes.
  Rejected for now because the current admin workflow already prefers dry-run
  review before sending, and this work is specifically intended to integrate
  with the manual planner first.

- Send notifications for phases derived only from the global anchor date.
  Rejected for v1 because that would email users based on legal estimates that
  are not anchored to entity-specific evidence.

## Consequences

**Positive**

- The client and notification system can converge on one canonical phase model.
- Budget-phase notifications gain stable per-user, per-entity, per-phase
  idempotency.
- One template can cover multiple phases while still distinguishing confirmed
  events from calculated deadlines.
- The manual planner gains a clean path for entity-phase campaigns instead of
  remaining review-only in practice.

**Negative**

- This requires a new public server read boundary for client phase data.
- The planner preview schema and field-descriptor contract need a small
  generalization before the UX is clean.
- Once a phase is sent, updating config inside that same phase will not resend
  automatically; that is an intentional trade-off.
- During rollout, the client may temporarily keep fallback logic, so some phase
  rules will still exist in two places until the public projection is adopted.

## References

- [Client budget timeline definition](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/content/campaigns/buget/timeline.json)
- [Client phase computation hook](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/hooks/use-campaign-timeline.ts)
- [Client calendar page](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/components/calendar/buget-calendar-page.tsx)
- [Client timeline strip](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/challenges/components/hub/BudgetTimelineStrip.tsx)
- [Campaign entity config registry spec](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604181116-campaign-entity-config-userinteractions-registry.md)
- [Template-first campaign admin runs spec](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604141955-template-first-campaign-admin-notification-runs.md)
- [Current entity config storage](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config/core/config-record.ts)
- [Current entity update delivery keys](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/public-debate-entity-update-keys.ts)
- [Current stored planner row schema](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/repo/runnable-plan-repo.ts)
- [Current planner preview table](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/components/CampaignAdminNotificationPlanTable.tsx)
