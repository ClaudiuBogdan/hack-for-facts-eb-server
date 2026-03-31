# Bundle Delivery With Queue And Existing Outbox

**Status**: Draft
**Date**: 2026-03-30
**Author**: Codex

## Problem

The notification system needs to send a single email that can contain multiple
source notifications for the same user and period, while preserving retry and
audit behavior.

The previous design direction introduced a separate pending-item table. That was
rejected in favor of a simpler model that reuses the existing queueing
infrastructure and the existing `notificationoutbox` table.

## Decision

Use `notificationoutbox` as the durable record for a bundle email and store the
bundle membership in `metadata`.

### What stays the same

- `notifications` remains the preference/config table.
- `notificationoutbox` remains the durable record for compose/send/retry/audit.
- BullMQ remains the orchestration mechanism for asynchronous compose/send work.

### What changes

- Add explicit bundle outbox types:
  - `anaf_forexebug_digest`
- Create bundle outbox rows before compose.
- Persist render-ready bundle membership in `notificationoutbox.metadata`.
- Reuse the existing outbox compose path for both transactional and bundle rows.

## Bundle Lifecycle

### 1. Materialize bundle membership

For the current ANAF / Forexebug digest, the admin trigger runs after data is loaded and:

1. finds eligible newsletter and alert preferences
2. groups source notification ids by `(userId, bundleType, periodKey)`
3. creates one outbox row per group with deterministic `delivery_key`
4. stores only the grouped source notification ids and lightweight audit fields
   in `metadata`
5. enqueues an outbox compose job

Daily and weekly user bundles may follow the same outbox pattern later, but
they are future scope only and are not implemented here.

### 2. Compose

The compose worker loads the outbox row by `outboxId`, inspects
`notificationType`, and:

- for `transactional_welcome`, builds the welcome props from metadata
- for bundle rows, loads `sourceNotificationIds` from metadata, fetches current
  source notification data, and builds the template props at compose time

Bundle retries still operate on the same outbox row, but bundle content is
recomputed from the stored source notification references rather than from
render-ready metadata blobs.

### 3. Send and retry

The send worker still operates on a single outbox row.

- Transient failures retry the same outbox row.
- Compose failures can be retried by re-enqueueing compose for the same outbox
  row.
- Permanent failures stay attached to the same outbox row; v1 does not rebuild
  bundle membership automatically.

## Metadata Contract

Bundle outbox rows store enough structured metadata to:

- rebuild template props during compose retries
- audit which source notifications were included
- inspect source notification ids during webhook side effects

Expected metadata keys:

- `bundleType`
- `sourceNotificationIds`
- `itemCount`
- `periodLabel` (optional)
- `designDoc` (optional)

The outbox row keeps the durable list of source notifications for audit and
retry orchestration. The actual newsletter/alert section payloads are rebuilt at
compose time.

## Why Not Arrays In Queue Payloads

Bundle membership must survive retries independently of Redis queue state.

Keeping the full bundle membership only in a queue payload would make compose
retries dependent on the job payload and would blur the retry boundary. The
outbox row is the correct durable boundary because it already stores rendered
content, status, send attempts, provider ids, and audit metadata.

## Why Not Reuse `reference_id`

`reference_id` is singular and stays meaningful for single-source rows. Bundle
emails can contain many source notifications, so bundle rows use:

- `reference_id = null`
- `metadata.sourceNotificationIds = [...]`

This preserves the existing schema while keeping the meaning of `reference_id`
honest.

## Webhook Behavior

Webhook reconciliation still keys off `delivery_id`.

For single-source rows, the existing `notification_id` tag remains useful. For
bundle rows, deactivation logic loads the outbox row via `delivery_id` and reads
`metadata.sourceNotificationIds`.

## Consequences

### Positive

- No new database table
- Retry boundary remains one outbox row per physical email
- Bundle membership is durable and auditable
- Compose jobs stay small (`outboxId` only)

### Trade-offs

- Bundle metadata becomes a structured contract that must be kept stable
- Bundle materialization must happen before enqueueing compose
- Querying bundle members for analytics/audit relies on JSON metadata rather
  than a dedicated relational table
