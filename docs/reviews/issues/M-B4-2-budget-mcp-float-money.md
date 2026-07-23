# B4-#2 — Budget MCP aggregate total is JS-float-summed money (No-Float rule violation)

|                       |                                                                |
| --------------------- | -------------------------------------------------------------- |
| **Original severity** | Medium                                                         |
| **Verified verdict**  | Confirmed · Severity unchanged (Medium) — bounded blast radius |
| **Confidence**        | CONFIRMED                                                      |
| **Domain**            | mcp / correctness                                              |
| **Modules / files**   | `src/modules/budget/shell/mcp/tools.ts`                        |
| **Fix effort**        | S                                                              |
| **Merge-blocker?**    | no                                                             |

## TL;DR

`aggregate_budget_by_classification` sums the per-bucket money amounts with a raw JS `Number()` reduce and emits the result as a money field. Item-level amounts stay precise decimal strings; only the rolled-up `value` total goes through float. This violates the project's **No-Float rule** (CLAUDE.md §1: "Floats are forbidden. Use `decimal.js` or integer math for all numeric calculations") and the budget DESIGN's money-precision stance. Fix: sum with `decimal.js` (already a project dep) and emit `.toFixed()`/`.toString()`.

## Evidence (re-verified against current code)

`src/modules/budget/shell/mcp/tools.ts:270`:

```ts
const total = res.value.reduce((acc, r) => acc + Number(r.amount), 0);
```

Emitted as the catalog "Core Rule" money field at :289-290:

```ts
...{
  value: String(total),   // :290 — float total stringified back into a money field
```

`r.amount` is typed `Money` (`src/modules/shared/core/types.ts:26: export type Money = string;`) — a decimal **string** (RON, 2 decimals, or a normalized decimal string). The item-level values passed through untouched at :281 (`items: res.value`) are precise; only the aggregate `value` is corrupted.

The result rows come from `aggregateByClassification` (`src/modules/budget/core/usecases.ts`) whose row type is `amount: Money` (`budget/core/types.ts:143`). Bucket count is bounded: `limit` default 50, max 100 (:253) — so the reduce sums ≤ 100 decimal strings.

## Root cause

`Number("123.45")` produces an IEEE-754 double. RON amounts carry 2 decimal places (bani); most 2-decimal values are not exactly representable in binary float, so `acc + Number(r.amount)` accumulates rounding drift across the buckets. The stringified `value` can therefore differ from the true decimal sum by sub-cent (and, in principle for very large normalized magnitudes above 2^53, by whole units). The codebase's whole premise (`decimal.js`, the ESLint `parseFloat` ban) is to avoid exactly this; the ban catches `parseFloat` but **not** `Number()`, so this slipped through.

## Blast radius & impact

- **Where it surfaces:** only the MCP tool's `value` field (the catalog Core-Rule scalar an LLM/agent reads as "the total for this breakdown"). The `items[]` array and the human-readable `summary` use the precise strings and are unaffected.
- **Magnitude of error:** bounded — ≤ 100 addends, so accumulated float drift is at most a few ULPs → sub-cent to a few bani for nominal RON. For `normalization: 'TOTAL'` (the only mode this tool uses, :264) amounts are nominal RON in the ~10^6–10^13 range, comfortably under 2^53 (~9×10^15), so no catastrophic large-integer loss here — the loss is decimal-fraction drift, not magnitude truncation.
- **Who's affected:** agentic/LLM callers of the budget MCP surface that reason over the `value` scalar. Not the GraphQL resolvers (they don't compute this rolled-up total — see below). No PII, no security impact.
- **Rule status:** this is a **guideline/consistency violation with real (if small) numeric drift**, which is why Medium is the right call rather than High — it does not currently produce a large wrong number, but it breaks the invariant the whole module is built on and could grow if `value` is ever consumed for arithmetic downstream.

## Reproduction / falsifiable scenario

Call the tool for a year/category whose buckets include fractional RON, e.g. amounts `"0.10"`, `"0.20"`, `"0.30"` (contrived): `Number("0.1")+Number("0.2")+Number("0.3") = 0.6000000000000001`, so `value` = `"0.6000000000000001"` while the true decimal sum is `"0.60"`. At scale, summing thousands→hundreds of realistic 2-decimal bani values yields a `value` whose fractional part disagrees with the exact decimal by a fraction of a ban.

## Additional context discovered

- **decimal.js is already a dependency and widely used** across the codebase (60+ files, e.g. `budget`'s sibling analytics modules `execution-analytics`, `commitments`, `normalization`, `uat-analytics` all import `decimal.js`). The budget **module itself** currently imports it nowhere (`grep` of `src/modules/budget` for `decimal.js`/`Decimal` → 0 hits), so this tool is the outlier.
- **Scan for other `Number()`/float sums over money** in the data modules' MCP + repo layers:
  - `budget/shell/mcp/tools.ts:270` — **the only money float-sum** found. ✗
  - `companies/shell/repo/companies-repo.ts:788-789` — `reduce(...+ Number(r.matched))` / `Number(r.unmatched)` — these are **row counts** (integers), not money. ✓ acceptable.
  - `primarii-transparency/shell/mcp/tools.ts:129` + `shell/contributor.ts:34` — `reduce(a + c.count)` — **document counts**, not money. ✓
  - `parliament/shell/repo/parliament-repo.ts:159` — `floors.reduce(...)` — d'Hondt seat-quota integer math, not money. ✓
  - `pnrr`, `procurement` MCP/repo — no float money sums found. ✓
  - The `perCapita` ratio division elsewhere in the budget path is a ratio (not a currency quantity) and is acceptable per the finding note.
- **No GraphQL twin:** the resolver path returns `items` and lets the client render; it does not compute this `value` roll-up, so the bug is MCP-only.

## Fix options

- **Option A (recommended):** sum with `decimal.js`:
  ```ts
  import { Decimal } from 'decimal.js';
  const total = res.value.reduce((acc, r) => acc.plus(r.amount), new Decimal(0));
  // …
  value: total.toString(),   // or total.toFixed(2) for nominal RON
  ```
  Matches CLAUDE.md §1 and sibling modules. Trivial, no API-shape change (still a string).
- **Option B:** integer/bigint bani math (multiply strings to integer minor units). More work, only warranted if amounts are guaranteed 2-decimal and never normalized to arbitrary precision — since this tool always uses `normalization: 'TOTAL'`, decimal.js (Option A) is simpler and safer.
- **Lint hardening (follow-up):** the `parseFloat` ban doesn't cover `Number()`. Consider a `no-restricted-syntax`/`no-restricted-globals` rule flagging `Number(` inside `reduce`/money contexts, or a review checklist item — otherwise this class recurs.
- **Test to pin it:** a unit test asserting `value` equals the exact `decimal.js` sum of `items[].amount` for a fixture with fractional buckets.

## Related

- CLAUDE.md §1 "No Float" rule; budget module DESIGN money-precision stance.
- Sibling correct usage: `commitments`, `execution-analytics`, `normalization` (all use `decimal.js`).
- Main report: B4 (architecture) findings.
