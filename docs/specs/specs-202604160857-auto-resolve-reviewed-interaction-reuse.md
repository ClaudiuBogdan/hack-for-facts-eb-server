# Auto-Resolve Reviewed Interaction Reuse

**Status**: Draft
**Date**: 2026-04-16
**Author**: Codex

## Problem

Campaign admins currently review many pending interaction records that are
duplicates of answers already reviewed successfully for the same interaction and
entity.

Today the system has no safe reuse path for that prior decision. Every matching
submission stays pending until an admin opens it, compares it manually, and
approves it again.

That creates three gaps:

- repetitive admin work for low-risk duplicate submissions
- slower queue processing for users whose answer already matches an approved
  precedent
- no canonical server-owned automation boundary for reuse, which increases the
  risk of ad hoc matching logic being added in the wrong layer

The design must reduce manual work without widening the trust boundary. A wrong
auto-approval is worse than leaving the row pending.

## Context

- Canonical interaction state is stored in `userinteractions`, one row per
  `user_id + record_key`, in
  [schema.sql](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/infra/database/user/schema.sql:238).
- Review transitions are applied through
  [update-interaction-review.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/update-interaction-review.ts:198).
- Public submissions are written through `syncEvents(...)` and then forwarded to
  post-sync hooks from
  [routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/routes.ts:190).
- The BullMQ user-event pipeline is explicitly best-effort in
  [specs-202603311636-user-events-module.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202603311636-user-events-module.md:26).
- Reviewable campaign interactions are centrally registered in
  [campaign-admin-config.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/campaign-admin-config.ts:218).
- Several reviewable payloads include transient fields such as `submittedAt` in
  [campaign-user-interactions.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/common/campaign-user-interactions.ts:39).
  Raw JSON equality would therefore miss semantically identical submissions.
- `record_key` is client-controlled per
  [specs-202603201356-learning-progress-generic-sync.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202603201356-learning-progress-generic-sync.md:83).
  That means reuse matching must stay narrow and additive.
- Some reviewable interactions have higher-risk side effects or free-text
  content. In particular, approved `public_debate_request` records already feed
  correspondence behavior in
  [public-debate-request-handler.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/user-events/shell/handlers/public-debate-request-handler.ts:118).

## Decision

Introduce an additive auto-resolution path that reuses the latest human-reviewed
approved interaction only when all of the following are true:

- the pending row is entity-scoped
- the pending row belongs to an explicit allowlist of reviewable interaction
  types
- a previously human-reviewed row exists for the exact same `record.key`
- the human-reviewed row belongs to the same `interactionId` and `entityCui`
- the normalized reviewed value matches the normalized pending value exactly

If any condition is not met, the row stays pending.

This feature is an optimization, not a correctness dependency. Failure must
fall back to manual review, not fail the user submission.

## Trigger And Ownership

- Add a new learning-progress core use case, for example
  `autoResolvePendingInteractionFromReviewedMatch`.
- Trigger it from the existing learning-progress post-sync hook layer created in
  [build-app.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/app/build-app.ts:1863).
- The hook runs after the user submission has already been committed and opens
  its own transaction for the reuse check.
- The hook processes only newly applied `interactive.updated` events whose
  current stored row is still `phase = pending`.
- The hook is fail-open. Errors are logged and the row remains pending.
- The implementation must emit structured summary logs for each hook run,
  including counts by:
  - attempts
  - failures
  - auto-approved rows
  - skipped rows by reason

This keeps the automation out of the request-critical write transaction and out
of the best-effort queue worker.

## Matching Model

### Precedent Source

Only direct campaign-admin approvals may act as precedent in v1:

- `review.reviewSource = campaign_admin_api`

Rows auto-resolved by this feature must not become precedent for later rows.

### Precedent Selection

The system loads the latest human-reviewed row for the same:

- `record.key`
- `interactionId`
- `scope.type = entity`
- `scope.entityCui`

The lookup considers both human-reviewed statuses:

- `approved`
- `rejected`

The latest human-reviewed row is authoritative:

- if it is `approved` and the normalized value matches, auto-approve
- if it is `approved` and the normalized value differs, keep pending
- if it is `rejected`, keep pending

The system must not search older rows to find a matching approval after a newer
human decision already disagreed.

### Value Normalization

Matching compares normalized business values, not raw stored JSON.

Normalization must be implemented in a shared pure helper in `core/` or
`common/`, not in admin REST code. It should reuse the typed parsers already
defined in:

- [campaign-user-interactions.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/common/campaign-user-interactions.ts:1)
- [public-debate-request.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/common/public-debate-request.ts:1)

The normalized outputs are compared with
[jsonValuesAreEqual()](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/json-equality.ts:18).

Normalization rules in v1:

- `city_hall_website`: trim URL, support both URL and JSON payload shapes, drop
  `submittedAt`
- `budget_document`: trim `documentUrl`, sort and dedupe `documentTypes`, drop
  `submittedAt`
- `budget_publication_date`: trim `publicationDate`, sort `sources` by stable
  key, drop `submittedAt`
- `budget_status`: compare only `isPublished` and `budgetStage`
- `city_hall_contact`: trim email and phone, lowercase email, drop
  `submittedAt`

If parsing or normalization fails for either row, the system must keep the
pending row unchanged.

## Repository Boundary

Add a dedicated repository method to
[ports.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/ports.ts:22),
for example:

```ts
findLatestCampaignAdminReviewedExactKeyMatches(input: {
  recordKey: string;
  interactionId: string;
  entityCui: string;
}): Promise<Result<readonly LearningProgressRecordRow[], LearningProgressError>>;
```

This query should be implemented directly in
[learning-progress-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/repo/learning-progress-repo.ts:475),
not through the admin list query.

Query shape:

- First, determine the latest `updated_at` among rows matching:
  - `record_key = $recordKey`
  - `record->>'interactionId' = $interactionId`
  - `record->'scope'->>'type' = 'entity'`
  - `record->'scope'->>'entityCui' = $entityCui`
  - `record->'review'->>'reviewSource' = 'campaign_admin_api'`
  - `record->'review'->>'status' IN ('approved', 'rejected')`
- Then, return every row in that matching set whose `updated_at` equals that
  latest timestamp, ordered by `user_id`, then `record_key`

The use case evaluates that entire latest-precedence group and fails open when
its rows disagree on status or normalized value.

V1 must not scan `audit_events` for historical attempts. Reuse is based only on
current canonical rows.

## Review Application

When a matching approved precedent is found, the use case calls
`updateInteractionReview(...)` with:

- `status = approved`
- `actor = system`
- `actorSource = auto_review_reuse_match`

V1 copies only the approval outcome. It must not copy any human-authored review
content or reviewer identity from the precedent row.

Specifically, v1 must not copy:

- `review.feedbackText`
- `review.reviewedByUserId`
- any precedent `result.response` values
- any approval-risk acknowledgement flags

The new review write produces its own `reviewedAt` timestamp through
`updateInteractionReview(...)`.

This requires adding `auto_review_reuse_match` to the review-source unions in:

- [core/types.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/types.ts:36)
- [campaign-admin-schemas.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-schemas.ts:292)
- [infra/database/user/types.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/infra/database/user/types.ts:125)

The auto-review must not enqueue notification side effects in v1.

The use case should emit structured server logs with:

- pending `userId`
- pending `recordKey`
- source `userId`
- source `recordKey`
- `interactionId`
- `entityCui`

This provenance stays server-side in v1 and is not added to public sync
payloads. Logs must not include raw submitted values, normalized payload
content, or copied user text.

## Supported Scope

V1 enablement is explicit and allowlisted.

Enable auto-resolution only for:

- `funky:interaction:city_hall_website`
- `funky:interaction:budget_document`
- `funky:interaction:budget_publication_date`
- `funky:interaction:budget_status`
- `funky:interaction:city_hall_contact`

Do not enable in v1 for:

- `funky:interaction:public_debate_request`
- `funky:interaction:budget_contestation`
- `funky:interaction:funky_participation`
- quiz interactions

The allowlist should live on the existing server-owned interaction config,
alongside the reviewable interaction inventory in
[campaign-admin-config.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/campaign-admin-config.ts:218).
It must not be maintained as a separate parallel list.

## Failure Policy

The feature must fail open. The pending row stays pending when:

- no human-reviewed precedent exists
- the latest precedent is rejected
- the latest precedent value differs
- normalization fails
- the row is no longer pending when the hook runs
- the latest-precedence group disagrees internally
- the repo query or review write fails

The use case must lock and re-read the pending row before applying the review,
using the same concurrency boundary already used by
[update-interaction-review.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/update-interaction-review.ts:216).

## Performance

V1 should start without a new index.

Reasons:

- the lookup is exact on `record_key`
- the table already has a `record_key` index in
  [schema.sql](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/infra/database/user/schema.sql:255)
- the Funky review indexes in
  [202604102200_add_campaign_admin_user_interaction_indexes.sql](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/infra/database/user/migrations/202604102200_add_campaign_admin_user_interaction_indexes.sql:1)
  already narrow review queries substantially

Before adding a new index, run `EXPLAIN` for the exact repository query.

If production access patterns show this lookup is hot, add a dedicated partial
index for human-reviewed exact-key precedence queries.

## Alternatives Considered

### Queue Worker Automation

Rejected.

The existing BullMQ user-event pipeline is best-effort. A pure database reuse
decision should not depend on that reliability boundary.

### Synchronous Matching Inside The User Submission Transaction

Rejected for v1.

This is more reliable than a post-sync hook, but it couples a queue-reduction
optimization to the availability of the core user write path. A matcher bug
would turn a safe optimization into a user-facing failure.

### Broader Matching Without Exact `record.key`

Rejected for v1.

Matching only by `interactionId + entityCui` would catch more duplicates, but it
widens the accidental-match risk and goes beyond the requested “same key and
entity” rule.

### Historical Matching Through `audit_events`

Rejected.

It increases implementation complexity, makes indexing harder, and is not
required for the initial safe behavior.

### Enabling `public_debate_request` In V1

Rejected.

Approved debate-request records already participate in existing correspondence
side effects. Reusing approvals there needs a separate design.

## Consequences

**Positive**

- duplicate low-risk submissions can leave the admin queue automatically
- review reuse stays server-owned and auditable
- the first rollout is intentionally narrow and fail-open
- the design preserves the existing approval primitive and current side-effect
  boundaries

**Negative**

- post-sync hooks are still best-effort, so reconciliation remains necessary
- exact-key matching is intentionally conservative and will miss some duplicate
  answers that a broader matcher could catch
- a new normalization layer must be maintained as interaction payloads evolve
- auto-resolved rows will not notify users in v1

## References

- [src/modules/learning-progress/core/usecases/update-interaction-review.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/update-interaction-review.ts)
- [src/modules/learning-progress/shell/repo/learning-progress-repo.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/repo/learning-progress-repo.ts)
- [src/modules/learning-progress/core/campaign-admin-config.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/campaign-admin-config.ts)
- [src/modules/learning-progress/shell/rest/routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/routes.ts)
- [src/app/build-app.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/app/build-app.ts)
- [src/common/campaign-user-interactions.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/common/campaign-user-interactions.ts)
- [docs/specs/specs-202603201356-learning-progress-generic-sync.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202603201356-learning-progress-generic-sync.md)
- [docs/specs/specs-202603311636-user-events-module.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202603311636-user-events-module.md)
