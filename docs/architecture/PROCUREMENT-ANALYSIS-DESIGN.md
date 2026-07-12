# Procurement Analysis — Domain Model, Building Blocks, and Serving Design

**Date:** 2026-07-12 (rev 2, same day — after external design review)
**Status:** Design for review — no implementation approved yet
**Relationship to other docs:** extends `PARLIAMENT-PROCUREMENT-FILTERING-DESIGN.md` (kernel predicate primitives, bound policy, engine-primary search, DA indexes — all still valid) with the procurement _analytics_ layer it deliberately left thin; consumes the decided MCP tool-contract v2 from `MCP-AGENTIC-LAYER-ARCHITECTURE-REVIEW.md`. For procurement aggregates it **supersedes** the assumption that the flows→matview stack is the terminal read model (§5.5 there).

**Review log:** rev 2 incorporates an adversarial external review (Codex gpt-5.6-sol, xhigh, 2026-07-12; 15 findings). Material changes: removed the merged `purchases` grain (F1 of that review); added undated-bucket semantics and per-measure aggregation laws (F2); replaced date-partitioning + watermark refresh with change-manifest + generation cutover (F3, F13); gate scope clarified — capability per grain × answer class only, scope-local coverage is descriptive (F4); rollup closure made explicit via a supported-combinations matrix (F5); breakdowns gained a mandatory `other` bucket and `share` demoted to a validated derivation (F6); `current` value now requires a per-record chain validator (F7); event capture reframed as an audit log, not an as-of source (F8); envelope slimmed (F9); metric registry reduced to a semantic policy table (F10); answer shapes cut 9→6 (F11); facts narrowed to analytical columns, rollups land incrementally (F12); MCP migration table added, tool names kept stable (F14); requirements matrix re-marked with milestone prerequisites + testing strategy added (F15).

**Evidence:** three-repo code inspection (scraper DDL/loaders, API modules, MCP layer) plus live read-only probes on `transparenta_prod` (2026-07-12, catalog/`pg_stats`/1%-sample queries under 10s timeouts; no writes). Probe outputs preserved in the session scratchpad (`probes/d1-catalog.out`, `d2-quality.out`, `d3-vet.out`). Appendix B has the numbers.

---

## 1. Owner decisions

Recorded 2026-07-12 via the question tool (this document), on top of the four decisions already recorded in the filtering design:

| #   | Decision                       | Choice                                                                                                                                                                                                                                                                   |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Analytics read model ownership | **Scraper-built fact + rollup package** (`procurement.analysis_facts_*` projections plus derived rollups, validated in ETL like other projections). Flows stays for cross-domain entity-360 only.                                                                        |
| D2  | Population & value exposure    | **Canonical-only + strict value separation.** Counts/money always canonical-only; duplicates only in detail and `includeDuplicates` lists. Spend answers use awarded values only; estimated values are a separate, labeled metric — never mixed into totals or rankings. |
| D3  | History                        | **Scraper starts append-only status/value change capture now** — scoped in rev 2 as an _audit log_ (§6.3), not an as-of-analytics source. Serving stays latest-corrected-state for v1.                                                                                   |
| D4  | Supplier geography             | **Invest: resolve supplier county/region via ONRC (`core.organizations`)**, behind a coverage probe + gate, sequenced as milestone M3 (§4).                                                                                                                              |

Inherited (filtering design, 2026-07-12): extend kernel `CollectionFilterSpec` with first-class predicates + cost classes + bound policy; engine-primary text search with bounded ILIKE fallback; DA indexes + one unified selectivity gate; ELI untouched. Inherited (MCP review): tool contract v2 (`ToolContext`/`ToolMeta`/registry), 3-tier auth, SDK transport, delete legacy MCP.

## 2. Ground truth — what the data actually is

Four analytical units exist; two more are commonly assumed but **do not exist**.

| Unit                   | Table                                | Rows (live)                     | What it is                                                                                                                                                                                                                                             | Money                                                                       | Dates                                                                                                      |
| ---------------------- | ------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Procedure**          | `procurement.procedures`             | 622,936                         | Tender/notice lifecycle (e-licitatie CA notices + SEAP notices). No supplier.                                                                                                                                                                          | `estimated_value_ron` (66%), `awarded_value_ron` (54%)                      | `publication_date` — **0% on the e-licitatie half**, 68.7% on SEAP; `state_date` 100% NULL (unpopulated)   |
| **Contract**           | `procurement.contracts`              | 3,274,706 (**47.8% canonical**) | Supplier-level award record. Now **two families**: `seap_contracts` 65% + `elicitatie_ca_award` 35% (award crawl in progress — several docs still say "SEAP-only"; stale). `status` is constantly `'awarded'` — the grain has **no lifecycle signal**. | `value_ron` (87.7% raw, **76.2% canonical**), `estimated_value_ron` (12.8%) | `contract_date` (79.9% canonical)                                                                          |
| **Direct acquisition** | `procurement.direct_acquisitions`    | 26,515,272 (87.1% canonical)    | Direct purchase from the SEAP/e-licitatie catalog. Status: finalized 51% / **unknown 44%** / awarded 5%.                                                                                                                                               | `value_ron` (71.9%), `estimated_value_ron` (56%)                            | `finalization_date` 63.9%, `publication_date` 66.6%, **either 66.8%** — a third of DAs have no usable date |
| **Amendment**          | `procurement.contract_modifications` | 52,297                          | Value-change record: `value_before/after/delta_ron`, free-text type. 89.6% linked to a contract; **47.2% dated**; covers ~**1.6%** of contracts.                                                                                                       | deltas                                                                      | `modification_date` (47%)                                                                                  |
| Lot                    | `procurement.procedure_lots`         | 1,223,689                       | Metadata enrichment (per-lot estimated value, CPV, start/completion dates). **No winner, no awarded value** — a per-lot _award_ grain does not exist (e-licitatie detail carries zero award/supplier rows; extraction deferred).                       | estimated only                                                              | start/completion                                                                                           |
| Payment                | —                                    | —                               | **Does not exist.** Nothing in the platform represents disbursements. `flows.money_flows` is an _award-value_ fact (amount = contract/DA value, date = contract/finalization date), not a payment ledger.                                              | —                                                                           | —                                                                                                          |

Supporting structures: `subsequent_contracts` 63k (2016–2018 framework call-offs, deliberately quarantined pending value audit); `ted_notices` 267k + links (~9% of procedures); `cpv_codes` reference with full hierarchy (division/group/level/labels RO+EN) and `cpv_divisions`; `core.organizations` 4.0M (ONRC; county/locality; **not FK'd** from facts) + `organization_identifiers` 7.5M; `core.public_entities`→`core.territories` resolves _buyer_ geography (77% of authorities).

**Update semantics:** every fact table upserts `ON CONFLICT ... DO UPDATE` on each load — prod is **latest-corrected-state**. History exists only in raw snapshots (e.g. `elicitatie_source.contract_snapshots`, 14M rows) and is not serveable. `status_events` was designed and deferred (revived by D3 as an audit log).

**Identity:** raw CUI strings on every row (normalized: strip RO prefix/non-digits). `supplier_identity_key` (`RO:<cui>` | `FOREIGN:<cc>:<norm>`, confidence high 92.7%) exists **only on the contracts grain**. No CUI grouping (successors/branches) — deferred, and this design keeps it deferred: answers are CUI-level, stated as such.

**Dedup:** reversible link layer (`is_canonical` + `dup_group_id` + method/confidence), one canonical per group, never destructive. The same real-world purchase can also appear **across grains** (DA vs contract vs call-off) — cross-grain collisions are only flagged, never merged. This is why grains never merge in answers either (§3.3).

### 2.1 The current serving path and its two fresh cracks

Aggregates today read five monthly matviews over `procurement_flow_facts_v1` (= `flows.money_flows` filtered to canonical, non-cancelled contract/DA rows), gated by `aggregate_quality_by_grain` + `public_contracts_filter_capabilities_v1` (8 answer classes per grain). That stack is well-built for what it does — but the probes surfaced two time bombs and one structural loss:

**F1 — The next gate refresh turns the DA surface off.** The July reload wave imported ~7M SEAP DA rows (`seap_da`/`seap_dan` families) largely missing dates and values. Live flows sampling shows DA date coverage collapsed **0.958 → ~0.65** and amount **0.994 → ~0.68** since the gate's 2026-06-29 refresh; both thresholds are 0.95. The moment the matviews refresh, `filter_answers_allowed` and `spend_rankings_allowed` flip false for `direct_acquisition` and every DA aggregate abstains. Nobody noticed because the refresh isn't in cron (P4 in the filtering doc). **Consequence: the already-designed "put MV refresh in cron" fix must NOT ship alone — it would turn the lights off.** It must be paired with data repair (§6.1). Note (rev 2): degrade semantics (§5.4) soften _count/time_ answers only; **spend answers keep strict abstention**, so for money the only real fix is repairing the data before refreshing. Excluding incomplete rows from the serving view merely to pass the gate would introduce selection bias and is not an option.

**F2 — Canonical selection loses money, and the designed rescue is unpopulated.** Canonical contract rows have 76.2% value coverage while the raw grain has 87.7% — dedup picks winners that carry fewer values than their suppressed duplicates (SEAP canonical: 69.8% vs 100% on its suppressed rows). The columns built to fix exactly this — `canonical_value_source`, `value_observations`, `value_disagreement` — are **100% NULL / never written**. Populating canonical values from dup-group members is the single highest-leverage data fix: it can lift contract amount coverage toward the 0.95 spend gate and unlock contract-grain money answers. The rescue needs a **disagreement policy** (which member value wins, when they conflict) — that policy is part of milestone M1, not an afterthought.

**F3 — Flows is the wrong substrate for procurement analytics.** It drops procedures entirely, drops cancelled rows (making status distributions impossible by construction), carries only 2-digit CPV usefully, has no status/procedure-type/supplier-geo dimensions, and its inclusion rules (canonical + non-cancelled + payer/payee semantics) are tuned for the cross-domain entity-360 question, not for procurement market analysis. Decision D1 replaces it as the analytics substrate; it remains the entity-360 feed. Because both substrates will briefly coexist, the reconciliation rule is explicit: **procurement surfaces are authoritative for procurement questions; entity-360 numbers are indicative and labeled as such.**

## 3. Semantic contract — the policy table

The single most important building block, deliberately small (rev 2): a **semantic policy table** keyed by `(grain, measure)` — one declaration module in the procurement core. Each entry defines: `valueBasis` rules, `dateBasis`, population (canonical policy), lifecycle/terminality rule, **aggregation law** (additive / distinct / ratio — i.e. whether the measure may be summed across buckets, must be recomputed from keys, or must be derived from two other measures), and the legal answer shapes. Metric identifiers and the docs table are _derived_ from it; the requirements matrix (§4) names policy keys so tests can assert coverage mechanically — and seeded end-to-end tests (§7.1) assert the _SQL results_, not just the declarations.

### 3.1 Value bases

| `valueBasis` | Meaning                               | Source                                                          | Where allowed                                                                                                                             |
| ------------ | ------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `estimated`  | What the buyer planned to spend       | procedures/lots `estimated_value_ron`, DA `estimated_value_ron` | Own labeled metrics only; **never** in spend totals/rankings (D2)                                                                         |
| `awarded`    | The award/contract value as published | contract/DA `value_ron`, procedure `awarded_value_ron`          | **Default for all spend answers**                                                                                                         |
| `current`    | awarded + linked amendment deltas     | contracts ⨝ `contract_modifications`                            | **Detail only, and only validator-passing** (below). Never an aggregate metric in this design; any future promotion needs its own review. |
| `paid`       | Actual disbursement                   | —                                                               | **Declared out of data.** Every surface that could imply "spent" says "awarded value" — the UI/tool copy is part of this contract.        |

**`current` requires a per-record chain validator** (rev 2): the amendment trail must form a complete ordered chain — each modification's `value_before_ron` reconciles with the predecessor's `value_after_ron` (or the original awarded value), ordering is provable (dated, or single-element), currency is consistent. Records that fail validation return `current: unknown` plus the raw trail; nothing is fabricated from unordered deltas (only 47% of modifications are dated). Aggregating `current` is out of scope regardless of coverage.

"**Final value**" (from the brief) is redefined honestly: _validated current value of a record in a terminal lifecycle state, as of the serving build_. Terminality is derivable for DAs (`finalized`/`cancelled`) and procedures (`awarded`/`cancelled`); the contracts grain has **no terminality signal** (status constantly `awarded`), so contract values are always reported `provisional: true` with the amendment trail as the change record. No payments data exists, so "final" never means "what was ultimately paid" — this caveat ships in the envelope, not in a footnote.

### 3.2 Date bases and the undated population

| Grain     | `dateBasis`                                     | Coverage (canonical population)   | Rule                                                                                                                                                                                                                                                                                    |
| --------- | ----------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DA        | `coalesce(finalization_date, publication_date)` | ~67%                              | usable, with undated handling below                                                                                                                                                                                                                                                     |
| Contract  | `contract_date`                                 | ~80%                              | same                                                                                                                                                                                                                                                                                    |
| Procedure | `publication_date` today                        | **~34% overall / 0% e-licitatie** | **series/period answers unsupported** until the scraper backfills a real date (populate the existing `state_date` or `publication_date` from raw notice state; the raw data has it). Policy table marks procedure-grain time answers `blocked: missing-date-basis`, not silently lossy. |
| Amendment | `modification_date`                             | 47%                               | trail display only; never a series                                                                                                                                                                                                                                                      |

**Undated rows are a first-class population, not a footnote** (rev 2, review F2). Every rollup carries an explicit **`undated` bucket** (`month_start IS NULL`) alongside its monthly buckets. The rules:

- **Non-temporal scopes** (no from/to): stats/breakdowns aggregate dated + undated buckets — full-population answers, with `undatedIncluded {count, valueRon}` reported.
- **Time-bounded scopes**: only dated buckets inside the window are aggregated. An undated row cannot be attributed to any period, so the answer never claims "missing _within_ period X"; instead it reports the scope's undated-bucket totals as context: `undatedInScope {count, valueRon}` ("this authority also has N undated records worth V that no period can claim").
- **Aggregation laws per measure** (declared in the policy table): sums/counts are additive across months → quarter/year derivable; **distinct counts are not additive** → computed at query time from key-retaining rollups only; coverage rates are ratios → recomputed from their component counts, never averaged.

### 3.3 Population & counting rules

- **Canonical-only everywhere** (D2). `includeDuplicates: true` is a list-only opt-in, labeled, tighter-capped. Procedures have no dedup layer (no flag) — the policy table records that asymmetry.
- **Neither money nor counts merge across grains** (rev 2 — the previously proposed `purchases = DA + contract` merged grain is **removed**; review F1 correctly showed it contradicted the flagged-not-merged cross-grain reality). Stats for a multi-grain scope return **labeled per-grain blocks side by side**. Clients may render a `recordCountSum` only with the exact label "records, not unique purchases"; the API never presents it as a count of purchases. Procedure counts additionally never sit next to contract counts without the lifecycle note (a procedure yields contracts).
- **Averages**: `avg = sum(value) / count(records WITH value)`, same grain, same population. Row-count denominators would understate averages by 13–28% given value coverage; the envelope carries both counts.
- **Breakdowns reconcile by construction** (rev 2): every breakdown = top-N buckets + **`other`** (the non-top-N remainder) + **`unknown`** (NULL dimension). The three sum exactly to the scope's stats totals. Any dimension with NULLs (county 63–100%, CPV 7–29%, supplier 15–29% depending on grain) will show a large `unknown` — that is the honest answer.
- **Shares are derivations, not primitives** (rev 2): a share = numerator stats ÷ denominator stats, validated: identical grain, valueBasis, population, and period; numerator scope must be a strict subset of the denominator scope; denominator includes `unknown`/`other`; if either operand's money is gate-blocked, the share abstains (no count/value mixing). Served as a convenience query (§5.3) but implemented as two validated stats calls.
- **Cross-grain duplicate flags** (DA-also-contract, call-off overlaps) surface on detail as review signals; v1 does not net them out of counts (flagged, not merged — consistent with the scraper's link-layer philosophy).

### 3.4 The answer envelope

Every aggregate response (GraphQL, MCP, agent) carries a uniform `meta`, deliberately limited to what the answering query already knows (rev 2 — no companion scans, no per-answer fact-table coverage computation):

```
meta {
  policyKey             # semantic policy table key, e.g. "da.spend.awarded"
  grain                 # one per block; multi-grain answers are arrays of blocks
  valueBasis            # estimated | awarded
  dateBasis             # for this grain
  population            # canonical-only | includes-duplicates
  buildId               # immutable serving-generation id (drives dataAsOf + caches, §6.2)
  counts { rows withValue }          # from the same rollup read
  undatedInScope { count valueRon }  # from the undated bucket, same read
  provisional           # true where terminality is underivable (all contract-grain money)
  caveats [String]      # gate blockers + policy caveats
  link                  # normalized filter deep link (canonical scope echo)
}
```

Traceability contract (rev 2, softened honestly): `link` is the canonical scope — opening it as a list shows the underlying records under the same filter. Exact reconciliation is guaranteed only where it is arithmetically possible: breakdown buckets (top-N + other + unknown) sum to stats totals from the same build; a paginated list is the same _population_, not a checksum. Rollup-repaired values (M1 rescue) may differ from a raw fact row's stored value — detail views show both with provenance.

## 4. Requirements matrix — catalog questions → policy keys

Milestones referenced by the matrix (prerequisites, honest about today):

- **M1 — data repairs** (§6.1): flows population fix, canonical value/date rescue (+ disagreement policy), SEAP DA family enrichment, procedure date backfill.
- **M2 — analysis facts + rollup package** (§6.2): new dimensions (status, procedure type, 8-digit CPV), generation cutover.
- **M3 — supplier geography** (D4): ONRC coverage probe passes, gate opens.

Status: ✅ answerable now (current stack) · ✅@Mx answerable when milestone lands · 🟡 degraded (works with disclosed loss) · ⛔@Mx blocked until milestone · ❌ out of data in v1. All money = awarded, canonical-only, per grain (D2).

### Supplier / company perspective (anchor: `supplierCui`)

| Question                                           | Interpretation & policy key                                                         | Shape                                         | Status                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| Total value received                               | Σ awarded per grain, labeled blocks side by side (never summed)                     | `stats`                                       | ✅ DA · ⛔@M1 contract money (count-based 🟡 meanwhile) |
| How many contracts/awards/lots                     | canonical record counts per grain, side by side; lots ❌ (no award grain)           | `stats`                                       | ✅ (lots ❌)                                            |
| Average value per contract                         | sum / with-value count, per grain                                                   | `stats`                                       | ✅ with disclosure                                      |
| Top institutions paying it                         | rank authorities by awarded Σ within supplier scope                                 | `breakdown(authority)`                        | ✅                                                      |
| Regions where it wins                              | buyer-region breakdown ✅; supplier's own region ✅@M3                              | `breakdown(buyerRegion)` / `(supplierRegion)` | ✅ / ✅@M3                                              |
| CPV categories it operates in                      | division ✅; 8-digit ✅@M2 (cpv_code rollup; entity×8-digit via bounded fact query) | `breakdown(cpvDivision\|cpvCode)`             | ✅ / ✅@M2                                              |
| Value & count evolution                            | monthly series, quarter/year derived (additive measures only); undated disclosed    | `series`                                      | ✅                                                      |
| Underlying contracts behind an aggregate           | `meta.link` → list                                                                  | `list`                                        | ✅                                                      |
| % of an institution's procurement to this supplier | share derivation: edge stats ÷ authority stats, same grain/basis/period             | derived (`share` query)                       | ✅ DA · ⛔@M1 contract money                            |

### Contracting institution perspective (anchor: `authorityCui`)

| Question                           | Interpretation & policy key                                                                        | Shape                      | Status                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| Total awarded / count / average    | as above, authority-anchored                                                                       | `stats`                    | ✅ (contract money ⛔@M1)                                    |
| Evolution                          | monthly series                                                                                     | `series`                   | ✅                                                           |
| Top suppliers                      | rank by Σ within authority scope                                                                   | `breakdown(supplier)`      | ✅                                                           |
| CPV categories by value/count      | division ✅; 8-digit ✅@M2                                                                         | `breakdown(cpv*)`          | ✅ / ✅@M2                                                   |
| Distribution by **status**         | procedures grain only (contracts have constant status; DA 44% unknown → dominant `unknown` bucket) | `breakdown(status)`        | ✅@M2, time axis ⛔@M1 (procedure dates); DA 🟡              |
| Distribution by **procedure type** | procedures grain; contracts inherit via 86.5% linkage with `unknown` bucket                        | `breakdown(procedureType)` | ✅@M2                                                        |
| Distribution by region / CPV       | buyer county/region; CPV as above                                                                  | `breakdown`                | ✅                                                           |
| Underlying contracts               | `meta.link`                                                                                        | `list`                     | ✅                                                           |
| Supplier concentration             | HHI/top-1/top-5 over supplier edges within scope (measured 71ms worst case)                        | `concentration`            | ✅ (value basis only where spend-approved, else count basis) |

### Regional and market perspective (anchor: territory and/or `cpv*`)

| Question                               | Interpretation & policy key                                                            | Shape                                              | Status                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Region total value & count             | buyer-region scope totals                                                              | `stats`                                            | ✅ (from existing region-keyed rollups)                                      |
| Top institutions in a region           | breakdown(authority) within region scope                                               | `breakdown`                                        | ✅@M2 (needs region×authority closure; today only region×CPV ranking exists) |
| Top companies receiving in a region    | breakdown(supplier) within buyer-region scope; supplier-home-region ✅@M3              | `breakdown`                                        | ✅ / ✅@M3                                                                   |
| Top CPV categories                     | breakdown(cpv\*)                                                                       | `breakdown`                                        | ✅                                                                           |
| Activity & structure evolution         | series + per-bucket distinct actors (distinct = query-time over key-retaining rollups) | `series(measure: count\|amountSum\|distinct(dim))` | ✅                                                                           |
| Distinct active institutions/suppliers | COUNT(DISTINCT key) from edge rollups; never summed across buckets                     | `series(distinct)` / `stats`                       | ✅                                                                           |
| Market concentration (region / CPV)    | `concentration` generalized to any _supported_ scope (see closure matrix, §6.2)        | `concentration`                                    | ✅                                                                           |
| Coverage caveat for all of the above   | buyer geo 77% (gated); `unknown` bucket carries the rest                               | —                                                  | disclosed                                                                    |

### Contract & dataset perspective

| Question                                    | Answer in this design                                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Same filters for lists and aggregates?      | Yes — one `ProcurementScope`, every shape (§5.1); lists add grain-specific residual filters under the kernel bound policy. Aggregate scopes are limited to the supported-combinations matrix (§6.2).                                       |
| Grouping dimensions                         | time buckets, supplier, authority, buyer region (supplier region @M3), cpv division/code (@M2), status/procedure type (@M2) — exactly the rollup dimensions.                                                                               |
| Correct analytical unit                     | §2 table. Spend questions: DA and contract grains reported side by side; tender-process questions: procedures; lots/amendments are detail enrichments; payments do not exist.                                                              |
| What monetary values represent              | §3.1 ladder; awarded is the default; `paid` declared out of data.                                                                                                                                                                          |
| Which date                                  | §3.2 per grain, with undated-population rules.                                                                                                                                                                                             |
| Count de-duplication                        | canonical-only + no cross-grain merging (§3.3).                                                                                                                                                                                            |
| Amendments / cancellations / status changes | amendments: raw trail always; validated `current` on detail; never aggregates. Cancellations excluded from spend, visible in status breakdowns. Status changes: latest-state serving; audit log starts per D3 (§6.3).                      |
| Identity resolution                         | CUI-level, `supplier_identity_key` extended to all grains (M2); org names/geo joined from `core.organizations` at build time; CUI grouping stays deferred and stated.                                                                      |
| CPV & geo hierarchies                       | CPV: full 8-digit + division from `cpv_codes` (hierarchy table already present); filtering accepts either, code compiled to index-safe ranges (kernel `codeRange`). Geo: siruta → county → region on both sides (buyer now, supplier @M3). |
| Aggregate → source records                  | `meta.link` + detail bundles carry `source_url`, dup/cross-grain flags, and value provenance.                                                                                                                                              |

## 5. Serving design

### 5.1 One scope, many shapes

`ProcurementScope` (extends today's scope filter; kernel-spec-declared so TypeBox/SDL/SQL/Zod + `fhash` all derive from one declaration):

```
scope {
  authorityCui, supplierCui,
  cpvDivision | cpvCode,            # code legal @M2; compiled to range
  buyerCounty | buyerRegion,
  supplierCounty | supplierRegion,  # @M3, capability-gated
  status, procedureType,            # @M2
  grain,                            # procedure | contract | direct_acquisition (no merged grain)
  from, to (month) | year,
  includeDuplicates (lists only)
}
```

Aggregate answers accept only scope/dimension combinations present in the supported-combinations matrix (§6.2); unsupported combinations are rejected with the specific missing capability named (same actionable-error discipline as the bound policy).

### 5.2 Answer shapes — six, not nine (rev 2)

| Shape                        | Answers                                                                   | Read model                                                  | Notes                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `list`                       | records + cursor/offset                                                   | facts (indexed)                                             | unchanged + the two DA indexes from the filtering doc                                                                         |
| `detail`                     | one record + enrichments                                                  | facts + children                                            | includes amendment trail, validated `current`, dup/cross-grain flags, value provenance ("explain" lives here, not as a shape) |
| `stats`                      | count, with-value count, Σ, avg, min/max date — per-grain labeled blocks  | rollups                                                     | capped/estimated counts kept                                                                                                  |
| `series(bucket, measure)`    | per-bucket measure; `measure ∈ count \| amountSum \| distinct(dimension)` | rollups (distinct → key-retaining edge rollups, query-time) | month storage; quarter/year derived for additive measures only; undated rules §3.2                                            |
| `breakdown(dimension, topN)` | top-N + `other` + `unknown`, each with share-of-scope                     | rollups                                                     | reconciles to `stats` by construction                                                                                         |
| `concentration(basis)`       | HHI, top-1/5 share, distinct suppliers                                    | edge rollups                                                | generalized to supported scopes                                                                                               |

Removed as first-class shapes (review F11): `share` → a validated derivation over two `stats` calls (§3.3), still exposed as a convenience query; `distinctTrend` → `series(distinct(dim))`; `explain` → part of `detail`; `facets` → batched `breakdown` calls behind one resolver. Growth (MoM/YoY) is a presentation of `series`, declared in the policy table so agents don't derive it from truncated data.

### 5.3 GraphQL surface (breaking changes allowed — pre-deployment)

Named queries over the six shapes: `procurementStats(scope)`, `procurementSeries(scope, bucket, measure)`, `procurementBreakdown(scope, dimension, topN)`, `procurementShare(numerator, denominator)` (derivation, validated per §3.3), `procurementConcentration(scope, basis)`, `procurementFacets(scope, dimensions)` (batched breakdowns), per-grain lists/details (kept). The five analyst queries (repeated pairs, same-day DAs…) remain as-is — they already fit. Every aggregate returns the §3.4 envelope. REST mirror optional later via the same kernel derivation; not v1.

**Migration table** for the existing surface (rev 2, review F14) — to be completed at implementation time, seeded here:

| Existing                                                                       | Disposition                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `procurementStats/TopAuthorities/TopSuppliers/CategoryBreakdown/SpendOverTime` | re-expressed over the six shapes; names kept where response shape survives, else renamed with the old query deleted (pre-deployment, no alias period needed for GraphQL)                                                                 |
| 5 analyst queries + search/detail/resolve/grainQuality                         | unchanged                                                                                                                                                                                                                                |
| 9 MCP tools                                                                    | **names are stable forever** (tool contract v2): all 9 keep their names and semantics; `get_procurement_grain_quality` stays (rev 1's rename to `get_procurement_capabilities` is dropped); the only addition is `aggregate_procurement` |

### 5.4 Capability gate v2 — per grain × answer class; scope coverage is descriptive

Clarified in rev 2 (review F4): the **gate** — the thing that can allow or abstain — remains a scraper-materialized snapshot **per (grain × answer class)**, computed on that class's serving population (date coverage gates time answers, amount gates spend, geo gates regional). It cannot be per request scope, and this design does not pretend otherwise. Rules:

- **Money: strict abstention**, unchanged — 0.95 thresholds with the existing hysteresis discipline. No degrade path for spend.
- **Count/time answers: disclosed degradation** — served with the undated/coverage context of §3.2–3.4 down to a floor (proposed 0.50, provisional), abstain below it.
- **Scope-local coverage** (this authority's undated count, this scope's with-value count) is **descriptive envelope metadata from the same rollup read** — it informs the reader; it never flips capability.
- Thresholds stay in `aggregate_filter_thresholds` (scraper-owned, versioned). The gate remains machine-readable and exposed unchanged (`procurementGrainQuality` + capabilities), feeding client UI, MCP, and envelopes.

### 5.5 MCP & agent tools (on decided contract v2)

Composable core + existing conveniences, all `KernelTool` v2 (typed input, `ToolContext`, `ToolMeta` with cost class, registry-selected), Zod derived from the same spec (`toZodShape`, quad-surface equivalence test):

| Tool                                                                                                                                                                                                                                  | Maps to                                                                                         | Meta                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- |
| existing 9 tools (`resolve_procurement_filter`, `search_procurement_*`, `rank_procurement_*`, `get_procurement_concentration`, `get_procurement_authority_cpv_spend`, `find_same_day_da_candidates`, `get_procurement_grain_quality`) | unchanged names + semantics, re-plumbed onto the new read models                                | as today                                    |
| `aggregate_procurement` (new)                                                                                                                                                                                                         | `{scope, shape: stats\|series\|breakdown\|concentration, dimension?, bucket?, measure?, topN?}` | standard; expensive for `distinct` measures |

Reliability rules for AI callers: every tool output echoes the §3.4 envelope (policyKey, valueBasis, caveats, link) — the model can cite provenance; ambiguous/expensive asks are bounced with the _specific_ bound or missing capability named; `llm_generated_filter` stays gate-blocked; summaries state "awarded value, not payments" wherever money appears; share requests that fail operand validation (§3.3) return the validation failure, never a partial ratio.

## 6. Data platform design (scraper-owned)

### 6.1 Immediate repairs — milestone M1 (sequence FIRST, independent of the package)

1. **Do not enable the MV refresh cron alone** (F1). Repair the data first: enrich the new-family DA rows, then refresh. For money there is no degrade path (§5.4) — repair is the only fix; excluding incomplete rows from the serving view to pass the gate is selection bias and is rejected.
2. **Value rescue** (F2): populate `canonical_value_source`/`value_observations` from dup-group members **under an explicit disagreement policy** (proposed: exact agreement → adopt; disagreement → adopt none, set `value_disagreement`, surface both on detail); recompute coverage; contract spend likely unlocks. Same mechanism for `contract_date` (80% canonical vs ~93% raw-side).
3. **SEAP DA family enrichment**: dates/values for `seap_da`/`seap_dan` (7M rows) from raw where present; rows that remain date-less live in the undated bucket (§3.2) — listable, countable in non-temporal scopes, never attributed to periods.
4. **Procedure date backfill**: populate `state_date` (exists, 100% NULL) or `publication_date` for the e-licitatie half from raw notice state. Unblocks procedure-grain time analysis.
5. From the filtering doc, unchanged: two DA indexes, unified selectivity gate, contract manifest + CI check, CONCURRENT refresh where matviews remain.

### 6.2 `procurement.analysis_facts` package — milestone M2 (D1)

Per-grain projection tables (not one mega-table — grains differ in columns and lifecycle, and a `grain` column union invites accidental cross-grain sums), built as an ETL stage with the same gate discipline as other projections. Rev 2 scoping (review F3/F12/F13):

- **Narrow analytical columns only** — normalized dimensions + measures, not wide raw copies: fact id + source refs; identity (`authority_cui`, `supplier_cui`, `supplier_identity_key` extended to all grains, org ids); resolved geo (buyer siruta/county/region now; supplier county/region @M3 with `supplier_geo_source`); `cpv_code` + `cpv_division`; `status`; on contracts `procedure_type` via the 86.5% linkage (NULL → unknown); `date_basis` (materialized) + raw dates; `value_estimated`, `value_awarded`, `value_source`; `is_canonical`, dup + cross-grain flags. Everything else stays on the source tables, reachable from `detail`.
- **No date-based partitioning in v1** (review F3: `date_basis` is mutable — enrichment moves rows across date partitions and breaks single-column uniqueness). Tables start unpartitioned (26.5M rows is comfortably within btree/seq tooling at these access patterns); if partitioning becomes necessary, partition on a **stable** key (grain-native id range). Revisit with measurements.
- **Refresh via load-run change manifests, published as generations** (F3 + F13): each ETL run emits per-row old/new rollup keys + tombstones (upserts can change dimension values; deletes must reverse old buckets); affected rollup buckets are rebuilt from the manifest and published **atomically as a new generation** — build → reconcile (invariant checks: per-grain sums match facts, breakdown buckets sum to stats) → switch the active-generation pointer. `buildId` (the generation) drives `dataAsOf`, cache keys, and envelope stamps; the previous generation is retained for rollback. Before first cutover: **shadow comparison** of every §4 ✅-row against the current MV answers.
- **Rollups land incrementally, gated by a supported-combinations matrix** (F5/F12) — a checked-in artifact listing every (scope dimensions × shape × grain) combination the package answers, validated by API health and scraper CI (extends the contract manifest from the filtering doc). Wave 1 rollups are the proven hot paths, all with the `undated` bucket and key retention where distincts are needed: (1) edge `authority × supplier × month` [DA + contract grains only — procedures have no supplier], key-retaining; (2) `authority × cpv_division × status × procedure_type × month`; (3) `supplier × cpv_division × month`; (4) `cpv_code × month` (8-digit exploration, no entity); (5) `buyer_region × cpv_division × month`. Combinations not covered (e.g. supplier × procedure_type) are **rejected with the missing capability named**, or served by bounded fact queries where a selective scope makes that interactive; new rollups are added when traffic justifies them, not speculatively. Sizing is measured in ETL CI per rollup before it ships — the rev 1 "×1.5–2" estimate is withdrawn as unsupported.
- Same-day DA candidates rollup: kept as-is.

### 6.3 Change audit log (D3, rescoped in rev 2)

Append-only `procurement.record_change_log (event_id, grain, fact_id, load_run_id, observed_at, changes jsonb)` written idempotently by the loaders on upsert-with-change (unique on `(grain, fact_id, load_run_id)`), initially capturing `status` and `value_ron` transitions with old/new values. **It is an audit log, not an as-of-analytics source**: it observes load-time changes to two fields; dates, canonical selection, identity, CPV, and deletions also change and are not captured. Serving surface in v1: none beyond `detail` provenance notes ("value changed on load of 2026-08-02"). If as-of-time analytics become a product goal, that requires a separate history/CDC design (business-effective vs load-observed time, full-field capture, retention/partitioning) — explicitly out of scope here. D3's intent (start accumulating change history now) is preserved at honest scope.

## 7. Cost model and testing

### 7.0 What is interactive

| Query family                                   | Read model                                                                                                | Measured/estimated                                                                                     | Class                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| stats/series/breakdown on any supported slice  | rollups (indexed by entity/month/dimension)                                                               | 10–100ms (HHI worst case 71ms measured)                                                                | interactive                                                                          |
| concentration / distinct measures, wide scopes | key-retaining edge rollups, COUNT(DISTINCT) at query time                                                 | 70ms–1.5s (empty-scope stats 1.5s measured)                                                            | interactive; cached for empty/near-empty scopes (15min TTL kept, keyed on `buildId`) |
| share derivation                               | two stats reads                                                                                           | 2× stats                                                                                               | interactive                                                                          |
| lists, selective scope                         | facts + composite indexes                                                                                 | <300ms                                                                                                 | interactive                                                                          |
| lists, residual predicates                     | facts                                                                                                     | unbounded → **bound policy required** (unchanged)                                                      | rejected/degraded with actionable error                                              |
| entity × 8-digit-CPV aggregates on facts       | facts + `(cpv_code, date_basis)` partial indexes                                                          | sub-second under selective scope — **estimated, to be proven in M2 CI before the matrix row flips ✅** | interactive under bound                                                              |
| counts                                         | capped 10k + estimated (kept); `procurementStats` procedure count capped+TTL-cached (P3 fix, unchanged)   | —                                                                                                      | —                                                                                    |
| per-request budget                             | ≤4 statements (provisional) — the slim envelope (§3.4) adds none: its fields come from the answering read | —                                                                                                      | enforced in the shape executor                                                       |

MCP cost classes map onto the v2 deadlines (cheap 5s / standard 15s / expensive 30s).

### 7.1 Testing strategy (rev 2, review F15)

- **Policy-table coverage test**: every §4 matrix row names a policy key; CI asserts the key exists and its declared legal shapes include the row's shape (mechanical, but only the floor).
- **Seeded end-to-end reconciliation**: fixture facts → build the package → assert stats totals, breakdown top-N+other+unknown reconciliation, undated-bucket behavior, and share validation against hand-computed expectations.
- **Property tests** for the invariants: money never crosses grains; canonical-only populations; avg denominators; share operand validation (subset scope, same basis/period, abstain on gate-block).
- **Correction tests**: a fixture row whose `date_basis`/dimension changes between runs — manifests must reverse old buckets and land new ones; deletes must tombstone.
- **Generation tests**: partial-build failure leaves the previous generation serving; pointer switch is atomic; caches keyed on `buildId` never serve mixed generations.
- **Shadow comparison** old MV answers vs new package for every currently-✅ matrix row, run before cutover and kept as a regression harness during the coexistence window.
- **Load tests** with production-shaped scopes (max-fanout authority, empty scope, undated-heavy scopes) against the measured anchors above.

## 8. Alternatives considered

- **Read model:** (a) scraper fact+rollup package ✅ D1; (b) widen the flows→MV stack — less work but procedures never fit, cancelled rows stay invisible, flows semantics get polluted for entity-360 consumers; (c) API-side caching over raw facts — non-viable at 17s scan reality.
- **Value semantics:** (a) awarded-only with strict separation ✅ D2; (b) coalesce awarded→estimated — fuller but every number needs an asterisk and journalistic misuse risk is high; (c) expose everything labeled — pushes the correctness burden onto every consumer.
- **"Final value":** (a) honest redefinition + validator + provisional flags ✅; (b) last amendment value as final — indefensible at 1.6%/47%-dated coverage; (c) omit the concept — leaves the brief's question unanswered when a bounded honest answer exists.
- **Merged cross-grain grain (`purchases`):** rejected in rev 2 — cross-grain duplicates are flagged-not-merged, so a merged count is knowingly wrong; labeled side-by-side blocks cost one headline KPI and keep every number defensible.
- **Shape count:** nine first-class shapes (rev 1) vs six + derivations ✅ — share/distinctTrend/explain multiplied GraphQL/MCP/gate/cache/test surface without adding analytical capability.
- **Registry:** per-answer metric registry (rev 1) vs semantic policy table ✅ — same correctness enforcement, far smaller compatibility surface, docs derived instead of mirrored.
- **History:** (a) audit log now ✅ D3-rescoped; (b) nothing — permanently loses pre-capture history; (c) full CDC/bitemporal — cost far beyond current product need, gets its own design if ever needed.
- **Distinct counts:** key-retaining rollups + query-time DISTINCT ✅; HLL sketches premature at measured latencies; revisit if edge rollups grow 10×.
- **Partitioning:** by `year(date_basis)` (rev 1) — rejected: mutable partition key + uniqueness constraints + watermark refresh don't compose (review F3). Unpartitioned/stable-key + change manifests ✅.

## 9. Risks and unresolved questions

1. **ONRC supplier-geo coverage is unmeasured** (D4/M3 rests on it) — first task of that workstream is a coverage probe + threshold before any UI promises supplier regions.
2. **`source_updated_at` semantics on procedures** — if it is notice state date (not scrape time), it's an interim date-basis candidate; verify against raw before the M1 backfill lands.
3. **Change-manifest complexity** sits in the scraper's hot loader path — the manifest emitter must be property-tested against the correction scenarios (§7.1) before any rollup consumes it.
4. **Cross-grain overlap magnitude** (DA-also-contract) is flagged but unquantified; if large, the side-by-side presentation needs a prominent overlap note — measure during M2.
5. **Contract terminality**: no signal exists; if SEAP/e-licitatie expose completion status in raw, capturing it would upgrade `provisional` semantics — scraper investigation ticket.
6. **Degrade floor** (0.50 proposed for count/time answers) is provisional — tune against real coverage after M1.
7. **Value-rescue disagreement policy** may leave coverage below the 0.95 spend gate even after M1 (disagreeing duplicates adopt nothing) — if so, contract money stays count-based and the matrix stays honest; do not loosen the gate to force it.
8. **Amendment linkage** may improve (notice_no→procedure links are 99.5%); `current` stays detail-only regardless (§3.1) — better linkage improves detail quality, not aggregate eligibility.
9. Inherited: Meili index inventory unprobed; pool/statement budget provisional; cursor-version bump on spec migration.

## 10. Recommended implementation direction

1. **M1 repairs first** (§6.1 — scraper): flows population fix + value/date rescue with disagreement policy + DA family enrichment + procedure dates; only then enable the refresh cron. API ships §5.4 degrade semantics (count/time only) in parallel.
2. **Policy table + envelope** (API): semantic policy table, slim envelope, other+unknown breakdown reconciliation, no-cross-grain-merge stats blocks — applied to the _existing_ MV-backed queries. Immediate correctness win, no data dependency.
3. **M2 package** (scraper): narrow facts + wave-1 rollups + supported-combinations matrix + generation cutover + shadow comparison; API repoints aggregate repos rollup-by-rollup behind the matrix.
4. **Shapes v2** (API): six-shape executor, share derivation query, facets-as-batched-breakdowns, GraphQL surface v2 per the migration table; §7.1 test suite lands with it.
5. **MCP**: `aggregate_procurement` + re-plumbing the stable 9 tools, on the tool-contract v2 migration already sequenced in the MCP review.
6. **Client**: entity-pair and market dashboards on stats/series/breakdown/share; server facets replace fan-outs (from the filtering doc's client wave).
7. **Audit log** (D3) lands with any scraper wave ≥1; **M3 supplier geo** after its coverage probe.
8. Write the filtering/analytics **standard** after waves 3–5 prove the model (inherited sequencing).

Each wave independently shippable; wave 1 is urgent regardless of the rest (F1 is a standing outage-on-refresh).

---

## Appendix A — What today's API already answers (baseline)

Scope `{authorityCui, supplierCui, cpvDivision, monthFrom/To}` → 5 dashboard aggregates (stats, top authorities/suppliers, category breakdown, monthly spend) + 5 analyst queries (repeated pairs, per-authority concentration/HHI, authority CPV spend, top suppliers by buyer-region×CPV, same-day DAs) + per-grain offset search, detail bundles with modification trail, cursor supplier-records feed, resolve, grain-quality/capabilities. 9 MCP tools mirror this. Gaps this design closes (with milestones): 8-digit CPV aggregates (M2), status/procedure-type distributions (M2, time axis after M1), share ratios (derivation, now for DA), region-scoped breakdown closure (M2), distinct-actor trends (now), non-monthly buckets (now), value provenance on detail (now), per-answer undated disclosure (now), procedure-grain time analysis (M1), supplier geography (M3).

## Appendix B — Probe evidence (transparenta_prod, 2026-07-12, read-only)

- **Grain populations** (D1.1, D2.6, D3.2): procedures 622,936; contracts 3,274,706 — canonical 1,564,286 (47.8%); split `seap_contracts` 2,120,245 / `elicitatie_ca_award` 1,154,461; canonical procedure-linkage (469,729+882,783)/1,564,286 = **86.5%**; canonical value coverage (428,200+764,129)/1,564,286 = **76.2%** vs raw 87.7% (exact per-family: suppressed SEAP rows 100% valued vs canonical SEAP 69.8%). DAs 26,515,272.
- **Reconciliation columns unpopulated** (D2.1): `canonical_value_source` null_frac = 1; `value_disagreement` = false on 100% of rows; `value_observations` never written (loader inspection).
- **Procedure dates** (D3.1): `elicitatie` 312,159 rows — publication_date 0; `seap_notice` 310,777 — 213,614 (68.7%); `state_date` 100% NULL (D2.1). Awarded value: elicitatie ~98% on award kinds, SEAP award_no_init 81.5%.
- **DA dates/values, 1% block sample, n=267,059** (D3.3): finalization 63.9%, publication 66.6%, either **66.8%**, value 71.9%, supplier 70.9%. Status × canonical (D3.4): canonical 87.1%; canonical-unknown 40.6% of canonical.
- **Flows drift** (D3.6 vs gate D2.10): gate (refreshed 2026-06-29): DA rows 15.72M, date 0.958, amount 0.994; contract rows 0.97M, amount 0.810. Live 1% sample: DA ~23.2M flows, date **65.4%**, amount **67.7%**; contract ~1.54M flows, amount 75.5%, date 80.1%. Thresholds (D2.13): DA date ≥0.95, amount ≥0.95 → both breached pending refresh (F1).
- **Modifications** (D2.2): 52,297 total; 46,863 linked (89.6%); 46,860 with delta; 24,686 dated (47.2%); 20,210 with value_after; span 2021-01-02..2026-06-03; `modification_type` free text.
- **Growth attribution** (D3.5 + scraper brief): whole DA table re-created 2026-06/07 (reload wave; `created_at` unusable for organic growth); 06-27 brief 19.1M → 07-12 26.5M driven by new `seap_da` (45.8%) / `seap_dan` (3.6%) family imports, not steady state.
- **Structures** (D1.1–D1.6): procedure_lots 1,223,689 (estimated values only); subsequent_contracts 63,246 (years 2016–2018; 56 SEAP dup candidates); ted_notices 267,456; cpv_codes 10,469 with parent/division/level; org_edge MV 8,239,435 rows/3.9GB; MV definitions confirm: rollups read `procurement_flow_facts_v1` = money_flows(source_id='procurement', flow_type ∈ {procurement_contract, direct_acquisition}), require non-null authority+supplier+date (org_edge) — i.e. today's aggregates silently exclude any-null rows on those keys.
- **Identity** (D2.12): `organization_identifiers` schemes = {ro-cui, onrc-cod-inmatriculare}, source = onrc only; `supplier_identity_confidence` high 92.7% / none 7.1% / low 0.25% (contracts grain only).
- Perf anchors reused from the filtering doc's Appendix A (measured 2026-07-12): CPV-division fact scan 16.97s; unique_code seq scan 7.2s; HHI worst case 71ms; empty-scope MV stats ~1.5s wall; capped count degraded 266ms.

---

## Rev 3 — implementation amendments (2026-07-12, wave 1 shipped)

Wave 1 is implemented and deployed (scraper package live on prod, generation build 2 active; server surface committed). Full record, evidence, and unresolved limitations: `PROCUREMENT-ANALYSIS-IMPLEMENTATION.md`. Amendments to this design discovered during implementation:

1. **§6.2 change manifests → full-rebuild generations.** Facts are upserted in place (no-op-guarded); only rollups are generation-stamped, rebuilt per run, reconciled, and published by a single-tx active-pointer flip (N-1 retained). Corrections trivially move buckets; all F3/F13 goals met with far less machinery. Measured full run: 43.1 min for 30.46M facts + 13 rollup lanes.
2. **§6.1(2) value rescue at projection time only** — the reserved `contracts.canonical_value_source/...` columns remain M1's deliverable; the package computes rescue into its own facts columns.
3. **F2 hypothesis corrected by measurement**: the dup-group value rescue recovers ~nothing (contracts 0 values / 16,074 dates; DA 80 values; 0 disagreements) — valueless canonical rows are overwhelmingly singletons without dup groups. The 76.2%→~87% contract value-coverage lift does NOT exist; spend unlock requires raw-side enrichment (M1 proper). §9.7's warning materialized in the strongest form.
4. **§6.3 audit log at analysis-run granularity** — written by the lane's diff; base loaders untouched.
5. **§5.4 gate v2 rides the generation**: the lane computes per-grain coverage and per-(grain × class) verdicts into `analysis_generations.quality`; the API consumes them (procedures now have a verdict; the new surface is decoupled from the F1-stale flows gate). Measured verdicts: spend abstains on all grains (value coverage .539/.762/.678); time procedure abstain (.343), contract/DA degraded (.810/.654); geo degraded everywhere.
6. **Identity keys at scale**: per-row SQL identity functions (CTE bodies, non-inlinable) blew a 45-min statement timeout on prod; keys are computed per DISTINCT supplier in a materialized CTE + both functions marked PARALLEL SAFE.
7. **§6.2 matrix**: the artifact is the exhaustive programmatically-generated closure (275 rows), hash-pinned and byte-vendored by the server with a bidirectional acceptance-space parity test; breakdown/concentration routing is per (scope, dimension) with a pinned rollup preference order; fully-scope-pinned concentrations and breakdowns over scope-fixed dims are rejected as stats answers.
8. **§2 supplier identity on procedures**: impossible (the grain has no supplier); procedure facts carry no supplier columns.

Measured serving anchors (prod, build 2): 13-query validation set 33–315 ms (8-digit CPV series 42 ms; bounded authority×cpv_code fact query 52 ms — the old 17 s scan class); platform-wide distinct-suppliers/quarter 1.9 s (cacheable); shadow vs the old org_edge MV exact-to-the-cent on the same-population slice; golden suite proves GraphQL == MCP == raw SQL on the live build.
