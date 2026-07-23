# A3-F2 — `logical_key` / `target_id` survive erasure and are structurally un-erasable

|                       |                                                                                                                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | Medium                                                                                                                                                                                                                                               |
| **Verified verdict**  | Confirmed · Severity unchanged (Medium)                                                                                                                                                                                                              |
| **Confidence**        | CONFIRMED (code paths); PLAUSIBLE (that PII actually lands in the key)                                                                                                                                                                               |
| **Domain**            | erasure · privacy                                                                                                                                                                                                                                    |
| **Modules / files**   | `src/modules/user-data/shell/repo/kysely-user-data-erasure-repo.ts`, `src/infra/database/user/migrations/202607111200_add_user_data_store.sql`, `src/modules/user-data/core/registry/categories/**`, `src/modules/user-data/core/planners/shared.ts` |
| **Fix effort**        | M                                                                                                                                                                                                                                                    |
| **Merge-blocker?**    | owner-call                                                                                                                                                                                                                                           |

## TL;DR

Owner erasure re-anonymizes `owner_id` and redacts `payload`/`annotations`, but never touches the identity columns `logical_key`, `target_id`, `target_type`, `schema_hash` on either `user_data_records` or `user_data_events`. On the events table those columns are _structurally_ un-erasable — the append-only trigger lists `logical_key` (and the others) as immutable, so an UPDATE that changed them would `RAISE EXCEPTION`. `logical_key` is client-controlled free-form for the `learning.progress` category (`^(?!internal:)\S+$`, maxLen 512) with no PII-rejecting validation, so any PII a client encodes into the key persists after a GDPR erasure, now durably linked to the anonymized owner. Fix: add key/target redaction to the erasure path (records only) and/or reject PII-shaped keys at write time; the events table needs a trigger allowance to redact them there.

## Evidence (re-verified against current code)

Erasure only writes four/seven columns and never the identity columns:

`kysely-user-data-erasure-repo.ts:51-64` (records):

```
.set({
  owner_id: input.anonymizedOwnerId,
  payload: active ? redactPayload(...) : null,
  annotations: active ? redactAnnotations(...) : null,
  privacy_redacted_at: input.now,
})
```

`kysely-user-data-erasure-repo.ts:74-83` (events) sets `owner_id`, `payload`, `annotations`, `client_occurred_at`, `source_event_id`, `source_occurred_at`, `privacy_redacted_at` — again **no** `logical_key` / `target_id` / `target_type` / `schema_hash`.

Immutability on the events table — `202607111200_add_user_data_store.sql:111-128` lists these in the `IS DISTINCT FROM OLD` guard that raises `user_data_events update touches immutable columns`; `logical_key` is at **line 115**. So even if the erasure repo _wanted_ to null the key on events, the trigger would reject it. Records table has no such trigger, so records _are_ mutable there.

Category key patterns (client-controlled, free-form):

- `learning-progress.ts:16` — `logicalKey: { pattern: /^(?!internal:)\S+$/, maxLength: 512 }` — accepts essentially any non-whitespace string up to 512 chars. `target: null`.
- `funky-interaction.ts:18` — `logicalKey: { pattern: /^funky:interaction:\S+$/, maxLength: 512 }`; `target: { required: false, allowedTypes: ['entity'] }`, so `target_id` here is an **entity CUI** (a company identifier, not personal PII).

Write-time validation does length + regex only, no PII screen — `core/planners/shared.ts:88-93` (`validateLogicalKey`).

Category enumeration is complete and small — `registry/categories/index.ts`: exactly two categories (`FUNKY_INTERACTION_CATEGORY`, `LEARNING_PROGRESS_CATEGORY`).

## Root cause

The erasure design treats `payload`/`annotations` as the only PII-bearing surface and the identity tuple `(owner_id, category, logical_key)` as opaque/technical. That holds for `funky.interaction` (namespaced key + entity-CUI target) but not for `learning.progress`, whose key is an arbitrary client string. Two compounding gaps: (1) the erasure UPDATE simply omits the identity columns; (2) on the events table the append-only trigger _forbids_ changing them, so the omission cannot be fixed without a trigger change.

## Blast radius & impact

- Affected rows: every `user_data_records` / `user_data_events` row for an erased owner in the `learning.progress` category whose `logical_key` embeds PII.
- Precondition: a client constructs a `learning.progress` logical key from personal data (e.g. `progress:jane.doe@example.com:lesson-3`, or a raw user handle/name). Nothing prevents it; the pattern allows it.
- On fire: after `eraseOwner`, `owner_id` is anonymized but the PII-bearing `logical_key` remains, and remains **joined to** that anonymized owner via `(owner_id, category, logical_key)` — i.e. the erasure leaves a durable personal-data residue that also links records↔events for the "forgotten" subject.
- Bounding factors: only one of two categories is exposed (`funky.interaction` keys are namespace-prefixed and its target is a company CUI, so it is low-risk); the realized risk depends entirely on how the frontend mints `learning.progress` keys, which is not visible in this repo. `schema_hash` is a content hash, not PII. So this is a latent/config-dependent leak, not a guaranteed one — hence Medium, not High.

## Reproduction / falsifiable scenario

1. Write a `learning.progress` record with `logicalKey = "progress:jane.doe@example.com"` (passes `^(?!internal:)\S+$`, ≤512).
2. Run owner erasure for that owner.
3. `SELECT logical_key FROM user_data_records WHERE owner_id = <anon>` still returns `progress:jane.doe@example.com`; the events row likewise retains it, and the trigger blocks any attempt to null it.

## Additional context discovered

- Only two categories exist, so the exposure is narrow and auditable — a targeted fix is cheap.
- `target_id` PII risk is effectively nil today (only `funky.interaction` sets a target, and it is an entity CUI), but the erasure gap for `target_id`/`target_type` should still be closed defensively for future categories.
- The records table is trigger-free, so redacting the key there is a pure repo change; the events table would additionally need the append-only trigger to permit a maintenance-mode key redaction (mirroring how it already special-cases `app.user_data_maintenance = 'on'` and `privacy_redacted_at`).
- Same bug class as the sibling erasure findings (payload/annotation redaction coverage) — this is the _identity-column_ corner the redactors don't reach.

## Fix options

**Option A (recommended) — redact identity columns during erasure + allow it on events.**
On records, add to the `.set(...)`: `logical_key` → a deterministic non-PII token (e.g. `redacted:<record_id>` to preserve the uniqueness constraint), and null `target_id`/`target_type` (respecting the `(target_type IS NULL) = (target_id IS NULL)` CHECK). On events, drop `logical_key`/`target_id`/`target_type` from the trigger's immutable list _only when_ `app.user_data_maintenance = 'on'` (the trigger already gates redaction on that flag + `privacy_redacted_at`). Trade-off: touches an audited immutability guard — needs a careful migration and a test asserting non-maintenance UPDATEs still fail.

**Option B — reject PII-shaped keys at write time (defense-in-depth, not a fix alone).**
Tighten `learning.progress` to a namespaced pattern like `funky.interaction` (e.g. `^learning:progress:[a-zA-Z0-9:_-]+$`) so keys cannot carry emails/free text, enforced in `validateLogicalKey`. This prevents _new_ PII keys but does nothing for already-stored rows, and can't fully bar a determined client from stuffing an identifier into the allowed charset. Ship alongside A, not instead of it.

Pin with a test: erase an owner whose record/event key contains PII → assert the persisted `logical_key`/`target_id` no longer contain it, and assert a normal (non-maintenance) UPDATE of `logical_key` still raises.

## Related

- Sibling erasure findings in this cluster (payload/annotation coverage) and the H-series erasure PII-survival items — same "what does erasure actually null" theme.
- Main report: user-data erasure completeness section.
