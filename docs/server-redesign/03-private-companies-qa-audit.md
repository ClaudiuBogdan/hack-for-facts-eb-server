# Private Companies Module — Data-Accuracy & API Audit

> **Status:** Findings report (read-only audit — no code changed)
> **Date:** 2026-06-20
> **Scope:** Companies GraphQL (`/api/v1/graphql`) + MCP (`/api/v1/mcp`) surfaces on the redesign server. No REST surface exists (GraphQL+MCP only).
> **Target env:** `localhost:3001` (postgres `ok`, meilisearch `ok`, opensearch `ok`).
> **Companion design doc:** [`03-private-companies.md`](./03-private-companies.md)
> **Data origin:** ONRC (registry: identity, status, registration, representatives, authorized CAEN, EU branches, address) + ANAF (fiscal status via TVA endpoint + bilanț financial statements). Cross-module public money flows in via the kernel `FlowsRepo` (payee/`in` direction). Several findings trace to the scrapper / source registries, not this server.

---

## 0. Method

A team of **7 specialist agents** ran in parallel (one re-deployed after cancellation), each owning one analytical angle, with mandatory cross-checking between adjacent areas. ~620 GraphQL + ~80 MCP requests at production scale:

| Dimension audited                                | Scale                         |
| ------------------------------------------------ | ----------------------------- |
| Distinct companies profiled (full + list)        | ~2,830                        |
| Financial years analysed                         | ~1,000+                       |
| Companies in trajectory math re-derivation       | 351 multi-year                |
| Public-money companies (DEDEMAN anchor + sample) | ~150                          |
| List pages walked (pagination stress)            | 13 pages / 0 dupes            |
| MCP tools × parity checks                        | 5 tools × 6 CUIs (120 fields) |

The 12 core techniques: cross-fetch entity-360°, bidirectional cardinality, multi-source reconciliation (ONRC vs ANAF), mathematical-invariant re-derivation (trajectory deltas with `Decimal`), filter op / virtual-field verification, cursor pagination stress, commutativity/exhaustiveness, aggregate sum-vs-denominator, error-propagation matrix, MCP↔GraphQL parity, statistical-outlier/duplicate detection, freshness/asOf sanity.

**Self-validation:** the three headline bugs (CAEN_DIVISION crash, `netResultDelta` formula, `byYear.year` null) were independently re-verified by the coordinator after the run. One earlier scrapper-research claim ("financials predate registration" = 3,119 cases) was explained by a discovered bulk-corruption event. One claimed outlier (5B employees) was **not reproducible** and retracted.

---

## 1. Executive summary

- **~30 distinct bugs** found: **4 CRITICAL, ~7 HIGH, ~12 MED, ~4 LOW**.
- **~10 data-quality issues** (non-bug but actionable).
- **~50 integrity tests PASSED**, establishing a solid baseline.
- Three coherent bug clusters dominate:
  1. **The `CAEN_DIVISION` aggregate cluster (C1–C4)** — the entire `groupBy:CAEN_DIVISION` path is broken (crashes on `eq`, silently bypasses `prefix`, crashes unfiltered), and the CAEN resolve dim is mis-wired to fuzzy text search. This is the most user-visible breakage.
  2. **The non-null error-propagation cluster (H2)** — every NON_NULL root field (`companies`, `companyCountyProfile`, `companyResolve`) nullifies the **entire** GraphQL `data` on any error (10/10 conditions). MCP is immune (11/11 HTTP 200), proving the resolver _can_ return a Result — GraphQL just doesn't expose it.
  3. **The public-money contract cluster (H4, M5)** — `byYear[].year` is 100% null (breakdown is actually by `flowType`), `topPayers` come from a foreign registry (54% aren't companies), and the field name/type is a documented-vs-impl lie.
- The spine identity contract is **bulletproof** (0 duplicate CUIs across 2,833 rows; 0 dup `(cui,year)`; entity-360 byte-identical 15/15), so the problems are concentrated in **derivations, cross-source joins, and the CAEN/aggregation surface**.

---

## 2. CRITICAL

### C1 — `groupBy:CAEN_DIVISION` + `caenCode.eq` → INTERNAL_SERVER_ERROR

**Severity:** CRITICAL · **Area:** aggregate · **Origin:** server (`companies-repo.ts:594-595` aliasing)

Combining `groupBy:CAEN_DIVISION` with `filter:{caenCode:{eq:"X"}}` throws `INTERNAL_SERVER_ERROR` (`"countBy failed"`, `type:Database`) for every `eq` value that has matching companies (6201, 4752, 6202, 6209, 7022). When the code has no matches (`eq:"9999"`) it returns 0 cleanly — the crash is data-dependent on the EXISTS subquery returning rows. The same filter + `STATUS`/`COUNTY` groupBy works fine (denom=86,102).

**Repro (independently re-verified):**

```graphql
{
  good: company(cui: "2816464") {
    cui
  }
  bad: companyCountyProfile(filter: { caenCode: { eq: "6201" } }, groupBy: CAEN_DIVISION) {
    groups {
      key
      count
    }
  }
}
```

→ `{"data":null,"errors":[{"message":"countBy failed","extensions":{"code":"INTERNAL_SERVER_ERROR","type":"Database"}}]}` (note: the sibling `good` field is also wiped — see H2).

**Cause:** the EXISTS subquery in the CAEN_DIVISION branch references the `cad` (division join) alias instead of `ca` (activities join), causing an ambiguous-column error when the outer filter also uses `ca`. The in-code comment at `companies-repo.ts:594-595` claims this was fixed — it was not (regressed or never landed).

### C2 — `groupBy:CAEN_DIVISION` silently bypasses `caenCode.prefix` filter

**Severity:** CRITICAL (silent wrong answers) · **Area:** aggregate · **Origin:** server

With `filter:{caenCode:{prefix:"62"}}` + `groupBy:CAEN_DIVISION`, the filter is **ignored** — the query returns ALL 92 divisions and a denominator of **1,198,063** (essentially the whole CAEN universe), instead of the filtered subset of 198,072 companies with a `62xx` CAEN activity. No error signal. The most dangerous bug in the set — confident-looking wrong numbers.

### C3 — `groupBy:CAEN_DIVISION` with NO filter crashes

**Severity:** CRITICAL · **Area:** aggregate · **Origin:** server

Per the schema docs, `STATUS`/`CAEN_DIVISION` do not require a driver filter. `STATUS` works unfiltered (denom=3,985,167 = canonical spine). But `CAEN_DIVISION` unfiltered throws `countBy failed / INTERNAL_SERVER_ERROR`. Either it should be gated (like COUNTY) or ungated (like STATUS); crashing is the worst of both worlds.

### C4 — `companyResolve(dim:CAEN)` does fuzzy text search, not CAEN resolution

**Severity:** CRITICAL · **Area:** resolve · **Origin:** server

The CAEN dim is documented as "prefix/division resolution". In reality it does **fuzzy full-text search on the Romanian label** (likely Meili), with no CAEN-code semantics. `q:"6201"` → 0 results; `q:""` → 50; `q:"6"` → codes that don't start with 6 (0101, 1010…). Returned hits have `cui:null` (dictionary entries, not companies) and include mislabeled dictionary entries and duplicates.

---

## 3. HIGH severity

### H1 — `trajectory.netResultDelta` ignores `netLoss` (42% of deltas misleading)

**Severity:** HIGH · **Area:** financials · **Origin:** server (`core/usecases.ts` trajectory builder)

The field is named `netResultDelta` (financial "net result" = profit − loss, the bottom line), but the value served is `latest.netProfit − prev.netProfit` — `netLoss` is dropped from the formula. Produces materially wrong deltas for any company that swings between profit and loss.

**Evidence (independently re-verified, CUI 10012185, 2023→2024):**

- returned `netResultDelta` = `5,931,214.00` == recomputed netProfit-only delta ✓
- true bottom-line (profit−loss) delta = `10,615,089.00` → **off by 80%**
- Across 351 multi-year companies: **147 (41.9%)** have a misleading `netResultDelta`. `turnoverDelta` and `employeesDelta` are clean (0/351).

**Fix:** one-liner — compute `(netProfit − netLoss)` per year before differencing.

### H2 — Non-null error propagation nullifies entire GraphQL queries (systemic)

**Severity:** HIGH (systemic) · **Area:** GraphQL contract · **Origin:** server

Every NON_NULL root field (`companies`, `companyCountyProfile`, `companyResolve`) nullifies the **entire `data` object** on any error. Tested **10/10 conditions** (bad `in:[]`, garbage cursor, invalid enum, missing arg, type coercion, the CAEN_DIVISION crashes, the county gate) — all collapse `data` to `null`, including healthy sibling fields.

**The proof it's avoidable:** MCP never propagates — all 11 error cases return HTTP 200 `{ok:false, error}`. The resolver _can_ return a Result; GraphQL just doesn't expose it. Nullable `company(cui)` correctly field-isolates (contrast row). This is the same defect class as parliament's H2.

### H3 — `registrationDate` bulk-corrupted for a mid-2024 re-registration cohort

**Severity:** HIGH · **Area:** data quality (identity) · **Origin:** scrapper / ONRC migration

Across specific 2–4 day windows in mid-2024, ONRC re-assigned `registrationDate` to the migration date for **thousands of pre-existing companies** (probed cohort: 2,646 across three windows; 2024-07-15/16: 1,232; 2024-07-17/18: 899; 2024-06-17: 515). These companies carry ANAF financial statements for years **before** the newly-written `registrationDate` — **94% (47/50)** of the 2024-07-17 cohort have `min(financials[].year) < year(registrationDate)`.

**Impact:** "age of company" analytics are wrong for thousands of companies (appear ~2 years younger); the 3,119 "financials predate registration" cases flagged by scrapper research trace to this event; "registered in 2024" filters are polluted. The back-dated financials may belong to a legally distinct prior entity (CUI reuse post-radiation).

**Fix:** expose `originalRegistrationDate`/`incorporationDate` or a `registrationDateCorrupted` flag for the cohort.

### H4 — `CompanyPublicMoney.byYear[].year` is 100% null; breakdown is actually by flowType

**Severity:** HIGH · **Area:** public money · **Origin:** server (`core/usecases.ts:156`)

`byYear[]` is documented/shaped as a per-year breakdown (`year: Int, flowType, totalRon, count`), but (a) `year` is **always null** (22/22 entries across 19 companies; independently re-verified on DEDEMAN: 3 buckets, all `year:null`) and (b) each element groups by **flowType**, not year. The array name, element type name, and `year` field are all three misleading.

**The data exists upstream:** `Entity.flowsIn` serves `minYear`/`maxYear` and a `byFlowType[]` breakdown. The flows pipeline has the year; `Company.publicMoney.byYear` simply drops it — a propagation bug, not missing source.

**DEDEMAN flowTypes:** `direct_acquisition` (1.79B RON), `procurement_contract`, `pnrr_subcontract`. Fix: populate `year` (group by `(year, flowType)`) or rename `byYear`→`byFlowType` and drop `year`.

### H5 — CUI `1` is a 632M RON public-money sink for unidentified payers

**Severity:** HIGH (data-integrity) · **Area:** public money / identity · **Origin:** scrapper (CUI collision)

CUI `1` — a **radiated** familial association (`fiscal=null`, no ANAF data) — reports **631,934,729.79 RON across 193 flows** as a payee, yet **97.5% (616M)** comes from unidentified/null-CUI payers excluded from `topPayers`. This is almost certainly a CUI-collision / sentinel-value artefact (`1` as a fallback payee id), not a real company receiving public money.

### H6 — MCP hides structured envelope fields under summary text

**Severity:** HIGH · **Area:** MCP contract · **Origin:** server

MCP returns correct row/group data bit-for-bit identical to GraphQL, but `totalCount`, `totalEstimated`, `denominator`, and `coverage` are **absent** from the MCP payload and only recoverable by parsing human-readable Romanian `summary` text. LLM agents cannot reliably distinguish capped vs exact totals (may confidently report "10000" when the true count is millions) and cannot verify the `Σgroups.count == denominator` invariant.

---

## 4. MEDIUM severity

| #       | Bug                                                              | Evidence / notes                                                                                                                                                                                                                                                                                   |
| ------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **M1**  | Same-CUI, completely different ONRC vs ANAF names                | 5 substantive cases / 119 (24.4% total mismatch). Worst: `46885059` ONRC `"0 COST ENERGY S.R.L."` vs ANAF `"SMARTER WAY DESIGN S.R.L."` (with financials 2023–2025) — likely CUI reuse/collision. 12/14 "different" cases are the systematic `AF` vs `ASOCIATIE FAMILIALĂ` abbreviation mismatch.  |
| **M2**  | `topPayers` come from a foreign registry                         | 54.2% of payer CUIs aren't companies (schools/ministries/municipalities → `company(cui:)` returns null); of those that are, 90.9% of names **differ** from `Company.name` (diacritics, `RO`+CUI prefixes, old abbreviations).                                                                      |
| **M3**  | `euBranches` is a dead/stub field                                | 0/120 profiles non-empty; targeted 6 obvious foreign _sucursale_ (SCOR SE PARIS, PARESA CESENA) — all `[]`. ONRC EUID table likely not loaded/joined.                                                                                                                                              |
| **M4**  | `matchConfidence:"UNMATCHED"` unreachable; territory atomic null | Enum has `SAFE                                                                                                                                                                                                                                                                                     | UNMATCHED`, but `UNMATCHED`is never emitted — on SIRUTA-miss the whole`territory`object is`null`(28.3% of companies), not`{…, matchConfidence:"UNMATCHED"}`. Callers can't distinguish "unmatched" from "no data". |
| **M5**  | `address.display` empty 78.3%                                    | When present, only a room/stand fragment (`"MANSARDA, CAMERA 3"`), never a full address. DEDEMAN itself is `""`. Misleading field name.                                                                                                                                                            |
| **M6**  | `CompanyFinancialYear.lines` serves Money as bare JSON integers  | Violates the Money-as-string precision contract: `lines["Creante"] = 69341056` (int) vs `summary.receivables = "69341056.00"` (string). Numerically equal today, but if ANAF ever publishes non-zero cents, `lines` will silently truncate while `summary` won't — divergence within one response. |
| **M7**  | Parallel-batch connection saturation                             | ≥6 concurrent `companies` resolvers (esp. with broad/`totalEstimated:true` filters) intermittently throw `listCompanies failed / Database`. Splitting into ≤5 selections always succeeds. Combined with H2, one slow query kills the whole batch.                                                  |
| **M8**  | `caenCode eq`/`prefix` timeouts on popular codes                 | Virtual EXISTS-over-`caen_activities` filter is 4–9s baseline for popular codes (4752, prefix 62); under DB load crosses the 15s `statement_timeout`. `mainCaenCode eq` (indexed) is instant for the same code. The most useful CAEN queries are effectively unusable.                             |
| **M9**  | `companyResolve(dim:REGNUM)` is case-sensitive                   | `j40/...` → `[]`; `J40/...` → hits. Registration numbers should resolve case-insensitively.                                                                                                                                                                                                        |
| **M10** | `confidence` exceeds 1.0 and is null for 3 of 4 dims             | Max observed 1.125; null for REGNUM/CAEN/COUNTY (only NAME carries confidence). `limit:0` returns 1 result (should be 0/reject).                                                                                                                                                                   |
| **M11** | `coverage.territoryMatched/Unmatched` always null                | Documented as the aggregate coverage signal; 100% null in practice.                                                                                                                                                                                                                                |
| **M12** | `entity(cui:)` vs `company(cui:)` validate CUI inconsistently    | `entity("-5")` → echoes `{cui:"5"}`; `company("-5")` → null/INVALID_INPUT. `entity()` accepts 19-digit CUIs; `company()` rejects them. The `CUI!` scalar should validate uniformly on both paths.                                                                                                  |
| **M13** | `matchConfidence` casing: GraphQL `"SAFE"` vs MCP `"safe"`       | GraphQL violates its own enum declaration (`safe                                                                                                                                                                                                                                                   | unmatched`); 6/6 CUIs diverge across surfaces.                                                                                                                                                                     |
| **M14** | MCP `resolve_company_filter` COUNTY dim returns plain strings    | GraphQL returns `{dim,value,label,cui,confidence}`; MCP returns `["Bacău"]`. Other 3 dims match — only COUNTY is structurally divergent in MCP.                                                                                                                                                    |
| **M15** | MCP error envelopes have 2 incompatible shapes                   | Schema-validation errors = plain text (no `structuredContent`); runtime errors = structured `{ok:false,error}`. Consumers branching on `structuredContent.ok` silently miss the validation category.                                                                                               |

---

## 5. LOW severity

- **CUI error semantics inconsistent:** `company(cui:)` rejects letters/empty with `INVALID_INPUT` but silently returns `null` for over-long/negative/`"0"`.
- **`vatPayer=true` AND `declaredFiscallyInactive=true`:** the two are independent flags (not complements); one company (`39550190`) carries both. Documented but surprising.
- **`publicMoney=null` (not zero-summary) when no flows:** undocumented binary contract; presence rate 9.5% (13/137).
- **Placeholder name:** CUI `41572620` is literally named `"$COMPANYNAME S.R.L."` (un-substituted template string); `q:"$COMPANYNAME"` returns nothing (`$` not Meili-tokenized).

---

## 6. Data-quality issues (non-bug, but actionable)

- **50.2% of the spine is radiated** (`status:1084`); only 43.7% `funcțiune` (`1048`). Consumers must filter `status:1048` for "active companies". 79 companies have null status code.
- **Name divergence 24.1%** — clustered: suffix-only 10.2%, punctuation 6.9%, "different" 4.2% (dominated by the systematic `AF`/`ASOCIATIE FAMILIALĂ` registry-convention mismatch, not random corruption).
- **CAEN conflict 11.6%** (ANAF main vs ONRC authorized set); 8 adjacent = revision mismatch, 10 cross-division. ~1,012,993 companies have NO ONRC CAEN (coverage gap).
- **Invalid `mainCaenCode`:** `9999` → ≥10,000 companies; `0000` → 2,043. Neither exists in CAEN Rev.4 (max 9900). ANAF sentinel/placeholder values leaking as real.
- **County Unicode:** names stored in legacy pre-2001 cedilla (`ş`/`ţ`) not modern comma-below (`ș`/`ț`) — the fold map must bridge both.
- **`caenActivities[]` not deduped** by code at API level (rev1/2/3 duplicates surface).
- **`q` tokenizer breaks on `.`:** `q:"S.R.L."` → 0 results; `q:"SRL"` → 50.
- **`summary` has 19 keys, not 20** (doc drift); `lines` has 20 (not the "221 indicators" the HOTSPOTS research claimed — off ~10×).
- **ANAF `asOf` variance** (05-18 / 05-19) is batch-ingestion timestamp, not per-filing freshness — harmless but undocumented.
- **Physics-violating balance-sheet values** (server-faithful to ANAF): 15 negative `cashAndBank`, 4 negative `receivables`, 1 negative each of `currentAssets`/`fixedAssets`; 163 negative `totalEquity` (legit insolvent).

---

## 7. Tests PASSED ✓ (proven-solid baselines)

These establish what works and should not be re-litigated without reason:

- **Spine identity 1:1:** 0 duplicate CUIs / orgIds / `codInmatriculare` across 2,833 rows; 0 duplicate `(cui,year)` financial rows.
- **Entity-360 parity:** `Entity.company` vs `company(cui)` byte-identical on shared fields **15/15**; `latestFinancial` matches 10/10.
- **MCP ↔ GraphQL data parity:** 119/120 spot-checked fields bit-for-bit identical across 5 tools × 6 CUIs.
- **Money precision:** 11,396 money string values, 100% two-decimal-place strings, zero float artifacts, zero comma-decimals.
- **Trajectory math (clean parts):** `turnoverDelta`/`employeesDelta` correct (0/351 mismatches); `latest.year == max(years)` always; no dup `(cui,year)`; no future years (max 2025).
- **Mutual exclusivity:** `netProfit > 0` AND `netLoss > 0` in same year → 0 violations / 518 records.
- **Filters:** all 11 fields × all ops correct; county diacritic fold works for all 10 diacritic counties (incl. cedilla↔comma-below); `hasFinancials`/`caenCode` virtual correctness anchor-verified.
- **Commutativity:** A∧B == B∧A, 5/5 pairs (CUI sets + totalCount identical).
- **`in:[]` rejection:** 6/6 fields correctly reject with `INVALID_INPUT` (rejectEmptyIn enforced).
- **Pagination:** 13-page walk — 0 duplicates, 0 gaps, sort stable across boundaries (100+100+16 == 216); 4/4 cursor tamper attacks rejected; stale cursor gracefully empty; estimated cap hits exactly 10000.
- **Public-money reconciliation:** `totalRon == ΣbyYear.totalRon` and `flowCount == ΣbyYear.count`, 19/19 companies Decimal-exact (spanning 2.2k → 1.8B RON).
- **MCP never propagates:** 11/11 error cases return HTTP 200 (contrast with GraphQL H2).
- **Privacy:** `is_active` not exposed under any of 6 probed names nor in 18 introspected `Company` fields; `lines`/`summary` carry only financial metrics; `CompanyRepresentative` is exactly `{name,role}`; `euBranches.fiscalCode` is exposed by design (foreign tax id).
- **Outliers clean:** turnover max 27.8B RON (Automobile-Dacia), employees max 12,313 (Dedeman); 0 negative turnover, 0 >10¹², 0 >1M employees; date extremes clean (0 pre-1950, 0 future, ONRC cutoff 2024-09-03 honored).

---

## 8. Cross-check corrections (the team validating itself)

- **5B-employees outlier RETRACTED** — the financials agent flagged a historically-noted 5,009,387,154 employees; the dataquality agent's 391-record scan found max 12,313 and could not reproduce it. Treated as non-reproducible single-row anomaly.
- **"Financials predate registration" EXPLAINED** — scrapper research cited 3,119 cases as a data-quality note; the dataquality agent traced it to the H3 bulk-corruption event (a mid-2024 ONRC re-registration migration), not scattered errors.
- **Name-divergence "different" bucket CLARIFIED** — 12/14 substantive name divergences are the systematic `AF`/`ASOCIATIE FAMILIALĂ` registry-convention mismatch, not random corruption; only 2 are truly unrelated (the worst being CUI `46885059`).
- **HOTSPOTS doc drift** — `summary` has 19 keys (not 20); `lines` has 20 (not 221). Corrected.

---

## 9. Fix priority

1. **C1–C4 + M8** — the CAEN aggregate/resolve cluster. Highest user-visible breakage (500s, silent wrong numbers, unusable resolve dim). Fix the `cad`/`ca` aliasing, gate or fix unfiltered CAEN_DIVISION, and wire `companyResolve(CAEN)` to actual code/prefix lookup. Add a covering index for popular `caenCode` (M8).
2. **H2** — make `companies`/`companyCountyProfile`/`companyResolve` nullable (or return in-band errors). Proven-safe pattern: nullable `company(cui)` + MCP's `{ok:false}` envelope. Same fix class as parliament H2.
3. **H1** — one-line fix to `netResultDelta` (include `netLoss`); add a unit test with a profit↔loss swing case.
4. **H4 + M2 + H5** — public-money contract: populate/rename `byYear.year`, resolve `topPayers` against `organizations.name`, and quarantine CUI `1`.
5. **H3** — expose `originalRegistrationDate` or a corruption flag for the mid-2024 cohort.
6. **M3, M4, M5, M11** — dead/stub fields (`euBranches`, `matchConfidence:UNMATCHED`, `address.display`, `coverage.*`): either wire or remove from the SDL.
7. **M13, M14, M15, H6** — MCP contract polish (enum casing, COUNTY shape, unified error envelope, expose structured totals).

---

## Appendix A — Bug register (compact)

| ID     | Sev      | Title                                                           | Area                  | Origin        |
| ------ | -------- | --------------------------------------------------------------- | --------------------- | ------------- |
| C1     | CRITICAL | `groupBy:CAEN_DIVISION` + `caenCode.eq` crashes                 | aggregate             | server        |
| C2     | CRITICAL | `groupBy:CAEN_DIVISION` bypasses `caenCode.prefix` (silent)     | aggregate             | server        |
| C3     | CRITICAL | `groupBy:CAEN_DIVISION` unfiltered crashes                      | aggregate             | server        |
| C4     | CRITICAL | `companyResolve(CAEN)` is fuzzy FTS, not code resolution        | resolve               | server        |
| H1     | HIGH     | `netResultDelta` ignores `netLoss` (42% misleading)             | financials            | server        |
| H2     | HIGH     | Non-null error propagation nukes whole query (10/10)            | contract              | server        |
| H3     | HIGH     | `registrationDate` bulk-corrupted (2,646 cohort)                | data quality          | scrapper/ONRC |
| H4     | HIGH     | `byYear[].year` 100% null (breakdown is flowType)               | public money          | server        |
| H5     | HIGH     | CUI `1` = 632M RON sink for unidentified payers                 | public money/identity | scrapper      |
| H6     | HIGH     | MCP hides `totalCount`/`denominator`/`coverage` in summary text | MCP contract          | server        |
| M1–M15 | MED      | see §4                                                          | various               | mixed         |
| L-\*   | LOW      | see §5                                                          | various               | mixed         |

## Appendix B — Reproducibility

All raw evidence (7 specialist reports + query files + JSON outputs) is retained in the audit workspace outside the repo. Key reproduction snippets are inline in each bug entry above. The GraphQL field names are verified via introspection (note divergences from the design doc: `CompanyEdge.node` is `CompanyListItem!`, `coverage` is typed `CompanyCoverage!` not `JSON!`, `Entity.company` returns `CompanyEntitySummary`).
