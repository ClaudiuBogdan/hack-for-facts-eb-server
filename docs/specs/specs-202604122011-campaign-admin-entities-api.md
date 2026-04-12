# Campaign Admin Entity Detail Server

**Status**: Draft
**Date**: 2026-04-12
**Author**: Codex

## Problem

The campaign-admin entity detail page needs a stable server contract for three
sections:

- entity header summary
- users associated with the entity
- entity-scoped notifications and user interactions

The existing server surface is close, but incomplete:

- `/user-interactions` already supports `entityCui`
- `/notifications` already supports `entityCui`
- `/users` does not support `entityCui`
- `/entities` returns the right summary shape, but it is not a stable direct
  lookup by `entityCui`

That leaves the client without a reliable way to deep-link directly to an
entity detail page and load its users section from a coherent campaign-admin
API.

## Context

- The new work must extend the existing
  [`campaign-admin-entities`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-entities/index.ts)
  module and the existing
  [`/api/v1/admin/campaigns/:campaignKey/users`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts)
  endpoint, not create a parallel admin family.
- Shared campaign-admin auth already exists and must remain the only access
  path: session-authenticated, Clerk permission-based, campaign-scoped, and
  fail-closed when wiring is missing.
- The existing entity list row already contains the canonical detail-page header
  fields:
  `entityCui`, `entityName`, `userCount`, `interactionCount`,
  `pendingReviewCount`, notification counts, and latest activity markers.
- The entity aggregate already defines the preferred association semantics:
  `userCount` is the union of users with visible entity-scoped campaign
  interactions and users with active campaign notification subscriptions for
  that entity.
- The current `/users` contract is interaction-shaped. Supporting
  subscription-only associated users requires a small additive widening of the
  response model because such users do not have a latest interaction id.

## Decision

Reuse the existing interaction and notification endpoints as-is, extend the
existing `/users` endpoint with optional `entityCui`, and add a small entity
summary lookup route for stable direct loads.

### Reused Detail Sections

Keep these unchanged:

- `GET /api/v1/admin/campaigns/:campaignKey/user-interactions?entityCui=...`
- `GET /api/v1/admin/campaigns/:campaignKey/notifications?entityCui=...`

They already satisfy the detail-page use case and already enforce the current
redaction boundary.

### Entity Summary Lookup

Add:

- `GET /api/v1/admin/campaigns/:campaignKey/entities/:entityCui`

The response reuses the existing entity row model instead of introducing a new
summary payload. Internally, the entity module gets exact-entity lookup support
so the route can return:

- `200` with one canonical entity summary row
- `404` when that entity has no campaign-admin aggregate data for the campaign

### Users by Entity

Extend:

- `GET /api/v1/admin/campaigns/:campaignKey/users`

with optional:

- `entityCui`

When `entityCui` is absent, keep the current endpoint semantics unchanged.

When `entityCui` is present, define “user associated with the entity” as:

- users with visible campaign interactions scoped to that entity
- union users with an active campaign notification subscription for that entity
- excluding globally unsubscribed users and users without an active global
  campaign subscription, matching the existing entity aggregate semantics

Field semantics under `entityCui`:

- `interactionCount`: visible campaign interactions for that user and entity
- `pendingReviewCount`: reviewable-only pending interactions for that user and
  entity
- `latestUpdatedAt`: latest association timestamp for that user and entity,
  using the latest visible interaction `updated_at` when present, otherwise the
  latest qualifying subscription `updated_at`
- `latestInteractionId`: latest visible interaction id for that user and entity,
  or `null` for subscription-only users
- `latestEntityCui`: the entity for the row, which is the requested `entityCui`
  for subscription-only users

This keeps the endpoint reusable for the detail page without adding a second
users endpoint or a second user row model.

## Alternatives Considered

- Rely on `GET /entities` for header hydration only.
  Rejected because the current endpoint has no exact `entityCui` lookup and is
  not a stable direct-fetch API for bookmarked detail pages.
- Extend `/users?entityCui=` with interaction-only semantics.
  Rejected because it would drift from the existing entity aggregate and omit
  subscriber-only associated users that already contribute to `userCount`.
- Add `GET /entities/:entityCui/users`.
  Rejected because it duplicates the existing `/users` family and creates two
  competing user list contracts for the same admin surface.

## Consequences

**Positive**

- The detail page can load all three sections from the existing campaign-admin
  route families with only small additive changes.
- Header data stays consistent with the existing entities list because the
  detail lookup reuses the same entity row model.
- The users section stays campaign-admin-native and filterable/paginatable
  through the existing `/users` endpoint.

**Negative**

- The `/users` row model must become slightly more permissive to represent
  subscription-only associated users cleanly.
- Entity-filtered user semantics become broader than the unfiltered `/users`
  endpoint, so tests must pin the exact behavior to avoid future drift.

## References

- [`src/modules/campaign-admin-entities/shell/rest/routes.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-entities/shell/rest/routes.ts)
- [`src/modules/campaign-admin-entities/shell/repo/campaign-admin-entities-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-entities/shell/repo/campaign-admin-entities-repo.ts)
- [`src/modules/learning-progress/shell/rest/campaign-admin-routes.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts)
- [`src/modules/learning-progress/shell/repo/learning-progress-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/repo/learning-progress-repo.ts)
- [`tests/integration/campaign-admin-users-rest.test.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/tests/integration/campaign-admin-users-rest.test.ts)
- [`tests/e2e/campaign-admin-entities-repo.test.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/tests/e2e/campaign-admin-entities-repo.test.ts)
