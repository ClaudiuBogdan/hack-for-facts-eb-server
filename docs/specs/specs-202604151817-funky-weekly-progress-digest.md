# Funky Weekly Progress Digest

**Status**: Proposed
**Date**: 2026-04-15
**Author**: Codex

## Problem

The Funky campaign has single-occurrence notification flows for welcome,
subscription, entity updates, and reviewed interactions, but it does not have a
simple weekly progress digest that:

- summarizes newly actionable interaction changes for one user
- recommends the most useful next steps across the campaign
- avoids duplicate delivery across repeated admin runs
- preserves strict access boundaries between user-authored progress state and
  server-managed notification state

The current codebase also has no safe place to store a per-user weekly digest
cursor inside the learning-progress system. If an internal digest cursor were
added naïvely, public progress sync and public progress reads could expose or
overwrite it.

## Context

- `UserInteractions` is the canonical per-user state store and is uniquely keyed
  by `(user_id, record_key)`.
- Public client sync writes into `UserInteractions` through
  `sync-events.ts`. That path already blocks client writes to server-owned
  review metadata and is the right trust boundary for additional server-owned
  fields and reserved records.
- Public `getProgress` currently loads all user records. Without an explicit
  filter, any internal digest cursor record would leak into the client snapshot
  and delta events.
- The notification system already uses `Notifications` for preferences and
  `NotificationsOutbox` for durable delivery state, compose/send lifecycle, and
  deduplication.
- The notification system already supports bundle-style outbox rows where
  membership or snapshot data lives in `NotificationsOutbox.metadata`.
- Campaign-admin notifications already provide:
  - strict admin authorization
  - template previews
  - dry-run-first runnable plans
  - send from stored plans
- The reviewed-interaction email flow already has dynamic next-step links, but
  the current logic is narrow and only covers a small subset of campaign
  interactions.
- The requested scope is admin-triggered now, but the implementation must also
  be callable from internal cron code later without depending on HTTP routes.

## Decision

Implement a weekly progress digest for the `funky` campaign as one bundled email
per user per week, using:

- one server-owned internal cursor record in `UserInteractions`
- one bundled outbox row per `(userId, weekKey)`
- one new digest email template
- one new campaign-admin runnable template for dry-run and send
- one internal planning/execution service that is reusable by both admin routes
  and a future cron job

### Goals

- Keep the design simple and explicit.
- Reuse existing outbox, template, and admin dry-run/send infrastructure.
- Keep the weekly digest dedupe authority in `NotificationsOutbox`.
- Keep notification cursor state inside the learning-progress system, but make
  it fully server-managed.
- Prevent public users and unauthorized actors from reading or writing internal
  digest cursor records.

### Non-goals

- Per-interaction delivery markers in v1.
- A separate pending-digest staging table.
- A public user inbox or web-notification feed.
- A fully generic cross-campaign notification-state framework.
- Automatic cron scheduling in this implementation.

### Architecture Summary

1. The planner enumerates users eligible for a weekly digest.
2. For each candidate user, it reads the internal weekly digest cursor record
   and loads changed actionable interaction rows with `updated_at > watermarkAt`.
3. It builds a render-ready digest snapshot and suggested next-step links from
   the user’s current campaign state.
4. Admin dry run stores the safe preview rows in a runnable plan.
5. Admin send creates or reuses one weekly digest outbox row per user/week.
6. The compose worker renders the digest directly from the outbox metadata
   snapshot.
7. After the send worker marks the digest outbox row as `sent`, a dedicated
   weekly-digest post-send reconciler updates the internal weekly digest cursor
   record with the same `weekKey`, `watermarkAt`, `lastSentAt`, and `outboxId`.

### Data Model

#### 1. Internal weekly digest cursor record

Store one server-owned `UserInteractions` row per user for the Funky weekly
digest cursor:

- `record_key = internal:funky:weekly_digest`
- `interactionId = internal:funky:weekly_digest`
- `scope = { type: 'global' }`
- `phase = 'resolved'`
- `kind = 'custom'`
- `completionRule = { type: 'resolved' }`

Payload shape:

```json
{
  "campaignKey": "funky",
  "lastSentAt": null,
  "watermarkAt": null,
  "weekKey": null,
  "outboxId": null
}
```

Rules:

- `campaignKey` must always equal `"funky"`.
- The server must validate that the reserved record key, reserved interaction
  id, and payload campaign key all agree.
- This row is unique per user because `UserInteractions` already enforces
  uniqueness by `(user_id, record_key)`.
- This row is server-owned. Public client sync must never create, update, or
  delete it.

#### 2. Weekly digest outbox type

Add one new outbox type:

- `funky:outbox:weekly_progress_digest`

Outbox identity:

- `scopeKey = digest:weekly_progress:funky:{weekKey}`
- `deliveryKey = digest:weekly_progress:funky:{userId}:{weekKey}`

This intentionally enforces at most one weekly digest outbox row per
`userId + weekKey`. If a same-week admin rerun occurs after a row already
exists, the system reuses or skips that row instead of rebuilding it.

#### 3. Weekly digest outbox metadata

Store a render-ready weekly digest snapshot in `NotificationsOutbox.metadata`.
This is simpler and more deterministic than recomputing digest membership during
compose.

Required metadata:

- `digestType = "weekly_progress_digest"`
- `campaignKey = "funky"`
- `weekKey`
- `periodLabel`
- `watermarkAt`
- `userId`
- `summary`
- `items`
- `primaryCta`
- `secondaryCtas`
- `allUpdatesUrl`

`summary.totalItemCount` is the canonical count of qualifying digest items
before truncation.

`summary` is safe, lightweight aggregate information such as:

- `totalItemCount`
- `visibleItemCount`
- `hiddenItemCount`
- `actionNowCount`
- `rejectedCount`
- `failedCount`
- `pendingCount`
- `approvedCount`
- `draftCount`

Each `items[]` entry must be render-safe and minimal:

- `itemKey`
- `interactionId`
- `interactionLabel`
- `entityName`
- `statusLabel`
- `statusTone`
- `title`
- `description`
- `updatedAt`
- `reviewedAt` when applicable
- `feedbackSnippet` when applicable
- `actionLabel`
- `actionUrl`

CTA contract:

- `primaryCta` is required for every sendable digest and has shape
  `{ label: string, url: string }`
- `secondaryCtas` is always present and is an array with zero to two entries,
  each with shape `{ label: string, url: string }`
- `allUpdatesUrl` is optional and may be null when no safe all-updates surface
  exists yet

`statusTone` is restricted to:

- `danger`
- `warning`
- `success`

Status mapping:

- rejected -> `danger`
- failed -> `danger`
- pending -> `warning`
- draft -> `warning`
- approved -> `success`

`feedbackSnippet` rules:

- source only end-user-safe review feedback already intended for the recipient
- strip HTML and control characters
- collapse repeated whitespace
- trim to at most 280 visible characters
- omit when the sanitized value is empty

No item may contain:

- raw submitted JSON payloads
- raw audit events
- email addresses
- thread body text
- admin-only internal notes that are not already intended for the end user

### Eligibility And Candidate Selection

#### User eligibility

A weekly digest candidate user must satisfy all of the following:

- active `funky:notification:global` preference
- not globally unsubscribed from email
- at least one digest-worthy interaction updated after the cursor watermark

The digest uses the campaign-global notification preference, not
entity-scoped `funky:notification:entity_updates`.

Send-time safety requirement:

- The send worker must re-check that the user is still eligible for
  `funky:notification:global` immediately before send.
- This requires a user-scoped eligibility helper in the notification-delivery
  repository contract.

#### Actionable interaction universe

Digest-worthy interaction rows are restricted to these `funky` campaign
interaction ids:

- `funky:interaction:city_hall_website`
- `funky:interaction:budget_document`
- `funky:interaction:budget_publication_date`
- `funky:interaction:budget_status`
- `funky:interaction:city_hall_contact`
- `funky:interaction:public_debate_request`
- `funky:interaction:funky_participation`
- `funky:interaction:budget_contestation`

Progress-only rows, lesson rows, quiz rows, and internal rows are excluded.

#### Digest-worthy states

An interaction row is eligible for inclusion in the weekly digest when both
conditions hold:

- `updated_at > watermarkAt` or `watermarkAt` is null
- the current state is one of:
  - reviewed and `approved`
  - reviewed and `rejected`
  - `phase = 'pending'`
  - `phase = 'draft'`
  - `phase = 'failed'`

This keeps the weekly digest focused on actionable progress changes instead of
every resolved quiz or progress marker.

#### Week semantics

- `weekKey` is derived in `Europe/Bucharest`.
- Weekly boundaries use the local Monday-to-Sunday business week for the Funky
  campaign.

#### Watermark semantics

- `watermarkAt` represents the highest user-interaction timestamp already
  covered by a successfully sent weekly digest.
- The dry-run planner captures one plan watermark.
- The send flow persists that watermark into the outbox metadata snapshot.
- The cursor record is updated only after the outbox row reaches `sent`.

This means:

- if outbox creation or compose fails, the cursor does not move
- if provider send fails before `sent`, the cursor does not move
- if new interaction changes happen after the dry-run watermark but before the
  digest is sent, those changes are intentionally excluded from that weekly
  snapshot and will remain eligible in a later digest because the cursor only
  advances to the stored watermark

### Item Ordering And Next-Step Recommendations

#### Digest item ordering

Within one user digest, items are sorted by:

1. severity bucket
2. newest `updatedAt`
3. stable `recordKey`

Severity bucket order:

1. rejected
2. failed
3. pending
4. approved
5. draft

#### Next-step computation

Next-step recommendations are computed from the user’s full current Funky
campaign state, not only from changed rows since the watermark.

Recommendation order:

1. If a digest item is rejected or failed:
   - recommend retrying that same interaction.
2. Else if a digest item is still draft:
   - recommend resuming that same interaction.
3. Else recommend the first missing reviewable Funky interaction for the same
   entity in campaign order.
4. If `budget_document` is approved and the public debate request is missing or
   still `idle`/`draft`:
   - recommend `public_debate_request`.
5. If the public debate request has already started or completed and the
   participation report is not yet resolved:
   - recommend `funky_participation`.
6. If participation has been reported and contestation is not yet started:
   - recommend `budget_contestation`.
7. Fallback:
   - recommend viewing the entity page.

The digest exposes:

- one primary next step
- up to two secondary next steps

Each link must be absolute and render-safe.
Digest CTAs must use canonical server-built URLs and must not preserve
client-authored query strings or fragments unless separately allowlisted.
Secondary CTAs must never duplicate the primary CTA URL.

### Template Design

The template is one user-focused weekly email, not an admin audit artifact.

Required sections:

1. Weekly heading:
   - explains this is a weekly progress update for the Funky campaign
2. Short summary:
   - how many updates matter this week
   - how many need action now
3. “What changed this week”:
   - up to five digest items
   - each item shows interaction label, entity, status, short explanation, and
     one inline action link
4. “Recommended next steps”:
   - one primary CTA
   - up to two secondary links
5. Footer:
   - preferences and unsubscribe links

Subject strategy:

- default: `Actualizarea ta săptămânală din campania Funky`
- if `actionNowCount === 1`: `Ai un pas important de făcut săptămâna asta`
- if `actionNowCount >= 2`: `Ai {actionNowCount} pași care merită atenție`
- preview text: `Vezi ce s-a schimbat și care este cel mai util pas următor.`

Content constraints:

- plain, user-facing Romanian copy first
- short paragraphs
- no admin terminology
- no raw status codes
- no duplicated CTAs
- do not show internal identifiers except `entityName`

Rendering constraints:

- the template must render entirely from outbox metadata plus standard base
  template props
- the compose worker must not query `UserInteractions` again for this template
- if `summary.totalItemCount === 0`, no email is sent and the row is not
  eligible for send
- if more than five items qualify, render the top five and summarize the rest
  via `hiddenItemCount`

### Access Control And Data Boundaries

#### Write restrictions

Public client sync must reject any incoming record where:

- `record.key` starts with `internal:`
- or `record.interactionId` starts with `internal:`

Only server-side use cases may create or update
`internal:funky:weekly_digest`.

Public `progress.reset` must preserve all `internal:*` rows. Resetting user
progress is not allowed to delete the weekly digest cursor.

#### Read restrictions

Public progress reads must never expose internal records.

Required protections:

- `LearningProgressRepository.getRecords(...)` excludes internal rows by
  default through an explicit `includeInternal` option that defaults to `false`
- `getProgress()` uses the default repository behavior and therefore never sees
  internal rows when computing snapshot, cursor, or delta events
- delta events must never include internal rows
- any public or admin query that accepts a `recordKey` or `recordKeyPrefix`
  from request input must reject or ignore `internal:` values unless an
  explicitly internal-only code path is used

#### Ownership boundaries

- `UserInteractions` remains the source of truth for user progress plus the
  single internal digest cursor record.
- `Notifications` remains the source of truth for notification preferences.
- `NotificationsOutbox` remains the source of truth for delivery state and
  deduplication.
- No user-facing route may mutate or read the weekly digest cursor directly.
- Admin dry-run views may show safe preview data only; they must not expose raw
  rendered HTML or user email addresses.

#### Internal write ownership

Weekly digest cursor writes are owned by one internal-only use case:

- `upsertWeeklyDigestCursor(...)`

Rules:

- it is the only code path allowed to create or update
  `internal:funky:weekly_digest`
- it uses fixed synthetic provenance owned by the server
- it is never reachable from public routes or client sync
- it may use the existing `upsertInteractiveRecord(...)` repository primitive
  internally, but callers do not write the reserved record directly

### Admin Triggering And Future Cron Reuse

#### Admin-triggered in v1

Implement the feature as a new campaign-admin runnable template with:

- dry run
- stored plan review
- send from stored plan

Suggested runnable id:

- `weekly_progress_digest`

Suggested target kind:

- `user`

Suggested selectors:

- `userId` optional

This keeps the admin interface simple and aligned with existing
template-first notification runs.

#### Internal cron readiness

Do not implement scheduling in this phase.

Do implement one internal service layer that the runnable template uses and that
future cron code can call directly without HTTP:

- `planWeeklyProgressDigest(...)`
- `executeWeeklyProgressDigestRow(...)`

Constraints:

- planning is side-effect-free
- sending is the only stateful operation
- cron reuse must call the same core planner/executor, not duplicate business
  logic in a separate path

### Send Lifecycle

1. Dry run computes candidate users and per-user digest snapshots.
2. Admin stores the plan.
3. Send consumes the stored plan.
4. For each `will_send` row:
   - create or reuse one weekly digest outbox row
   - store the render-ready metadata snapshot
   - enqueue compose
5. Compose renders from metadata only.
6. Send worker sends the email.
7. After the outbox row becomes `sent`, the weekly-digest post-send reconciler
   updates
   `internal:funky:weekly_digest` with:
   - `campaignKey`
   - `lastSentAt`
   - `watermarkAt`
   - `weekKey`
   - `outboxId`

The cursor update must be idempotent and safe to re-run.

The post-send reconciler is owned by the delivery pipeline and runs immediately
after the send worker successfully transitions the outbox row to `sent`.

Cursor advancement intentionally happens at `sent`, not `delivered`. The weekly
digest dedupe boundary is provider acceptance, not webhook-confirmed delivery.

### Testing Requirements

#### Happy path

- weekly digest dry run returns one row for a user with changed actionable
  interactions after the watermark
- send creates one outbox row with the correct type, scope key, delivery key,
  and metadata
- send success updates the internal weekly digest cursor record
- subsequent dry run skips already-covered interactions because of the new
  watermark

#### Security

- public sync rejects `internal:*` record keys
- public sync rejects `internal:*` interaction ids
- `getProgress()` omits internal rows from snapshot and delta events
- public `recordKey` and `recordKeyPrefix` reads do not expose internal rows
- public `progress.reset` preserves internal rows
- send-time eligibility is re-checked for `funky:notification:global`

#### Dedupe and failure behavior

- duplicate send for the same `userId + weekKey` reuses or skips the existing
  outbox row
- failed send before `sent` does not advance the digest cursor
- existing retryable failed outbox row is reusable
- post-send reconciler is idempotent across retries or duplicate execution

#### Planning and state consistency

- items are ordered by severity then recency
- next-step recommendations follow the defined ranking
- new interaction changes after the dry-run watermark are not included in the
  stored snapshot and remain eligible for a later digest

## Alternatives Considered

### Per-interaction notification markers in `UserInteractions`

Rejected because it would:

- require many row mutations per digest send
- complicate query logic and replay behavior
- duplicate the outbox’s role as the delivery authority

### Separate pending-digest staging table

Rejected because the repo already supports bundled outbox delivery and the
requested scope favors simpler reuse of existing infrastructure.

### Recomputing digest membership during compose

Rejected for v1 because it weakens determinism between dry run, stored plan, and
what is actually sent. A small render-ready snapshot in outbox metadata is
simpler and safer here.

### Storing digest cursor outside `UserInteractions`

Rejected because the requested direction is to keep the cursor in the learning
progress system with strict server ownership and clear campaign scoping.

## Consequences

**Positive**

- One clear server-owned weekly digest cursor per user for the Funky campaign
- One bundled email per user per week with deterministic deduplication
- Reuse of existing outbox, template, and admin runnable-plan infrastructure
- Clear write and read protections for internal records
- Simple future cron reuse through the same core planner/executor

**Negative**

- Weekly digest remains one snapshot per user/week; same-week reruns do not
  rebuild a new snapshot when an outbox row already exists
- Internal-record filtering must be implemented carefully on both read and
  write paths
- A new bundled template adds one more outbox branch and metadata contract to
  maintain
- The delivery pipeline gains one explicit post-send reconciler branch for the
  weekly digest outbox type

## References

- [src/infra/database/user/schema.sql](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/infra/database/user/schema.sql)
- [src/modules/learning-progress/core/usecases/sync-events.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/sync-events.ts)
- [src/modules/learning-progress/core/usecases/get-progress.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/get-progress.ts)
- [src/modules/learning-progress/core/campaign-admin-config.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/campaign-admin-config.ts)
- [src/modules/learning-progress/core/usecases/reviewed-interaction-source.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/learning-progress/core/usecases/reviewed-interaction-source.ts)
- [src/modules/campaign-admin-notifications/shell/registry/admin-reviewed-interaction-runnable.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/registry/admin-reviewed-interaction-runnable.ts)
- [src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/campaign-admin-notifications/shell/registry/trigger-definitions.ts)
- [src/modules/notification-delivery/core/types.ts](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/src/modules/notification-delivery/core/types.ts)
- [docs/specs/specs-202603301900-bundle-delivery-with-queue-and-outbox.md](/Users/claudiuconstantinbogdan/projects/devostack/hack-for-facts-eb-server/docs/specs/specs-202603301900-bundle-delivery-with-queue-and-outbox.md)
