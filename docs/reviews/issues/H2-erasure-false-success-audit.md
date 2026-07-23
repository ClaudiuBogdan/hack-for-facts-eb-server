# H2 — Erasure writes a SUCCESS audit + fires "erasure completed" email while the User Data Store is never erased

|                       |                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | High (escalates to Critical under config drift)                                                                                                         |
| **Verified verdict**  | Confirmed · Severity unchanged (High; escalates to Critical when store rows exist under flag-off)                                                       |
| **Confidence**        | CONFIRMED                                                                                                                                               |
| **Domain**            | erasure · privacy                                                                                                                                       |
| **Modules / files**   | `src/modules/clerk-webhooks/shell/anonymization/user-data-anonymizer.ts`, `src/app/build-app.ts`, `src/infra/config/env.ts`, `src/modules/user-data/**` |
| **Fix effort**        | S                                                                                                                                                       |
| **Merge-blocker?**    | yes                                                                                                                                                     |

## TL;DR

On a Clerk `user.deleted` webhook the anonymizer treats a missing `userDataStoreEraser` as "nothing to erase" (`ok({records:0,events:0,receipts:0})`), then writes a completed audit row and fires the admin "erasure completed" email. The eraser is wired **only** when `config.userDataStore.enabled` is true — a flag that **defaults to `false`** — while the store tables are created unconditionally by migration and the deletion handler is registered unconditionally. Result: any deployment with residual store rows but the flag off silently skips GDPR erasure **and affirmatively records success**. Fix: build the eraser whenever `userDb` exists (decouple erasure from the write-enable flag).

## Evidence (re-verified against current code)

**1. Undefined eraser is treated as success** — `user-data-anonymizer.ts:1088-1095`:

```ts
const userDataStoreResult =
  deps.userDataStoreEraser === undefined
    ? ok({ records: 0, events: 0, receipts: 0 })
    : await deps.userDataStoreEraser.eraseOwner({ ownerId: userId, ... });
```

`isErr()` is then false, so control falls straight through to the success path.

**2. Success audit is written unconditionally after that** — `:1108-1125`. `insertAuditRow` overwrites the `{status:'started'}` marker (written by `markAuditStarted`, `:665`) with the full summary (`userDataStoreRecords/Events/Receipts = 0`) and sets `completed_at`. There is **no status column** — "completed" is implicit in the presence of the full summary. Nothing records whether the 0 means "nothing existed" vs "we never tried" (`:588-630`).

**3. Admin "erasure completed" email fires** — `:1132-1144` → `notifyAdminAnonymizationCompleted` (`:678-697`) calls `notifier.notifyCompleted(...)`. It fires whenever `deps.adminNotifier` is set, which is gated on `config.email.enabled` only (`build-app.ts:1278-1291`) — **independent** of the store flag.

**4. Eraser wired only under the flag** — `build-app.ts:1261-1273`: `userDataStoreEraser` is constructed **inside** `if (shouldInitializeUserDataStore)`. `:1277` attaches it to the anonymizer only when defined. Critically, the anonymizer itself (`:1274`) and the Clerk deletion handler (`:1293-1298`) are created/registered **outside** the gate — every instance processes deletions whether or not the store is enabled.

**5. Flag definition + default** — `env.ts:146` `USER_DATA_STORE_ENABLED: Type.Optional(Type.Boolean({ default: false }))`; parsed `env['USER_DATA_STORE_ENABLED'] === 'true'` (`:343`); resolved `enabled: env.USER_DATA_STORE_ENABLED ?? false` (`:594`); consumed at `build-plan.ts:177` `shouldInitializeUserDataStore = config.userDataStore.enabled`. **Default-OFF.**

**6. Tables created unconditionally** — `202607111200_add_user_data_store.sql:4` `CREATE TABLE IF NOT EXISTS user_data_records (...)`. Migrations run regardless of the flag, so the tables (and any rows) exist even when the flag is off.

## Root cause

Two independent design gaps compound: (a) the anonymizer conflates "eraser dependency absent" with "no data to erase" instead of failing closed; and (b) wiring couples the **erasure** capability to the **write-enable** flag, even though the underlying tables (and therefore residual PII) exist unconditionally. The audit/notification path then reports success based on a summary that was never validated against actual store contents.

## Blast radius & impact

- **Compliance falsification.** The system emits a durable audit row and an admin "erasure completed" email asserting a GDPR Art. 17 erasure that did not touch the User Data Store. This is worse than a silent miss — it manufactures false evidence of compliance.
- **The dangerous state is the default, not an edge case.** `USER_DATA_STORE_ENABLED` defaults to `false`. Any deployment that had the flag on for a window (owner routes writing `user_data_records` / `_events` / `_idempotency_receipts`), then turned it off (rollback, incident mitigation, cost), leaves rows behind with the eraser now undefined. Subsequent `user.deleted` events falsely report success.
- **Multi-instance topology.** Because the anonymizer and the deletion handler are wired outside the flag gate, an instance/replica with the flag off still registers and processes Clerk deletion webhooks — it just skips the store. A mixed fleet (some instances on, some off) will erase or not depending on which pod the webhook lands on, all reporting SUCCESS.
- **No self-heal.** See below — the reconcile job neither runs (when flag off) nor checks for residual owner rows (when on).
- **Bounding condition:** only bites when store rows actually exist for the deleted owner. With a never-enabled, never-written store, the 0/0/0 result is genuinely correct — which is exactly why it slipped review.

## Reproduction / falsifiable scenario

1. Deploy with `USER_DATA_STORE_ENABLED=true`; a user creates records via the owner routes (rows land in `user_data_records`).
2. Redeploy with `USER_DATA_STORE_ENABLED` unset/`false` (default). Tables and rows persist.
3. Clerk fires `user.deleted` for that user.
4. Observed: `anonymizeDeletedUser` returns `ok` with `userDataStoreRecords:0`; `userdataanonymizationaudit` gets a completed row; the admin receives an "erasure completed" email. The user's `user_data_records` / `_events` / `_idempotency_receipts` rows are **still present with original payloads**.

Test sketch (e2e, mirrors `tests/e2e/user-data-anonymizer.test.ts`): seed 2 store records for `ownerId`, build the anonymizer **without** `userDataStoreEraser`, call `anonymizeDeletedUser`, then assert the store rows are gone OR that no completed audit/notification was produced. Today it wrongly reports success with the rows intact.

## Additional context discovered

- **Reconcile does not catch it — two ways.** (a) The maintenance/reconcile runtime is wired inside the same `if (shouldInitializeUserDataStore)` block (`build-app.ts:1715` → maintenance runtime at `:1775-1795`), so with the flag off it never runs. (b) Even when it runs, `findViolations` (`kysely-user-data-reconciliation-repo.ts:36-141`) only checks **event-sourcing integrity** — `revisionMismatch`, `afterImageMismatch`, `missingEvent`, `expiredReceipts`. It has **no notion of "rows owned by an anonymized/deleted user"**, so residual PII from a skipped erasure is invisible to reconciliation.
- **Tests miss the exact path.** `tests/e2e/user-data-anonymizer.test.ts` always wires an eraser (`:38`, `:1109`). There is a good test that a **failing** eraser aborts the anonymization so Clerk retries (`:1100-1127`), and one asserting counts when the eraser is present (`:722`, `:737`). There is **no** test for the undefined-eraser-with-residual-rows case, and no test asserting the eraser is always wired. The handler unit test uses a fixed `userDataStoreRecords: 0` summary (`user-deleted-anonymization-handler.test.ts:34`), so it doesn't exercise the wiring gap.
- **Sibling to H1.** H1 covers PII surviving in `resend_wh_emails`; this finding is the audit/notification-integrity twin — erasure is incomplete **and** reported complete.

## Fix options

**Option A — Always wire the eraser when `userDb` exists (recommended).**
The store tables are created unconditionally, so erasure must be unconditional too; only _reads/writes/maintenance_ should stay behind `USER_DATA_STORE_ENABLED`. In `build-app.ts:1259-1273`, hoist the registry + `makeUserDataStoreEraser({ erasurePort: makeUserDataErasureRepo({ db: userDb }), registry })` construction out of the `if (shouldInitializeUserDataStore)` gate (guard only on `userDb !== undefined`), leaving the owner/admin routes and maintenance runtime (`:1715` block) gated as-is. Then `deps.userDataStoreEraser` is always defined and the `undefined` branch at `user-data-anonymizer.ts:1088` becomes unreachable in production. Small, localized, and makes erasure fail-closed via the existing eraser error path.

**Option B — Fail closed when the eraser is absent.**
At `user-data-anonymizer.ts:1088`, replace the `ok({0,0,0})` branch with a lightweight residual-rows probe (COUNT over the owner's store rows). If any exist, return `err` (Clerk retries) or write a degraded/failed audit and suppress the "completed" notification. Heavier, still leaves data un-erased in the moment, and needs a new port. Use only if A is infeasible.

Recommended: **A**, plus a pinning test. Add an e2e that seeds store rows and drives `anonymizeDeletedUser` through the **actual build-app wiring with the flag off**, asserting the rows are erased and that a no-op success audit/email is never produced when residual rows exist. Optionally a build-app unit assertion that a build with `userDb` present always attaches `userDataStoreEraser` to the anonymizer.

## Related

- [H1](H1-...md) — residual PII in `resend_wh_emails` after erasure (same erasure-completeness theme).
- Main report: erasure / privacy section.
