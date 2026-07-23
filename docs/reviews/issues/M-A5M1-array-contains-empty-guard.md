# A5-M1 — `contains: []` on an array column has no empty-array guard

|                       |                                                     |
| --------------------- | --------------------------------------------------- |
| **Original severity** | Medium                                              |
| **Verified verdict**  | Revised → Low (query 500, NOT match-all widening)   |
| **Confidence**        | CONFIRMED                                           |
| **Domain**            | correctness                                         |
| **Modules / files**   | `src/modules/shared/core/filters/derive.ts:309-329` |
| **Fix effort**        | S                                                   |
| **Merge-blocker?**    | no                                                  |

## TL;DR

The `contains` op on an ARRAY column compiles an empty input array to an **untyped** `array[]` SQL literal (`col @> to_jsonb(array[])` for jsonb, `col @> array[]` for text[]), unlike `in` at :282 which guards empty→`sql\`false\``. The reachable public path is `reference.tags`(jsonb array). Postgres rejects the untyped empty literal with`cannot determine type of empty array`, so the actual runtime is a **query error / 500 — NOT a match-all row widening**. It is still a correctness/robustness gap worth a one-line guard, but it does not over-return data.

## Evidence (re-verified against current code)

`derive.ts:309-328` — the `contains` array branch:

```ts
const items = Array.isArray(value) ? value : [value];
const coerced: (...)[] = [];
for (const item of items) { /* coerce; [] stays [] */ }
const arr = sqlArray(coerced);            // sqlArray([]) → sql`array[]`  (UNTYPED)
return ok(wrap(
  field.column.arrayKind === 'jsonb'
    ? sql`${colRef} @> to_jsonb(${arr})`  // → col @> to_jsonb(array[])
    : sql`${colRef} @> ${arr}`));         // → col @> array[]
```

`sqlArray` (`derive.ts:211-216`) builds `array[${join(values)}]`; with `values=[]` this is the literal `array[]` with **no type annotation and no elements**.

Contrast `in` at `derive.ts:280-282`:

```ts
// #60h: explicit empty in:[] means "match nothing" — compile to FALSE
if (value.length === 0) return ok(wrap(sql`false`));
```

This guard fires _before_ the array branch, so `in` on an array column is safe. `contains` has no equivalent.

Reachability confirmed:

- `reference/core/filters.ts:115-120` — `tags` field, `ops: ['contains']`, `column: { …, arrayColumn: true, arrayKind: 'jsonb' }`. Live public filter.
- `surfaces.ts:59` (REST) and `:137` (GraphQL) type `contains` on an array column as `Type.Array(Type.String())` / `[String!]` with **no `minItems`** (`grep minItems` → none). So `{ tags: { contains: [] } }` passes surface validation on both surfaces and reaches the deriver.

Postgres behavior (reasoned, not live-run — no DB reachable in this read-only pass): an untyped empty array literal `array[]` fails analysis with `ERROR: cannot determine type of empty array`. `to_jsonb(array[])` (jsonb path, the reachable `tags` case) passes an untyped empty array to `to_jsonb(anyelement)` → same error. This raises to the repo/composer execution and surfaces as a `databaseError` / 500, not a result set.

## Root cause

The empty-array short-circuit was added only to the `in` case (#60h) and never mirrored to `contains`. `sqlArray([])` emits an untyped literal, so the degenerate input reaches Postgres as invalid SQL.

## Blast radius & impact

- **Flag for the reader (per task):** the behavior is a **query error (500), NOT a match-ALL widening.** `X @> ARRAY[]` is _logically_ true for every X (every set contains the empty set), so if the literal were typed (e.g. `array[]::text[]`) this WOULD silently widen to all rows. It does not widen only because the untyped literal errors first. The guard is still the correct fix — do not rely on the accidental error for safety.
- Only the public `reference` collection (`tags`, ~15k rows) exposes a `contains` array op today, so blast is bounded to public data and a failed request. No auth/PII surface.
- No amplification: a single malformed request → single 500. Not a usable DoS beyond a normal bad-request.

## Reproduction / falsifiable scenario

GraphQL: `referencePublicEntities(filter: { tags: { contains: [] } })` → expect a 500 / database error (`cannot determine type of empty array`), not a full-table result. A unit test on `toConditionBuilders(referenceSpec, { tags: { contains: [] } })` currently produces a `col @> to_jsonb(array[])` condition; after the fix it should produce `sql\`false\``.

## Additional context discovered

- Scanned all other array operators: `&&` (text[] overlap) and `?|` (jsonb) are only emitted from the `in` branch (`derive.ts:289-297`), which is already guarded by the empty check. `@>` / `to_jsonb(@>)` are only emitted from `contains`. `prefix` is scalar-only. **`contains` is the sole unguarded array op.**
- `primarii-transparency/core/filters.ts:172` also declares an `arrayColumn:'text'` field, but its op is `in` (guarded), not `contains`.
- No existing test exercises `contains: []`.

## Fix options

- **Option A (recommended):** mirror the `in` guard at the top of the `contains` array branch — if the coerced/`items` array is empty, `return ok(wrap(sql\`false\`))`. Semantically correct (contains-all of nothing over a filter surface = "match nothing", consistent with the `in:[]`decision) and eliminates the invalid SQL. Add a unit test pinning`{ tags: { contains: [] } }`→`false`.
- **Option B:** type the array literal (`array[]::text[]` / cast in `to_jsonb`). This makes the SQL valid but then `@> ARRAY[]` **matches all rows** — the widening the task warned about. Reject.

Pin with a unit test in the derive/composer suite.

## Related

- Sibling: [M-A5M2](M-A5M2-fallback-search-missing-pins.md), [M-A2M1](M-A2M1-quota-reconcile-overcharge.md), [M-A2M2](M-A2M2-kernel-tools-agent-exposure.md).
- Same guard family as `in:[]` #60h in `derive.ts:280-282`.
