# Remove Legacy Learning Progress Admin Review Surface

**Status**: Accepted
**Date**: 2026-04-11
**Author**: Codex

## Implementation update

This migration is complete in the current codebase.

- `/api/v1/admin/learning-progress/reviews` has been removed.
- The legacy API-key auth/config surface for that endpoint has been removed.
- `learning_progress.review_pending` has been removed from `admin-events`.
- `institution_correspondence.reply_review_pending` remains the supported
  queue/export/apply workflow.
- Learning-progress review now exists only through the campaign-admin routes
  for allowlisted interaction types.

## Problem

The codebase still exposed two different admin review flows for learning-progress interactions:

- a legacy API-key HTTP surface at `/api/v1/admin/learning-progress/reviews`
- a newer authenticated campaign-admin surface backed directly by canonical database reads

That duplication kept legacy-only auth, schemas, queue wiring, repository methods, and tests alive even though the intended operator path had already moved to the campaign-admin routes. It also preserved a browserless/generic fallback that no longer matched the newer, safer review model.

## Context

- The legacy flow used a shared API key, returned raw learning-progress rows, and relied on a generic `learning_progress.review_pending` admin-event queue.
- The new flow uses session auth plus campaign-admin permissions, exposes a constrained projection, and reads review candidates directly from canonical tables.
- Institution correspondence still depends on admin-events for explicit review/export/apply workflows. That queue is not redundant today.
- The campaign-admin allowlist is still narrower than the old generic review path. Retiring the legacy path therefore creates an intentional feature gap for interaction types that are not yet represented in `CAMPAIGN_REVIEW_CONFIGS`.
- This refactor intentionally accepts that gap instead of preserving the legacy system-admin surface.

## Decision

Remove the legacy learning-progress system-admin review path and its dedicated queue workflow.

- Delete the API-key route surface and the code that only existed to mount and authenticate it.
- Remove the `learning_progress.review_pending` admin-event definition, registry wiring, sync hook, repository listing path, and legacy tests.
- Keep the campaign-admin review routes and the shared review write path (`submitInteractionReviews`, `updateInteractionReview`, and the optional review side-effect plan contract gated by request-level opt-in such as `send_notification`).
- Keep `institution_correspondence.reply_review_pending` and the shared admin-events infrastructure because that workflow still needs queue/export/apply behavior.
- Record the remaining gap clearly: generic/browserless learning-progress review is no longer supported by this backend until equivalent campaign-admin coverage or a new machine-to-machine flow is added.

### Legacy vs new admin flow

- Legacy admin
  - API key auth
  - raw row payloads
  - generic row-based review queue
  - offset pagination
  - browserless automation via HTTP
- Campaign admin
  - session auth plus Clerk permission checks
  - campaign-scoped safe projection
  - direct DB-backed review listing
  - cursor pagination
  - reviewer identity recorded in canonical review metadata

## Alternatives Considered

- Keep the legacy endpoint until the campaign-admin allowlist reaches feature parity.
  - Rejected because it preserves the duplicate security model and the legacy raw-row review surface longer than necessary.
- Keep the legacy endpoint but remove only the queue.
  - Rejected because the endpoint itself is the behavior being retired; keeping it would preserve the browserless/API-key path the migration is explicitly removing.
- Remove the entire `admin-events` module.
  - Rejected because institution correspondence still depends on queue/export/apply flows that are not replaced by direct database reads.

## Consequences

**Positive**

- One review model remains for learning-progress human review: the campaign-admin surface.
- Legacy-only config, auth bypass logic, repository APIs, and tests are removed.
- The remaining admin-events surface is narrower and better aligned with actual queue use cases.

**Negative**

- Generic learning-progress review outside the campaign-admin allowlist is no longer supported.
- Browserless/API-key learning-progress review automation is removed and not replaced in this change.

## References

- [src/modules/learning-progress/shell/rest/campaign-admin-routes.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts)
- [src/modules/learning-progress/core/usecases/submit-interaction-reviews.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/submit-interaction-reviews.ts)
- [src/modules/learning-progress/core/usecases/update-interaction-review.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/update-interaction-review.ts)
- [src/modules/admin-events/shell/events/institution-correspondence-reply-review-pending.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/admin-events/shell/events/institution-correspondence-reply-review-pending.ts)
- [docs/specs/specs-202604102107-campaign-admin-user-interactions-review-api.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604102107-campaign-admin-user-interactions-review-api.md)
