# M-B1F1 — procurementSeries `counts.rows` includes the undated bucket (stats excludes it)

|                       |                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Original severity** | Medium                                                                                                                                                                                                 |
| **Verified verdict**  | Confirmed · Severity revised → Low–Medium (envelope metadata only)                                                                                                                                     |
| **Confidence**        | CONFIRMED                                                                                                                                                                                              |
| **Domain**            | correctness                                                                                                                                                                                            |
| **Modules / files**   | `src/modules/procurement/core/analysis-usecases.ts:423-429,449-475`; `src/modules/procurement/shell/repo/analysis-repo.ts:174,314-363,367-412`; `src/modules/procurement/core/envelope.ts:27-29,55-72` |
| **Fix effort**        | S                                                                                                                                                                                                      |
| **Merge-blocker?**    | no                                                                                                                                                                                                     |

## TL;DR

Under a bounded time window, `procurementSeries` reports `meta.counts.rows` = **dated (in-window) + undated** rows, while `procurementStats` reports `counts.rows` = **dated only** (its SQL sums with `FILTER (where datedPred)`). The series executor synthesizes its envelope `reads` by summing `recordCount` over **every** returned group row — including the `month === null` (undated) group — and _also_ reports that same undated count separately as `undatedInScope`. So for the same scope+window, the two surfaces disagree on `counts.rows` by exactly the undated count, and within the series envelope the undated rows are effectively counted twice (in `counts.rows` and in `undatedInScope`). Served points and money sums are correct; only the envelope metadata is wrong.

## Evidence (re-verified against current code)

- **Series sums ALL groups (no dated filter):** `analysis-usecases.ts:470-475` (additive law) and `:424-429` (distinct law) build `reads` via `rows.reduce((acc, r) => acc.plus(r.recordCount), 0)` over the full `rows` array, then set `undatedCount: undated?.recordCount` where `undated = rows.find(r => r.month === null)` (`:449`) / `r.bucket === null` (`:423`). The undated group is in `rows`, so it is included in the total AND re-reported as `undatedCount`.
- **The series SQL returns an undated group and does NOT dated-filter its aggregates:** `analysis-repo.ts:389-398` `seriesFor` selects `to_char(month_start,'YYYY-MM') as month, … coalesce(sum(record_count),0) … group by month_start order by month_start asc nulls last` — no `FILTER (where datedPred)`. With a bounded window, `compileScope` (`:174`) admits `((datedPred) or month_start is null)`, so the result set contains in-window month groups **plus** a `month = null` group.
- **Stats DOES dated-filter:** `analysis-repo.ts:336` `coalesce(sum(record_count) filter (where ${datedPred}), 0)::text as rows` and `:343` `… filter (where month_start is null) … as undated_count`. So stats `counts.rows` = dated only; undated is a disjoint disclosure.
- **Envelope treats the two fields as distinct, not additive:** `envelope.ts:27-29` `counts:{rows,withValue}` and `undatedInScope:{count,valueRon}`; `:69-72` sets `counts.rows = reads.rows` and `undatedInScope.count = reads.undatedCount` verbatim. Nothing subtracts undated from rows.
- **Breakdown gets it right (the correct pattern):** `analysis-repo.ts:533-542` computes its `total` row with `sum(record_count) filter (where datedPred)` and reports undated separately (`undated_rc`), then `readsOf(totals)`. Series is the outlier because it derives `reads` from group rows instead of a dedicated dated-filtered totals aggregate.

## Root cause

`seriesFor` reuses the per-bucket group rows to synthesize the envelope `reads` totals, but those groups are not dated-filtered — the undated group rides along (intentionally, so `undatedInScope` can be populated) and gets folded into the `rows`/`withValue` totals. Stats and breakdown compute their totals with an explicit `FILTER (where datedPred)`; series does not.

## Blast radius & impact

- **Metadata only.** The served `points` exclude the undated bucket (`:434-435`, `:465`), and money sums are unaffected. Only `meta.counts.rows` / `meta.counts.withValue` are inflated.
- **Fires under a bounded window** (`from`/`to`/`year`). Unbounded scopes set `datedPred = true`, so stats' `rows` also includes undated and the two surfaces happen to agree (undated becomes a subset disclosure on both) — so the discrepancy is specifically the bounded-window case.
- **Who consumes it:** `counts.rows` is envelope metadata surfaced to the tri-surface agents (GraphQL + MCP) that reason over answers. An LLM cross-checking "series row count vs stats row count for 2024" sees a mismatch equal to the undated count and may narrate a phantom discrepancy, or double-count when it adds `counts.rows + undatedInScope`. No wrong served figure reaches an end user chart.

## Reproduction / falsifiable scenario

Given a scope with undated DA rows sharing the dims: `procurementStats(scope:{grain:'direct_acquisition', from:'2024-01', to:'2024-12'})` → `meta.counts.rows = D`. `procurementSeries(scope: same, bucket:'month', measure:'recordCount')` → `meta.counts.rows = D + U` where `U = meta.undatedInScope.count > 0`. Expected: both equal `D`, with `U` disclosed only in `undatedInScope`.

## Additional context discovered

- The distinct-series path (`:424-429`) has the identical shape, so the fix must cover both additive and distinct branches (or, preferably, move totals into the repo).
- The undated `record_count` is genuinely available per row (`seriesFor` selects it), so the fix needs no extra query.
- No test asserts `series.counts.rows === stats.counts.rows` for a bounded window — the asymmetry is uncaught.

## Fix options

- **A (recommended, robust):** Mirror stats/breakdown — have `seriesFor`/`distinctSeriesFor` return dated-filtered totals (`sum(record_count) FILTER (where datedPred)` + `undated_count FILTER (where month_start is null)`) and build `reads` via `readsOf(totals)`, instead of summing group rows in core. This matches stats in **both** bounded and unbounded cases automatically.
- **B (core-only, cheaper):** In `analysis-usecases.ts`, exclude the undated group from the `rows`/`withValue` reduce **only when `scopeWindow(scope) !== undefined`** (bounded). Simpler but reproduces the bounded/unbounded semantic split by hand and risks re-drifting; less clean than A.
- Add a unit/integration test pinning `series.meta.counts.rows === stats.meta.counts.rows` and `undatedInScope.count` disjoint from `counts.rows` under a bounded window.

Recommend A. Severity Low–Medium: real cross-surface metadata inconsistency, no wrong served data.

## Related

Shares the "envelope says one thing, read says another" theme with [M-A6M3](M-A6M3-region-canonicalization-regression.md). Main report: B1-F1.
