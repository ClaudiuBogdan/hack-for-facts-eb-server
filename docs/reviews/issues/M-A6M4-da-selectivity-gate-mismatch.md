# M-A6M4 — DA selectivity gates diverge (cursor accepts what offset rejects)

|                       |                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original severity** | Medium                                                                                                                                                                                                                                                                                                                                         |
| **Verified verdict**  | Confirmed · Severity unchanged (High when composed with H3)                                                                                                                                                                                                                                                                                    |
| **Confidence**        | CONFIRMED                                                                                                                                                                                                                                                                                                                                      |
| **Domain**            | procurement / mcp                                                                                                                                                                                                                                                                                                                              |
| **Modules / files**   | `src/modules/procurement/core/search.ts:179-210`; `src/modules/procurement/core/constants.ts:82-95`; `src/modules/procurement/shell/repo/filter-helpers.ts:177-246`; `src/modules/procurement/core/filters.ts:444-452`; `src/modules/procurement/shell/repo/procurement-repo.ts:568-573`; `src/modules/procurement/shell/mcp/tools.ts:163-175` |
| **Fix effort**        | S–M                                                                                                                                                                                                                                                                                                                                            |
| **Merge-blocker?**    | owner-call                                                                                                                                                                                                                                                                                                                                     |

## TL;DR

Two selectivity gates guard the 20–26M-row direct-acquisitions grain, and they disagree. The **offset** gate (`assertDaOffsetSelective`, qualifying set `DA_OFFSET_SELECTIVE_FIELDS = ['authorityCui','supplierCui']` + a fully-bounded ≤`maxWindowDays` range) rejects standalone `cpvDivision`/`cpvCode`/`uniqueCode` because they were **measured to time out** (16.6s / 8.0s vs a 15s statement timeout). The **cursor** gate (`assertDaSelective`, `DA_SELECTIVE_FIELDS` includes `cpvCode, cpvDivision, uniqueCode`) **accepts them standalone** — and that is exactly the gate on the MCP tool `search_procurement_direct_acquisitions`. So the public MCP surface admits the very filters the offset surface banned as un-servable.

## Evidence (re-verified against current code)

- **Offset gate — rejects the CPV/uniqueCode fields:** `constants.ts:95` `DA_OFFSET_SELECTIVE_FIELDS = ['authorityCui','supplierCui']`. `search.ts:179-210` loops only those, then requires a range with **both** bounds and span ≤ `maxWindowDays`; otherwise errors: "CPV and free-text q refine such a filter but cannot stand alone".
- **The measurements behind the offset gate** (`constants.ts:82-93`, live 2026-07-09, 15s timeout): `authority_cui 0.8s ✓`, `supplier_cui 6.4s ✓`, `bounded 366d window 6.5s ✓`, **`cpv division range 16.6s ✗` (2.8M rows to sort)**, **`unique_code eq 8.0s ✗` (no index — seq scan)**. Comment explicitly: "The legacy cursor surface keeps its own, looser `DA_SELECTIVE_FIELDS` rule."
- **Cursor gate — accepts them:** `filters.ts:444-452` `DA_SELECTIVE_FIELDS = ['authorityCui','supplierCui','cpvCode','cpvDivision','uniqueCode','year','finalizationDate']`. `filter-helpers.ts:181-196` returns `ok()` on the FIRST entity/cpv/uniqueCode field present with any real value — so `cpvDivision:'45'` **alone** passes; so does `uniqueCode:'…'` alone.
- **This is the MCP path:** `tools.ts:163-175` tool `search_procurement_direct_acquisitions` exposes `authorityCui, supplierCui, cpvDivision, uniqueCode, year, first` → `usecases.ts:53-58 searchDirectAcquisitions` → `procurement-repo.ts:573 assertDaSelective(filter, daMaxWindowDays)` → `listDirectAcquisitions`. The MCP-reachable divergence set is **`{cpvDivision, uniqueCode}`** (`cpvCode` and `q` are not on this tool; `year` is bounded by both gates).

## Root cause

The gates were derived from different cost models and never reconciled. The offset gate was rewritten against real measurements (only entity/bounded-window qualifies); the cursor gate (`assertDaSelective`) predates it and still treats "any CPV/uniqueCode present" as selective. The divergence is documented as intentional ("looser") but the looseness is exactly the un-servable case.

## Blast radius & impact

- **Does the cursor LIMIT save it? No — not for these fields.** `constants.ts:83-90` states `finalization_date` is NULL on 9.57M rows and `ORDER BY finalization_date DESC NULLS LAST` cannot be served by the plain date index; "the planner sorts whatever the WHERE clause yields." A standalone `cpvDivision:'45'` compiles to an index-safe `cpv_code` range (`cpvDivisionRange`, filter-helpers.ts:54-91) that _finds_ ~2.8M rows, but the keyset sort over that set must still materialize+sort all of them before `LIMIT first` — so cursor pagination hits the **same ~16.6s** the offset gate rejected. `uniqueCode` has **no index**: an `eq` is a seq scan over 20–26M rows (~8s), worst case full-table when the code is rare/absent. Cursor even omits the capped-count subquery, so the query is the sole cost — still over the 15s timeout.
- **Outcome per request:** the statement runs to the 15s Postgres `statement_timeout` and errors (57014), having pinned one pool connection for the full 15s. Pool size is 10 per DB client (CLAUDE.md).
- **Composition is the real danger.** This tool is on the **public, unthrottled MCP surface** (see H3). A handful of concurrent `cpvDivision`-only or `uniqueCode`-only DA searches saturate the 10-connection pool for 15s each → pool starvation / cross-tenant latency spike. That elevates a Medium single-query cost into a High-impact DoS **when composed with H3/H4** (no rate limit, proxy-trust bypass).

## Reproduction / falsifiable scenario

MCP call: `search_procurement_direct_acquisitions { cpvDivision: "45", first: 20 }` (no entity, no date). `assertDaSelective` returns `ok` on the first CPV branch; `listDirectAcquisitions` runs the ranged+sorted query → ~16.6s → 57014 timeout error to the caller, 15s connection held. Repeat N≈pool-size concurrently → pool exhaustion. Same with `{ uniqueCode: "<rare>" }` (seq scan).

## Additional context discovered

- `year` standalone is safe on **both** gates: offset accepts a bounded ≤`maxWindowDays` window; cursor's `assertDaSelective:201-219` caps year span to `ceil(maxWindowDays/365)` years. So the divergence is genuinely just `{cpvDivision, cpvCode, uniqueCode}`, of which MCP exposes `cpvDivision, uniqueCode`.
- `breakdownFor`/analysis rollups are unaffected — this is the row-listing (`procurement.direct_acquisitions` base table) path only.
- No test asserts parity between `DA_SELECTIVE_FIELDS` and `DA_OFFSET_SELECTIVE_FIELDS`; the two lists drifting is undetected.

## Fix options

- **A (recommended):** Align the cursor gate with the measurements. Move `cpvCode`/`cpvDivision`/`uniqueCode` out of the standalone-qualifying set in `assertDaSelective` (keep them as _refiners_ that require a co-present entity or bounded date window), so both surfaces enforce the same "entity or bounded window qualifies; CPV/uniqueCode refine" rule. Add a unit test pinning `{cpvDivision:'45'}` alone → rejected on both gates.
- **B (narrower):** Keep cursor field set but require a co-present **bounded date window** whenever the only dimension is `cpvDivision`/`uniqueCode` (bounds the sort input). More permissive than A but still closes the unbounded scan.
- **C (defense-in-depth, do regardless):** Ensure a per-request statement timeout well under 15s for this grain AND rate-limit/authenticate the MCP surface (H3/H4) so gate gaps cannot be amplified.

Recommend A + C. Severity Medium standalone, High in combination with the unthrottled MCP surface.

## Related

[H3](H3-unthrottled-public-mcp.md), [H4](H4-trustproxy-ratelimit-bypass.md) (amplifiers). Main report: A6-M4.
