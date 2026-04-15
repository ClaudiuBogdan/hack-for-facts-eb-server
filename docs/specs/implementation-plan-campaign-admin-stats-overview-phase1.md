# Implementation Plan: Campaign Admin Stats Overview Phase 1

**Status**: Draft
**Date**: 2026-04-15
**Author**: Codex
**Spec**: [Campaign Admin Marketing Stats Layer](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604151141-campaign-admin-marketing-stats-layer.md)

## Goal

Implement the first production-ready analytics slice from the campaign-admin
stats specification, using only current authoritative backend state.

This phase delivers a dedicated stats module and a single overview endpoint that
aggregates existing operational signals into one sanitized analytics response.

## Target Scope

Initial implementation scope:

- new module:
  - `src/modules/campaign-admin-stats`
- new authenticated route:
  - `GET /api/v1/admin/campaigns/:campaignKey/stats/overview`
- supported campaign keys:
  - `funky`
- allowed data sources:
  - `userinteractions`
  - `notifications`
  - `notificationsoutbox`
  - `resend_wh_emails`
  - existing campaign-admin meta queries and repos
- route response sections:
  - `coverage`
  - `users`
  - `interactions`
  - `entities`
  - `notifications`

Target response shape for v1:

- `coverage`
  - `hasClientTelemetry`
  - `hasNotificationAttribution`
- `users`
  - `totalUsers`
  - `usersWithPendingReviews`
- `interactions`
  - current campaign-admin interaction aggregate counts derived from existing
    reviewable and visible interaction config
- `entities`
  - current campaign-admin entity meta counts
- `notifications`
  - pending delivery count
  - failed delivery count
  - delivered count
  - opened count
  - clicked count
  - suppressed or bounced count where derivable safely

## Out of Scope

Do not implement in this phase:

- client telemetry ingestion
- `campaign.discovered`, `content.viewed`, `challenge.started`, active time, or
  revisit retention metrics
- broad append-only analytics event storage unless needed by the selected
  implementation and explicitly justified
- embedding analytics into existing `/users`, `/entities`, `/notifications`, or
  `/user-interactions` list endpoints
- raw correspondence analytics
- any analytics response that exposes raw email, raw click URL, or raw
  operational payload content
- CSV export, time-series drilldowns, cohort retention routes, or entity deep
  analytics routes

## Hard Constraints

### Architecture

- follow the existing dedicated stats-module pattern used by
  `campaign-subscription-stats`
- keep analytics route schemas separate from operational admin schemas
- do not reuse operational DTOs from:
  - `learning-progress` campaign-admin routes
  - `campaign-admin-entities`
  - `campaign-admin-notifications`
  - `institution-correspondence`
- fail closed on auth and permission checks using the existing campaign-admin
  permission authorizer

### Data provenance

- phase 1 may only use current authoritative server-side state
- do not imply support for client telemetry metrics that the backend does not
  capture yet
- any metric not derivable from current data must be omitted, nullable, or
  explicitly marked unavailable

### Privacy and security

- analytics may expose only `user_id` and allowlisted summary fields
- never expose:
  - user email addresses
  - institution email addresses
  - notification recipient addresses
  - email subject, html, or text content
  - correspondence message bodies, headers, attachments, or notes
  - raw click URLs or unsubscribe URLs
  - raw interaction payload JSON
- if click data is exposed at all in this phase, expose only aggregate counts
- analytics queries must return sanitized DTOs only

### Numeric rules

- do not introduce float API fields
- use integers, integer basis points, or decimal strings only
- prefer counts in v1; add rates only if they can be expressed safely and
  clearly

## Deliverables

### 1. New module scaffold

Add a dedicated module with the usual boundaries:

- `core/types.ts`
- `core/ports.ts`
- `core/errors.ts`
- `core/usecases/get-campaign-admin-stats-overview.ts`
- `shell/rest/routes.ts`
- `shell/rest/schemas.ts`
- `shell/repo/campaign-admin-stats-repo.ts`
- `index.ts`

### 2. Dedicated overview route

Implement:

- `GET /api/v1/admin/campaigns/:campaignKey/stats/overview`

Requirements:

- same campaign-admin auth boundary as the existing campaign admin routes
- same `funky` permission model
- response contains only sanitized stats DTOs
- response is stable and documented

### 3. Repo-backed notification engagement counts

Add a stats-repo query for notification engagement that safely derives:

- delivered deliveries
- opened deliveries
- clicked deliveries
- suppressed or bounced deliveries

Requirements:

- correlate `notificationsoutbox` with `resend_wh_emails` using safe provider
  identifiers only
- count deliveries, not raw webhook rows, when open or click events are joined
- do not surface raw provider payloads

### 4. Build-app wiring

Register the new stats routes in `src/app/build-app.ts` only when campaign-admin
wiring is available.

### 5. Tests

Add targeted tests for:

- route auth and permission enforcement
- privacy boundary and redaction
- happy-path aggregate response
- notification open and click aggregation behavior
- unsupported campaign and validation behavior

## Workstreams

### 1. Core contract and DTO design

Files:

- `src/modules/campaign-admin-stats/core/*`
- `src/modules/campaign-admin-stats/shell/rest/schemas.ts`

Changes:

- define the sanitized overview response schema
- define explicit nullable or unavailable fields if needed
- define a narrow repo contract for overview aggregates

Acceptance:

- DTOs cannot represent raw email or raw payload content
- response sections map cleanly to current authoritative sources

### 2. Repo implementation

Files:

- `src/modules/campaign-admin-stats/shell/repo/campaign-admin-stats-repo.ts`

Changes:

- implement overview aggregate queries or orchestration needed for:
  - user meta counts
  - interaction aggregate counts
  - entity meta counts
  - notification delivery and engagement counts
- use statement timeout if the implementation runs direct SQL
- keep query boundaries explicit and easy to test

Acceptance:

- counts are derivable without client telemetry
- notification engagement counts are delivery-based and sanitized

### 3. Route implementation

Files:

- `src/modules/campaign-admin-stats/shell/rest/routes.ts`
- `src/app/build-app.ts`

Changes:

- register the overview route
- use the existing campaign-admin auth hook pattern
- return `401`, `403`, `404`, and `500` consistently

Acceptance:

- unauthenticated requests fail with `401`
- authenticated requests without campaign permission fail with `403`
- unsupported campaigns fail closed

### 4. Security and privacy verification

Files:

- route tests
- repo tests where relevant

Checks:

- no raw email addresses in the response
- no raw click URLs in the response
- no raw interaction payloads in the response
- no operational DTO reuse that accidentally leaks content-rich fields

Acceptance:

- tests prove the overview route remains sanitized even when source tables
  contain richer data

## Test Requirements

Minimum required automated coverage:

- unit tests for schema shaping or mapper helpers
- integration tests for the new route
- repo tests for any non-trivial SQL aggregation logic

Suggested test cases:

- authorized request returns overview sections with expected counts
- response includes `coverage.hasClientTelemetry = false`
- response includes notification delivered, opened, and clicked counts without
  revealing click URLs
- response never contains:
  - `institutionEmail`
  - `toEmail`
  - `renderedSubject`
  - `renderedHtml`
  - `renderedText`
  - `clickLink`
- unsupported campaign key is rejected
- permission denial is enforced

## Security Review Requirements

Before this phase is considered done, verify:

- the route cannot be reached without existing campaign-admin permissions
- the repo does not join raw rich-content fields into response mappers
- raw `resend_wh_emails` rows are not returned
- the overview schema cannot accidentally grow by serializing unknown database
  metadata
- all returned fields are explicitly allowlisted

## Acceptance Criteria

The phase is complete when:

- the overview route is live behind existing campaign-admin auth
- the response is fully sanitized and documented
- notification engagement counts are available in aggregate form
- tests cover auth, validation, aggregation, and privacy constraints
- no existing operational admin route contract is widened to include deep
  analytics data

## References

- [specs-202604151141-campaign-admin-marketing-stats-layer.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604151141-campaign-admin-marketing-stats-layer.md)
- [implementation-plan-campaign-admin-user-interactions-review-api.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/implementation-plan-campaign-admin-user-interactions-review-api.md)
- [src/modules/campaign-subscription-stats/shell/rest/routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-subscription-stats/shell/rest/routes.ts:1)
- [src/modules/campaign-subscription-stats/shell/repo/campaign-subscription-stats-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-subscription-stats/shell/repo/campaign-subscription-stats-repo.ts:1)
