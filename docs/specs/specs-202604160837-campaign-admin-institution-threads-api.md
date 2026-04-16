# Campaign Admin Institution Threads API

**Status**: Draft
**Date**: 2026-04-16
**Author**: Codex

## Problem

The current institution-correspondence admin design is not aligned with the
actual admin workflow.

- The deprecated standalone admin endpoint is not used and must not remain a
  parallel privileged surface.
- The existing draft implementation models admin actions around the low-level
  correspondence runtime phases rather than the simpler admin workflow the
  product needs.
- Admins need to manage one clear thread workflow in the campaign-admin UI:
  - view unresolved threads
  - view started threads
  - append manual response events
  - move threads into a validated terminal state

The admin workflow is simpler than the internal transport/runtime model and
should be expressed directly in the admin API.

## Context

- Thread persistence already exists in
  [`institutionemailthreads`](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/infra/database/user/migrations/202604021100_unify_production_user_schema.sql)
  and remains owned by
  [`institution-correspondence`](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/modules/institution-correspondence/index.ts).
- The existing low-level correspondence engine still uses transport/runtime
  phases such as `awaiting_reply` and `reply_received_unreviewed`. Those remain
  internal implementation details and must not define the admin workflow model.
- Campaign-admin routes already provide the desired privileged boundary:
  session auth, Clerk permission checks, campaign scoping, strict query
  validation, and fail-closed startup behavior.
- The admin workflow must support append-only manual response history because
  correspondence can continue outside the platform and later be recorded in the
  system.
- Scope for v1 remains:
  - campaign key `funky`
  - `platform_send` threads only
  - one list view with filters rather than separate APIs for “started” and
    “unresolved”

## Decision

Expose a first-class admin state model through campaign-admin routes and remove
the deprecated standalone correspondence admin surface.

### Admin State Model

The admin API uses two explicit concepts:

- `threadState`
  - `started`
  - `pending`
  - `resolved`
- `currentResponseStatus`
  - `null`
  - `registration_number_received`
  - `request_confirmed`
  - `request_denied`

`threadState` is the admin workflow state.

`currentResponseStatus` is the latest manual response classification recorded by
an admin, if one exists.

### Response Events

Admins do not patch thread status directly.

Instead, they append a manual response event with:

- `responseDate`
- `messageContent`
- `responseStatus`

Response events are append-only and multiple manual response events are allowed
per thread.

Each stored admin response event records:

- `id`
- `responseDate`
- `messageContent`
- `responseStatus`
- `actorUserId`
- `createdAt`
- `source = campaign_admin_api`

Response events are authoritative by append order.

- The most recently appended admin response event is the authoritative manual
  event.
- `responseDate` is historical payload supplied by the admin.
- `createdAt` is the server-generated append timestamp.
- `latestResponseAt` in the admin DTO equals the latest appended event's
  `responseDate`.
- `responseEvents` are returned in append order, oldest first.

### State Transition Rules

The admin API enforces these forward-only transitions:

- `started + registration_number_received -> pending`
- `started + request_confirmed -> resolved`
- `started + request_denied -> resolved`
- `pending + registration_number_received -> pending`
- `pending + request_confirmed -> resolved`
- `pending + request_denied -> resolved`
- `resolved + any manual response event -> rejected`

For v1 there is no reopen path.

### Relationship to Internal Correspondence Phases

The existing low-level correspondence/runtime phases remain internal.

The admin API projects the admin state model on top of them:

- once any admin `responseEvent` exists, admin state is derived only from the
  latest appended admin response event
- low-level runtime phase never overrides an existing admin response event
- low-level runtime phase is used only when no admin response events exist

- `started`
  - threads with no admin response events and no unresolved inbound-reply state
- `pending`
  - threads with latest manual response status
    `registration_number_received`
  - or threads whose low-level runtime state indicates an unresolved inbound
    reply or follow-up need
- `resolved`
  - threads with latest manual response status `request_confirmed` or
    `request_denied`
  - or threads whose low-level runtime state is already terminal

`failed` low-level threads are excluded from the v1 admin API scope entirely.

To keep the system internally consistent, successful admin response writes may
also update the low-level internal phase using the nearest compatible mapping,
but that mapping remains an internal detail, not the admin contract.

### Route Family

Add campaign-scoped routes:

- `GET /api/v1/admin/campaigns/:campaignKey/institution-threads`
- `GET /api/v1/admin/campaigns/:campaignKey/institution-threads/:threadId`
- `POST /api/v1/admin/campaigns/:campaignKey/institution-threads/:threadId/responses`

Do not keep or replace the old API-key auth path.

### Authentication and Authorization

- Reuse the existing campaign-admin auth hook and permission model.
- Every route must verify that the resolved thread:
  - belongs to the requested `campaignKey`
  - is a `platform_send` thread
- Requests fail closed when campaign-admin permission wiring is unavailable.
- Detail and write routes return `404` when the thread does not satisfy that
  scope, even if the raw thread id exists.

### List Contract

The list endpoint follows existing campaign-admin patterns:

- opaque cursor pagination
- `page` response envelope with `limit`, `totalCount`, `hasMore`, and
  `nextCursor`
- strict rejection of unknown query parameters

Supported filters:

- `stateGroup`
  - `open`
  - `closed`
- `threadState`
  - `started`
  - `pending`
  - `resolved`
- `responseStatus`
  - `registration_number_received`
  - `request_confirmed`
  - `request_denied`
- `query`
- `entityCui`
- `updatedAtFrom`
- `updatedAtTo`
- `latestResponseAtFrom`
- `latestResponseAtTo`

If `stateGroup` and `threadState` are both provided and contradict each other,
the API rejects the request with `400`.

`query` stays minimal and matches only:

- `entityCui`
- `institutionEmail`

The v1 list uses one fixed order:

- `updatedAt desc`

Cursor semantics are derived only from `updatedAt desc`, then `id asc` as the
stable tie-breaker.

`stateGroup=open` means `threadState in { started, pending }`.

`stateGroup=closed` means `threadState = resolved`.

The v1 list does not support:

- alternate sort fields
- entity-name full-text search
- subject full-text search

### Detail Contract

The detail endpoint returns a dedicated redacted thread DTO, not the raw stored
thread record.

Top-level detail fields:

- `id`
- `entityCui`
- `entityName`
- `campaignKey`
- `submissionPath`
- `ownerUserId`
- `institutionEmail`
- `subject`
- `threadState`
- `currentResponseStatus`
- `createdAt`
- `updatedAt`
- `latestResponseAt`
- `responseEventCount`
- `requesterOrganizationName`
- `budgetPublicationDate`
- `consentCapturedAt`
- `contestationDeadlineAt`
- `responseEvents`
- `correspondence`

Safe correspondence entry fields:

- `id`
- `direction`
- `source`
- `fromAddress`
- `subject`
- `textBody`
- attachment metadata only
- `occurredAt`

Optional response fields keep stable nullability instead of being omitted.

The detail endpoint does not return:

- raw `headers`
- raw entry `metadata`
- `htmlBody`
- `toAddresses`
- `ccAddresses`
- `bccAddresses`
- provider transport metadata
- `captureAddress`
- raw webhook payloads
- `threadKey`

### Manual Response Append Contract

`POST .../:threadId/responses` is the only write route in v1.

Request body:

- `expectedUpdatedAt`
- `responseDate`
- `messageContent`
- `responseStatus`

Allowed `responseStatus` values:

- `registration_number_received`
- `request_confirmed`
- `request_denied`

Validation rules:

- `messageContent` must be non-empty after trimming.
- `responseDate` must be a valid date-time.
- `expectedUpdatedAt` is required and enforced as an optimistic concurrency
  check.
- invalid transitions are rejected with `409`

Derived state rules:

- appending `registration_number_received` results in:
  - `threadState = pending`
  - `currentResponseStatus = registration_number_received`
- appending `request_confirmed` results in:
  - `threadState = resolved`
  - `currentResponseStatus = request_confirmed`
- appending `request_denied` results in:
  - `threadState = resolved`
  - `currentResponseStatus = request_denied`

`resolved` threads reject any further manual response event in v1.

### Persistence Contract

Admin workflow state is stored in an optional typed object inside the existing
thread
record:

- `record.adminWorkflow`
  - `currentResponseStatus`
  - `responseEvents[]`

`threadState` is always derived and is not stored as a separate persisted field.

Existing version-1 correspondence records remain readable without backfill.
Threads without `record.adminWorkflow` use the low-level phase projection rules
described above.

`responseStatus` filtering in the list API applies only to
`currentResponseStatus`, which exists only when at least one admin response
event has been appended.

### Notifications

After a successful manual response append, reuse the existing entity-update
publisher only when there is an existing supported event mapping.

For v1:

- appending `registration_number_received` does not create a new public update
  notification
- appending `request_confirmed` or `request_denied` does not create a new
  public update notification unless an existing supported correspondence event
  is already being updated under the hood

Notification publishing remains best-effort and must not roll back a successful
thread mutation.

### Write Response Contract

`POST .../:threadId/responses` returns:

- the same redacted detail DTO as
  `GET /api/v1/admin/campaigns/:campaignKey/institution-threads/:threadId`
- `createdResponseEventId`

### Explicit Non-Goals

This spec does not add:

- unmatched inbound email triage
- attaching stored webhook emails to a thread
- manual outbound email composition
- a separate `/meta` endpoint
- support for `self_send_cc` threads
- reopen / backward transitions

## Alternatives Considered

- Keep the standalone institution-correspondence admin routes and add more
  features there.
  Rejected because it duplicates the privileged boundary and keeps an unused
  API-key surface alive.
- Continue exposing the old low-level correspondence phase model directly in the
  admin API.
  Rejected because it is harder for admins to reason about and does not match
  the desired workflow of started/pending/resolved plus append-only response
  events.
- Add both a generic status patch route and a response-event append route.
  Rejected because append-only response events are sufficient for the current
  workflow and keep the API simpler and safer.

## Consequences

**Positive**

- The admin API matches the real workflow more closely than the old
  correspondence phase model.
- Multiple manual responses are supported cleanly through append-only response
  events.
- The unresolved dashboard can be implemented as one list with filters rather
  than multiple competing endpoints.
- The deprecated standalone privileged surface can be removed entirely.

**Negative**

- The admin model now has to be projected from, and coordinated with, the
  existing low-level correspondence runtime state.
- Some threads may have older low-level correspondence phases that need to be
  mapped into the new admin state model.
- The v1 implementation intentionally omits reopen/backward transitions.

## References

- [`src/modules/institution-correspondence/index.ts`](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/modules/institution-correspondence/index.ts)
- [`src/modules/institution-correspondence/core/types.ts`](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/modules/institution-correspondence/core/types.ts)
- [`src/modules/institution-correspondence/shell/repo/institution-correspondence-repo.ts`](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/modules/institution-correspondence/shell/repo/institution-correspondence-repo.ts)
- [`src/modules/learning-progress/shell/rest/campaign-admin-routes.ts`](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts)
- [`src/modules/campaign-admin/shell/rest/authorization.ts`](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/modules/campaign-admin/shell/rest/authorization.ts)
- [`src/app/build-app.ts`](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/app/build-app.ts)
