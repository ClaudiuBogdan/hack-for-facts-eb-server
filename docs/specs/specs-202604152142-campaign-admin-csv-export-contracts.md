# Campaign Admin CSV Export Contracts

**Status**: Draft
**Date**: 2026-04-15
**Author**: Codex

## Problem

Campaign admins need to export all campaign-admin rows that match the active
filters on the client as CSV and send that data to operators for spreadsheet
work.

The current admin surface has three gaps:

- `/user-interactions` is a paginated JSON audit API, not an export contract
- the current server implementation materializes all matched interaction rows in
  memory and rejects queries above `5000` rows, so it cannot safely power an
  "export all" flow
- the interaction review workflow already depends on a stable spreadsheet
  header contract for copy-paste review updates, and arbitrary export headers
  would break that workflow

This matters because the export is not only a reporting feature. For
`user-interactions`, the exported file must remain compatible with the existing
bulk review spreadsheet column contract while staying inside the current
redaction and authorization boundaries.

## Context

- Campaign-admin access is already session-authenticated, Clerk-permission
  based, campaign-scoped, and fail-closed. CSV export must not create a second
  access path.
- The current interaction queue state is driven by normalized route search in
  the client and translated into server-bound filters in:
  [`search-schema.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/schemas/search-schema.ts)
  and
  [`campaign-admin-user-interactions.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/api/campaign-admin-user-interactions.ts).
- The existing bulk review spreadsheet contract is defined in:
  [`bulk-review-clipboard.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/utils/bulk-review-clipboard.ts).
  Its header names and row semantics are already the de facto import contract.
- The current bulk review import flow only stages rows that already exist in the
  active client workspace. It matches pasted rows against the currently loaded
  `bulkReviewItems`, then derives `expectedUpdatedAt` from those in-memory
  items during submit. Exporting CSV does not, by itself, extend that workflow
  to arbitrary offline re-import across rows that are not currently loaded.
- The existing review paste parser accepts tab, comma, or semicolon delimited
  data and ignores unknown columns. That makes additive CSV columns safe as
  long as the known review columns keep their existing names.
- The interaction table headers visible in the UI are not the same thing as the
  spreadsheet import contract:
  [`CampaignAdminUserInteractionsTable.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/components/CampaignAdminUserInteractionsTable.tsx).
  For `user-interactions`, the spreadsheet contract must win.
- The current queue route supports `submissionPath`, but the queue toolbar draft
  does not round-trip it. Export based on "current filters" will drift unless
  the client preserves that filter state:
  [`CampaignAdminUserInteractionsToolbar.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/components/CampaignAdminUserInteractionsToolbar.tsx).
- The `entities` table uses client-facing labels but several cells are
  composite, so CSV export must flatten those values into explicit columns:
  [`CampaignAdminEntitiesTable.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/components/CampaignAdminEntitiesTable.tsx).
- The existing safe-projection rule for campaign-admin audit data remains in
  force. Raw `record` JSON and raw `audit_events` are out of scope for export.

## Decision

Add two dedicated CSV export endpoints and define the CSV header contracts
explicitly in terms of the client workflow.

### Endpoints

Add:

- `GET /api/v1/admin/campaigns/:campaignKey/user-interactions/export`
- `GET /api/v1/admin/campaigns/:campaignKey/entities/export`

Both endpoints must:

- use the existing campaign-admin auth and authorization boundary
- return `Cache-Control: no-store`
- return `200` as `text/csv; charset=utf-8`
- return `Content-Disposition: attachment; filename="...csv"`
- include a UTF-8 BOM so spreadsheet tools open Romanian text correctly
- return the current JSON error envelope on non-`200` responses before any CSV
  bytes are written
- return a header-only CSV when no rows match

### Filter Contract

The export endpoints must use the same filter vocabulary as the corresponding
list endpoints, excluding pagination-only and UI-only state.

#### User interactions export filters

Use the same server-bound filters as the current queue request:

- `phase`
- `reviewStatus`
- `interactionId`
- `lessonId`
- `entityCui`
- `scopeType`
- `payloadKind`
- `submissionPath`
- `userId`
- `recordKey`
- `recordKeyPrefix`
- `submittedAtFrom`
- `submittedAtTo`
- `updatedAtFrom`
- `updatedAtTo`
- `hasInstitutionThread`
- `threadPhase`

Do not accept:

- `sortBy`
- `sortOrder`
- `reviewSelectionKey`
- `reviewStatusMode`
- `cursor`
- `pageIndex`
- `limit`

`reviewStatus` must not be treated as a raw repository filter. It must mirror
the current REST row semantics after reviewability and submission-path gating.
That means audit-only rows such as self-send public-debate submissions remain
outside the derived pending/approved/rejected review set even if their raw
phase is `pending`.

When `hasInstitutionThread` or `threadPhase` is present, the export must mirror
the current queue behavior and restrict candidate interactions to the
thread-summary-capable subset before formatting rows.

#### Entities export filters

Use the same filter contract as the existing entities list:

- `query`
- `interactionId`
- `hasPendingReviews`
- `hasSubscribers`
- `hasNotificationActivity`
- `hasFailedNotifications`
- `latestNotificationType`
- `latestNotificationStatus`
- `sortBy`
- `sortOrder`

Do not accept:

- `cursor`
- `pageIndex`
- `limit`

For v1, the entities export contract follows the current client search model,
not every filter the server route can theoretically accept. Server-only date
filters are out of scope until the entities client search schema carries them.

`query` must follow the current server behavior, which is entity-CUI search.
It does not add entity-name search parity in v1, even though the current client
placeholder copy overstates that behavior.

### Client Source Of Truth

The client export buttons must build request params from the same normalized
search helpers already used for list loading.

For `user-interactions`, the export trigger must use the normalized
`CampaignAdminQueueSearch` state after conversion through
`getCampaignAdminQueueFilters(...)`, then explicitly strip `sortBy` and
`sortOrder`. V1 export matches the current filter set, excluding sort order.

As part of this work, the queue client must preserve `submissionPath` in its
filter draft and toolbar round-trip. Without that fix, "export current filters"
is not trustworthy for queue states that originate from a deep link or user
page cross-link.

The required touchpoints are:

- `CampaignAdminFilterDraft`
- `createCampaignAdminFilterDraft(...)`
- `buildCampaignAdminQueueSearchFromDraft(...)`
- the queue toolbar controls and active-filter summary

For `entities`, the export trigger must use the current normalized
`CampaignAdminEntitiesSearch` state after conversion through
`getCampaignAdminEntitiesFilters(...)`. Export must strip pagination state and
must not narrow itself to the current page. V1 does not add new client-side
date filters for entities export.

### User Interactions CSV Contract

The `user-interactions` export is a spreadsheet-compatible report contract
first and an audit export second.

The first columns, in this exact order, must be:

- `User Interaction ID`
- `User ID`
- `Record Key`
- `Entity Name`
- `Entity CUI`
- `Interaction Type`
- `Interaction ID`
- `Entity Link`
- `Interaction Element Link`
- `Submitted Value`
- `Decision`
- `Send Notification`
- `Review Feedback`

These names must exactly match the existing clipboard export contract in the
client.

The fixed header names follow the current literal clipboard contract. For
derived human-readable cell values, the export should use the same locale-aware
label semantics the current client uses for the active request locale, with
English as the fallback when no locale can be resolved.

#### Semantics of the first 13 columns

- `User Interaction ID` is the current composite selection key:
  `userId::recordKey`
- `Submitted Value` uses the same safe primary-value semantics as the client
  helper in
  [`payload-summary.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/utils/payload-summary.ts)
- `Interaction Type` uses the current client-facing localized label with raw
  `interactionId` fallback
- `Entity Link` and `Interaction Element Link` use the current clipboard-export
  link semantics: absolute same-origin URLs when `platformBaseUrl` is available

The three editable review columns have special behavior:

- `Decision` is exported blank
- `Send Notification` is exported blank
- `Review Feedback` is exported blank

These columns are reserved for operator edits and paste-back. They must not be
pre-filled from persisted server review state, because doing so would turn an
untouched download into an unintended review import payload when pasted back.

V1 does not change the current bulk review import boundary. The exported CSV is
compatible with the existing editable columns, but it is not a standalone
offline review submission protocol for arbitrary rows that are not already
loaded in the client workspace.

#### Read-only appended columns

After the 13 fixed spreadsheet columns, append read-only audit columns using
client-facing names that do not collide with any current spreadsheet import
header alias:

- `Current review status`
- `Association`
- `Updated`
- `Thread status`
- `Risk flags`
- `Reviewed by`

These appended columns are additive. The existing spreadsheet parser will
ignore them during paste-back as long as their headers do not match any
existing decision, feedback, or notification alias.

Their v1 mappings must be explicit:

- `Current review status` = client-facing localized review status label derived
  from the current row state
- `Association` = `organizationName` or blank
- `Updated` = raw `updatedAt` ISO timestamp
- `Thread status` = client-facing localized thread-phase label, with the
  current localized `No thread` value for null
- `Risk flags` = client-facing localized risk-flag labels joined with `; `
- `Reviewed by` = `reviewedByUserId` or blank

`Submitted Value` must also be explicit. The server must mirror the current
client helper semantics:

- `institutionEmail` when present
- otherwise `websiteUrl` when present
- otherwise budget document URL
- otherwise budget publication date, or the first publication source URL
- otherwise budget status `isPublished`
- otherwise city hall contact email, then phone
- otherwise participation observations, then debate-took-place value
- otherwise contestation contested item, then institution email
- otherwise blank

#### Redaction boundary

`user-interactions` export must only use the same safe row model already
exposed by `CampaignAdminInteractionListItem`. In particular:

- no raw `record`
- no raw `audit_events`
- no internal-only fields
- no payload fields that are not already surfaced or safely derived

### Entities CSV Contract

The `entities` export does not need a paste-back contract. It should align with
the data the client already presents, with composite table cells flattened into
explicit columns.

The CSV columns must be:

- `Entity Name`
- `Entity CUI`
- `Users`
- `Interactions`
- `Pending reviews`
- `Subscribers`
- `Outbox notifications`
- `Failed notifications`
- `Latest interaction at`
- `Latest notification at`
- `Latest notification type`
- `Latest notification status`
- `Public page`

The v1 mappings must be:

- `Entity Name` = `entityName?.trim() || entityCui`
- `Entity CUI` = `entityCui`
- `Users` = `userCount`
- `Interactions` = `interactionCount`
- `Pending reviews` = `pendingReviewCount`
- `Subscribers` = `notificationSubscriberCount`
- `Outbox notifications` = `notificationOutboxCount`
- `Failed notifications` = `failedNotificationCount`
- `Latest interaction at` = `latestInteractionAt` ISO timestamp or blank
- `Latest notification at` = `latestNotificationAt` ISO timestamp or blank
- `Latest notification type` = client-facing localized notification-type label
  with raw fallback, and the current localized `Unavailable` value for null
- `Latest notification status` = client-facing localized
  notification-status label with raw fallback, and the current localized
  `Unavailable` value for null
- `Public page` = absolute same-origin URL for the public entity page when
  `platformBaseUrl` is available

### Ordering

`entities` export should honor the existing server-side `sortBy` and `sortOrder`
contract because the repository already supports it.

`user-interactions` export should prioritize filter parity and safe streaming
over exact UI order parity. Local-only UI sorts such as `value` and
`reviewState` are not part of the export contract.

For `user-interactions`, v1 ordering is a stable export order:

- `updatedAt desc`
- `userId asc`
- `recordKey asc`

This is acceptable because paste-back matching is id-based, not position-based.

### Server Implementation Shape

#### User interactions

Do not implement `user-interactions` export by calling the existing
`loadAllCampaignAdminInteractionRows(...)` helper. That helper intentionally
materializes all rows and rejects results above `5000`.

Instead:

- add a dedicated export use case
- fetch rows from the repository in batches
- enforce an explicit statement timeout for the batched export query path
- format rows through the same safe projection rules already used by the REST
  response
- apply any review-status-only filtering with the same semantics as the current
  audit API
- bound enrichment work per batch for entity names and official-email lookups
- write CSV rows incrementally to the response stream

If an export exceeds the supported request budget, the endpoint should fail
explicitly with the existing error envelope rather than silently dropping rows.

The export path therefore has two failure modes:

- preflight failure before response headers are sent:
  return the existing non-`200` JSON error envelope
- failure after CSV streaming has started:
  abort the response stream; do not attempt to switch the in-flight CSV
  response into JSON

#### Entities

Do not materialize all entity rows up front. Reuse the repository cursor flow
and write CSV rows incrementally until no next cursor remains.

The export route wiring must receive `platformBaseUrl` so entity and
interaction link columns can match the current absolute-link clipboard export
semantics.

### CSV Safety Rules

All CSV cells must:

- be escaped according to CSV quoting rules
- normalize embedded newlines into single-line cells
- neutralize spreadsheet formula prefixes by prefixing values that start with
  `=`, `+`, `-`, or `@` with a leading single quote

For v1, link-valued columns (`Entity Link`, `Interaction Element Link`,
`Public page`) should emit absolute same-origin URLs when `platformBaseUrl` is
available. This intentionally matches the current browser clipboard export
workflow, which resolves links against the current origin.

This matches the current clipboard safety rule already enforced in the client.

## Alternatives Considered

- Build the CSV entirely in the client by refetching every page from the
  existing JSON list endpoints.
  Rejected because `user-interactions` currently fails above `5000` rows,
  duplicates large-response memory costs in the browser, and pushes too much
  privileged data through the JSON API just to transform it client-side.
- Reuse the current `user-interactions` route handler and loop over its full
  in-memory formatting path.
  Rejected because that preserves the current scalability failure and does not
  produce a safe "export all" contract.
- Export raw interaction JSON or raw audit events.
  Rejected because it widens the privileged data boundary beyond the existing
  safe-projection design.
- Create a background job or bundle-export workflow first.
  Rejected for v1 because it adds operational complexity before the simple
  direct-download case has been validated.

## Consequences

**Positive**

- Campaign admins get a direct CSV export that respects the current admin
  filters.
- `user-interactions` export remains compatible with the existing spreadsheet
  review workflow because the header prefix is the current client contract.
- The export stays inside the existing safe-projection and fail-closed auth
  boundary.
- The server no longer depends on the `5000` row in-memory cap for export-all
  behavior.

**Negative**

- `user-interactions` export will not guarantee parity with local-only UI sort
  modes such as `value` and `reviewState`.
- The queue client needs a small filter round-trip fix for `submissionPath` to
  make "export current filters" fully trustworthy.
- The server must own a CSV serializer and a mirrored primary-value formatter
  for the `Submitted Value` column, so tests must pin those semantics.

## References

- [`docs/specs/specs-202604102107-campaign-admin-user-interactions-review-api.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604102107-campaign-admin-user-interactions-review-api.md)
- [`docs/specs/specs-202604122011-campaign-admin-entities-api.md`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202604122011-campaign-admin-entities-api.md)
- [`src/modules/learning-progress/shell/rest/campaign-admin-routes.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/rest/campaign-admin-routes.ts)
- [`src/modules/learning-progress/shell/repo/learning-progress-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/shell/repo/learning-progress-repo.ts)
- [`src/modules/campaign-admin-entities/shell/rest/routes.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-entities/shell/rest/routes.ts)
- [`src/modules/campaign-admin-entities/shell/repo/campaign-admin-entities-repo.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-entities/shell/repo/campaign-admin-entities-repo.ts)
- [`src/features/campaigns/buget/admin/utils/bulk-review-clipboard.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/utils/bulk-review-clipboard.ts)
- [`src/features/campaigns/buget/admin/utils/payload-summary.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/utils/payload-summary.ts)
- [`src/features/campaigns/buget/admin/schemas/search-schema.ts`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/schemas/search-schema.ts)
- [`src/features/campaigns/buget/admin/components/CampaignAdminUserInteractionsTable.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/components/CampaignAdminUserInteractionsTable.tsx)
- [`src/features/campaigns/buget/admin/components/CampaignAdminEntitiesTable.tsx`](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-client/src/features/campaigns/buget/admin/components/CampaignAdminEntitiesTable.tsx)
