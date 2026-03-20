# Plan: Review & Harden Learning Progress Generic Sync

## Context

The learning-progress module was refactored from a per-user event array (event-sourced) model to a generic record store (one row per `user_id + record_key`). The spec is at `docs/specs/specs-202603201356-learning-progress-generic-sync.md`. This plan covers bugs/issues found during review and missing test coverage to add.

---

## Part 1: Fixes

### Fix 1 — GET route missing 400 response schema + wrong type assertion

**File:** `src/modules/learning-progress/shell/rest/routes.ts`

`getProgress` can return `InvalidEventError` (non-numeric `since` cursor) which maps to HTTP 400. But:

- The GET route schema (line 76) only defines `200`, `401`, `500` — missing `400`.
- The type assertion at line 94 is `status as 500` — should be `status as 400 | 500`.

**Changes:**

- Add `400: ErrorResponseSchema` to the GET route's response schema.
- Change `reply.status(status as 500)` to `reply.status(status as 400 | 500)`.

### Fix 2 — Remove `EventLimitExceededError` dead code

**Files:** `src/modules/learning-progress/core/errors.ts`, `src/modules/learning-progress/index.ts`

After the refactor, `MAX_EVENTS_PER_USER` was removed, the old `getEventCount()` port was removed, and `sync-events.ts` no longer uses `createEventLimitExceededError`. The type, constructor, and HTTP status mapping entry are all unreachable.

**Changes:**

- Remove `EventLimitExceededError` interface, `createEventLimitExceededError` constructor, and its entry in `LEARNING_PROGRESS_ERROR_HTTP_STATUS` from `errors.ts`.
- Remove `EventLimitExceededError` and `createEventLimitExceededError` re-exports from `index.ts`.

### Fix 3 — `ErrorResponseSchema` `ok` field should not be Optional

**File:** `src/modules/learning-progress/shell/rest/schemas.ts`

All other modules use `ok: Type.Literal(false)` (required). This module changed it to `Type.Optional(Type.Literal(false))`, which is inconsistent. The route handlers always send `ok: false`.

**Change:** Revert to `ok: Type.Literal(false)`.

### Fix 4 — Fake repo type safety in early-return path

**File:** `tests/fixtures/fakes.ts`

At the `applied: false` early return (~line 1447), `existing` is typed `LearningProgressRecordRow | null` but runtime logic guarantees non-null. Add a defensive guard to make the invariant explicit.

**Change:** Add null guard before the return: `if (existing === null) throw new Error('Invariant: expected existing row');`

---

## Part 2: New Tests

### Unit: `tests/unit/learning-progress/sync-events.test.ts`

| #   | Test name                                                                    | Spec section | What it verifies                                                                                      |
| --- | ---------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| 1   | "processes reset followed by interactive.updated atomically"                 | Sec 4        | A batch `[progress.reset, interactive.updated]` fully commits: old rows cleared, new record stored    |
| 2   | "merges new audit events even when the record snapshot is stale"             | Sec 6        | Stale record + new audit events → stored record stays newer, audit events ARE merged, `applied: true` |
| 3   | "stores multiple interactive.updated events for different keys in one batch" | Sec 4        | A batch with 2+ `interactive.updated` events for different keys → all stored                          |

### Unit: `tests/unit/learning-progress/reducer.test.ts`

| #   | Test name                                                                                         | What it verifies                                                                    |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 4   | "buildSnapshotFromRecords computes lastUpdated from the latest updatedAt across multiple records" | Multi-record snapshot ordering and `lastUpdated` computation                        |
| 5   | "buildDeltaEventsFromRecords excludes rows and audit events at the since boundary"                | Row with `updatedSeq === since` excluded; audit event with `seq === since` excluded |
| 6   | "getLatestCursor returns '0' for an empty array"                                                  | Direct call with `[]`                                                               |

### Unit: `tests/unit/learning-progress/get-progress.test.ts`

| #   | Test name                                         | What it verifies                                                  |
| --- | ------------------------------------------------- | ----------------------------------------------------------------- |
| 7   | "treats empty string cursor as a cold load"       | `since: ''` → events: [], snapshot present                        |
| 8   | "returns all records as deltas when since is '0'" | `since: '0'` → all rows appear as delta events + snapshot present |

### Integration: `tests/integration/learning-progress-rest.test.ts`

| #   | Test name                                                         | What it verifies                                              |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| 9   | "returns 400 for non-numeric since cursor"                        | `GET ?since=abc` → 400                                        |
| 10  | "accepts empty events array on PUT"                               | `PUT { events: [] }` → 200 `{ ok: true }`                     |
| 11  | "isolates records between users"                                  | Seed user 1 records, GET as user 2 → empty snapshot           |
| 12  | "processes reset followed by interactive.updated in single batch" | `PUT [reset, updated]` → 200, then `GET` → new record present |

---

## Verification

1. `pnpm test:unit` — all unit tests pass
2. `pnpm test:integration` — all integration tests pass
3. `pnpm typecheck` — no type errors
4. `pnpm lint` — no lint warnings
