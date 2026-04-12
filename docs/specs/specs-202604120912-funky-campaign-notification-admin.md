# Funky Campaign Notification Admin

**Status**: Draft
**Date**: 2026-04-12
**Author**: Codex

## Problem

Funky campaign admins do not have a dedicated, campaign-scoped notification
admin surface.

Today the server has the needed building blocks, but they are split across
separate modules and security models:

- campaign-admin authorization exists for learning-progress review only
- notification triggering exists through API-key admin routes, not session-based
  campaign admin routes
- notification audit data exists in `notificationsoutbox`, but no safe
  campaign-admin projection exists
- email previewability exists through the template registry and local scripts,
  but not through an authenticated admin API

That leaves three gaps:

- campaign admins cannot audit campaign notification activity without raw
  database access
- campaign admins cannot safely re-run approved notification flows without
  using the API-key trigger model
- campaign admins cannot preview supported templates through the same privileged
  boundary

This matters because the campaign-admin model is intentionally stricter than the
older generic admin model: it is session-authenticated, Clerk permission-based,
fail-closed when wiring is missing, and scoped by `campaignKey` at the route
boundary.

## Context

- The current campaign-admin boundary is implemented in
  [`src/app/build-app.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/app/build-app.ts),
  [`src/modules/learning-progress/shell/rest/campaign-admin-routes.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts),
  and
  [`src/modules/learning-progress/shell/security/clerk-campaign-admin-permission-checker.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/security/clerk-campaign-admin-permission-checker.ts).
- The fail-closed contract is already specified in
  [`docs/specs/specs-202604110932-campaign-admin-fail-closed-authorization.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604110932-campaign-admin-fail-closed-authorization.md).
- The notification pipeline already has reusable outbox use cases for:
  - transactional welcome
  - public-debate campaign welcome and entity subscription
  - public-debate entity update notifications
- The durable audit source of truth is `notificationsoutbox`, with render/send
  state, template metadata, attempt counts, and safe server-side join
  opportunities.
- The email template registry is the preview source of truth through
  registrations that already expose `id`, `version`, `description`,
  `payloadSchema`, and `exampleProps`.
- This repository does not contain a separate browser admin frontend. The
  “client” work in scope for this feature is the authenticated admin API
  contract under `/api/v1/admin/campaigns/:campaignKey/notifications`.
- Only `funky` is supported today, but the internal design should allow future
  campaign-specific policy and eventually a platform-wide notification admin.

## Decision

Introduce a dedicated `campaign-admin-notifications` module under the existing
campaign-admin route family and extract the authorization boundary into a shared
campaign-admin utility so privileged route families do not duplicate auth logic.

### Module Placement

Create two modules:

- `src/modules/campaign-admin/`
  - owns reusable campaign-admin authorization and campaign-policy helpers
  - reused by both learning-progress campaign-admin routes and notification
    campaign-admin routes
- `src/modules/campaign-admin-notifications/`
  - owns notification-audit, manual-trigger, and template-preview behavior for
    campaign admins

`campaign-admin-notifications` structure:

- `core/`
  - `errors.ts`
  - `types.ts`
  - `ports.ts`
  - `usecases/list-campaign-notification-audit.ts`
  - `usecases/execute-campaign-notification-trigger.ts`
  - `usecases/list-campaign-notification-templates.ts`
  - `usecases/get-campaign-notification-template-preview.ts`
- `shell/`
  - `rest/routes.ts`
  - `rest/schemas.ts`
  - `repo/outbox-audit-repo.ts`
  - `registry/trigger-definitions.ts`
  - `registry/template-preview-catalog.ts`
  - `preview/template-preview-service.ts`

### Core / Shell Boundary

`core/` stays pure and returns `Result<T, E>`.

`core/ports.ts` defines module-local abstractions:

- `CampaignNotificationAuditRepository`
- `CampaignNotificationTriggerRegistry`
- `CampaignNotificationTemplatePreviewService`

`shell/` implements those ports by composing existing public module APIs from:

- `notification-delivery`
- `notifications`
- `institution-correspondence`
- `learning-progress`
- `email-templates`
- `entity`

Campaign-specific policy stays in registries and configs, not in generic query
or route infrastructure.

### Shared Campaign-Admin Authorization

Extract the existing campaign-admin boundary from learning-progress into a
shared utility with these semantics:

- route family is registered only when `ENABLED_ADMIN_CAMPAIGNS` contains one or
  more supported campaign keys
- startup fails closed when campaign-admin routes are enabled but required
  wiring is missing:
  - `userDb`
  - real `authProvider`
  - non-empty `CLERK_SECRET_KEY`
- unsupported campaign keys fail startup before route registration
- every `/api/v1/admin/campaigns/:campaignKey/...` plugin uses the same
  preHandler:
  - require authenticated session via `request.auth`
  - resolve campaign policy from `:campaignKey`
  - evaluate Clerk permission for that campaign
  - attach authorized access context to the request

Per-request semantics remain:

- unsupported or disabled campaign: `404`
- missing auth: `401`
- authenticated without permission: `403`
- Clerk lookup failure or invalid payload: deny access

No route in this feature uses API-key admin auth.

### Route Family

Add a dedicated route family:

- `GET /api/v1/admin/campaigns/:campaignKey/notifications`
- `GET /api/v1/admin/campaigns/:campaignKey/notifications/triggers`
- `POST /api/v1/admin/campaigns/:campaignKey/notifications/triggers/:triggerId`
- `GET /api/v1/admin/campaigns/:campaignKey/notifications/templates`
- `GET /api/v1/admin/campaigns/:campaignKey/notifications/templates/:templateId/preview`

The route family is registered from `build-app.ts` inside the existing
campaign-admin enablement block and uses the same authorizer instance as the
learning-progress campaign-admin routes so Clerk permission caching is shared.

### Audit API Contract

`GET /api/v1/admin/campaigns/:campaignKey/notifications`

Query contract:

- `notificationType?`
- `templateId?`
- `status?`
- `eventType?`
- `entityCui?`
- `threadId?`
- `source?`
- `sortBy?`
  - allowlist: `createdAt`, `sentAt`, `status`, `attemptCount`
- `sortOrder?`
  - allowlist: `asc`, `desc`
- `cursor?`
- `limit?`
  - allowlist range: `1..100`

Unknown query keys, filters, or sort keys fail closed through TypeBox request
validation and server-side allowlists.

Response contract:

- `items[]`
  - `outboxId`
  - `campaignKey`
  - `notificationType`
  - `templateId`
  - `templateName`
  - `templateVersion`
  - `status`
  - `createdAt`
  - `sentAt`
  - `attemptCount`
  - `safeError`
    - `category`
    - `code`
  - `projection`
    - safe per-notification-kind data only
- `page`
  - `nextCursor`
  - `hasMore`

Audit source of truth:

- `notificationsoutbox`
- optional read-only joins only where they improve safe projection or trigger
  validation

Initial Funky audit inclusion registry:

- `funky:outbox:welcome`
- `funky:outbox:entity_subscription`
- `funky:outbox:entity_update`
- `funky:outbox:admin_failure`

`transactional_welcome` is not included in the initial audit surface because it
does not carry a first-class campaign identity in the current production flow.
If later added, it must be bound to a campaign-aware registry entry and
server-side filter, not inferred from client input.

Redaction rules:

- never expose `toEmail`
- never expose raw `deliveryKey`
- never expose raw `metadata`
- never expose unsubscribe tokens or links
- never expose rendered HTML/text stored in outbox rows
- never expose raw provider errors or provider-specific IDs
- never expose raw `failureMessage` from admin-failure metadata

Safe error projection strategy:

- derive category primarily from durable status
- derive code from a narrow allowlist of known internal prefixes and webhook
  event families
- return `null` when no safe mapping exists

Initial safe categories/codes:

- `skipped_unsubscribed`
- `skipped_no_email`
- `suppressed`
- `webhook_timeout`
- `compose_validation`
- `render_error`
- `email_lookup`
- `send_retryable`
- `send_permanent`
- `provider_bounce`
- `provider_suppressed`
- `unknown`

Initial safe projection registry:

- `funky:outbox:welcome`
  - `kind: public_debate_campaign_welcome`
  - `userId`
  - `entityCui`
  - `entityName`
  - `acceptedTermsAt`
  - `triggerSource`
- `funky:outbox:entity_subscription`
  - `kind: public_debate_entity_subscription`
  - `userId`
  - `entityCui`
  - `entityName`
  - `acceptedTermsAt`
  - `selectedEntitiesCount`
  - `triggerSource`
- `funky:outbox:entity_update`
  - `kind: public_debate_entity_update`
  - `userId`
  - `entityCui`
  - `entityName`
  - `threadId`
  - `threadKey`
  - `eventType`
  - `phase`
  - `replyEntryId`
  - `basedOnEntryId`
  - `resolutionCode`
  - `triggerSource`
- `funky:outbox:admin_failure`
  - `kind: public_debate_admin_failure`
  - `entityCui`
  - `entityName`
  - `threadId`
  - `phase`

### Manual Trigger Contract

`GET /api/v1/admin/campaigns/:campaignKey/notifications/triggers`

Returns a server-registered catalog:

- `triggerId`
- `campaignKey`
- `templateId`
- `description`
- `inputSchema`
- `targetKind`

`POST /api/v1/admin/campaigns/:campaignKey/notifications/triggers/:triggerId`

Rules:

- body is validated against the trigger definition’s TypeBox schema
- template ids are never accepted from the client
- arbitrary payload objects are never accepted from the client
- the admin layer stops at the existing notification pipeline boundary:
  - periodic flows enqueue collect/materialization work
  - direct outbox flows create or reuse outbox rows and enqueue compose
  - downstream render/send/dedupe/validation remain unchanged

Response contract:

- `status`
  - `queued`
  - `skipped`
  - `partial`
- `triggerId`
- `campaignKey`
- `templateId`
- `reason?`
- `details`
  - structured counters and ids only

Trigger registry structure:

- one definition per server-approved trigger id
- registry key: `${campaignKey}:${triggerId}`
- each definition declares:
  - `triggerId`
  - `campaignKey`
  - `templateId`
  - `inputSchema`
  - `targetKind`
  - `execute(...)`
  - `buildSafeAuditProjection(...)`

Initial Funky trigger catalog:

- `public_debate_campaign_welcome`
  - input: `{ userId, entityCui }`
  - resolver:
    - load the authoritative terms-accepted record from learning-progress using
      the `funky:progress:terms_accepted::entity:${entityCui}` key
    - load or validate the existing global preference and entity subscription
    - load entity name from `entityRepo`
  - delegate:
    - `enqueuePublicDebateTermsAcceptedNotifications`
  - behavior:
    - returns `queued` when a new or pending welcome outbox is enqueued
    - returns `skipped` with `already_processed` when the durable outbox exists
      in a non-pending terminal state
- `public_debate_entity_subscription`
  - input: `{ userId, entityCui }`
  - resolver:
    - same authoritative terms-accepted and subscription lookup as above
  - delegate:
    - `enqueuePublicDebateTermsAcceptedNotifications`
  - behavior:
    - same created/reused/skip semantics as above, but for the entity
      subscription outbox
- `public_debate_entity_update.thread_started`
- `public_debate_entity_update.thread_failed`
- `public_debate_entity_update.reply_received`
- `public_debate_entity_update.reply_reviewed`
  - input: `{ threadId }`
  - resolver:
    - load thread by id from institution-correspondence
    - ensure thread belongs to the requested campaign and platform-send flow
    - derive the current snapshot for the requested subtype server-side
  - delegate:
    - a state-aware entity-update enqueue helper that reuses the current
      notification-delivery pipeline but skips already-processed outbox rows
      instead of requeueing compose work for terminal deliveries
  - behavior:
    - returns `skipped` with `phase_mismatch` when the thread’s current state
      does not match the requested subtype
    - returns `skipped` with `no_subscribers` when no active recipients exist
    - returns `partial` when some recipients were queued and some were already
      processed

Deferred trigger:

- `transactional_welcome`
  - not exposed in the initial catalog
  - reason:
    - it is not campaign-scoped in the current domain model
    - its durable outbox rows do not currently carry authoritative campaign
      identity
    - exposing it under a campaign-scoped admin family would rely on inferred
      scope rather than server-owned campaign state

### Template Preview Contract

`GET /api/v1/admin/campaigns/:campaignKey/notifications/templates`

Returns the previewable template catalog for the campaign:

- `templateId`
- `name`
- `version`
- `description`
- `requiredFields`

`GET /api/v1/admin/campaigns/:campaignKey/notifications/templates/:templateId/preview`

Returns:

- `templateId`
- `name`
- `version`
- `description`
- `requiredFields`
- `html`
- `text`
- `exampleSubject`

Preview design:

- source of truth is the email template shell registry, not ad-hoc scripts
- previewable templates are controlled by a campaign allowlist registry
- initial Funky preview allowlist:
  - `public_debate_campaign_welcome`
  - `public_debate_entity_subscription`
  - `public_debate_entity_update`
  - `public_debate_admin_failure`
- preview rendering starts from `registration.exampleProps`
- base props are overwritten with preview-safe values server-side:
  - `unsubscribeUrl`
  - `preferencesUrl`
  - `platformBaseUrl`
  - `isPreview`
- preview never uses production user addresses, live unsubscribe tokens, or
  runtime-loaded production payloads
- required field descriptors are derived from the registration’s `payloadSchema`
  and returned as top-level schema field metadata

No custom payload editing is exposed in v1. Preview is example-driven only.

### Extensibility

Reusable units introduced by this design:

- shared campaign-admin authorization boundary
- trigger definition registry
- safe audit projection registry
- outbox audit repository
- template preview service

Future campaigns extend the system by adding:

- campaign policy entry
- audit inclusion config
- trigger definitions
- preview template allowlist

A future platform-wide notification admin can reuse the same outbox audit repo,
projection registry, and preview service with a wider policy layer instead of
rebuilding notification-specific logic in another module.

### Implementation Plan

Milestone 1: Shared auth extraction

- extract reusable campaign-admin access policy and auth hook
- switch learning-progress campaign-admin routes to the shared helper
- keep existing fail-closed tests passing

Milestone 2: Core and shell scaffolding

- add `campaign-admin-notifications` core errors, types, ports, and route
  schemas
- add audit query repo, trigger registry, and preview service
- wire route registration in `build-app.ts`

Milestone 3: Audit API

- implement outbox query filters, sort allowlists, cursor pagination, and safe
  projections
- add integration coverage for authorization, redaction, and query behavior

Milestone 4: Manual triggers

- implement state-aware trigger definitions for the approved Funky catalog
- keep direct sends out of the admin layer
- add unit coverage for idempotency, skip reasons, and unsupported triggers

Milestone 5: Template preview

- implement preview catalog and rendered preview endpoint
- add unit tests for schema-derived fields and preview sanitization

Milestone 6: Review pass

- review security, regressions, hardcoded Funky assumptions, and missing tests
- fix findings before finalizing

### Test Strategy

Unit tests:

- shared campaign-admin auth helper
- safe error mapping and projection redaction
- trigger definition validation and skip behavior
- preview service field derivation and preview-safe prop overrides

Integration tests:

- route family auth failures: `401`, `403`, `404`
- startup fail-closed behavior when campaign-admin wiring is missing
- audit filtering, sorting, and cursor pagination
- unknown filters and sorts rejected fail-closed
- unsupported trigger rejection
- trigger execution through existing pipeline boundaries
- template preview rendering through the real renderer

Behavioral regression tests:

- learning-progress campaign-admin routes still inherit the same auth boundary
- entity-update manual triggers do not enqueue compose work for already-terminal
  outbox rows

## Alternatives Considered

### Extend the API-key notification trigger routes

Rejected because the feature must be session-authenticated, Clerk
permission-based, campaign-scoped at the route boundary, and attributable to the
acting user. The API-key model does not satisfy those constraints.

### Add notification endpoints directly to the learning-progress campaign-admin plugin

Rejected because it would mix unrelated module responsibilities and keep the
campaign-admin auth boundary trapped inside the learning-progress module instead
of extracting a reusable privileged-route primitive.

### Expose raw `notificationsoutbox` rows or raw metadata blobs

Rejected because raw rows contain fields that must stay private or
implementation-specific:

- email addresses
- delivery keys
- unsubscribe artifacts
- raw provider errors
- raw metadata payloads

### Allow arbitrary preview payload overrides from the client in v1

Rejected because the feature goal is safe example-driven preview, not a generic
template rendering console. Arbitrary payload entry would widen the data
boundary and complicate validation without being required for the admin workflow
in this repository.

## Consequences

**Positive**

- The new notification admin surface follows the same session + Clerk + fail-closed model as the existing campaign-admin routes.
- Campaign-specific policy lives in registries instead of route-local hardcoding.
- Audit, trigger, and preview responsibilities are separated cleanly while still sharing a single privileged route family.
- The design avoids API-key bypasses and avoids direct-send shortcuts around the outbox pipeline.

**Negative**

- Shared campaign-admin auth extraction adds some refactoring cost before the new feature can land.
- The initial trigger catalog intentionally excludes `transactional_welcome`, so the first release is not feature-complete against the broader candidate list.
- Entity-update manual triggering requires a new state-aware helper to avoid requeueing terminal outbox rows, which is stricter than some current non-admin flows.
- Preview remains example-driven and does not support arbitrary data entry in v1.

## References

- [`src/app/build-app.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/app/build-app.ts)
- [`src/modules/learning-progress/shell/rest/campaign-admin-routes.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts)
- [`src/modules/learning-progress/shell/security/clerk-campaign-admin-permission-checker.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/security/clerk-campaign-admin-permission-checker.ts)
- [`src/modules/notification-delivery/core/usecases/enqueue-public-debate-terms-accepted-notifications.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/enqueue-public-debate-terms-accepted-notifications.ts)
- [`src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts)
- [`src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts)
- [`src/modules/email-templates/shell/registry/index.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/email-templates/shell/registry/index.ts)
- [`src/modules/email-templates/shell/renderer/index.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/email-templates/shell/renderer/index.ts)
- [`docs/specs/specs-202604110932-campaign-admin-fail-closed-authorization.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604110932-campaign-admin-fail-closed-authorization.md)
