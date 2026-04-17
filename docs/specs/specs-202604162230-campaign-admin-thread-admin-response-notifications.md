# Campaign Admin Thread Admin-Response Notifications

**Status**: Draft
**Date**: 2026-04-16
**Author**: Codex

## Problem

The campaign-admin institution-thread flow can persist manual admin responses,
but it cannot deliberately notify subscribed users about those responses as a
first-class event.

Today the system has several gaps:

- the campaign-admin thread list/detail APIs do not expose requester vs
  subscriber audience counts, so the admin UI cannot show how many users are
  subscribed or currently eligible to receive a send
- `POST /api/v1/admin/campaigns/:campaignKey/institution-threads/:threadId/responses`
  does not support explicit opt-in notification sending after a response is
  saved
- the current public-debate entity-update notification flow is derived from
  thread snapshots and reply review state, not from a specific admin response
  event id
- the admin notification trigger UI cannot manually target the latest admin
  response on a thread with the same dedupe boundary as the immediate send path
- the existing requester/subscriber email copy is designed for lifecycle
  updates, not for “an admin response was added to this thread”

Without a dedicated admin-response notification path, the system cannot safely
dedupe immediate send vs manual trigger on the same response event, and it
cannot present accurate audience information to admins before sending.

## Context

### Target Scope and Objectives

This change extends the existing campaign-admin institution-thread surface and
the existing public-debate notification infrastructure without introducing a new
privileged route family.

Objectives:

- expose raw requester/subscriber subscription counts on thread list/detail
  responses
- also expose eligible requester/subscriber counts after global unsubscribe and
  campaign-disabled filtering so the UI can show actual send reach
- add `sendNotification?: boolean` to the admin response append route with
  default behavior remaining “save only”
- persist the admin response first, then enqueue notification side effects for
  the exact created response event when sending is requested
- treat admin responses as a first-class notification event keyed by
  `responseEventId`
- add one admin-only manual trigger for the latest admin response on a thread
  through the existing campaign-admin notification trigger system
- preserve all current `public_debate_entity_update` lifecycle behavior
  unchanged
- use admin-response-specific requester/subscriber template copy so recipients
  understand why they received the email

Primary code areas:

- [src/modules/institution-correspondence/shell/rest/campaign-admin-routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/shell/rest/campaign-admin-routes.ts)
- [src/modules/institution-correspondence/shell/rest/campaign-admin-schemas.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/shell/rest/campaign-admin-schemas.ts)
- [src/modules/institution-correspondence/shell/rest/campaign-admin-formatters.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/shell/rest/campaign-admin-formatters.ts)
- [src/modules/institution-correspondence/core/usecases/append-campaign-admin-thread-response.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/core/usecases/append-campaign-admin-thread-response.ts)
- [src/modules/institution-correspondence/core/admin-workflow.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/core/admin-workflow.ts)
- [src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts)
- [src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts)
- [src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts)
- [src/modules/notification-delivery/shell/queue/workers/send-worker.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/queue/workers/send-worker.ts)
- [src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts)
- [src/modules/campaign-admin-notifications/shell/rest/schemas.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/rest/schemas.ts)
- [src/modules/campaign-admin-notifications/shell/repo/outbox-audit-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/repo/outbox-audit-repo.ts)
- [src/modules/email-templates/shell/registry/index.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/email-templates/shell/registry/index.ts)

### Constraints and Limitations

- preserve the current campaign-admin auth boundary and fail-closed startup
  checks
- keep the existing institution-thread append write path append-only and
  optimistic-concurrency-protected
- keep the current forward-only resolved-thread rule unless the product later
  explicitly decides to allow post-resolution admin responses
- preserve current `public_debate_entity_update` lifecycle notifications for
  `thread_started`, `thread_failed`, `reply_received`, and `reply_reviewed`
- do not derive admin-response sends from the existing thread snapshot flow
- do not add a bespoke manual-trigger route when the existing
  campaign-admin-notification trigger system already provides the privileged
  surface
- prefer a dedicated read-only audience summary adapter injected into the admin
  thread routes instead of widening generic notification-delivery ports across
  the whole codebase
- requester/subscriber counts are role counts, not raw notification-row counts:
  requester is `0 | 1`, subscribers exclude the requester when the requester is
  subscribed
- the same audience summary source must support both:
  - list/detail DTO decoration
  - `notificationExecution.reason` decisions such as “no subscribers” vs
    “subscribed but filtered out”
- if the admin-response enqueue step fails after the response is saved, the API
  should not roll back the write; it should return the persisted thread and a
  `notificationExecution` status describing the failure

### Security Requirements

- preserve campaign scoping, `platform_send` scoping, and existing `404` hiding
  behavior for out-of-scope thread ids
- keep audience counting read-only and expose counts only, never recipient user
  ids or notification ids on list/detail responses
- use the exact `createdResponseEventId` returned by the append result for the
  immediate send path so concurrent later responses cannot hijack the send
  target
- recheck per-user entity eligibility at send time for the new admin-response
  family so a user who disables the campaign after enqueue but before send does
  not still receive the email
- keep manual triggering within the existing campaign-admin notification
  execution routes and audit system
- preserve dedupe keys based on `threadId + responseEventId` so repeat sends for
  the same response reuse the same delivery boundary
- do not broaden raw correspondence payload exposure or admin-only metadata in
  user-facing templates

### Compatibility Requirements

- the admin client parser is strict; any added response fields here will require
  coordinated client schema updates before shipping
- list/detail response additions should be additive and grouped under a nested
  audience object to reduce future contract churn
- `sendNotification` must be treated as `request.body.sendNotification ?? false`
  in route logic; do not depend on schema defaults being applied at runtime

## Decision

### 1. Add a Dedicated Audience Summary Adapter

Add one read-only adapter, used only by the campaign-admin institution-thread
routes, that can batch-compute audience counts for `(entityCui, ownerUserId)`
pairs.

For each thread:

- raw requester count:
  - `1` when the thread owner has an active entity-update subscription for that
    entity
  - otherwise `0`
- raw subscriber count:
  - all other active entity-update subscribers for that entity
- eligible requester count:
  - requester count after global unsubscribe and campaign-disabled filtering
- eligible subscriber count:
  - subscriber count after the same filtering

Route DTOs will expose these counts as a nested additive object, for example:

- `notificationAudience.requesterCount`
- `notificationAudience.subscriberCount`
- `notificationAudience.eligibleRequesterCount`
- `notificationAudience.eligibleSubscriberCount`

This keeps notification internals out of the correspondence repo and avoids
fan-out changes to broad delivery interfaces.

### 2. Extend the Append Route With Explicit Send Opt-In

Extend `POST /api/v1/admin/campaigns/:campaignKey/institution-threads/:threadId/responses`
with `sendNotification?: boolean`.

Behavior:

- omitted or `false`:
  - preserve current behavior
  - no notification side effects
- `true`:
  - append the admin response first
  - read the exact created response event from the returned thread using
    `createdResponseEventId`
  - invoke the dedicated admin-response enqueue path
  - return the persisted thread plus `notificationExecution`

The write must succeed independently of notification enqueue success. If enqueue
fails or no recipients are eligible, return `200` with the persisted response
and a structured `notificationExecution` result.

### 3. Add a First-Class Admin-Response Enqueue Path

Implement a dedicated enqueue helper for admin responses.

Inputs include:

- thread identity and entity context
- `responseEventId`
- `responseStatus`
- admin response message content
- actor/trigger attribution
- recipient role derivation from `ownerUserId`

Dedupe rules:

- scope key includes `threadId + responseEventId`
- delivery key includes the same scope key plus the notification reference
- immediate send and manual trigger for the same response reuse the same
  outbox rows
- a later admin response gets a new `responseEventId`, so it remains sendable

The admin-response event must not be derived from the legacy
`deriveCurrentPlatformSendSnapshot` flow.

Immediate-send resolution rule:

- the immediate send path must use the exact `createdResponseEventId` returned
  by the append operation
- it must resolve that event from the returned thread object, not from a fresh
  “latest response” lookup
- “latest admin response on thread” lookup is reserved for the manual trigger

### 4. Use a Dedicated Admin-Response Template Family

Do not change current lifecycle template behavior.

Add a dedicated admin-response template family with separate requester and
subscriber copy variants:

- requester copy:
  - clearly states that an admin response was added to the recipient’s request
- subscriber copy:
  - clearly states the recipient follows the locality and is receiving an
    update, not necessarily a reply to their own request

Compose selection will branch to these templates only for the admin-response
event family. Existing `public_debate_entity_update` templates remain unchanged.

### 5. Add Manual Trigger Through the Existing Admin Notification Trigger System

Add one new campaign-admin trigger definition, for example
`public_debate_admin_response.latest`, that:

- accepts `threadId`
- loads the thread through the existing scoped correspondence repo
- verifies thread scope matches the campaign-admin institution-thread rules
- resolves the latest admin response event from current thread state
- skips when no admin response exists
- reuses the same admin-response enqueue helper with
  `reusedOutboxComposeStrategy = skip_terminal_compose`

Explicit skip reasons should include:

- thread not found / unsupported scope
- no admin response exists on the thread
- already processed when the same response event was already queued or sent and
  nothing replayable remains

This keeps auth, audit, result formatting, and operator workflow aligned with
the existing trigger UI.

### 6. Fail Closed at Send Time

Because campaign/global preferences can change after enqueue, the send worker
must explicitly recheck per-user entity eligibility for the new admin-response
family before email send.

If a user becomes ineligible between enqueue and send:

- do not send
- mark the outbox row with the appropriate skipped status
- keep this behavior consistent with existing unsubscribe safety expectations

To preserve current lifecycle behavior, this send-time entity-eligibility
recheck should be scoped only to the new admin-response event family rather
than retroactively changing all existing lifecycle entity-update sends.

### 7. Extend Audit and Admin Notification Schemas

Admin-response sends must be visible in campaign-admin notification audit.

Update the relevant audit projection and REST validation layers to support the
new event family and to expose enough debugging context:

- event type or equivalent family identifier
- `responseEventId`
- `recipientRole`
- thread/entity identifiers already used by the existing audit UI

This keeps manual-trigger results, audit, and template rendering aligned on the
same metadata.

### 8. Response Payload Contract for `sendNotification=true`

When `sendNotification` is `true`, add `notificationExecution` to the append
response.

Target shape:

- `requested: true`
- `status: queued | skipped | partial`
- `reason?: string`
- `requesterCount`
- `subscriberCount`
- `eligibleRequesterCount`
- `eligibleSubscriberCount`
- `queuedOutboxIds`
- optionally `createdOutboxIds`, `reusedOutboxIds`, and
  `enqueueFailedOutboxIds` for admin diagnostics

Recommended reasons:

- `no_subscribers`
- `no_eligible_recipients`
- `already_processed`
- `enqueue_failed`

When `sendNotification` is omitted or `false`, keep the current response shape
unchanged.

## Alternatives Considered

- Overload the existing `public_debate_entity_update` template and event schema
  with `admin_response_added`.
  Rejected because it fans out into existing compose, schema, preview, and
  audit validators and increases regression risk in stable lifecycle
  notifications.
- Add a brand-new bespoke admin-trigger REST route.
  Rejected because the existing campaign-admin notification trigger system
  already provides auth, audit, and execution result handling.
- Resolve the immediate-send response from a fresh “latest admin response”
  lookup.
  Rejected because a concurrent later admin response could cause the wrong event
  to be sent.
- Widen generic delivery repository interfaces for audience counting.
  Rejected because that would force unnecessary changes across unrelated fakes
  and delivery call sites.
- Fail the whole append request when notification enqueue fails.
  Rejected because the response append is the primary write and must not be
  rolled back by optional post-write notification side effects.

## Consequences

**Positive**

- admins get accurate raw and effective audience counts on thread screens
- the append route supports explicit “save and notify” behavior without
  changing the default save-only path
- dedupe is tied to the actual admin response event rather than to a mutable
  thread snapshot
- manual trigger and immediate send share the same delivery boundary
- requester vs subscriber email copy becomes explicit and less misleading
- notification audit remains coherent for operators

**Negative**

- this adds one more notification event family and template family to maintain
- send worker logic becomes slightly more specialized because admin-response
  sends require entity eligibility rechecks
- the admin client must be updated in lockstep for the additive response-shape
  changes
- audit/query schemas must be widened to support the new event family

## Testing Strategy

### Unit Tests

- audience summary adapter:
  - raw counts with requester subscribed
  - raw counts with requester not subscribed
  - eligible counts after global unsubscribe filtering
  - eligible counts after campaign-disabled filtering
- admin-response enqueue helper:
  - scope key includes `responseEventId`
  - immediate rerun reuses outbox rows for the same response
  - later response event produces new outbox rows
  - `registration_number_received`
  - `request_confirmed`
  - `request_denied`
- compose worker:
  - requester template selection
  - subscriber template selection
- send worker:
  - skips admin-response sends when user becomes campaign-disabled after enqueue
- audit projection:
  - new event family metadata parses correctly

### Integration Tests

- institution-thread list endpoint returns audience counts
- institution-thread detail endpoint returns audience counts
- append route with `sendNotification` omitted or `false` does not enqueue
  notifications
- append route with `sendNotification = true` returns `notificationExecution`
  and queues notifications when eligible recipients exist
- append route with `sendNotification = true` and no eligible recipients returns
  `status = skipped` with counts and reason
- manual trigger resolves the latest admin response on the thread
- manual trigger returns the expected skipped reason when no admin response
  exists yet
- manual trigger dedupes against an already-queued or already-sent immediate
  send for the same response event
- later admin response on the same thread remains sendable because it gets a
  new response-event scope key

### E2E / Real DB Tests

- repo-level or end-to-end verification of audience counts against real
  notifications table semantics
- dedupe behavior across persisted outbox rows for:
  - immediate send then manual trigger on the same response
  - first admin response then later admin response
- audit visibility for the new event family

### Client Coordination

- update the strict client parser for the new institution-thread DTO fields
- update the admin trigger UI to expose the new manual trigger
- verify the client can render raw vs eligible counts and the new send result

## Acceptance Criteria

- list and detail endpoints return separate requester/subscriber raw counts
- list and detail endpoints also return eligible requester/subscriber counts
- the append route accepts `sendNotification?: boolean` and defaults to save
  only
- when `sendNotification = true`, the route persists the admin response before
  attempting notification enqueue
- notification dedupe for admin responses is tied to `responseEventId`
- immediate send and manual trigger do not duplicate the same admin response
- a later admin response can still create a new sendable notification event
- requester and subscriber recipients receive different admin-response copy
- existing lifecycle notifications remain unchanged
- `registration_number_received`, `request_confirmed`, and `request_denied`
  are all supported by the admin-response notification path
- no eligible recipients produces a skipped execution result instead of a hard
  failure
- admin-response sends are visible in notification audit and compatible with the
  trigger UI

## Definition of Done

- implementation matches the decision above without introducing a parallel admin
  surface
- unit, integration, and targeted e2e tests cover the required scenarios
- send-time eligibility is fail-closed for the new admin-response family
- route-level optimistic concurrency and thread scoping remain intact
- current lifecycle notification behavior is unchanged
- client contract updates are identified and ready before shipping
- code review confirms the implementation matches the specification and no
  critical security or dedupe gaps remain

## References

- [src/modules/institution-correspondence/shell/rest/campaign-admin-routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/shell/rest/campaign-admin-routes.ts)
- [src/modules/institution-correspondence/core/usecases/append-campaign-admin-thread-response.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/core/usecases/append-campaign-admin-thread-response.ts)
- [src/modules/institution-correspondence/core/admin-workflow.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/institution-correspondence/core/admin-workflow.ts)
- [src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/usecases/enqueue-public-debate-entity-update-notifications.ts)
- [src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/repo/extended-notifications-repo.ts)
- [src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/queue/workers/compose-outbox.ts)
- [src/modules/notification-delivery/shell/queue/workers/send-worker.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/shell/queue/workers/send-worker.ts)
- [src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts)
- [src/modules/campaign-admin-notifications/shell/repo/outbox-audit-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/repo/outbox-audit-repo.ts)
- [docs/specs/specs-202604160837-campaign-admin-institution-threads-api.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604160837-campaign-admin-institution-threads-api.md)
- [docs/specs/specs-202604161950-campaign-admin-thread-response-compat-fix.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604161950-campaign-admin-thread-response-compat-fix.md)
- [docs/guides/INTERACTIVE-ELEMENT-CHECKS-AND-TRIGGERS.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/guides/INTERACTIVE-ELEMENT-CHECKS-AND-TRIGGERS.md)
