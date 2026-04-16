# Implementation Plan: Campaign Admin Institution Threads API

**Status**: Draft
**Date**: 2026-04-16
**Author**: Codex
**Spec**: [Campaign Admin Institution Threads API](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/docs/specs/specs-202604160837-campaign-admin-institution-threads-api.md)

## Goal

Implement a clean, secure, and reliable campaign-admin institution-thread API
for `funky` that exposes the new admin workflow model:

- `threadState = started | pending | resolved`
- `currentResponseStatus = null | registration_number_received | request_confirmed | request_denied`
- append-only manual `responseEvents[]`

The implementation must supersede the current draft phase-driven admin design
in the worktree and remove the deprecated standalone correspondence admin
surface.

## Target Scope and Objectives

### In scope

- supported campaign key:
  - `funky`
- supported thread scope:
  - `platform_send` public-debate threads only
- routes:
  - `GET /api/v1/admin/campaigns/:campaignKey/institution-threads`
  - `GET /api/v1/admin/campaigns/:campaignKey/institution-threads/:threadId`
  - `POST /api/v1/admin/campaigns/:campaignKey/institution-threads/:threadId/responses`
- list filters:
  - `stateGroup`
  - `threadState`
  - `responseStatus`
  - `query`
  - `entityCui`
  - `updatedAtFrom`
  - `updatedAtTo`
  - `latestResponseAtFrom`
  - `latestResponseAtTo`
- persistence updates:
  - append manual admin response events
  - persist enough state to expose `threadState`, `currentResponseStatus`, and
    response history reliably
- deprecated-surface retirement:
  - unregister old `/api/v1/admin/institution-correspondence/*` routes
  - remove old auth-bypass path handling
  - remove standalone admin auth/config/env wiring for the retired route family

### Out of scope

- `self_send_cc` threads
- unmatched inbound email triage
- attaching stored webhook emails to threads
- manual outbound email sending or composition
- separate started/unresolved APIs
- CSV export
- reopen / backward transitions
- entity-name full-text search

### Concrete objectives

1. Replace the current unmerged phase-driven admin action model in the worktree
   with the simpler admin workflow model from the spec.
2. Expose one list API that can support started, pending, resolved, and
   unresolved/open dashboard views through filters.
3. Support append-only manual response events with strict transition
   validation.
4. Keep the existing low-level correspondence engine working internally while
   projecting the new admin state model on top of it.
5. Keep the admin DTOs minimal and safe: no raw transport fields, no raw
   metadata, no `htmlBody`.

## Constraints and Limitations

### Architecture constraints

- Keep thread ownership in `src/modules/institution-correspondence`.
- Reuse the shared campaign-admin authorization pattern rather than adding a
  new auth mechanism.
- The low-level correspondence runtime phases remain internal; do not try to
  redesign the whole correspondence engine in this change.
- Prefer rewriting the current draft admin route/use-case layer in place over
  creating a second competing admin implementation in the same worktree.

### Domain constraints

- The admin API source of truth is:
  - latest appended manual response event, when present
  - otherwise a projection from existing low-level thread state
- Manual response events are append-only.
- `resolved` threads reject further manual response events in v1.
- Multiple manual response events are allowed while the thread is still
  `started` or `pending`.
- The admin API must not expose low-level runtime phases directly.
- Once any admin response event exists, low-level runtime phase is
  compatibility-only and must not override admin state.
- Low-level `failed` threads are excluded from v1 admin scope.

### Simplicity constraints

- Do not keep the old action names:
  - `mark_reply_received`
  - `review_reply`
  - `close_no_response`
  - `reopen_awaiting_reply`
    in the new admin API.
- Do not add a generic patch endpoint.
- Do not introduce a separate write route for status-only transitions.
- Prefer one append-response route that drives validated state transitions.

### Compatibility constraints

- Existing stored threads may already have low-level phases such as
  `reply_received_unreviewed`, `manual_follow_up_needed`,
  `resolved_positive`, `resolved_negative`, or `closed_no_response`.
- The new admin API must define a deterministic projection from those low-level
  states into:
  - `started`
  - `pending`
  - `resolved`
- Any compatibility mapping used internally must stay out of the public admin
  contract.

## Security Requirements

### Authentication and authorization

- Require the existing session-authenticated campaign-admin flow.
- Reuse the existing Clerk permission authorizer and fail closed if wiring is
  missing.
- All routes must enforce campaign scope and `platform_send` scope.
- Out-of-scope thread ids return `404`, not a partial leak.

### Data minimization

- Responses must use explicit DTOs, not reused raw correspondence formatters.
- Never expose:
  - `threadKey`
  - raw `headers`
  - raw entry `metadata`
  - `htmlBody`
  - `toAddresses`
  - `ccAddresses`
  - `bccAddresses`
  - provider-send metadata
  - raw webhook payloads
  - `captureAddress`
- Optional response fields must use stable nullability instead of omission.

### Input validation

- Reject unknown query params and invalid request bodies.
- Validate `responseStatus` strictly against the allowlist.
- Require non-empty trimmed `messageContent`.
- Validate `responseDate` as a date-time.
- Enforce `expectedUpdatedAt` optimistic concurrency on every write.

### Integrity and lifecycle safety

- The write path must be atomic:
  - lock the thread row
  - verify campaign/scope
  - verify `expectedUpdatedAt`
  - append the response event
  - update any internal compatibility state needed for consistency
  - return the final updated thread
  - all in one transaction
- Valid state transitions:
  - `started + registration_number_received -> pending`
  - `started + request_confirmed -> resolved`
  - `started + request_denied -> resolved`
  - `pending + registration_number_received -> pending`
  - `pending + request_confirmed -> resolved`
  - `pending + request_denied -> resolved`
  - `resolved + any -> 409`
- Invalid transitions must fail clearly with `409`.

### Deprecated surface removal

- Remove route registration for the old standalone correspondence admin routes.
- Remove request-path auth bypass logic for the deprecated prefix.
- Remove the standalone correspondence admin API key env/config wiring.
- Deployment/runtime config must stop supplying the retired correspondence admin
  API key after this lands.

## Deliverables

### 1. Revised domain contracts

Add or update:

- `src/modules/institution-correspondence/core/types.ts`
- `src/modules/institution-correspondence/core/ports.ts`
- new helpers/use cases under `src/modules/institution-correspondence/core/`

Deliver:

- typed optional `record.adminWorkflow` schema
- typed admin response-event schema
- typed admin state projection model
- typed list/detail DTO contracts
- typed append-response input/output contracts
- compatibility mapping helpers from low-level thread state to admin state

### 2. Revised repo support

Update:

- `src/modules/institution-correspondence/shell/repo/institution-correspondence-repo.ts`

Deliver:

- campaign-admin list query aligned to:
  - `stateGroup`
  - `threadState`
  - `responseStatus`
  - `query`
  - date filters
- detail lookup for campaign-scoped `platform_send` threads
- one atomic append-response mutation path

### 3. Revised campaign-admin REST surface

Update:

- `src/modules/institution-correspondence/shell/rest/*`
- `src/modules/institution-correspondence/index.ts`

Deliver:

- list route
- detail route
- append-response route
- explicit DTO formatters
- explicit TypeBox schemas
- no `htmlBody` in v1 request or response DTOs
- no recipient arrays in v1 correspondence DTOs

### 4. App and config cleanup

Update:

- `src/app/build-app.ts`
- `src/infra/config/env.ts`

Deliver:

- new route registration only under campaign-admin wiring
- removal of deprecated standalone route registration
- removal of deprecated path-based auth bypass logic
- removal of deprecated correspondence admin env/config wiring

### 5. Test suite updates

Add or update:

- unit tests for state projection and append-response transitions
- integration tests for new route behavior
- repo/e2e tests for query behavior and atomic append-response persistence
- tests covering deprecated-surface removal

## Workstreams

### 1. Replace the draft admin state/action model

Files:

- current draft admin use cases, schemas, formatters, and route files in
  `src/modules/institution-correspondence/`

Changes:

- remove the draft admin action model based on:
  - `mark_reply_received`
  - `review_reply`
  - `close_no_response`
  - `reopen_awaiting_reply`
- replace it with:
  - admin state projection helpers
  - append-response use case
  - response-event DTOs
  - `record.adminWorkflow` persistence

Acceptance:

- no new public route or schema exposes the old draft action names
- the admin API contract reflects the new strategy, not the superseded draft

### 2. Admin state projection

Files:

- `src/modules/institution-correspondence/core/types.ts`
- new projection helper(s)

Changes:

- define:
  - `record.adminWorkflow.currentResponseStatus`
  - `record.adminWorkflow.responseEvents[]`
  - `threadState`
  - `currentResponseStatus`
  - `responseEvents`
- define deterministic projection rules:
  - latest appended manual response event wins when present
  - once an admin response event exists, low-level runtime phase never
    overrides admin state
  - otherwise unresolved low-level reply/follow-up states project to `pending`
  - otherwise terminal low-level states project to `resolved`
  - otherwise `started`
  - `failed` low-level threads are excluded from v1 scope
- define latest semantics:
  - append order is authoritative
  - `latestResponseAt` equals the latest appended event's `responseDate`
  - `responseEvents` return oldest first

Acceptance:

- projection behavior is deterministic and unit-tested
- older stored threads can still be represented safely through the new admin
  model
- older records remain readable without backfill

### 3. Append-response mutation path

Files:

- new append-response use case
- repo mutation path

Changes:

- append a typed manual response event
- enforce the allowed transition matrix
- derive and persist resulting admin state fields or equivalent internal
  compatibility state
- persist the event under `record.adminWorkflow.responseEvents[]`
- persist `record.adminWorkflow.currentResponseStatus`
- return the final updated thread DTO and `createdResponseEventId`

Acceptance:

- writes are atomic
- `resolved` threads reject new manual response events
- multiple manual responses are allowed for `started` and `pending`

### 4. List/detail query implementation

Files:

- repo query helpers
- route-level formatters

Changes:

- implement list filtering by:
  - `stateGroup`
  - `threadState`
  - `responseStatus`
  - `query`
  - date filters
- reject contradictory `stateGroup` + `threadState` combinations with `400`
- keep one fixed order:
  - `updatedAt desc`
  - `id asc`
- expose one list/table data model for the admin UI
- keep entity-name enrichment best-effort:
  - warning log on lookup failure
  - `entityName = null`

Acceptance:

- unresolved/open dashboard views can be built from the single list route
- started-only and resolved-only views can be built from filters
- no raw/internal data leaks into list or detail DTOs

### 5. Deprecated-surface retirement

Files:

- `src/app/build-app.ts`
- `src/infra/config/env.ts`
- retired standalone rest files and related tests

Changes:

- remove the deprecated standalone correspondence admin routes
- remove deprecated auth bypass checks
- remove deprecated env/config fields and tests

Acceptance:

- old standalone routes are not reachable
- no request-path auth exemption remains for the retired prefix
- deprecated correspondence admin config is gone

## Testing Strategy

### Unit tests

Primary targets:

- admin state projection helpers
- response-event append use case
- transition validation
- append-only response event persistence semantics
- DTO formatter redaction

Must cover:

- `started -> pending` on `registration_number_received`
- `started -> resolved` on `request_confirmed`
- `started -> resolved` on `request_denied`
- `pending -> pending` on `registration_number_received`
- `pending -> resolved` on terminal statuses
- `resolved -> any` rejected
- low-level phase fallback projection when no manual response event exists
- low-level phase ignored once a manual response event exists
- `failed` threads excluded from v1 scope
- `htmlBody` absent from DTOs
- `responseEvents` returned oldest first
- `latestResponseAt` derived from the latest appended event's `responseDate`

### Integration tests

Primary targets:

- list route auth and permission behavior
- detail route scope checks and redaction
- append-response route behavior and response shape
- deprecated-route removal

Must cover:

- `401` unauthenticated
- `403` authenticated without permission
- `404` unsupported campaign
- `404` thread id exists but belongs to another campaign or submission path
- `404` thread id exists but low-level phase is `failed`
- list filters for:
  - `stateGroup`
  - `threadState`
  - `responseStatus`
- contradictory `stateGroup` + `threadState` gives `400`
- `responseStatus` filter matches only `currentResponseStatus`, not low-level
  fallback projection
- append-response success cases
- invalid transition `409`
- deprecated `/api/v1/admin/institution-correspondence/*` unreachable

### E2E / repo-backed tests

Use repo/e2e tests for:

- stable pagination
- correct `totalCount`
- state-filter query semantics
- atomic append-response persistence
- stale `expectedUpdatedAt` rejection on the real DB path
- manual-response precedence over low-level phase on the real DB path

The repo-backed coverage for this feature must remain part of normal validation,
not just an optional local-only suite.

## Acceptance Criteria

- The old draft phase-driven admin API contract is replaced by the new admin
  state model.
- The deprecated standalone correspondence admin route family is removed.
- The deprecated correspondence admin env/config wiring is removed.
- The new list API supports one-table admin UX via filters for started,
  pending, resolved, and open/closed views.
- The detail API returns safe correspondence content plus append-only admin
  response history.
- The write API appends manual response events and enforces the allowed
  transition matrix.
- `resolved` threads reject new manual response events.
- Multiple manual response events are allowed for `started` and `pending`
  threads.
- Once any admin response event exists, it is authoritative over low-level
  phase for admin state projection.
- No `htmlBody`, raw headers, raw metadata, provider metadata, `threadKey`, or
  raw webhook payloads or recipient arrays appear in the admin DTOs.
- Unit, integration, and repo-backed tests cover the critical behavior and pass.

## Definition of Done

- Spec and plan are implemented, not the superseded draft model.
- The new admin routes are wired and exported cleanly.
- Deprecated standalone correspondence admin wiring is removed.
- Validation commands are run and passing, or any blocker is documented
  explicitly before closing:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `pnpm test:e2e`
  - `pnpm run ci`
- The implementation has been reviewed against the revised spec.
- Review findings are fixed.
- Final verification confirms no known security regression in the new admin
  surface.

## References

- [Campaign Admin Institution Threads API](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/docs/specs/specs-202604160837-campaign-admin-institution-threads-api.md)
- [src/modules/institution-correspondence/index.ts](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/modules/institution-correspondence/index.ts)
- [src/modules/institution-correspondence/core/types.ts](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/modules/institution-correspondence/core/types.ts)
- [src/modules/institution-correspondence/shell/repo/institution-correspondence-repo.ts](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/modules/institution-correspondence/shell/repo/institution-correspondence-repo.ts)
- [src/modules/campaign-admin/shell/rest/authorization.ts](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/modules/campaign-admin/shell/rest/authorization.ts)
- [src/app/build-app.ts](/Users/claudiuconstantinbogdan/.codex/worktrees/a4ae/hack-for-facts-eb-server/src/app/build-app.ts)
