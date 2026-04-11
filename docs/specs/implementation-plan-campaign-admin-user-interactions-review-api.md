# Implementation Plan: Campaign Admin User Interactions Review API

**Status**: Implemented
**Date**: 2026-04-11
**Author**: Codex
**Spec**: [Campaign Admin User Interactions Review API](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604102107-campaign-admin-user-interactions-review-api.md)

## Implementation update

The follow-on migration removed the legacy learning-progress system-admin route,
its API-key auth/config wiring, and the overlapping
`learning_progress.review_pending` admin-event workflow. References below to
the legacy route or “compatible existing behavior” are historical implementation
context, not current runtime behavior. See
[specs-202604111500-learning-progress-admin-review-migration.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604111500-learning-progress-admin-review-migration.md)
for the current migration record and the remaining intentional gap.

## Goal

Implement a production-ready admin endpoint for campaign-reviewed user
interactions, starting with public-debate requests, with:

- authenticated Clerk-backed campaign-admin authorization
- safe flattened list responses
- durable reviewer attribution in `UserInteractions`
- allowlisted approval/rejection behavior
- targeted tests for auth, redaction, audit, side effects, and pagination

## Scope

Initial implementation scope:

- campaign key:
  - `funky`
- interaction allowlist:
  - `funky:interaction:public_debate_request`
  - `funky:interaction:city_hall_website`
- routes:
  - `GET /api/v1/admin/campaigns/:campaignKey/user-interactions`
  - `GET /api/v1/admin/campaigns/:campaignKey/user-interactions/meta`
  - `POST /api/v1/admin/campaigns/:campaignKey/user-interactions/reviews`

Out of scope for this implementation:

- generic admin-event trigger/replay APIs
- CSV download endpoint
- generic support for all interaction types
- deep correspondence inspection from this endpoint

## Implemented Scope Updates

The shipped implementation expanded beyond the original single-interaction v1
scope in the following ways:

- multiple allowlisted reviewable interaction types are now supported for
  `funky`
- selector metadata is exposed through `/user-interactions/meta`
- safe queue rows now include:
  - `websiteUrl`
  - `entityName`
  - `interactionElementLink`
- queue projections now distinguish interaction-specific enrichment:
  - public debate requests retain institution-email and thread-summary behavior
  - city hall website records project website URLs without thread summaries

This implementation status should be treated as the current source of truth for
the shipped API surface, with the spec continuing to govern future changes.

## Workstreams

### 1. Reviewer attribution in learning-progress domain types

Files to update:

- `src/modules/learning-progress/core/types.ts`
- `src/infra/database/user/types.ts`
- `src/modules/learning-progress/shell/rest/admin-schemas.ts`
- `src/modules/learning-progress/shell/rest/schemas.ts`
- tests covering review serialization

Changes:

- extend stored review metadata with:
  - `reviewedByUserId?: string`
  - `reviewSource?: 'campaign_admin_api' | 'learning_progress_admin_api'`
- extend evaluated audit events with:
  - `actor: 'system' | 'admin'`
  - `actorUserId?: string`
  - `actorSource?: 'campaign_admin_api' | 'learning_progress_admin_api'`
- preserve backward compatibility for existing rows that do not have these
  fields

Acceptance:

- old rows still deserialize
- new admin reviews persist reviewer identity

### 2. Review write path with explicit actor metadata

Files to update:

- `src/modules/learning-progress/core/usecases/update-interaction-review.ts`
- `src/modules/learning-progress/core/usecases/submit-interaction-reviews.ts`
- `src/modules/learning-progress/shell/rest/admin-routes.ts`

Changes:

- add optional actor metadata input to `updateInteractionReview(...)`
- default existing automation/API-key route behavior to:
  - `actor = 'system'`
  - `actorSource = 'learning_progress_admin_api'`
- allow the new campaign-admin route to write:
  - `actor = 'admin'`
  - `actorUserId = authenticated user id`
  - `actorSource = 'campaign_admin_api'`

Acceptance:

- existing learning-progress admin route behavior remains compatible
- campaign-admin reviews capture reviewer identity

### 3. Clerk-backed campaign admin permission checker

Files to add or update:

- new checker in learning-progress shell or shared security location
- `src/app/build-app.ts`
- tests for permission checker behavior

Changes:

- use the same strategy as advanced-map:
  - Clerk `private_metadata.permissions`
  - caching
  - timeout
  - fail closed
- permission name:
  - `campaign:funky_admin`

Acceptance:

- unauthenticated requests get `401`
- authenticated requests without permission get `403`
- Clerk failures deny access

### 4. Safe admin projection query for public-debate requests

Files to add or update:

- `src/modules/learning-progress/core/ports.ts`
- `src/modules/learning-progress/shell/repo/learning-progress-repo.ts`
- new route schemas and formatter helpers

Changes:

- add a dedicated repository method for campaign-admin listing
- constrain results to the allowlisted interaction id for `funky`
- support review filters:
  - `phase`
  - `reviewStatus`
  - `interactionId`
  - `lessonId`
  - `entityCui`
  - `scopeType`
  - `payloadKind`
  - `submissionPath`
  - `userId`
  - `recordKeyPrefix`
  - `submittedAtFrom`
  - `submittedAtTo`
  - `updatedAtFrom`
  - `updatedAtTo`
- implement keyset pagination on:
  - `updatedAt DESC`
  - `userId ASC`
  - `recordKey ASC`
- return a safe flattened projection only

Initial safe summary fields:

- `userId`
- `recordKey`
- `campaignKey`
- `interactionId`
- `lessonId`
- `entityCui`
- `phase`
- `reviewStatus`
- `submittedAt`
- `createdAt`
- `updatedAt`
- `reviewedAt`
- `reviewedByUserId`
- `reviewSource`
- `feedbackText`
- `payloadKind`
- `adminSummary`
- `riskFlags`
- audit counters and timestamps

Redaction rules:

- do not return raw `record.value`
- do not return raw `auditEvents`
- do not return `ngoSenderEmail`
- do not return `preparedSubject`
- do not return legal-representative details

Acceptance:

- pending public-debate requests are listable without exposing raw payloads
- filters behave exactly and pagination is stable

### 5. Correspondence monitoring enrichment

Files to add or update:

- new route-level enrichment helper
- `src/modules/institution-correspondence/core/ports.ts` only if needed
- tests

Changes:

- enrich public-debate list items with a minimal thread summary when a
  platform-send thread exists for the same entity and campaign:
  - `threadId`
  - `threadPhase`
  - `lastEmailAt`
  - `lastReplyAt`
  - `nextActionAt`
- keep this summary minimal and do not embed the thread record or message
  bodies

Acceptance:

- admins can tell whether approval led to a thread and current thread phase
- no full correspondence content is exposed

### 6. Campaign-admin route implementation

Files to add or update:

- new route module under learning-progress shell/rest
- `src/modules/learning-progress/index.ts`
- `src/app/build-app.ts`

Changes:

- register authenticated campaign-admin routes
- validate `campaignKey`
- enforce allowlisted interaction ids for that campaign
- use the dedicated review list query
- use the updated review write path with reviewer attribution
- keep side effects server-derived through the existing public-debate approval
  preflight path

Acceptance:

- list and review flows work end-to-end with auth and permission checks

### 7. Database/index support

Files to update:

- new user DB migration under `src/infra/database/user/migrations/`

Changes:

- add targeted partial/expression indexes for public-debate review queue access
- prioritize:
  - allowlisted public-debate interaction filtering
  - entity-based triage
  - submission-path filtering
  - updated-at ordered scans

Acceptance:

- the new query has a clear index path for the main pending queue filters

### 8. Tests

Files to add or update:

- new campaign-admin integration test file
- unit tests for permission/auth and review attribution
- existing review tests where actor metadata changed

Must cover:

- `401` unauthenticated
- `403` authenticated without permission
- Clerk lookup fail-closed
- allowlisted interaction-only exposure
- raw payload redaction
- list filters and keyset pagination
- reviewer attribution persisted in review and audit event
- approve happy path with public-debate side effects
- reject path with feedback
- stale update conflict
- no duplicate send on repeated review attempts

## Suggested Order

1. Extend learning-progress types and review write path for reviewer metadata.
2. Add the Clerk-backed campaign admin permission checker.
3. Build the safe projection repository method and route schemas.
4. Implement the new campaign-admin routes and wire them in `build-app.ts`.
5. Add minimal correspondence summary enrichment.
6. Add the DB migration for targeted indexes.
7. Add and run focused tests.

## Verification Commands

- `pnpm test -- --run tests/integration/learning-progress-admin-review-rest.test.ts`
- `pnpm test -- --run tests/integration/institution-correspondence-admin-rest.test.ts`
- `pnpm test -- --run tests/integration/public-debate-request-dispatch-rest.test.ts`
- `pnpm test -- --run tests/integration/advanced-map-analytics-rest.test.ts`
- `pnpm lint`
- `pnpm typecheck`

## Review Focus

After implementation, hand the same plan and spec to:

- a security review agent
- a system design review agent
- a code review agent

They should specifically assess:

- privilege boundary correctness
- least-privilege data exposure
- concurrency and side-effect safety
- query/index design
- API and type compatibility
