# Procurement — catalog ↔ live-schema reconciliation (plan §7a, foundation §14.10)

The AI-agent filter catalog (`prod-db/AI_AGENT_FILTER_QUESTION_CATALOG.md`) names
LOGICAL objects. This module reconciles them to the LIVE `procurement.*` schema
(verified 2026-06-17). The names below are what the catalog/plan call them; the
live objects are what this module actually reads.

| Catalog logical name | Live object (verified) | Reconciliation |
|---|---|---|
| `procurement.org_edges` rollup keyed `(authority_cui, supplier_cui, period, category)` | `procurement.org_edge_monthly_rollups` (matview, 8.34M) | period = `month_start` (MONTHLY grain). **NO category dimension** in this MV — CPV category lives in the two `*_cpv_division_monthly_rollups`. PC-1/3/6 → org_edge; PC-2/4 → the cpv-division MVs. |
| "canonical procurement fact table / single declared grain" | `procurement.procurement_flow_facts_v1` (view over `flows.money_flows where source_id='procurement'`) | the canonical fact surface the MVs are built over. `source_grain` = the kernel `flow_type` (`direct_acquisition` / `procurement_contract`), **NOT** a SEAP/elicitatie split. |
| "rebuilt CPV dictionary; do not rely on the corrupt `cpv_codes`" | `procurement.cpv_divisions` (45 clean) + `cpv_codes` (9749, `cpv_level`/`parent_code` 100% NULL) | **CONFIRMED corrupt live** (0/9749 have cpv_level). Hierarchy + division filters use `cpv_divisions` (2-digit) ONLY. Raw 8-digit `cpv_code` + best-effort `label_ro` allowed for display, never tree navigation. CPV (8-digit) discovery is flagged low-confidence; `cpv` resolution downgrades to code-echo when `label_ro` coverage is poor (§7.6 I8). |
| "buyer territory from core; supplier territory from company registration" | buyer: pre-joined in the MVs (`authority_county_code`/`authority_region`); supplier: **absent** | Buyer-region filters supported. Supplier-region filters **gate-blocked** (`supplier_region_filters_allowed=false` live for both grains) → `InvalidInput` until the company-registry backfill. |
| "explicit duplicate/canonical rules" | `is_canonical` + `dup_group_id` on contracts/DAs; flows + rollups read canonical only | Every base-table list forces `is_canonical=true` by default (`includeDuplicates=true` opts in, results labelled). |
| `aggregate_quality_by_grain` (the grain gate) | `procurement.aggregate_quality_by_grain` (matview, 2 rows) | Read LIVE per request. Three booleans (`filter_answers_allowed` / `spend_rankings_allowed` / `supplier_region_filters_allowed`) are recomputed at MV-refresh time, NOT code constants. Gate enforcement lives in the usecases (abstain / count-degrade / reject). |

## Golden-question routing (PC-1..PC-10)

| Catalog | Live route |
|---|---|
| PC-1 top suppliers of authority X, period T | `topSuppliersForAuthority` → `org_edge_monthly_rollups` (dim=authority_cui). Share over the BASIS measure (value when `spend_rankings_allowed`, else flow_count). |
| PC-2 top suppliers to region R, kind K | `topSuppliersByRegionCpv` → `supplier_cpv_division_monthly_rollups` (region + cpv_division). |
| PC-3 top authorities buying from Y | `topAuthoritiesForSupplier` → `org_edge_monthly_rollups` (dim=supplier_cui). |
| PC-4 authority X spend by CPV × year | `authorityCpvSpend` → `authority_cpv_division_monthly_rollups` (dim=authority_cui). |
| PC-5 supplier concentration for X | `supplierConcentration` over `org_edge` edges — top1/top5 share + HHI; `basis='value'` only when `spend_rankings_allowed`, else count-based (`totalRon=null`). |
| PC-6 repeated buyer-supplier pairs | `repeatedPairs` → `org_edge` aggregated to edge grain, `minMonths` over distinct active months, first/last_flow_date. |
| PC-7 same-day DA splitting | `sameDaySplittingCandidates` → `same_day_direct_acquisition_candidates` (DA grain only; "candidate = review signal, NOT illegality"). |
| PC-8 contracts modified > X% | `listModificationsAboveDelta` → `contract_modifications`, `delta_pct = value_delta_ron / nullif(value_before_ron,0)` in SQL. |
| PC-9 awards to recently-registered suppliers | **CROSS-SOURCE** — needs `companies.registration_date`. OUT of this module (§4.4 kernel cross-source / Entity composition). |
| PC-10 procedures/contracts without linkage | `searchContracts({ procedureId isNull })` + `listModifications({ linkMethod isNull })`. |

## Money / currency boundary (audit F1/F7, verified live 2026-06-17)

The `currency` column is NOT a clean ISO code. Live distribution (contracts):
empty/null 1.62M, `RON` 331k, `EUR` 2558, `USD` 49, plus a garbage tail (CPV codes,
bare amounts) on ~2.6k rows. **Invariant verified: `value_ron IS NOT NULL` ⟹ currency
∈ {null,'',RON}** (no exceptions across 1.77M value-present rows). Boundary mapping:

- `isRon` = `currency` is null / '' / 'RON'.
- `valueSuspect` = `value_ron IS NULL AND currency present AND currency NOT IN ('','RON')`
  (a non-RON native value the loader could not convert; `value_ron` is correctly nulled).

**Currency exposure rule** (the client contract needs a token beside `valueRon`):

```
currency = isRon ? 'RON' : (/^[A-Za-z]{3}$/.test(trimmed) ? trimmed.toUpperCase() : null)
```

The RAW column never reaches the wire. A non-ISO-like token (the garbage tail)
degrades to `null`, which the paired `valueSuspect: true` already explains. Only
`isRon` / `valueSuspect` / the sanitized token are surfaced.

## The client contract (`docs/design/procurement/graphql-api-spec.md`)

The offset-search + scope-aggregate + detail-bundle surface the rebuilt UI reads.
It coexists with the cursor surface the MCP tools page through; neither shares
filter specs with the other (adding a field to a `CollectionFilterSpec` would
change `fhashFor` and invalidate live MCP cursors).

| Contract surface | Live route | v1 constraint |
|---|---|---|
| `procurementProcedures/Contracts/DirectAcquisitions/Modifications` | `shell/repo/offset-search-repo.ts` over the 4 base tables | `page * pageSize ≤ 10 000`; `total` is a CAPPED exact count (≤10 000 exact, else null + `totalEstimated`); a count timeout degrades `total`, never the page. |
| DA search selectivity | `core/search.ts:assertDaOffsetSelective` | Requires `authorityCui`, `supplierCui`, or a fully-bounded ≤366-day date range. Measured live: `cpvDivision` alone = **16.6 s** (over the 15 s statement timeout, 2.8M rows to sort); `unique_code` has **no index** (8.0 s seq scan). CPV and `q` refine but never qualify. |
| DA `publicationDate` facet | `direct_acquisitions.finalization_date` | `publication_date` is 100% NULL on the `elicitatie_da` half; `finalization_date` is the indexed, populated column. |
| `procurementStats/TopAuthorities/TopSuppliers/CategoryBreakdown/SpendOverTime` | `shell/repo/scope-agg-repo.ts`; routing in `core/scope.ts:routeScope` | A CPV-dimension answer, or any scope naming a `cpvDivision`, reads `supplier_cpv_division_monthly_rollups` (the only CPV MV carrying BOTH cuis); everything else reads `org_edge_monthly_rollups`. The two MVs partition the same facts differently, so they are never mixed inside one answer. |
| `scope.cpvCode` | — | **InvalidInput in v1**: every rollup is keyed on the 2-digit `cpv_division_code`. The 8-digit code still works as a search filter. |
| `procurementStats.proceduresCount` | `procurement.procedures` (a base table, not a rollup) | Procedures have no `supplier_cui`, so a supplier scope counts the DISTINCT procedures under which that supplier won a canonical contract. Grain-independent: a procedure is a tender notice, not a flow. |
| `procurementProcedure/Contract/DirectAcquisition` detail | `shell/repo/detail-repo.ts` | `perLotWinners: null` (procedure_lots has no winner identity, no awarded value). Procedure `duplicates: []` + `isCanonical: true` + `dupGroupId: null` (the table has no dedup columns). Duplicate siblings are driven from the canonical row's indexed `authority_cui` → `supplier_cui`; both null ⇒ `[]`. |
| `ted` | `procedure_ted_links.procedure_id` → `ted_notices` | Both link columns are 100% populated (57 965/57 965), so `procedure_details` is not needed and is not declared. Coverage is 57 965 / 622 936 procedures = **9.3%** → an unlinked procedure honestly serves `ted: null`. |
| `procurementSupplierRecords` | two per-table keyset queries merged in TS | Cursor encodes `(date, grain, id)`; the grain tag is REQUIRED because `contract_id` and `da_id` are unique only within their own table. `total` is always null. |
| `procurementGrainQuality` → `ProcurementCapabilityGate` | `procurement.aggregate_quality_by_grain` | Rates stringified; `dataAsOf` = the matview `refreshed_at` (`etl.lane_watermarks` has no procurement row); **`cadence` is ALWAYS null** — nothing declares a refresh schedule and the MVs drift (refreshed_at 2026-06-29, read 2026-07-09). |

### Money across grains, in the scope aggregates

Counts may merge across grains; **money may not** (§14.6). `totalValueRon` /
`amountRonSum` sum ONLY the in-scope grains whose live `spend_rankings_allowed` is
true — currently `direct_acquisition` only. A suppressed grain contributes *nothing*
(not zero), and when no in-scope grain qualifies the amount is `null`. Rankings fall
back to the `flow_count` basis whenever any in-scope grain is suppressed, because a
null amount would otherwise sink that grain's rows regardless of their size.
`amountPresentCount` / `amountMissingCount` are COUNTS and span every in-scope grain:
"1.6M contract flows carry an amount we may not total" is the honest statement.

### Caching (`shell/scope-cache.ts`)

Empty-scope aggregates cost 1.6–3.6 s each live, and the client fires all five in one
multi-root document. A 15-minute in-process TTL cache covers scopes with **no**
`authorityCui`/`supplierCui` — a bounded key space (empty + 45 divisions) × grain-set
× month-window × topN. The gate's `refreshed_at` is part of every key, so a matview
refresh invalidates implicitly. Entity scopes are index-fast and stay live. The
empty-scope entries are warmed at module init, fire-and-forget.
