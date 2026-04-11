# Campaign Admin User Interactions Review API

**Status**: Accepted
**Date**: 2026-04-11
**Author**: Codex

## Implementation update

The legacy learning-progress system-admin review route and its dedicated
`learning_progress.review_pending` queue workflow were removed on 2026-04-11.
This document remains the design reference for the campaign-admin API, but any
references below to `/api/v1/admin/learning-progress/reviews` describe the
pre-migration baseline, not the current shipped surface. See
`docs/specs/specs-202604111500-learning-progress-admin-review-migration.md`
for the removal record and the intentional post-migration gap.

## Problem

The server already stores reviewable campaign submissions in `UserInteractions`,
but the current admin surface is not suitable for a browser-based campaign admin
client.

The main gaps are:

- the current learning-progress admin review routes are protected by a shared
  API key instead of authenticated user sessions plus scoped admin permissions
- the current review write path records `evaluated` audit events as
  `actor: 'system'`, so the system does not durably capture which admin made
  the decision
- the current admin response shape returns the full `record` and full
  `auditEvents`, which is too broad for a high-risk admin UI because it can
  expose raw user-submitted JSON, free text, URLs, and other sensitive content
- `UserInteractions` is a generic store for many user-controlled records, so a
  generic "list all interactions" admin endpoint would create an unnecessary
  cross-campaign data-exposure surface
- the current listing path supports only a narrow filter set and offset-based
  pagination; it is not designed for a production review queue or CSV-like
  operational export
- approvals can trigger institution-email side effects, but the current route
  does not provide a campaign-admin-safe monitoring projection for related send
  and thread state

Without a dedicated design, the admin client would either reuse an automation-
oriented API-key endpoint or fall back to raw SQL-like projections. Both would
be risky and hard to evolve safely.

## Context

- `UserInteractions` is the canonical per-user store for interactive records
  and inline audit history:
  - `record` stores the latest lifecycle snapshot
  - `audit_events` stores append-only interaction history
- review-required interactions are already modeled in the learning-progress
  module:
  - `listInteractionReviews(...)`
  - `submitInteractionReviews(...)`
  - `updateInteractionReview(...)`
- the current learning-progress admin routes live at:
  - `GET /api/v1/admin/learning-progress/reviews`
  - `POST /api/v1/admin/learning-progress/reviews`
- the public debate request flow already uses pending interaction review as a
  safety boundary:
  - invalid institution email is rejected automatically
  - valid but mismatched institution email is held in `pending`
  - an approval can trigger platform send side effects through
    `prepareApprovedPublicDebateReviewSideEffects(...)`
- the advanced-map modules already establish the preferred privileged-boundary
  pattern for user-facing admin features:
  - authenticate the user session with `requireAuthHandler`
  - check a Clerk `private_metadata.permissions` entry
  - enforce the privileged permission only at the risky write/read boundary
  - fail closed when the Clerk lookup fails
- the repo already has an `admin-events` module for queue-backed review work.
  That module is the right future home for explicit re-scan and retry tooling,
  but the immediate need here is a campaign-admin HTTP surface over canonical
  user interactions.
- the data-minimization direction in
  `docs/specs/specs-202604012011-personal-data-minimization-strategy.md`
  explicitly warns against copying user-submitted and correspondence data into
  secondary read models and metadata blobs.

Important current gaps discovered in the codebase:

- `updateInteractionReview(...)` writes `actor: 'system'` for reviewed
  interactions, so reviewer attribution is currently lost
- `reviewReply(...)` on institution threads also stores only review notes and
  timestamp, not reviewer identity
- `docs/specs/specs-202603311900-institution-email-flow.md` says mismatch
  review metadata should exist, but the current public-debate handler only logs
  the mismatch and leaves the row pending without a durable hold-reason field
- the institution-correspondence admin routes currently expose full
  correspondence bodies and headers, which reinforces the need for stronger
  field-level minimization on any new admin endpoint

Additional implementation-review findings captured on 2026-04-11:

- the new campaign-admin route now stores reviewer identity in the canonical
  `UserInteractions` row:
  - `record.review.reviewedByUserId`
  - `record.review.reviewSource`
  - appended `audit_events[].actorUserId`
  - appended `audit_events[].actorPermission`
  - appended `audit_events[].actorSource`
- public progress sync correctly rejects direct client authorship of
  `record.review` and non-user audit events, and public read models correctly
  redact reviewer identity before returning snapshots and deltas
- however, the current public sync behavior still allows a user to submit a
  newer `resolved` or `failed` record snapshot after admin review and keep the
  stored review metadata attached to the modified payload; this breaks the
  guarantee that an approval or rejection refers to an immutable reviewed
  submission
- the legacy API-key route at `/api/v1/admin/learning-progress/reviews`
  remains less complete than the new campaign-admin route because it still
  records reviews as generic `system` actions without a durable
  `learning_progress_admin_api` source marker
- the campaign-admin queue scope remains intentionally narrower than the full
  client interaction inventory; only interaction types with an explicit safe
  projection are in scope
- the fail-closed route-mounting and plugin-level authorization boundary is
  specified separately in
  `docs/specs/specs-202604110932-campaign-admin-fail-closed-authorization.md`

## Decision

Add a dedicated campaign-admin REST surface for reviewable user interactions,
with Clerk-backed campaign admin permissions, field-level safe projections, and
durable reviewer attribution in `UserInteractions`.

### 1. Authenticate with user sessions and a Clerk-backed campaign admin permission

Do not reuse the shared admin API key pattern for the new admin client flow.

The new routes should:

- use the existing auth middleware plus `requireAuthHandler`
- use a Clerk-backed permission lookup patterned after
  `makeClerkAdvancedMapDatasetWritePermissionChecker(...)`
- fail closed on missing config, Clerk HTTP errors, invalid Clerk payloads, or
  permission cache lookup errors
- fail startup when the campaign-admin API is enabled without the required
  session-auth wiring or user DB support

The required permission string for the public-debate campaign is:

- `campaign:funky_admin`

The permission lives in Clerk `private_metadata.permissions`, for example:

```json
{
  "permissions": ["campaign:funky_admin"]
}
```

This is intentionally a dedicated campaign-admin permission. It must not reuse:

- `advanced_map:public_write`
- a global "admin" bypass
- organization membership inference

### 2. Scope the endpoint to campaign-reviewed interactions, not all user interactions

The new surface must not expose the entire generic `UserInteractions` table.

Instead, each campaign defines an allowlist of reviewable interaction types and
their safe admin projection rules.

Current allowlist:

- `funky:interaction:public_debate_request`
- `funky:interaction:city_hall_website`

Rules:

- the route is parameterized by `campaignKey`
- the server internally constrains the query to interaction ids registered for
  that campaign
- interactions without an explicit admin projection are excluded from the API
- future campaign-specific interaction types may be added only by code changes,
  not by client-provided filter values alone
- each interaction type owns a projection strategy:
  - `public_debate_request` keeps institution-email and thread-summary
    enrichment
  - `city_hall_website` projects a website URL and intentionally keeps thread
    summary fields null

This keeps the privileged boundary aligned with product intent instead of
turning the endpoint into a generic inspection tool for all synced user data.

### 3. Add a safe list endpoint with keyset pagination and review-oriented filters

Add a route shaped like:

- `GET /api/v1/admin/campaigns/:campaignKey/user-interactions`
- `GET /api/v1/admin/campaigns/:campaignKey/user-interactions/meta`

Use keyset pagination, not offset pagination, with the stable sort:

- `updatedAt DESC`
- `userId ASC`
- `recordKey ASC`

The response should return a flattened, CSV-friendly projection rather than the
raw `LearningProgressRecordRow`.

Required filters:

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

Recommended derived filters for public debate:

- `hasInstitutionThread`
- `threadPhase`
- `riskFlag`

The list item should contain only safe review columns, for example:

- identity and routing:
  - `userId`
  - `recordKey`
  - `campaignKey`
  - `interactionId`
  - `lessonId`
  - `entityCui`
  - `entityName`
- lifecycle:
  - `phase`
  - `reviewStatus`
  - `submittedAt`
  - `createdAt`
  - `updatedAt`
  - `reviewedAt`
- reviewer summary:
  - `reviewedByUserId`
  - `reviewSource`
- review notes:
  - `feedbackText`
- projection:
  - `payloadKind`
  - `institutionEmail`
  - `websiteUrl`
  - `riskFlags`
  - `interactionElementLink`
- related correspondence summary when applicable:
  - `threadId`
  - `threadPhase`
  - `lastEmailAt`
  - `lastReplyAt`
  - `nextActionAt`
- audit summary:
  - `submittedEventCount`
  - `evaluatedEventCount`
  - `lastAuditAt`

The list endpoint must not return by default:

- raw `record.value`
- raw `record.result.response`
- full `auditEvents`
- arbitrary JSON payload blobs
- free-text bodies from institution correspondence
- raw email headers
- prepared self-send correlation fields

CSV export, if added, must use the same safe projection, not a raw DB dump.

The metadata route should return only safe selector data:

- `availableInteractionTypes`
  - `interactionId`
  - `label | null`

### 4. Add a bulk review endpoint, but keep side effects allowlisted and server-owned

Add a route shaped like:

- `POST /api/v1/admin/campaigns/:campaignKey/user-interactions/reviews`

Request body:

- bulk review items with:
  - `userId`
  - `recordKey`
  - `expectedUpdatedAt`
  - `status: approved | rejected`
  - `feedbackText` when required

Behavior:

- reuse the existing optimistic-concurrency requirement from
  `updateInteractionReview(...)`
- keep bulk DB updates transactional
- keep preflight validation fail-fast and atomic across the submitted batch
- prepare risky side effects before commit
- execute side effects only after the review transaction commits

Critically, the client must not submit arbitrary trigger names or payloads.

Allowed behavior in v1:

- approve or reject a reviewable interaction
- let the server derive approved side effects for that interaction type
  - for public debate request approval, this may create or reuse the
    institution correspondence thread and trigger platform send behavior

Explicitly out of scope for this endpoint:

- generic "trigger any admin event"
- generic queue replay
- generic thread mutation

Those operations should remain separate, explicit, and allowlisted, likely on
top of the `admin-events` module.

### 5. Persist real reviewer identity in `UserInteractions`

The new admin route must record who reviewed the item.

Extend the stored review metadata and the appended audit event so they carry
the reviewer identity and review source.

Target review shape:

```ts
review: {
  status: 'approved' | 'rejected';
  reviewedAt: string;
  feedbackText?: string | null;
  reviewedByUserId: string;
  reviewSource: 'campaign_admin_api';
}
```

Target evaluated audit event additions:

```ts
{
  type: 'evaluated',
  actor: 'admin' | 'system',
  actorUserId?: string,
  actorPermission?: string,
  actorSource?: 'campaign_admin_api' | 'user_event_worker'
}
```

Rules:

- browser-admin reviews must store `actor = 'admin'`
- automated/system transitions may continue to use `actor = 'system'`
- the route must write the authenticated reviewer user id, not an email address
- permission strings may be copied into audit events when useful for forensics,
  but Clerk profile data must not be duplicated into the DB
- if the legacy API-key review route remains enabled, it must stamp a durable
  source marker such as `reviewSource = 'learning_progress_admin_api'` and
  `actorSource = 'learning_progress_admin_api'`, or be explicitly treated as a
  compatibility-only path that is not relied on for reviewer-source forensics

This reviewer identity must be returned in the safe admin projection and remain
visible in the durable audit history for later investigation.

For avoidance of doubt, reviewer identity is stored on the backend only. Public
client APIs must not allow end users to set, overwrite, or round-trip reviewer
identity fields as authoritative input.

### 6. Add a campaign-admin projection layer instead of returning raw JSON

Introduce a dedicated admin projection for user interactions.

Responsibilities:

- flatten relevant `record` fields into SQL-selected columns
- derive event-specific safe summary data
- derive risk flags without exposing the raw payload
- attach related institution-thread summary when one exists

For `funky:interaction:public_debate_request`, the safe summary may include:

- `institutionEmail`
- `organizationName`
- `submissionPath`
- `isNgo`
- `submittedAt`

It should exclude by default:

- `ngoSenderEmail`
- `preparedSubject`
- `legalRepresentativeName`
- `legalRepresentativeRole`
- any other fields that are not required for review triage

If an interaction type cannot be represented safely with a specific summary
projection, it must not be added to the admin endpoint until that projection is
implemented.

Reviewed async-review submissions must also retain payload integrity. After an
item has been approved or rejected, a later client-authored content change must
not keep the old review attached to the modified payload.

Acceptable implementations:

- reject client-authored updates to reviewed async-review records unless they
  explicitly re-enter `pending`
- or accept a retry only by clearing stored review metadata and forcing a new
  review cycle

Not acceptable:

- preserving `approved` or `rejected` review metadata across user-authored
  payload changes in `resolved` or `failed` state
- allowing modified reviewed content to appear in admin-approved exports,
  projections, or side-effect pipelines without a fresh review decision

### 7. Add targeted repository support and indexes for review queue queries

Do not implement the admin list by loading full rows and filtering in memory.

Add a dedicated repository method for the admin projection query, backed by
explicit JSONB expression filters and keyset pagination.

The query should be optimized for the primary review use cases:

- pending review queue
- campaign interaction type filters
- entity-based triage
- updated-at ordered review work

Likely new index work:

- partial index for reviewable interaction ids ordered by `updated_at`
- partial expression index for `entityCui`
- partial expression index for `submissionPath` on public-debate requests

Exact index definitions should be chosen after `EXPLAIN ANALYZE` on realistic
staging data, but the spec direction is:

- keep the canonical table
- add minimal targeted partial indexes
- avoid building a separate denormalized admin table for v1

### 8. Keep monitoring separate from deep correspondence inspection

The campaign-admin interaction list should expose thread/send state summaries so
admins can monitor whether an approved review led to a thread and whether that
thread is awaiting reply, failed, or needs follow-up.

It should not embed the full correspondence thread.

If deeper inspection is needed, the user should navigate to a dedicated
correspondence admin surface. That surface should itself be reviewed later for
redaction and least-privilege behavior.

### 9. Close the current hold-reason gap for pending public-debate requests

The current code logs official-email mismatch and leaves the interaction in
`pending`, but it does not persist a durable hold reason on the interaction.

The new admin projection must make this state reviewable without relying on log
search.

Acceptable v1 options:

- persist an explicit machine-readable hold reason in `record.review`
- or derive a stable `riskFlag` / `holdReason` in the admin projection from the
  current record plus validation logic

Preferred direction:

- derive `riskFlags` in the admin projection first
- add stored hold-reason state only if the product later needs durable
  round-tripping across multiple review tools

## Alternatives Considered

### 1. Reuse the existing API-key learning-progress admin routes

Rejected because:

- they are designed for automation, not a browser-admin client
- they do not use scoped user identity
- they lose reviewer attribution by writing `actor: 'system'`
- they expose the raw interaction row shape

### 2. Expose a generic raw `UserInteractions` admin endpoint

Rejected because:

- it would expose unrelated campaign or product data
- it would encourage returning raw user-submitted JSON and audit payloads
- it would be hard to secure with field-level least privilege

### 3. Build the entire feature only on top of `admin-events`

Rejected for v1 because:

- the immediate operator task is review of canonical campaign submissions
- the admin client needs a direct, paginated queue view over current records
- `admin-events` is still better suited to re-scan/export/apply workflows and
  future explicit retry tooling

The new endpoint should align with `admin-events`, not be blocked on it.

### 4. Add a generic "trigger action" endpoint with client-selected action names

Rejected because:

- it creates an injection-style control surface for privileged operations
- it makes authorization and audit harder to reason about
- it risks double-send or unsafe state transitions

High-risk side effects must remain server-derived and interaction-specific.

## Consequences

**Positive**

- campaign admins use authenticated user sessions and scoped permissions instead
  of shared API keys
- reviewer identity becomes durable in `UserInteractions`
- the admin client gets a safe, CSV-friendly projection tailored to review work
- the admin client can populate interaction-type selectors from server metadata
- queue rows can link directly to the related entity and campaign interaction
  element without inspecting raw payloads
- public-debate review can show related thread/send state without leaking full
  correspondence payloads
- the new surface aligns with the existing advanced-map permission strategy

**Negative**

- this requires a schema evolution for review/audit identity fields
- there will be some duplication between the generic learning-progress admin
  routes and the new campaign-admin routes until the old automation endpoint is
  retired or narrowed
- event-specific safe projections add maintenance work for every newly
  reviewable interaction type
- query optimization needs real data validation before final index choices are
  locked in

## Implementation Checks

Security and reliability checks to complete after implementation:

- verify `401` for unauthenticated requests and `403` for authenticated users
  without `campaign:funky_admin`
- verify Clerk permission lookup failures fail closed
- verify non-allowed interaction ids never appear even when filters are omitted
- verify the list and CSV export never expose raw `record.value`, raw
  `auditEvents`, raw headers, or full correspondence bodies
- verify reviewer identity is stored in both `record.review` and the appended
  `evaluated` audit event
- verify end users cannot change the payload of an already reviewed async-review
  record while keeping the previous `approved` or `rejected` status attached
- verify stale `expectedUpdatedAt` values fail with conflict and do not apply
  side effects
- verify approve-side-effect preparation remains atomic across batch reviews
- verify post-commit send failure does not falsely report send success
- verify repeated approval submissions do not double-send institution email
- verify the endpoint logs identifiers and state transitions, not full payloads
- verify keyset pagination stays stable under concurrent review updates
- verify `EXPLAIN ANALYZE` uses the intended partial indexes for the primary
  pending-queue queries
- verify the admin client can triage pending public-debate mismatches without
  looking at application logs
- verify the legacy API-key review route either stamps
  `learning_progress_admin_api` source attribution or is retired from audit-
  relevant workflows

## References

- `src/modules/learning-progress/shell/rest/campaign-admin-routes.ts`
- `src/modules/learning-progress/shell/rest/campaign-admin-schemas.ts`
- `src/modules/learning-progress/shell/rest/admin-routes.ts`
- `src/modules/learning-progress/shell/rest/admin-auth.ts`
- `src/modules/learning-progress/core/usecases/update-interaction-review.ts`
- `src/modules/learning-progress/shell/repo/learning-progress-repo.ts`
- `src/modules/entity/core/ports.ts`
- `src/modules/user-events/shell/handlers/public-debate-request-handler.ts`
- `src/modules/user-events/shell/handlers/public-debate-request-dispatch.ts`
- `src/modules/institution-correspondence/shell/rest/admin-routes.ts`
- `src/modules/advanced-map-datasets/shell/security/clerk-write-permission-checker.ts`
- `src/modules/advanced-map-datasets/shell/rest/routes.ts`
- `src/modules/advanced-map-analytics/shell/rest/routes.ts`
- `src/modules/admin-events/shell/events/learning-progress-review-pending.ts`
- `src/infra/database/user/schema.sql`
- `docs/specs/specs-202603201356-learning-progress-generic-sync.md`
- `docs/specs/specs-202603311900-institution-email-flow.md`
- `docs/specs/specs-202604012011-personal-data-minimization-strategy.md`
- `docs/specs/specs-202604042341-admin-event-review-queue.md`
- `docs/specs/specs-202604110932-campaign-admin-fail-closed-authorization.md`
