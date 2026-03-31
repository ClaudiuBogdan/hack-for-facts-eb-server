# Generic Learning Progress Sync and Storage

**Status**: Draft
**Date**: 2026-03-20
**Author**: Codex

## Problem

The previous learning-progress backend stored one JSONB event array per user and encoded domain-specific semantics directly into server-side event types and snapshot logic. That design no longer matched the client progress model and introduced correctness issues:

- stale writes could overwrite newer record state based on arrival order
- concurrent writes to the same logical record could race and lose audit events
- the backend understood onboarding, content progress, and other domain-specific concerns that the client had already moved into generic records
- the client and server no longer shared one canonical sync contract

The current system needed a single generic contract where the server stores opaque progress records safely and the client owns projection into learning or campaign-specific views.

## Context

### Current Constraints

- The route remains `GET /api/v1/learning/progress` and `PUT /api/v1/learning/progress`.
- The server stores one row per `user_id + record_key`.
- Client-owned reserved keys such as onboarding, active path, streak, lesson summaries, and campaign state must remain opaque to the backend.
- The client uses `InteractiveStateRecord` and `InteractiveAuditEvent` as the shared envelope for both user-facing and reserved/system state.
- Sync must be safe under retries, stale offline updates, and concurrent device/tab writes.
- Review-required interactions need a server-owned review field without turning the whole record into a server-owned object.

### Why This Matters Now

- The client now projects `LearningGuestProgress` from generic records rather than syncing domain-specific events.
- The server had to stop interpreting old event types such as `content.progressed`, `onboarding.completed`, `onboarding.reset`, and `activePath.set`.
- Atomicity and write ordering had to be corrected so progress state is determined by record freshness and transaction boundaries rather than request arrival order.

## Decision

### 1. The server accepts only generic progress transport events

The only accepted event types are:

- `interactive.updated`
- `progress.reset`

Rules:

- `interactive.updated` carries one `InteractiveStateRecord` and optional `InteractiveAuditEvent[]`.
- `progress.reset` clears all learning-progress rows for the user.
- The server rejects old learning-specific transport events and does not expose replacement server-specific domain events.
- Public sync must reject client-authored `record.review`; review state is written only through server-side use cases.
- Public sync may receive an unchanged echoed `record.review` from a prior server snapshot or delta; the server strips the echo and preserves the stored review state.
- A public retry back to `phase = pending` clears previously stored `record.review` only when the retry is newer than the reviewed row.

### 2. The server snapshot is generic, not projected

The response snapshot shape is:

```ts
{
  version: 1,
  recordsByKey: Record<string, InteractiveStateRecord>,
  lastUpdated: string | null,
}
```

Rules:

- The snapshot is authoritative remote state.
- The server does not return `LearningGuestProgress` or any projected fields such as onboarding, active path, streak, or content summaries.
- The client is responsible for projecting generic records into app-specific state.

### 3. Storage is one row per `user_id + record_key`

Each learning-progress row stores:

- `record_key`
- current `record` (`InteractiveStateRecord`)
- inline `audit_events` (`StoredInteractiveAuditEvent[]`)
- `updated_seq`
- timestamps

Rules:

- `record_key` is fully client-controlled.
- `updated_seq` is a monotonic server cursor and write-order marker.
- `updated_seq` is not a freshness signal; record freshness is determined by `record.updatedAt`.
- The backend remains agnostic to keys such as `system:learning-onboarding`, `system:learning-streak`, `system:lesson-progress:<contentId>`, or campaign keys.
- Field ownership can still differ inside the opaque record: for review-required interactions, `record.review` is server-owned even though the server remains agnostic to domain-specific record keys.

### Review-required record example

Example reviewed interaction row payload:

```ts
{
  key: 'campaign:primarie-website-url::entity:4305857',
  interactionId: 'campaign:primarie-website-url',
  lessonId: 'civic-monitor-and-request',
  kind: 'custom',
  scope: { type: 'entity', entityCui: '4305857' },
  completionRule: { type: 'resolved' },
  phase: 'resolved',
  value: {
    kind: 'json',
    json: {
      value: {
        websiteUrl: 'https://example.com',
        submittedAt: '2026-03-23T19:27:40.526Z',
      },
    },
  },
  result: null,
  review: {
    status: 'approved',
    reviewedAt: '2026-03-23T19:30:00.000Z',
    feedbackText: 'Approved by review.',
  },
  updatedAt: '2026-03-23T19:30:00.000Z',
  submittedAt: '2026-03-23T19:27:40.527Z',
}
```

Operational rule for future review-required interactives:

- user submissions go through public `interactive.updated`
- server review updates must go through a server-side use case
- the server should append a system `evaluated` audit event when review is applied

### Canonical Interactive Lifecycle

`InteractiveStateRecord` is the only authoritative lifecycle envelope.

Local client definition metadata may classify an interactive as:

- `immediate`
- `async_review`

That metadata is not synced; the synced contract remains the generic record.

Canonical phase meanings:

- `idle`: no meaningful submission yet
- `draft`: editable unsent value
- `pending`: submitted and waiting for async review
- `resolved`: successful terminal state
- `failed`: terminal retry-needed state

Field expectations:

- `idle` / `draft`
  - `result = null`
  - `review` absent
  - `submittedAt` absent or null
- `pending`
  - `value` is present
  - `result = null`
  - `review` absent
  - `submittedAt` is present
  - one user `submitted` audit event exists for the attempt
- `resolved` for immediate-eval interactions
  - `result` carries the evaluation outcome
  - `review` stays absent
- `resolved` for async-review interactions
  - `review.status = approved`
  - `review.reviewedAt` is present
  - `submittedAt` is preserved from the user attempt
- `failed` for async-review interactions
  - `review.status = rejected`
  - `review.reviewedAt` is present
  - `review.feedbackText` is required
  - `submittedAt` is preserved from the user attempt

Ownership rules:

- client-owned through public sync: `value`, `phase`, `submittedAt`, and `result` for immediate-eval flows
- server-owned: `review` for all async-review flows
- public sync must never author `review`
- public sync may echo a previously returned `review`, but the server ignores the echoed field unless it differs, in which case the request is rejected
- review outcomes must not be encoded in `result.response`, `result.feedbackText`, or legacy `reviewStatus` payloads

Retry rule:

- a retry is represented as a new public submit of the same record key
- the retried record re-enters `phase = pending`
- server-owned `review` from the previous attempt is cleared
- `submittedAt` and `updatedAt` advance for the new attempt
- a new user `submitted` audit event is appended

### 4. Sync requests support partial success for invalid events

A sync request is processed inside one repository transaction for database correctness, but validation failures no longer abort the whole request.

Rules:

- invalid public events are reported per event in the success payload:

```ts
{
  ok: true,
  data: {
    newEventsCount: number,
    failedEvents: Array<{
      eventId: string,
      errorType: 'InvalidEventError',
      message: string,
    }>,
  },
}
```

- valid events in the same request are still applied in order even when earlier or later events fail validation
- repository or transaction failures still abort the request and return a retryable request-level error
- `progress.reset` followed by valid `interactive.updated` events still commits atomically with respect to database failures

### 5. Writes are serialized per existing row and safe under first-write races

`upsertInteractiveRecord()` enforces write safety with two behaviors:

- existing rows are locked during update
- first-write races use conflict-safe insert retry

Rules:

- concurrent writes to the same `record_key` must not drop audit events
- the implementation must handle two clients creating the same row concurrently
- writes that start from the same previous state must not overwrite each other’s merged audit history

### 6. Stale record snapshots are rejected by `record.updatedAt`

The server compares incoming and stored record freshness using `record.updatedAt`.

Rules:

- if the incoming record is older than the stored record, the stored row snapshot stays newer
- unseen audit events may still merge into the row even when the stored record remains the authoritative snapshot
- final row state is determined by record freshness, not request arrival order

### 7. Remote delta ordering is still expressed by `updated_seq`

The server exposes deltas by cursor using `updated_seq`.

Rules:

- `GET /api/v1/learning/progress` without `since` returns the authoritative snapshot and may return `events: []`
- `GET /api/v1/learning/progress?since=<cursor>` returns synthetic `interactive.updated` deltas for rows changed after that sequence
- `updated_seq` is the server-owned ordering token used for sync cursors
- `updated_seq` must not be used by the client as a replacement for `record.updatedAt` freshness

## Alternatives Considered

### 1. Keep old content/onboarding/active-path event types

Rejected because:

- it keeps server-side domain knowledge that the client has already moved into reserved records
- it creates two overlapping progress contracts
- it reintroduces schema drift between client projection rules and backend storage

### 2. Use a special server meta row for onboarding, active path, or sync metadata

Rejected because:

- it breaks the generic record model
- it makes the server aware of client-specific state meanings
- the client already has a reserved-key convention that serves the same purpose without backend semantics

### 3. Normalize into multiple backend tables and projections

Rejected because:

- it adds complexity without changing the client contract
- the chosen model optimizes for one generic sync backend with minimal schema surface
- a single table plus opaque records is sufficient for current needs

## Consequences

**Positive**

- The client and server now share one generic sync contract.
- Stale offline updates no longer overwrite newer record state.
- Concurrent writes to the same logical record are handled safely.
- The backend stays simple and agnostic to learning- or campaign-specific semantics.
- Reserved keys can evolve on the client without backend schema changes.

**Negative**

- The server no longer provides projected app state; the client must own all projection logic.
- Cold snapshots still do not include historical audit logs unless the API is extended to embed them.
- The meaning of reserved keys is intentionally undocumented in the backend schema itself and must be tracked in client specs and code.

## References

- `src/modules/learning-progress/core/types.ts`
- `src/modules/learning-progress/core/ports.ts`
- `src/modules/learning-progress/core/usecases/get-progress.ts`
- `src/modules/learning-progress/core/usecases/sync-events.ts`
- `src/modules/learning-progress/core/reducer.ts`
- `src/modules/learning-progress/shell/repo/learning-progress-repo.ts`
- `src/modules/learning-progress/shell/rest/schemas.ts`
- `src/infra/database/user/schema.sql`
