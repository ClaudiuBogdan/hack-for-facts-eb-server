# Parliament & Public-Contracts Filtering — Diagnosis and Design

**Date:** 2026-07-12
**Status:** Design for review — no implementation approved yet
**Scope decision (owner):** Parliament + public-contracts only. Execution-line-items (ELI) is already deployed and stays untouched; it serves as a capability reference, not a migration target.

This note is the outcome of a three-repo investigation (Client, API, Scraper) plus live read-only probes against the production database (`transparenta_prod`, PG 18.4, via port-forward; all probes `EXPLAIN (ANALYZE, BUFFERS)` under 10–30s statement timeouts, no writes, no refreshes). Evidence appendix at the end.

---

## 1. Product goal (owner's framing, recorded 2026-07-12)

> "I want powerful, flexible, efficient queries like _how many contracts and total amount has this company with this institution, and filter by period, see maybe graphs_ — that's the goal. Build this powerful query so we can iterate and improve now, because we have not deployed the parliament and public-contracts database to the client yet. The execution line item is already deployed so we should focus only on the public contracts and parliament. About unification: create a standard and building blocks for filtering best practices, but we can have different interfaces for each domain to avoid being constrained by one filtering module. Optimize the filters per domain; write the guide after we have tested a very good version that allows more powerful composition."

Implications taken as requirements:

1. The design target is **compositional analytical filtering** — entity × entity × period × category slices answering _count + amount + trend_ — not just list filtering.
2. Parliament/procurement are **pre-deployment**: breaking their current GraphQL shapes is acceptable if the client is updated in the same wave; ELI compatibility is out of scope.
3. Deliver **building blocks + a written standard**, not a single mandatory filter module. Domain interfaces may diverge where the domain demands it.

## 2. How the current system works (condensed map)

**Topology.** Parliament + procurement live on the redesign surface (`/api/v1/graphql`, `src/app/build-redesign-app.ts`), reading one shared read-only pool (max 15, `statement_timeout` 15s — `src/modules/shared/shell/db/pool.ts`) over schemas `parliament.*` / `procurement.*` in `transparenta_prod`. DDL and data are owned by the scraper repo (`src/db/prod-migrations/`, loaders in `src/sources/{parliament,public-contracts}/prod/`).

**Filter kernel.** `src/modules/shared/core/filters/` defines `CollectionFilterSpec`: declare fields once, derive three surfaces (TypeBox for REST/MCP, GraphQL SDL inputs, SQL condition builders) plus canonical filter hashing (`fhash`) that binds cursors to the filter set. **The kernel's predicate compiler only handles single-column ops** (eq/in/range/prefix/contains/isNull, array ops). Everything else — diacritic-folded ILIKE, OR-across-columns, EXISTS/semijoins, enum-buckets over JSON `attrs`, CPV range expansion, canonical-row scoping — is declared `virtual` and hand-compiled inside each repo. Result: `parliament-repo.ts` is 2,714 lines; procurement splits across four repos; the two DA surfaces (cursor vs offset) grew **divergent selectivity gates** (`DA_SELECTIVE_FIELDS` in `core/filters.ts:444` vs `DA_OFFSET_SELECTIVE_FIELDS` in `core/constants.ts:95`).

**Data grains (semantics to preserve).**

- Procurement: three fact grains (procedures ~622k, contracts ~3.27M, direct acquisitions ~26.5M) with `is_canonical`/`dup_group_id` dedup as a reversible link layer; grains may merge for counts, **never for money**; contract spend is gate-suppressed (amount coverage 0.81 < threshold). Aggregates are answered only from five materialized views keyed on `(month, grain, authority, supplier, county/region, cpv_division)`, guarded by the machine-readable capability gate `public_contracts_filter_capabilities_v1` / `aggregate_quality_by_grain`.
- Parliament: canonical bills only in default lists (bicameral twins via `canonical_bill_key`); ballots carry `match_method` (resolved vs unresolved member identity, `mandate_key` nullable by design); `bill_act_links.resolution_status` drives hasLaw/publishedInMo; AI-enrichment rows are privacy-gated; parent-bound cursors keep `vote_records` (3.76M) from ever being scanned unparented.

**Client.** Parliament/procurement already share a consistent idiom distinct from the legacy `AnalyticsFilter`: discrete URL params with Zod `.optional().catch(undefined)`, defaults stripped, a single writer hook (resets `page:1`, `replace:true`), pure operator-object `buildXFilter` builders per grain, TanStack Query keyed on the whole search object, 300ms debounce, capability-gate-aware UI.

## 3. Diagnosis — measured on production, 2026-07-12

### 3.1 Confirmed problems

| #   | Problem                                                                          | Measurement                                                                                                                                                | Root cause                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | DA list filtered by CPV division alone                                           | **16.97s**, 1.23M buffers read (~9.4GB I/O), lossy bitmap at `work_mem=32MB`, 2.85M canonical rows → top-101                                               | No composite index; single-column `das_cpv_code_idx` forces bitmap heap scan + sort. **Reachable in prod today** through the cursor surface, whose gate admits `cpvDivision`/`cpvCode`/`uniqueCode`/`year` as "selective"          |
| P2  | DA lookup by `unique_code`                                                       | **7.2s**, full parallel seq scan of 26.5M rows / 2.3M buffers to find 1 row                                                                                | Scraper migration `20260707T161000__drop_unused_da_index.ts` dropped `das_unique_code_idx` while the API still offers the filter — a cross-repo contract break neither side detected                                               |
| P3  | `procurementStats` runs an exact blocking `count(*)` on procedures on every call | 345ms empty scope (134k buffers); **1.30s** supplier scope (48.5k contract rows semijoined)                                                                | `countProceduresInScope` (`procurement-repo.ts:718-754`) sits **outside** the scope cache and violates the module's own "no blocking COUNT on facts" invariant                                                                     |
| P4  | Aggregate matviews stale                                                         | Gate `refreshed_at = 2026-06-29`; facts loaded through **2026-07-12** (13 days drift)                                                                      | The MV refresh stage is not in the daily 01:10 cron (comment says "split off to a separate job" that doesn't exist); refresh SQL is non-CONCURRENT `REFRESH MATERIALIZED VIEW` (ACCESS EXCLUSIVE — blocks API reads while running) |
| P5  | Bills lists full-scan the table on every query                                   | 77ms per query over 45k rows (13k buffers); `pg_stat_user_tables` shows **228k seq scans / 9.2B tuples** of cumulative traffic                             | Status/type filters live in JSON `attrs` enum-buckets and q is folded ILIKE — nothing indexable as designed. Tolerable at 45k rows; linear degradation with growth                                                                 |
| P6  | Text-search delegation does not exist in the live path                           | Code inspection: `listVotes`/`listBills` → repo ILIKE always; Meili used only for person-name resolution; `searchEngineUp` merely relaxes the q-only bound | The "Meili-primary, ILIKE fallback" comments in `specs.ts` describe an unimplemented intent. Meanwhile OpenSearch already serves `unified_contracts` (5.9M docs, 5.4GB) and `unified_parliament` (183k docs)                       |
| P7  | Data outgrew the design notes                                                    | DA 26.5M vs 17M documented (+56% in ~1 month); contracts 3.27M vs 1.88M                                                                                    | Growth compounds P1–P4; any "it's fine at current size" argument has a short shelf life                                                                                                                                            |

Client-side (code inspection, not DB-measured): the members filter fires N `parliamentResolveFilter` round trips + `loadAllGroups()` (2 queries) before the real query on first use; composition/judet facets derive from `pageSize:500` fan-out fetches; vote detail walks ballots in up to 3 serial requests. These are interface-shape problems the new filter contract should absorb (resolve-in-one-request, server-provided facets).

Pipeline note (out of filtering scope, worth a ticket in the scraper): `parliament.sitting_agenda_item_documents` shows 205k seq scans / **260 billion** tuples read — the agenda loader/validator (`prod-agenda-port.ts`, `validate-prod.ts`) scans the 2.45M-row table per item instead of using an index.

### 3.2 Suspects closed by measurement (do not spend design budget here)

- Members q folded-ILIKE: 6ms (5.3k rows). Votes q with chamber+year bound: 14ms (20.7k rows).
- Speeches 366-day window without mandate: **149ms** — PG18 serves it via a skip scan (431 index searches) on `(mandate_key, spoken_at DESC)`; the feared 1.4M-row seq scan does not happen. The 366/92-day windows remain good product bounds, but no `spoken_at` index is needed at current volume.
- Supplier concentration/HHI: 71ms for the maximum-fan-out authority (7,533 distinct suppliers) — SQL-side grouping over the rollup MV is fine. (Separate correctness note: HHI folds through `Number()` floats, `aggregate-repo.ts:296-318`, against the No-Float rule.)
- `cappedCount` with a selective anchor + rare ILIKE refinement: 266ms — the degradation exists but is mild at realistic anchor sizes.
- Empty-scope stats decomposition: 1.45s + 0.98s + 1.24s run concurrently ≈ 1.5s wall — matches the documented mitigation; acceptable, cached for non-entity scopes.

### 3.3 Deliberate bounds that are working (keep, and make declarative)

Offset DA gate (CUI or ≤366-day window), capped counts (10k → `totalEstimated`/null degrade), parent-bound cursors, speech windows + FULL_TEXT depth downgrade, canonical-only defaults, aggregate reads only from MVs, capability gate suppressing low-coverage filters (supplier-region correctly blocked), scope cache keyed on gate `refreshed_at`, 15s ambient statement timeout.

## 4. Decisions made by the owner (2026-07-12, via question tool)

| Decision                 | Choice                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filter composition model | **Extend the kernel `CollectionFilterSpec`** with first-class predicate primitives; modules declare, kernel compiles                                                                    |
| Text search              | **Engine-primary (Meili/OpenSearch) with bounded ILIKE fallback**                                                                                                                       |
| DA hot paths             | **Both**: scraper adds earned indexes AND the API unifies the two selectivity gates into one declarative policy                                                                         |
| Unification scope        | **Parliament + procurement only; ELI untouched.** Unification = shared building blocks + a best-practices standard written _after_ a proven good version; domain interfaces may diverge |

## 5. Proposed design

### 5.1 The filter model: one spec, richer primitives, explicit cost classes

Extend `CollectionFilterSpec` so the predicates that today live as hand-written "virtuals" become declarative. Sketch (names indicative):

```ts
type PredicateSpec =
  | { kind: 'column'; ... }                          // existing ops
  | { kind: 'foldedText'; columns: ColumnRef[];      // diacritic-folded ILIKE across columns
      minLen: number; maxLen: number }
  | { kind: 'anyOf'; over: PredicateSpec[] }         // OR-across-columns/predicates
  | { kind: 'exists'; table: string; localKey: string; foreignKey: string;
      where?: PredicateSpec[] }                      // EXISTS / semijoin (bill_act_links, speech_texts…)
  | { kind: 'enumBucket'; column: ColumnRef;         // JSON attrs → enum vocab (bill status/type)
      buckets: Record<string, SqlPattern> }
  | { kind: 'codeRange'; column: ColumnRef;          // index-safe prefix→range (CPV '33' → ['33000000','34000000'))
      widthRule: CodeRangeRule }
  | { kind: 'canonicalScope'; flagColumn: ColumnRef; // is_canonical default + includeDuplicates opt-out
      optOutField?: string };
```

Each field also declares a **cost class**, and the spec carries one **bound policy** per collection:

```ts
type CostClass = 'indexed' | 'selective' | 'residual'; // residual = only legal when riding a bound
interface BoundPolicy {
  requireOneOf: FieldName[][]; // e.g. [['authorityCui'],['supplierCui'],['dateWindow<=366d']]
  maxWindowDays?: number;
  onUnbounded: 'reject' | 'degrade'; // degrade = e.g. drop FULL_TEXT depth, cap window
}
```

Why this matters: P1/P2 happened because bound rules were duplicated per surface and index assumptions lived only in code comments. With cost classes + one bound policy on the spec, **both** the cursor and offset surfaces compile the same gate (fixes the divergence permanently), error messages can say _which_ bound to add, and the capability gate (`filter_answers_allowed` etc.) plugs in as just another input to the same policy evaluation.

What stays out of the kernel: genuinely domain-specific logic (vote cohesion, act lineage, grain-quality semantics) stays in module repos. The kernel gains predicate vocabulary, not domain knowledge.

### 5.2 The analytical query: scope → answers

The owner's target query — _company × institution × period → count, total, trend_ — is served today by `org_edge_monthly_rollups` (8.2M rows, indexed by authority/supplier/region + month) and its CPV-division siblings. The design formalizes this as a two-part contract, generalizing procurement's existing `ProcurementScopeFilter`:

- **Scope** = the filterable dimensions that all answer shapes share (entity pair, period, territory, category, grain, canonical policy). Compiled once by the kernel; hashed once (`fhash`) for cursors and cache keys.
- **Answer shapes** over a scope: `list` (facts, cursor/offset), `stats` (count + sum + first/last), `series` (monthly buckets — the chart feed), `breakdown` (top-N by one dimension), `facets` (distinct values + counts for UI). Each shape declares which read model answers it: facts tables for `list`, rollup MVs for everything aggregate, engine for `q`-driven lists. The capability gate arbitrates per grain (spend answers already correctly blocked for contracts).

Parliament gets the same shape vocabulary on its own dimensions (member/group/chamber/legislature/period): `list` bills/votes/speeches, `stats`/`series` for activity heatmaps (which the client already builds today from per-year loops), `facets` to replace the client's 500-row fan-out derivations.

This is exactly the "different interfaces per domain, shared building blocks" split the owner asked for: scope compilation, bound policy, hashing, caching, capped counts, and answer-shape plumbing are kernel blocks; each domain declares its own dimensions and read models.

### 5.3 Counts and totals

- Lists: keep capped counts (10k + `totalEstimated`) everywhere; keep the concurrent count-with-degrade pattern (measured harmless at 266ms worst realistic case).
- `procurementStats` (P3): replace the exact procedures count with either (a) a capped count through the same `cappedCount` helper, or (b) inclusion in the scope cache with its own short TTL — **not** keyed on the gate watermark (the count reads base tables, not MVs, so gate-keying would serve stale counts after loads). Recommendation: (a) for correctness plus (b) for latency; entity scopes become cacheable once the count is capped.
- Aggregate stats/series read MVs only (unchanged rule).

### 5.4 Text search (engine-primary)

- `q` on bills, votes titles, procurement titles/names routes to the engines: query Meili/OS with the folded term + scope pre-filters where the index carries them (`cuis`, `doc_date`, `doc_type` exist in `search.documents` and the unified indexes), take top-K ids, join ids back into SQL for authoritative filtering/sorting/pagination. Cursor identity: fhash covers `q` + engine generation marker so cursors reset cleanly on reindex.
- Keep the current bounded folded-ILIKE as the down-path (it is measured-fine on parliament tables and anchored procurement queries; the existing `searchEngineUp` bound-relaxation logic inverts into "engine down → bounds required", which is what the code already does).
- Prerequisite plumbing: the API needs read access to the unified indexes (today only the `entities` Meili index is wired), and the 03:40 `entities-search-sync` freshness becomes part of the answer contract (surface `indexedAt` next to `dataFreshness`, which the client already displays).
- Open item (probe blocked): Meilisearch index inventory could not be listed (no valid API key in the non-secret env used; only OpenSearch was inventoried). Before implementation, confirm which engine hosts which unified index and its update cadence.

### 5.5 Read models and indexes (scraper repo changes)

Earned by measurement, satisfying the "indexes are earned" bar:

1. `direct_acquisitions (cpv_code, finalization_date DESC NULLS LAST, da_id DESC) WHERE is_canonical` — kills P1 (16.9s → index-order scan). Estimated ~1.5–2GB.
2. Restore `das_unique_code_idx` (or the API drops the filter — but P2 exists because the two repos disagreed silently; the design adds the index _and_ the contract test below). ~400MB.
3. **Contract manifest:** a small checked-in artifact (per collection: required indexes, expected MV names, capability columns) that the API validates at startup/health and the scraper CI validates before dropping anything. P2 is the proof this is needed: "unused" was measured from the DB's `idx_scan`, but the consumer's _intent_ lived in another repo. (The `das_unique_code_idx` had `idx_scan` counts near zero precisely because the API path seq-scanned instead of using it — absence of scans is not absence of need.)
4. MV refresh (P4): move aggregate-filter MV refresh into a committed cron (daily, after the 01:10 load lanes), switch to `REFRESH MATERIALIZED VIEW CONCURRENTLY` (all five MVs already have the required unique indexes), and stamp the gate's `refreshed_at` — which automatically invalidates the API's scope cache. No API change needed beyond surfacing freshness.
5. Speeches: no new index (skip scan measured at 149ms); revisit only if volume grows ~5×.

### 5.6 Client: building blocks, then the standard

Generalize what parliament/procurement already do well into a shared kit (not a mandatory module): URL-state writer hook, Zod param schemas with `.catch(undefined)`, operator-object builder helpers, capability-gate hook, debounced search input, active-filter chips. Add from the new server contract:

- **One resolve round trip:** `resolveFilter(dimensions[], terms[])` batched server-side (replaces N per-judet calls + `loadAllGroups()`).
- **Server facets** replace `pageSize:500` fan-out derivations.
- **Series/stats shapes** replace per-year client loops for heatmaps and enable the entity-pair dashboard (count + total + trend chart) directly.
- Ballot pagination stays parent-bound; raise the page cap server-side (200 → 500) so the common vote detail is one request instead of three, keeping the hard cap.

The **standard** (the "guide" the owner asked for) is written after the procurement implementation proves the model, as `docs/server-redesign/filtering-standard.md`: dimension naming, cost classes, bound-policy patterns, count semantics, facet/series shapes, URL conventions, capability gating, and when a domain may deviate.

## 6. Options considered and trade-offs

**Composition** — (a) extend kernel spec ✅ chosen; (b) keep repo-level virtuals: cheapest now, but the three repos keep drifting and every new dataset re-implements folding/gates/counts (this drift already produced P1's dual gates); (c) standalone predicate library without spec integration: avoids kernel coupling but leaves gates and count semantics as conventions rather than enforced properties.

**Text search** — (a) engine-primary + ILIKE fallback ✅ chosen: best capability, engines already populated; costs id-join plumbing and freshness coupling; (b) Postgres FTS/pg_trgm: one system, but violates the scraper's no-FTS-in-PG philosophy, adds multi-GB indexes on the 24GB table, weaker relevance; (c) status quo with tighter bounds: zero cost, permanently primitive search.

**DA hot paths** — (a) indexes + unified gate ✅ chosen; (b) gates only: no scraper work but CPV browsing stays impossible (product regression); (c) indexes only: unblocks queries but leaves the gate divergence that shipped a 16.9s query.

**Counts** — capped everywhere vs exact: exact counts on 26.5M-row facts are incompatible with the 15s budget under composition; capped+estimated is already the norm on every other surface; P3 is the last exact holdout. Chosen: capped (with TTL cache), recorded as recommendation (not separately user-decided; follows from the module's own invariant).

**Pagination** — keep the current split (cursor for MCP/feeds, offset for numbered search grids). No measured problem; revisiting would churn the client for no evidence. _Provisional — not explicitly user-decided._

## 7. Incremental path (no breaking of current links)

1. **Stop the bleeding (API-only, days):** unify the DA gates behind one policy (cursor surface adopts CUI-or-window rule); disable `uniqueCode` filtering until its index returns; cap + cache `countProceduresInScope`.
2. **Scraper wave:** committed MV-refresh cron with CONCURRENTLY; the two DA indexes; contract manifest + CI check. (Also: agenda-loader seq-scan ticket, HHI No-Float fix in API.)
3. **Kernel wave:** predicate primitives + cost classes + bound policy; procurement migrates first (its specs are smaller and its gates are the proof case); parliament follows.
4. **Analytics wave:** scope/answer-shape contract (`stats`/`series`/`breakdown`/`facets`) on procurement — this delivers the owner's entity-pair query with charts; then parliament activity shapes.
5. **Search wave:** engine-primary q behind a flag, ILIKE fallback retained; confirm Meili/OS index ownership first.
6. **Client wave:** shared kit + batched resolve + server facets; then the entity-pair dashboard.
7. **Write the standard** after wave 4–5 ship and are validated.

Each wave is independently shippable; waves 1–2 are pure wins with no interface change.

## 8. Risks and unresolved questions

- **Meili inventory unprobed** (no key in non-secret env): confirm engine/index ownership and doc freshness before the search wave. Also confirm whether `unified_contracts` includes DAs or only contracts/procedures (5.9M docs vs 26.5M DA rows suggests partial coverage — if DAs are absent, engine-primary q for DAs needs an indexing decision in the scraper).
- **Growth rate** (+56% DAs in a month): re-run the S2/S3 probes after the indexes land; the contract manifest should include probe queries as regression checks.
- **MV refresh duration under CONCURRENTLY** is slower than non-concurrent; measure on the 9.2M-row supplier rollup before committing to daily cadence (fallback: refresh the two big MVs weekly, the gate + small MVs daily).
- **Pool budget:** one stats request currently fans out to ~5 statements on a 15-connection pool shared by all redesign modules; the answer-shape design should set a per-request statement budget (provisional: ≤4).
- **Cursor stability across spec migration:** fhash changes when filters are recanonicalized; ship a cursor-version bump with "restart pagination" behavior (the envelope already supports it).
- Pagination model and count semantics were adopted as recommendations without an explicit owner decision — flagged provisional (§6).

---

## Appendix A — Probe evidence (griffin prod, 2026-07-12, read-only session)

Environment: PG 18.4, `work_mem=32MB`, `effective_cache_size=48GB`, `random_page_cost=1.1`. Sizes: `search.documents` 31GB/15.6M rows; `flows.money_flows` 26GB/25.1M; `procurement.direct_acquisitions` 24GB/26.5M; `contracts` 4.6GB/3.27M; `procedures` 781MB/622k; `parliament.speeches` 1.5GB/1.04M (+`speech_texts` 741MB/1.4M); `vote_records` 662MB/3.76M; `bills` 108MB/45k.

**P1 — DA cpvDivision '33', cursor-shape list (LIMIT 101):**

```
Limit (actual time=16625..16953 rows=101)
  Buffers: shared hit=141137 read=1232470
  -> Gather Merge -> Sort (top-N heapsort, 125kB)
     -> Parallel Bitmap Heap Scan on direct_acquisitions
          rows=948554/worker  Rows Removed by Index Recheck: 3202504
          Heap Blocks: exact=105966 lossy=365755   [work_mem-bound lossy bitmap]
          -> Bitmap Index Scan on das_cpv_code_idx (rows=3478823)
Execution Time: 16972.746 ms
```

**P2 — DA unique_code = 'DA38938739' (real value):**

```
-> Parallel Seq Scan on direct_acquisitions
     Filter: (is_canonical AND unique_code='DA38938739')
     Rows Removed by Filter: 8854221/worker   Buffers: hit=1119673 read=1181396
Execution Time: 7219.158 ms      [index dropped 2026-07-07: drop_unused_da_index]
```

**P3 — countProceduresInScope:** empty scope 345ms (parallel index-only scan, 134k buffers); cpv '33' 50ms; 2024 window 9.4ms; supplier '9311280' semijoin **1297ms** (bitmap 117k index rows → 61k heap blocks → hash semijoin 5,777 procedures).

**P4 — freshness:** `aggregate_quality_by_grain.refreshed_at = 2026-06-29 07:26`; `etl.load_runs` shows public-contracts flows load succeeded 2026-07-12 07:07 (13-day MV drift). Gate: DA `filter_answers_allowed=t, spend_rankings_allowed=t`; contracts spend blocked (amount coverage 0.810 < threshold); supplier-region blocked v1 (both grains).

**P5 — bills residual status filter:** Seq Scan 45,964 rows → 6,424 match → top-20; 77ms; 13k buffers. `pg_stat_user_tables`: bills 228,382 seq scans / 9.23B tuples read cumulative.

**Closed suspects:** members q 6.0ms; votes q (chamber+2025) 14.3ms; speeches 366-day window 149ms — `Index Scan using speeches_mandate_idx ... Index Searches: 431` (PG18 skip scan); HHI worst authority ('1590120', 7,533 suppliers) 71ms; cappedCount authority 109ms, +rare-ILIKE 266ms; empty-scope MV stats 1450/985/1240ms.

**Index inventory (S0.2, decisive facts):** `direct_acquisitions` has only single-column btrees (authority_cui, supplier_cui, cpv_code, finalization_date) + `da_key`/`da_id` uniques + partial `das_flow_staleness_idx` — **no unique_code, no composite**. `speeches` has only `(mandate_key, spoken_at DESC)` + pkey. Traffic: `das_flow_staleness_idx` idx_scan=799M (ETL), `da_key` 298M; `das_cpv_code_idx` idx_scan=21 (essentially unused — it cannot serve the sorted list pattern).

**OpenSearch inventory:** `unified_contracts` 5,947,452 docs / 5.4GB; `unified_parliament` 183,398 / 98.5MB; `unified_legal` 3.16M; `unified_monitorul` 57.6k; `unified_pnrr` 71.7k. Meilisearch: not inventoried (no API key available in non-secret env) — **remaining probe**.

**Scraper-side pipeline flag:** `parliament.sitting_agenda_item_documents` — 205,046 seq scans / 260.5B tuples read (source: `prod-agenda-port.ts` / `validate-prod.ts` loops), plus `procurement.procedure_lots/addresses/cpv_codes/award_criteria` each ~3.1k seq scans (detail loaders). ETL-side; not on the API request path.

Raw probe outputs preserved in the investigation session scratchpad (`probes/s0-catalog.out`, `s1-s3.out`, `s2b.out`, `s3b.out`, `s4-s7.out`).
