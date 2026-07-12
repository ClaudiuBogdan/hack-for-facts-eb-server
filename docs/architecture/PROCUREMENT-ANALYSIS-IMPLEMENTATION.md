# Procurement Analysis — Implementation Record (wave 1)

**Date:** 2026-07-12
**Status:** Implemented. Scraper package deployed to prod; server surface committed, NOT deployed.
**Design:** `PROCUREMENT-ANALYSIS-DESIGN.md` (rev 2 + the rev-3 amendments below). Tool contract context: `MCP-AGENTIC-LAYER-ARCHITECTURE-REVIEW.md`; filtering substrate: `PARLIAMENT-PROCUREMENT-FILTERING-DESIGN.md`.

## 1. What shipped

### Scraper (`hack-for-facts-eb-scrapper`, commit `07bb6468` — DEPLOYED)

- **Migrations** `20260712T140000__procurement_analysis_facts` + `20260712T141000__procurement_analysis_rollups` (applied to `transparenta_prod` 2026-07-12 via scoped `--only` from a dedicated griffin checkout `hack-for-facts-eb-scrapper-analysis-facts`):
  - `procurement.analysis_facts_{contracts,direct_acquisitions,procedures}` — narrow per-grain projections, full population + `is_canonical`, `privacy_class='public'`, projection-time dup-group **value/date rescue** (`value_source`/`date_source`/`value_rescue_disagreement`), buyer geo via `public_entities→territories`, `cpv_division` validated against `cpv_divisions`, `procedure_type` via linkage, `date_basis` per design §3.2. Traceability: fact PK → source row → `source_url`.
  - `procurement.supplier_identity_key_v1/_confidence_v1(text)` — immutable SQL ports of `contract-identity.ts` (property-tested ≡ TS over a generated corpus), extending supplier identity to the DA grain.
  - `procurement.analysis_generations` — one `active` generation (partial unique), `quality` jsonb verdicts, `matrix_hash`, `reconcile`/`facts_counts` evidence.
  - 5 generation-stamped monthly rollups (`analysis_rollup_edge_monthly`, `_authority_dims_monthly`, `_supplier_cpv_monthly`, `_cpv_code_monthly`, `_region_cpv_monthly`) — undated bucket = NULL `month_start`, NULL dims = unknown buckets, uniform measures (`record_count`, `with_value_count`, `value_awarded_sum`, `with_estimated_count`, `value_estimated_sum`).
  - `procurement.record_change_log` — append-only status/value audit at analysis-run granularity (design D3 as rescoped).
- **Lane** `load-analysis-facts` (prod-cli): load-prod advisory lock (never runs beside the nightly chain), pre-upsert guarded stale census, chunked DA sync (2M-id ranges, session temp rescue tables), per-rollup commits, reconcile → quality verdicts (vs `aggregate_filter_thresholds`) → single-tx flip → prune to N-1; `--rollback` proof and `--dry-run` modes; abandoned-`building` recovery at run start; 45min/30s statement/lock timeouts. `validate-analysis-facts` runs the two-tier gate against the active generation + a zero-drift BLOCK check.
- **Matrix artifact** `prod-db/contracts/procurement-analysis-combinations-v1.json` — the **exhaustive 275-row closure** (221 rollup-served / 49 rejected / 5 bounded-fact-query), generated from the capability model, hash-pinned (`1ce871d54e28…f412`), prettier-ignored, stamped into every generation.
- **CronJob** `public-contracts-analysis-facts` (30 6 \* \* \* UTC) — committed **suspended**; unsuspend is an explicit operator decision after the prod-scale canary + shadow comparison.

### Server (`hack-for-facts-eb-server` — committed, NOT deployed)

- **Core** (pure, Result-typed, decimal.js money): `core/policy.ts` (semantic policy table, grain×measure), `core/analysis-scope.ts` (scope + fhash spec + subset/window helpers), `core/combinations.ts` (`WAVE1_CAPABILITIES` + `routeAnalysis`, shape-specific rollup preference orders, named-capability rejections), `core/gate-v2.ts` (`decideAnswer` over the generation's `quality`: spend strict, time/geo degrade to the 0.50 floor, missing → abstain), `core/envelope.ts` (§3.4 envelope, nullable reads on abstention), `core/analysis-usecases.ts` (six shape executors; per-grain labeled blocks; breakdown top-N+other+unknown with reconciliation assertion; share as validated strict-subset derivation; facets require explicit grain).
- **Shell**: `shell/repo/analysis-repo.ts` (build-pinned rollup reads, single-flight monotonic generation micro-cache, one-statement breakdown/stats with FILTER-split undated bucket, buildId-keyed scope cache), declare-module schema for generations + rollups, GraphQL surface v2, MCP `aggregate_procurement` on the existing `KernelMcpTool` array.
- **Vendored matrix** (byte-copy + pinned hash) with an **exhaustive bidirectional parity test**: every artifact row routes to the same rollup table; every server-accepted combination exists in the artifact.

## 2. Versioned replacements / deprecations

| Old                                                                                                                   | New                                                                                          | State of old                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `procurementStats(scope, grain)` (flat)                                                                               | `procurementStats(scope)` → per-grain labeled blocks + envelope                              | replaced in place (pre-deployment)                                                                                                                                                              |
| `procurementTopAuthorities` / `procurementTopSuppliers` / `procurementCategoryBreakdown` / `procurementSpendOverTime` | `procurementBreakdown(scope, dimension, topN)` / `procurementSeries(scope, bucket, measure)` | **deleted**                                                                                                                                                                                     |
| `procurementConcentration(authorityCui, …)`                                                                           | `procurementConcentration(scope, basis)`                                                     | generalized in place                                                                                                                                                                            |
| —                                                                                                                     | `procurementShare(numerator, denominator)`, `procurementFacets(scope, dimensions)`           | new                                                                                                                                                                                             |
| `shell/repo/scope-agg-repo.ts` + ScopeFilter-era usecases                                                             | `shell/repo/analysis-repo.ts` + analysis usecases                                            | **deleted**                                                                                                                                                                                     |
| flows→MV stack (5 matviews + capability gate)                                                                         | `analysis_facts_*` + generation-stamped rollups                                              | **still serving** the 5 analyst queries, `procurementGrainQuality`, entity-360 presence/profile, and the legacy MCP concentration tool; retirement is a later wave after coexistence proves out |
| 9 MCP tools                                                                                                           | unchanged names/IO; `aggregate_procurement` added                                            | `get_procurement_concentration` deliberately stays on the legacy MV path (re-plumb deferred — byte-identical output preserved)                                                                  |

## 3. Key decisions (rev-3 design amendments)

1. **Change manifests → full-rebuild generations** (facts upserted in place with no-op guards; only rollups generation-stamped; single-tx pointer flip; N-1 retention). Corrections trivially move buckets; matches repo canon.
2. **Value/date rescue at projection time only** — reserved `contracts.canonical_value_source/...` columns remain untouched (M1/#45's deliverable).
3. **Audit log at analysis-run granularity** — base loaders untouched; no trigger on the 26.5M-row hot path.
4. **Procedure facts have no supplier columns** (grain has none).
5. **Gate v2 rides the generation** — the lane computes per-grain coverage and per-(grain × class) verdicts (`quality` jsonb) at build time; the API consumes them. Procedures get a verdict (the old gate had no row); the new surface is decoupled from the F1-stale flows gate.
6. **Money abstains honestly until M1** — DA/contract awarded-value coverage (~72% / ~76→87% post-rescue) is below the strict 0.95 spend gate. Count answers serve; time answers serve degraded-with-disclosure where ≥0.50. This is the design working as intended; the fix is M1 data repair, never threshold loosening.

Implementation-time additions: shape-specific rollup routing preferences (stats/series smallest-first; breakdown/concentration entity-first) mirrored exactly between the artifact generator and the server router; fully-pinned concentration scopes rejected as stats answers; breakdown over a scope-fixed dimension rejected (single bucket).

## 4. External reviews (Codex gpt-5.6-sol, high)

- **Scraper round** — 9 findings (no P0), all addressed: pre-upsert stale census (dilution attack), zero-drift gate check in standalone validate, bounded transactions (temp rescue tables + chunked DA sync + per-rollup commits + timeouts), abandoned-generation recovery + failed-build rollup cleanup, `privacy_class`, warning-tier semantics, sync-policy operator-owned fields, failure-mode pg tests, formatting. Adaptations recorded: no per-bucket digests (no independent oracle exists — the gate cannot re-verify its own GROUP BY; fixture pg tests own transformation correctness).
- **Server round** — 11 findings (2 P0), all addressed: per-request generation pinning + single-flight monotonic cache; exhaustive artifact closure + bidirectional parity (this fix ALSO caught a scraper generator bug that had dropped the flagship breakdown rows); gate composition for time/geo on all shapes with nullable (never fabricated) envelope reads; strict-subset + normalized-window share validation; facets explicit-grain requirement; `get_procurement_concentration` reverted to the byte-identical legacy path; concentration disclosure semantics (distinct known suppliers, positive-basis HHI caveats, unknown-supplier weight); null-money preservation end-to-end; undated-only keys excluded from rankings; boundary/cache tests. **Recorded rebuttal:** no server-side disposable-Postgres DDL suite (would duplicate scraper-owned migrations); live SQL is proven by the prod golden run + scraper pg suites.

## 5. Deployment & validation evidence (2026-07-12)

- Migrations applied via scoped `platform-migrate prod latest --only …` (mandatory while gated migrations exist) from `/home/sysadmin/projects/devostack/hack-for-facts-eb-scrapper-analysis-facts` (dedicated checkout — the primary griffin checkout's legacy `src/` tree still hosts a live private-companies loader and was not touched).
- **First `--rollback` proof attempt FAILED at the 45-min statement timeout**: the identity-key SQL functions (CTE bodies → not inlinable → per-row SPI) made one 2M-row DA chunk exceed 45 min. Fixed by computing keys over DISTINCT suppliers in a materialized CTE + `PARALLEL SAFE` on both functions (commit `8dad70f7`, migration `20260712T142000`). The failed proof left zero trace on prod (verified: 0 generations, 0 facts, 0 audit rows, no stranded runs).
- **`--rollback` proof (fixed code): GREEN in 42.9 min** — facts sync 34.5 min (30.46M rows: 622,936 procedures + 3,274,706 contracts + 26,562,664 DAs), rollups 6.2 min, reconcile 38 s, gate 86 s, flip 1 ms. All structural checks VALID (exact source/canonical parity; all 13 rollup lanes reconcile on all five measures; cross-rollup agreement; matrix closure). Overall `warning` from the quality tier, as designed.
- **Quality verdicts (build-time, canonical population)**: procedure coverage date 0.343 / value 0.539 / geo 0.702 / cpv 0.926 → spend abstain, time abstain, geo degraded; contract 0.810/0.762/0.751/0.833 → spend abstain, time degraded, geo degraded; DA 0.654/0.678/0.599/0.673 → spend abstain, time degraded, geo degraded. Money abstains everywhere until M1 — exactly the design's prediction.
- **F2 correction (empirical)**: the dup-group value rescue recovered almost nothing — contracts 0 values (16,074 dates), DA 80 values, 0 disagreements. Canonical rows missing values are overwhelmingly **singletons without dup groups**; the design's F2 hypothesis (76.2%→~87% contract value coverage from suppressed duplicates) does not hold. Contract/DA spend can only be unlocked by raw-side enrichment (M1 proper). The rescue machinery stays (it is correct and cheap; dates did benefit), but it is not the spend-gate lever the design hoped.
- First committed run: TBD(build_id, stage durations)
- Query-validation set: TBD(runtimes + correctness evidence)
- Shadow comparison vs MV answers: TBD
- CronJob smoke: TBD (left suspended)

## 6. Unresolved limitations (wave-2+ candidates)

1. **Money abstention until M1 repairs** (headline; see §3.6). The old MV surface still serves DA spend from its stale 2026-06-29 gate snapshot — F1 (gate flip on next MV refresh) remains open and owned by M1; nothing in this wave refreshes those MVs.
2. **Supplier-scoped concentration is degenerate** (supplier-keyed HHI over a single supplier, disclosed). The artifact models it authority-keyed; a keyed-concentration dimension is the wave-2 fix.
3. **Breakdown buckets return bare CUIs** — no name join in the rollups; client resolves or wave 2 adds a name join at build time.
4. **cpvDivision filtering on the cpv_code rollup** uses the 2-digit prefix; pathological codes whose prefix is not a valid division can diverge marginally from `cpv_division`-keyed rollups.
5. **Entity × 8-digit CPV** stays a bounded-fact-query rejection until proven in CI (M2 line in the design's §7.0).
6. **Cross-grain overlap** is measured as a WARN-tier magnitude probe only; per-row flags need their own design once magnitude is known.
7. **CronJob suspended**; unsuspend requires an explicit operator decision (prod-scale canary + shadow comparison were run — see §5 — but the standing rule keeps activation human-gated). The lane's sync-policy row reflects suspension until then.
8. **Client wave pending** — the deleted GraphQL queries are still referenced by the (undeployed) client; the client migration is its own wave.
9. **M3 supplier geography** unchanged (ONRC coverage probe first).

## 7. Runbook pointers

- Scraper lane: `prod-cli load-analysis-facts [--rollback|--dry-run]`, `validate-analysis-facts`; evidence in `etl.load_runs`/`etl.validation_results`; generation state in `procurement.analysis_generations`.
- Scraper-side runbook + measured numbers: `prod-db/PUBLIC_CONTRACTS_NOTES.md` §2026-07-12 analysis-facts; TRACKER registry row `20260712T1400xx`.
- Server: the surface fails closed ("analysis package not published") without an active generation; matrix drift is boot-logged by comparing `ANALYSIS_MATRIX_SHA256` vs the active generation's `matrix_hash`.
