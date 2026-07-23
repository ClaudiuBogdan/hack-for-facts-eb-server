# A2-M1 — Failed quota reconcile leaves reservation pinned → day-long 429 lockout

|                       |                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| **Original severity** | Medium                                                                                                  |
| **Verified verdict**  | Confirmed · Severity unchanged                                                                          |
| **Domain**            | correctness (availability, fail-closed)                                                                 |
| **Modules / files**   | `src/modules/agent/shell/rest/routes.ts:108-136`, `src/modules/agent/shell/quota/quota-store.ts:34-117` |
| **Fix effort**        | M                                                                                                       |
| **Merge-blocker?**    | no (self-heals at UTC midnight, fail-closed)                                                            |

## TL;DR

`reserveRemaining` pins the user's daily quota key to the **full budget** for the duration of a turn (`quotaKey = budget`, reservation = `budget - used`). `reconcileQuota` (routes.ts:108-136) undoes the pin only on `reconciled.isOk()`; on a transient Redis error it **just logs — no retry, no compensation**. So a Redis blip during `onFinish` reconciliation leaves `quotaKey` stuck at `budget` → `usedToday()` returns `budget` → every subsequent `/chat` that UTC day returns 429 (`QUOTA_EXCEEDED`). It self-heals at the next UTC midnight (the key is date-scoped) and is fail-closed (over-charges, never under-charges), so it is availability-degrading, not a spend leak.

## Evidence (re-verified against current code)

Reservation pins the key to full budget (`quota-store.ts:34-43`, `RESERVE_REMAINING_SCRIPT`):

```lua
local reserved = budget - current
redis.call('SET', KEYS[1], budget, 'EX', ARGV[2])   -- quotaKey := budget
redis.call('SET', KEYS[2], reserved, 'EX', ARGV[2]) -- reservationKey := reserved
return reserved
```

So during the turn `usedToday()` (`:72-79`, reads `quotaKey`) returns `budget`. This is by design — it blocks concurrent overspend. Reconcile is what restores the real count.

Reconcile error path (`routes.ts:110-134`):

```ts
reconciliationChain = reconciliationChain.then(async () => {
  if (quotaReconciled) return;
  try {
    const reconciled = reservedTokens > 0
      ? await deps.quota.reconcileReservation(userId, reservedTokens, highestObservedTokens)
      : await deps.quota.recordUsage(userId, highestObservedTokens);
    if (reconciled.isOk()) {
      quotaReconciled = true;               // ← only cleared on success
      if (fallbackReconciliationTimer !== null) { clearTimeout(...); }
    } else {
      request.log.warn(..., 'agent: failed to reconcile token usage');  // ← log only, no retry
    }
  } catch (error) { request.log.warn(...); }  // ← throw: log only, no retry
});
```

On the **normal completion path** (`onFinish`, routes.ts:224-228) `reconcileQuota` is called **exactly once**. If that single call errors, `quotaReconciled` stays `false`, but nothing re-invokes `reconcileQuota` — the fallback timer is only scheduled from `onError`/`handleClientClose` (`:137-146`, `:219`, `:245`, `:155`), not from a reconcile failure. So a normal, successful stream whose reconcile hits a transient Redis error leaves the reservation permanently un-reconciled for the turn.

`reconcileReservation` returning `err(...)` = a real Redis failure (the Lua eval threw, `:114-116`). It is the _only_ thing that can clear the pin. No compensation runs afterward.

TTL confirmed: `QUOTA_TTL_SECONDS = 48*60*60` (`:22`). But the _lockout_ duration is **not 48h** — `quotaKey` is `agent:quota:{userId}:{utcDay}` (`:26`). Once UTC rolls to the next day, `usedToday()` reads a _new_ (unset→0) key, so the block lifts at the **next UTC midnight**; the 48h TTL only garbage-collects the stale pinned key afterward. Task's "48h" framing overstates the outage; correct bound = **remainder of the current UTC day.**

## Root cause

The reserve/reconcile protocol is optimistic-pin-then-correct, but the correction step has no durability: a single transient failure at the one guaranteed reconcile call (`onFinish`) is unrecoverable within the turn, and the reservation is never retained/released by any later mechanism on that path.

## Blast radius & impact

- **Trigger:** any transient Redis error during the `onFinish` reconcile of a completed turn (eval timeout, failover, connection reset). Frequency ≈ Redis blip rate during the ~ms reconcile window per turn — low but non-zero, and each hit locks that user out for the rest of the UTC day.
- **Effect:** affected user's `usedToday == budget` → all further `/chat` return 429 until UTC midnight. Read endpoints (`/conversations`, `/quota`) still work; `/quota` will report `used == budget`.
- **Fail-closed / bounded:** over-charges the user (denies service), never grants free tokens. Self-heals daily. Single-user scope (keyed by userId). Unlimited-list users (`quotaConfig.unlimitedUserIds`) unaffected — they skip reservation.
- Title generation has the same pattern but its `finally` (routes.ts:331-342) attempts a release, so it is less exposed.

## Reproduction / falsifiable scenario

1. User with `used=0`, budget `B`. Start `/chat` → `reserveRemaining` sets `quotaKey=B`.
2. Force `reconcileReservation` to return `err` (e.g. stub `redis.eval` to throw on the reconcile eval only).
3. Stream completes normally (`onFinish` fires, calls `reconcileQuota` once → error → logged, `quotaReconciled` stays false, no retry).
4. `GET /quota` → `used == B`; next `POST /chat` → 429. Persists until UTC date change.

## Related L2 (turn spanning UTC midnight) — brief

`utcDay()` is recomputed _at reconcile time_ (`quota-store.ts:24-27`). If a turn starts before UTC midnight and reconciles after: `reserveRemaining` pinned **yesterday's** `quotaKey` to budget and wrote **yesterday's** `reservationKey`; `reconcileReservation` now reads **today's** `reservationKey` (unset → `reserved <= 0` → Lua returns early, `:49-51`), so **today's** count is never credited (under-count) **and** yesterday's `quotaKey` stays pinned at budget until its 48h TTL. Net: usage under-counted for the boundary turn + a lingering (self-expiring) reservation on yesterday's key. Same root fix family — key the reservation/reconcile to a single captured day.

## Fix options

- **Option A (recommended):** on reconcile error, **retain the reservation and retry with bounded backoff** (e.g. 2–3 attempts) before giving up; if all fail, fall back to `recordUsage(actual)` compensation or explicitly release the reservation so the key returns to the true count rather than staying pinned at `budget`. Ensures the pin is always undone on the success _or_ exhausted-retry path.
- **Option B:** capture `utcDay` once at reserve time and thread it through reconcile (fixes L2 too), and make `reconcileReservation` idempotent/retriable so the fallback timer can safely re-drive it after any failure — then schedule the fallback timer on reconcile failure as well, not only on close/error.
- Recommended: A + the day-capture half of B. Add a test that stubs a one-shot reconcile failure and asserts the key is not left at `budget` (and a midnight-boundary test).

## Related

- Sibling: [M-A2M2](M-A2M2-kernel-tools-agent-exposure.md), [M-A5M1](M-A5M1-array-contains-empty-guard.md).
- Agent module spec §2.7 (quota).
