# Public Debate Entity Config Notification Integration

**Status**: Draft
**Date**: 2026-04-21
**Author**: Codex

## Problem

The admin-managed entity config payload needs to store structured public debate
information for an entity and make that information usable by the admin
notification system.

Today:

- `campaign-entity-config` only supports `budgetPublicationDate` and
  `officialBudgetUrl`
- the config payload is strict and versioned, so additive shape changes can
  break reads if they are not handled explicitly
- the main campaign-admin entity projection does not surface config-only
  entities
- existing public-debate notification families are built around thread
  lifecycle events, not around entity config
- there is no current admin notification family or runnable plan that targets
  users based on the presence of public debate data inside entity config

That creates four gaps:

- admins cannot store the public debate announcement details in the canonical
  config store
- the admin API cannot validate or persist the new payload safely
- the system cannot reliably identify entities that have public debate data
  populated
- the campaign-admin notification workflow cannot preview or send a dedicated
  public debate announcement email to eligible subscribers for those entities

## Context

- Campaign entity config is implemented in
  [`src/modules/campaign-entity-config/`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config)
  and is currently scoped to the `funky` campaign.
- Config rows are stored as internal JSON records inside `userinteractions`,
  not in a dedicated table. The stored payload is strict and versioned in
  [`config-record.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config/core/config-record.ts).
- The admin write contract is a full replacement `PUT` with optimistic
  concurrency via `expectedUpdatedAt`, implemented in
  [`upsert-campaign-entity-config.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config/core/usecases/upsert-campaign-entity-config.ts).
- The entity-config collection route is the current discovery surface for
  configured-but-inactive entities. The main `/entities` projection does not
  include config-only entities. Relevant code:
  [`learning-progress-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/repo/learning-progress-repo.ts:347)
  and
  [`campaign-admin-entities-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-entities/shell/repo/campaign-admin-entities-repo.ts:364).
- Public-debate notification preferences already exist as:
  - campaign master preference: `funky:notification:global`
  - entity-scoped subscriber preference: `funky:notification:entity_updates`
- Eligibility for entity-scoped public-debate mail is already defined as:
  active entity subscription for that entity, excluding global unsubscribe and
  disabled campaign preference. Relevant code:
  [`extended-notifications-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts:284).
- Campaign-admin notifications already support:
  - previewable templates
  - single manual triggers
  - dry-run-first runnable templates with stored plans
- The runnable-plan model is already the preferred admin workflow for
  repeatable or bulk sends. Relevant code:
  [`create-campaign-notification-runnable-plan.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/core/usecases/create-campaign-notification-runnable-plan.ts)
  and
  [`send-campaign-notification-runnable-plan.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/core/usecases/send-campaign-notification-runnable-plan.ts).
- The existing `public_debate_entity_update` email family is thread-specific and
  requires thread metadata. It is not a fit for config-driven public debate
  announcement data.

## Decision

Extend the campaign entity config contract with a new `public_debate` field and
integrate it with campaign-admin notifications through a new config-driven
notification family and runnable plan.

Phase 1 uses the admin dry-run and send workflow as the authoritative delivery
path. Saving config does not send emails automatically.

### Config Payload Contract

Add a new field under `values`:

```json
{
  "public_debate": {
    "date": "2026-05-10",
    "time": "18:00",
    "location": "Council Hall, Example City Hall",
    "online_participation_link": "https://example.ro/dezbatere",
    "announcement_link": "https://example.ro/anunt",
    "description": "Public debate regarding the local budget proposal."
  }
}
```

The external and persisted JSON contract uses English snake_case keys:

- `public_debate`
- `date`
- `time`
- `location`
- `online_participation_link`
- `announcement_link`
- `description`

The nested object is optional at the top level through `public_debate: null`,
but when present it must satisfy:

- `date`: required date-only string in `YYYY-MM-DD`
- `time`: required local time string in `HH:MM`, 24-hour format
- `location`: required trimmed non-empty string
- `online_participation_link`: optional absolute `http/https` URL
- `announcement_link`: required absolute `http/https` URL
- `description`: optional trimmed non-empty string

Both `values` and `public_debate` remain strict objects with
`additionalProperties: false`.

### Validation And Normalization

Validation remains layered:

- Fastify route schemas validate request and response shape
- core config normalization remains authoritative for business validation and
  persisted-read validation

Normalization rules:

- date-only values are normalized using the existing business-date strategy
- URL values are normalized using the existing absolute URL strategy
- `time` is validated strictly as `HH:MM`
- string fields are trimmed before storage
- for optional nested fields, empty strings and explicit `null` collapse to one
  canonical stored form: the key is omitted
- the canonical fingerprint input uses the normalized stored form, so omission
  and explicit `null` never produce different announcement hashes

At the config level:

- `PUT` remains a full replacement, not a patch
- `values.public_debate` must always be present in the body, even when `null`
- `isConfigured` becomes `true` when any supported config field is populated,
  including `public_debate !== null`
- all-null config writes remain invalid in Phase 1
- clearing `public_debate` is allowed only when at least one other config field
  remains populated
- clearing the final configured field for an entity is out of scope until
  explicit delete semantics exist

### Backward Compatibility And Payload Versioning

This change must not break existing config rows.

The current strict v1 reader would reject old rows if the schema were widened
naively, so the module adopts explicit dual-read versioning:

- existing rows with `version = 1` remain readable
- `version = 1` rows are mapped to `values.public_debate = null` at read time
- new writes persist `version = 2`
- `version = 2` requires the widened `values` shape
- unsupported versions remain invalid persisted data

No new database table is introduced.

### Admin API Integration

The admin route family remains unchanged:

- `GET /api/v1/admin/campaigns/:campaignKey/entities/:entityCui/config`
- `PUT /api/v1/admin/campaigns/:campaignKey/entities/:entityCui/config`
- `GET /api/v1/admin/campaigns/:campaignKey/entity-config`
- `GET /api/v1/admin/campaigns/:campaignKey/entity-config/export`

Contract changes:

- detail `GET` returns `values.public_debate` with `null` default
- `PUT` accepts and validates the widened `values` object
- list responses include the widened `values` shape

Rollout compatibility:

- because the current `PUT` body is strict full replacement, immediately
  requiring `values.public_debate` would break older admin clients
- Phase 1 therefore includes a temporary compatibility shim for requests that
  omit `values.public_debate`
- during that window:
  - create requests map missing `public_debate` to `null`
  - update requests preserve the currently stored `public_debate` value when the
    key is omitted
- once the admin client rollout is complete, the route returns to the strict
  full-replacement contract and requires the key explicitly

Collection discovery changes:

- add `hasPublicDebate?: boolean` to the list/export query model
- implement this in the collection CTE by extracting the nested JSON object from
  config rows
- use `/entity-config` as the canonical admin surface for “entities with public
  debate configured”

Phase 1 does not add the public-debate field to the main `/entities` projection.

Export changes:

- `/entity-config/export` remains CSV, not JSON
- add explicit flat columns for the public debate payload:
  - `Public Debate Date`
  - `Public Debate Time`
  - `Public Debate Location`
  - `Public Debate Online Link`
  - `Public Debate Announcement Link`
  - `Public Debate Description`
- Phase 1 does not add a raw JSON payload column to CSV

### Notification Model

Introduce a new config-driven campaign-admin notification family for public
debate announcements.

Recommended identifiers:

- template id: `public_debate_announcement`
- runnable id: `public_debate_announcement`
- single trigger id: `public_debate_announcement.latest`
- outbox type: `funky:outbox:public_debate_announcement`

This family is separate from `public_debate_entity_update`.

Reason:

- `public_debate_entity_update` is tied to thread lifecycle events
- its outbox metadata and email template expect thread fields such as `threadId`,
  `threadKey`, `phase`, `institutionEmail`, and `subjectLine`
- reusing it would conflate two unrelated business events and complicate audit,
  compose, and deduplication

### Event Source And Admin Triggering

The source event for this family is:

- “an entity has a non-null normalized `public_debate` payload”

In Phase 1, that event becomes actionable through the admin notification
surface, not through direct post-commit email dispatch.

Admin behavior:

- a single trigger can target one entity by `entityCui`
- a runnable template can enumerate all entities whose config currently has
  `public_debate != null`
- dry run materializes the exact recipients and rows that would be sent
- send consumes the stored plan and creates outbox rows only for `will_send`
  rows

This keeps notification delivery deliberate, reviewable, and consistent with the
existing admin notification architecture.

### Identifying Candidate Entities

Candidate entities for this family are loaded from campaign entity config, not
from the general campaign-admin entity projection.

Phase 1 candidate source:

- entity-config rows where `values.public_debate != null`

Recommended implementation:

- add a dedicated reader/helper in `campaign-entity-config` that can list or
  load entities with populated `public_debate`
- back that helper with the existing entity-config collection logic
- use the new `hasPublicDebate` capability for admin discovery and trigger
  candidate loading

The `/entities` admin projection remains out of scope because it intentionally
does not represent config-only entities.

### Recipient Targeting

Phase 1 reuses the existing public-debate entity subscription audience:

- notification preference type: `funky:notification:entity_updates`

Recipients for a given entity are:

- users with an active `funky:notification:entity_updates` row for that
  `entityCui`
- excluding users globally unsubscribed from email
- excluding users whose public-debate campaign preference is disabled

The runnable planner may summarize audience counts using the same semantics as
the current public-debate audience summary reader, but execution remains
recipient-specific and must still recheck eligibility.

Phase 1 does not introduce a new user preference type for public debate
announcements.

### Delivery And Dedupe

The new outbox metadata includes:

- `campaignKey`
- `entityCui`
- `entityName`
- normalized `public_debate` payload
- `announcementFingerprint`
- `configUpdatedAt`
- `triggerSource`
- `triggeredByUserId`

Deduplication rules:

- one delivery per `(campaignKey, entityCui, userId, announcementFingerprint)`
- `announcementFingerprint` is a stable hash of the normalized
  `public_debate` payload

This means:

- rerunning the same announcement dry run does not duplicate already-sent mail
- changing the normalized public debate payload creates a new send opportunity

Send-time behavior:

- recheck entity eligibility before compose/send
- if the recipient is no longer eligible, skip as unsubscribed/ineligible
- if an outbox already exists with terminal sent state for the same delivery key,
  mark the row as already sent
- recheck that the current config row still contains a non-null `public_debate`
  payload for the entity
- recheck that the current normalized payload fingerprint still matches the
  stored `announcementFingerprint`
- if the payload was removed or changed after dry run, treat the row as
  `missing_data` with reason code `stale_announcement`

Execution semantics for changed config:

- dry run stores the payload fingerprint and config `updatedAt` snapshot in the
  row execution data
- send uses the stored snapshot only as a replay boundary, not as a blind
  authority
- the latest config is reloaded before enqueue
- if the latest config differs from the stored snapshot, send does not enqueue a
  stale announcement row

### Runnable Plan Workflow

Add a new runnable template definition under
`campaign-admin-notifications`:

- selector schema:
  - `entityCui?`
- filter schema:
  - `hasPublicDebate?`
  - optionally `updatedAtFrom?`
  - optionally `updatedAtTo?`
- dry-run row source:
  - config rows with `public_debate != null`
- row expansion:
  - one row per eligible recipient per entity announcement fingerprint

Each dry-run row should expose safe preview data only:

- `rowKey`
- `userId`
- `entityCui`
- `entityName`
- `recordKey`
- `interactionId`
- `interactionLabel`
- `reviewStatus = null`
- `reviewedAt = null`
- `statusMessage`
- current status:
  - `will_send`
  - `already_sent`
  - `already_pending`
  - `ineligible`
  - `missing_data`

Phase 1 keeps the existing shared runnable-row schema. It does not widen the
core runnable row REST contract just for this template.

Recommended row mapping:

- `recordKey`: entity-config record key for the entity
- `interactionId`: fixed value `public_debate_announcement`
- `interactionLabel`: fixed human label such as `Public debate announcement`
- `statusMessage`: compact human summary including debate date, time, location,
  and whether online participation is available

The stored plan carries the execution data needed to enqueue the new outbox
family later.

### Template And Audit Integration

Add a dedicated user-facing email template for this family.

Phase 1 sends Romanian copy only with `lang = 'ro'`.

Template content should include:

- entity name
- debate date
- debate time
- debate location
- announcement link
- optional online participation link
- optional description
- link back to entity page or campaign page

Admin integration changes:

- add the new template to the preview catalog
- add an audit projection for the new outbox type
- expose the new template and runnable in the campaign-admin notifications API

Closed-registry wiring required for the new outbox family:

- add the new outbox constant to the campaign key constants
- add the new outbox type to the `NotificationOutboxType` union
- add a compose branch for the new outbox type
- add campaign sender selection support for the new outbox type
- add the new outbox type to admin audit allowlists and projection mapping
- widen campaign-admin audit projection unions and REST schemas to include the
  new family
- register the template in the email-template registry and preview catalog

## Alternatives Considered

- Send emails automatically from `PUT /entities/:entityCui/config`.
  Rejected for Phase 1 because config writes are admin editing operations, while
  the existing admin notification platform already uses dry-run-first review
  before send. Immediate send would be harder to review, replay, and dedupe
  safely.
- Reuse `public_debate_entity_update`.
  Rejected because that family is thread-lifecycle-specific and requires thread
  metadata that does not exist for config-driven public debate announcements.
- Add a new subscriber preference type for this email family.
  Rejected for Phase 1 because the existing `entity_updates` preference already
  represents the public-debate entity subscription boundary and reusing it keeps
  rollout smaller.
- Use `/campaigns/:campaignKey/entities` to discover configured entities.
  Rejected because that projection does not include config-only entities and is
  therefore not authoritative for this feature.
- Introduce a generic config schema registry before adding this field.
  Rejected for now because `campaign-entity-config` is still single-campaign and
  a direct extension of the current strict schema is materially simpler.

## Consequences

**Positive**

- The public debate payload gets a canonical, validated, admin-managed store.
- Existing config rows remain readable through explicit version compatibility.
- Admins can identify entities with configured public debate data through the
  entity-config surface.
- Public debate announcement mail reuses the existing subscriber audience and
  the existing admin dry-run/send workflow.
- The new notification family stays separate from thread lifecycle mail, which
  keeps audit and delivery semantics coherent.

**Negative**

- The entity-config reader/writer gains version-compatibility complexity.
- The public debate payload uses English snake_case keys even though admins may
  enter Romanian content values.
- A new notification family, template, outbox branch, audit projection, and
  runnable definition must be added instead of reusing existing public-debate
  update code.
- Phase 1 intentionally does not auto-send on config save, so admins must still
  execute the runnable plan or trigger.

## References

- [`src/modules/campaign-entity-config/core/types.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config/core/types.ts)
- [`src/modules/campaign-entity-config/core/config-record.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config/core/config-record.ts)
- [`src/modules/campaign-entity-config/core/usecases/upsert-campaign-entity-config.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config/core/usecases/upsert-campaign-entity-config.ts)
- [`src/modules/campaign-entity-config/shell/rest/routes.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-entity-config/shell/rest/routes.ts)
- [`src/modules/learning-progress/shell/repo/learning-progress-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/repo/learning-progress-repo.ts)
- [`src/modules/campaign-admin-entities/shell/repo/campaign-admin-entities-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-entities/shell/repo/campaign-admin-entities-repo.ts)
- [`src/modules/notifications/core/types.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notifications/core/types.ts)
- [`src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts)
- [`src/modules/campaign-admin-notifications/core/usecases/create-campaign-notification-runnable-plan.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/core/usecases/create-campaign-notification-runnable-plan.ts)
- [`src/modules/campaign-admin-notifications/core/usecases/send-campaign-notification-runnable-plan.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/core/usecases/send-campaign-notification-runnable-plan.ts)
- [`src/modules/campaign-admin-notifications/shell/registry/runnable-template-definitions.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/registry/runnable-template-definitions.ts)
- [`src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts)
- [`src/modules/email-templates/core/types.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/email-templates/core/types.ts)
- [`docs/specs/specs-202604181116-campaign-entity-config-userinteractions-registry.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604181116-campaign-entity-config-userinteractions-registry.md)
- [`docs/specs/specs-202604141955-template-first-campaign-admin-notification-runs.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604141955-template-first-campaign-admin-notification-runs.md)
