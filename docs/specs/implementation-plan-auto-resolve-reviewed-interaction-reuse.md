# Implementation Plan: Auto-Resolve Reviewed Interaction Reuse

**Status**: Draft
**Date**: 2026-04-16
**Author**: Codex
**Spec**: [Auto-Resolve Reviewed Interaction Reuse](/Users/claudiuconstantinbogdan/.codex/worktrees/8e2c/hack-for-facts-eb-server/docs/specs/specs-202604160857-auto-resolve-reviewed-interaction-reuse.md)

## Goal

Implement the smallest safe version of reviewed-interaction reuse so that a
pending entity-scoped interaction can be auto-approved only when the latest
direct campaign-admin review for the exact same `record.key`, `interactionId`,
and `entityCui` is approved and the normalized business value matches exactly.

The implementation must reduce duplicate admin work without:

- broadening the trust boundary
- introducing new notification or correspondence side effects
- making normal user submissions depend on the availability of the reuse logic
- allowing auto-approved rows to become precedent for later auto-approvals

## Target Scope And Objectives

### In Scope

- add a server-owned auto-review source:
  - `auto_review_reuse_match`
- add an allowlist flag on existing campaign interaction config for v1 reuse
- add shared normalization helpers for allowlisted interaction types
- add a repository query that loads the full latest-precedence group for an
  exact-key candidate
- add a core use case that:
  - locks and re-reads the pending row
  - validates eligibility
  - loads the latest precedence group
  - compares normalized values
  - applies approval through `updateInteractionReview(...)`
- add a post-sync hook that invokes the use case after committed public sync
  writes
- add a reconciliation entrypoint that can re-run the same use case for pending
  rows missed by the post-sync hook
- add structured summary logs needed to operate the feature safely
- add unit, integration, and e2e coverage

### V1 Allowlisted Interaction Types

- `funky:interaction:city_hall_website`
- `funky:interaction:budget_document`
- `funky:interaction:budget_publication_date`
- `funky:interaction:budget_status`
- `funky:interaction:city_hall_contact`

### Out Of Scope

- matching by `interactionId + entityCui` without exact `record.key`
- scanning `audit_events` for historical attempts
- auto-reusing rejected reviews
- trusting any precedent source other than `campaign_admin_api`
- enabling `public_debate_request`
- enabling `budget_contestation`
- enabling quiz or participation-report interactions
- notification side effects from auto-approved rows
- correspondence side effects from auto-approved rows
- a new background runtime just for this feature

## Constraints And Limitations

- `record_key` is client-controlled, so matching must stay narrow and exact.
- Several payloads embed transient fields such as `submittedAt`, so raw JSON
  equality is not acceptable.
- The current post-sync hook boundary is fail-open and fire-and-forget; it is
  not reliable enough on its own for eventual consistency.
- `updateInteractionReview(...)` remains the only review-application primitive.
  The new use case must not bypass it.
- The implementation must preserve one-row-per-`user_id + record_key`
  semantics in `userinteractions`.
- The fake learning-progress repository in `tests/fixtures/fakes.ts` must stay
  behaviorally aligned with the real repository.
- The design should favor reuse of existing config and route wiring rather than
  introducing parallel registries or new orchestration layers.

## Security Requirements

- Only rows with `review.reviewSource = campaign_admin_api` may act as
  precedent in v1.
- Auto-approved rows must never become precedent for later rows.
- Auto-approval must copy only the approval outcome. It must not copy:
  - `review.feedbackText`
  - `review.reviewedByUserId`
  - precedent `result.response`
  - approval-risk flags
- Logs must include only stable ids and summary counts:
  - pending `userId`
  - pending `recordKey`
  - source `userId`
  - source `recordKey`
  - `interactionId`
  - `entityCui`
- Logs must not include raw payload JSON, normalized payload content, reviewer
  notes, or free text.
- Auto-review must not trigger notifications, compose jobs, emails, threads, or
  any other downstream side effects in v1.
- Any ambiguity, parser failure, repo failure, or race must fail open and leave
  the row pending.
- The reconciliation entrypoint must be idempotent and safe to run repeatedly.

## Proposed Design

### 1. Extend Config And Review Source Types

Files:

- `src/modules/learning-progress/core/types.ts`
- `src/infra/database/user/types.ts`
- `src/modules/learning-progress/shell/rest/campaign-admin-schemas.ts`
- `src/modules/learning-progress/core/campaign-admin-config.ts`

Changes:

- add `auto_review_reuse_match` to the review-source unions
- add a boolean flag on `CampaignAdminInteractionConfig`, for example:
  - `autoReviewReuseEnabled: boolean`
- set the flag to `true` only for the five v1 allowlisted interaction types

Rationale:

- one boolean is simpler and safer than introducing a mode enum in v1
- colocating the allowlist with the existing interaction config prevents drift

### 2. Add Shared Normalization Helpers

Files:

- new helper under `src/modules/learning-progress/core/`, for example:
  - `auto-review-reuse-normalization.ts`
- possibly a small shared helper in `src/common/` only if it is already reused

Changes:

- implement pure normalization functions for the allowlisted interaction types
- reuse existing typed payload parsers from:
  - `src/common/campaign-user-interactions.ts`
- use `jsonValuesAreEqual(...)` for comparison of normalized outputs
- return a result that distinguishes:
  - `supported + normalized value`
  - `unsupported`
  - `invalid/unparsable`

Rules:

- trim strings where the admin projection already trims them
- lowercase emails for `city_hall_contact`
- sort and dedupe `documentTypes`
- sort publication-date `sources` deterministically
- drop transient fields such as `submittedAt`

### 3. Add Exact-Key Precedence Query

Files:

- `src/modules/learning-progress/core/ports.ts`
- `src/modules/learning-progress/shell/repo/learning-progress-repo.ts`
- `tests/fixtures/fakes.ts`
- real-db tests under `tests/e2e/`

Changes:

- add a repo method that loads the full latest-precedence group for:
  - exact `record_key`
  - exact `interactionId`
  - exact `entityCui`
  - entity scope only
  - `record.phase in ('resolved', 'failed')`
  - `reviewSource = campaign_admin_api`
  - `reviewStatus in ('approved', 'rejected')`
- implement it as a two-step query:
  - find latest matching `updated_at`
  - fetch every matching row at that timestamp

Why this shape:

- it is the smallest safe way to handle millisecond timestamp ties
- it avoids scanning historical `audit_events`
- it avoids reusing the admin list query, which carries unrelated read logic

### 4. Add Core Use Case

Files:

- new use case under `src/modules/learning-progress/core/usecases/`, for example:
  - `auto-resolve-pending-interaction-from-reviewed-match.ts`
- `src/modules/learning-progress/index.ts`

Inputs:

- `userId`
- `recordKey`

Behavior:

- start a transaction through `repo.withTransaction(...)`
- load the pending row with `getRecordForUpdate(...)`
- exit without change unless:
  - row exists
  - `phase = pending`
  - `scope.type = entity`
  - interaction config exists and `autoReviewReuseEnabled = true`
- normalize the pending row; if unsupported or invalid, skip
- load the latest-precedence group from the repo
- if the group is empty, skip
- normalize every row in that group
- if any row in the group is invalid, skip
- if statuses differ across the group, skip
- if normalized values differ across the group, skip
- if the group status is `rejected`, skip
- if the normalized group value differs from the pending value, skip
- otherwise call `updateInteractionReview(...)` with:
  - `status = approved`
  - `actor = system`
  - `actorSource = auto_review_reuse_match`
  - no `feedbackText`
  - no `approvalRiskAcknowledged`
  - locked row `updatedAt` passed as `expectedUpdatedAt`

Outputs:

- `approved`
- `skipped` with stable reason
- `error`

Stable skip reasons should include:

- `record_not_found`
- `not_pending`
- `unsupported_scope`
- `interaction_not_enabled`
- `pending_value_invalid`
- `no_precedent`
- `precedent_invalid`
- `precedent_group_status_conflict`
- `precedent_group_value_conflict`
- `precedent_rejected`
- `value_mismatch`

### 5. Add Post-Sync Hook

Files:

- new hook factory under `src/modules/learning-progress/shell/`, for example:
  - `auto-review-reuse-hook.ts`
- `src/app/build-app.ts`

Changes:

- add a named post-sync hook that scans applied events and invokes the use case
  for eligible `interactive.updated` rows
- register it through the existing `learningProgressSyncHooks` array
- keep it independent from the BullMQ user-event publisher hook

Rules:

- only inspect `interactive.updated`
- only inspect records whose synced payload is `phase = pending`
- do not trust the synced payload as final truth; the use case re-reads the row
- log and continue on any failure
- emit structured summary logs with counts by outcome and skip reason

### 6. Add Reconciliation Entrypoint

Files:

- simplest safe option:
  - new script under `scripts/`, for example:
    `reconcile-auto-review-reuse.ts`
- optional helper function under `src/modules/learning-progress/` if shared by
  the hook and script

Changes:

- add a `package.json` script entry for the reconciliation command
- enumerate pending allowlisted rows in bounded batches
- reuse `listCampaignAdminInteractionRows(...)` with:
  - `phase = pending`
  - allowlisted interactions only
  - existing cursor pagination
  - bounded `limit`
- invoke the same core use case for each candidate
- print a final summary with counts only
- exit non-zero on unrecovered failures

Design choice:

- v1 should use a script, not a new queue or cron subsystem
- the script is simpler, auditable, and enough to satisfy the mandatory
  reconciliation requirement from the spec

### 7. Keep Side Effects Explicitly Disabled

Files to touch only if needed for assertions or tests:

- `src/modules/campaign-admin-notifications/...`
- `src/modules/user-events/shell/handlers/public-debate-request-handler.ts`

Requirement:

- do not wire auto-approved rows into existing notification or correspondence
  behavior
- add one focused negative regression test around the notification trust
  boundary for `reviewSource`
- avoid correspondence-module test changes unless the implementation touches
  that boundary

## Testing Strategy

### Unit Tests

Add or extend unit coverage for:

- normalization helper:
  - trims and drops transient fields correctly
  - rejects unsupported or invalid payloads
  - sorts arrays deterministically
- core use case:
  - approves exact matching approved precedent
  - skips when latest group is rejected
  - skips when latest group value differs
  - skips when latest group disagrees internally
  - skips when pending row is not allowlisted
  - skips when scope is not entity
  - skips when pending row changes before approval
  - never copies feedback, reviewer identity, or response metadata
  - never treats `auto_review_reuse_match` rows as precedent
- post-sync hook:
  - only reacts to `interactive.updated`
  - ignores non-pending synced rows
  - logs and continues on use-case failure
- fake repo:
  - latest-precedence-group semantics match the real repo contract

Likely files:

- `tests/unit/learning-progress/update-interaction-review.test.ts`
- new:
  - `tests/unit/learning-progress/auto-review-reuse-normalization.test.ts`
  - `tests/unit/learning-progress/auto-resolve-pending-interaction-from-reviewed-match.test.ts`
  - `tests/unit/learning-progress/auto-review-reuse-hook.test.ts`

### Integration Tests

Add integration coverage for:

- learning-progress REST + post-sync hook:
  - a pending allowlisted submission stays pending when no precedent exists
  - a pending allowlisted submission becomes approved after the hook when a
    matching `campaign_admin_api` precedent exists
  - hook failure does not fail the public sync request
- script-level reconciliation:
  - pending rows missed by the hook can be approved by the reconciliation
    script
  - repeated reconciliation runs are idempotent
- notification regression:
  - `auto_review_reuse_match` rows are excluded from admin-reviewed interaction
    notification behavior

Likely files:

- `tests/integration/learning-progress-rest.test.ts`
- new:
  - `tests/integration/auto-review-reuse-reconciliation.test.ts`

### E2E / Real DB Tests

Add real-db coverage for:

- repository query:
  - exact-key precedence lookup returns the full latest-precedence group
  - older approved rows are ignored when the latest reviewed row is rejected
  - non-matching `entityCui` or `record_key` rows are excluded
- schema/type compatibility:
  - `auto_review_reuse_match` review source serializes and deserializes
    correctly

Likely files:

- new:
  - `tests/e2e/learning-progress-auto-review-reuse-repo.test.ts`

Notes:

- This backend repo uses “e2e” primarily for real database coverage rather than
  browser flows.

## Acceptance Criteria

- The system auto-approves only exact-key, exact-entity, exact-normalized-value
  matches from `campaign_admin_api` approved precedent rows.
- The system fails open on ambiguity, invalid data, parser failure, repo
  failure, and concurrency races.
- Auto-approved rows carry `reviewSource = auto_review_reuse_match`.
- Auto-approved rows do not copy feedback, reviewer identity, approval-risk
  flags, or response metadata from the precedent row.
- Auto-approved rows do not trigger notifications or correspondence side
  effects.
- The allowlist lives on existing interaction config, not in a separate
  registry.
- The post-sync hook is registered and emits structured summary logs.
- The reconciliation script exists, runs safely, and is idempotent.
- Unit, integration, and e2e coverage exists for the main happy path and the
  main fail-open paths.

## Definition Of Done

- implementation matches the spec and this plan
- all touched types, schemas, repo interfaces, and fakes compile
- tests added in the planned layers pass
- `pnpm typecheck` passes
- `pnpm lint` passes
- `pnpm test:unit` passes for the touched suites
- targeted integration and e2e tests for this feature pass
- any new script has a clear usage contract in code comments or adjacent docs
- logging does not expose raw payloads or free text
- no unexpected behavior change is introduced for:
  - normal learning-progress sync
  - campaign-admin review submission
  - public debate correspondence
  - admin-reviewed notification flows
- `pnpm deps:check` passes if the new files introduce new module edges

## Implementation Order

1. Add config flag and review-source type/schema updates.
2. Add normalization helper and unit tests.
3. Add repo method plus fake repo support and real-db tests.
4. Add core use case and unit tests.
5. Add post-sync hook wiring and integration tests.
6. Add reconciliation script and integration coverage.
7. Run focused unit, integration, and e2e tests.

## Risks And Mitigations

- Risk: hook failures silently leave rows pending.
  Mitigation: mandatory reconciliation path and structured summary logs.
- Risk: incorrect normalization causes false approvals.
  Mitigation: allowlist only low-risk interaction types, exact matching, and
  fail-open on invalid data.
- Risk: later auto-approved rows become precedent.
  Mitigation: restrict precedent source to `campaign_admin_api` only.
- Risk: sensitive reviewer context leaks into auto-approved rows or logs.
  Mitigation: explicit no-copy rule and negative tests.
- Risk: drift between real repo and fake repo behavior.
  Mitigation: add targeted tests for latest-precedence-group semantics in both
  layers.
