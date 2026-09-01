# 13 — Legacy roots on the kernel endpoint (`/graphql` → `/api/v1/graphql`)

> **Status:** DRAFT r1 (2026-09-02) — design for the user's fork decision C′:
> _"the goal is not to change the GraphQL interfaces for key data types, like the
> analytics filter, but the API endpoint can and should change to remove the
> legacy code and keep only the new codebase."_ Program of record:
> scrapper `prod-db/BUDGET_SERVING_REDESIGN_PROGRAM_2026-09-01.md` §2, §4 S1, §7.1.
> Evidence: scrapper `prod-db/evidence/budget-chronos-serving-2026-09-01/client-operation-inventory.md`
> (every client document, root, type and page, with file:line).
> Conforms to [`00-foundation-shared-kernel.md`](./00-foundation-shared-kernel.md).

## 0. Decision, in one paragraph

The legacy root operations the client sends (26 of the 40 legacy roots; 51 documents)
keep their **names, argument types and result shapes**, and are served from
**`/api/v1/graphql`** by the kernel modules over Chronos `transparenta_prod`. The
client migration is the URL plus the removal of the legacy transport
(`src/lib/api/graphql.ts`). When the golden-master replay (§6) is green for every
live document, the legacy `/graphql` endpoint, the ten legacy modules, `build-app.ts`,
the `budgetDb` / `insDb` pools and the Phoenix port-forwards are deleted. **No
Phoenix code survives; the key GraphQL types survive unchanged.**

## 1. What "unchanged" means, precisely

Client-visible surface (inventory §5), frozen:

- **Input types and enums by name and field:** `AnalyticsFilterInput`,
  `AnalyticsExcludeInput`, `AnalyticsInput`, `ReportPeriodInput`, `PeriodSelection`,
  `PeriodIntervalInput`, `PeriodType`, `PeriodDate` (scalar, by name),
  `Normalization`, `Currency`, `ReportType` (enum with the Romanian-literal value
  resolver), `AccountCategory`, `ExpenseType`, `SortOrder`, `EntityFilter`,
  `UATFilterInput`, `BudgetSectorFilterInput`, `FundingSourceFilterInput`, the two
  classification filters, every `Commitments*Input`, every `Ins*FilterInput`.
  **Only `@deprecated` markers may be added** (user constraint); additive fields
  are discussed one by one (program Appendix B).
- **Root names and signatures** as in inventory §4.
- **Result field names** (snake_case) and array order as the legacy resolvers emit
  them; `__typename` where the client reads it (`commitmentsSummary` union members).
- **Output type NAMES are not frozen** unless the client reads `__typename` or
  spreads a fragment on the name. Verified: only the `CommitmentsSummaryResult`
  union members are read by name. So a legacy output type may be renamed when it
  collides with a kernel type (§3), field names untouched.

Semantics frozen or deliberately changed — the **compatibility manifest** — is
program §2.2, decided as _"fix the bugs, document every difference"_: omitted
`report_type` sums all report types (kept); `[]` means "no filter" (kept — the
kernel's `in: []` → `false` must not apply on these roots); the five silently
ignored nested exclusions and `aggregate_min/max_amount` are **implemented** (a
documented delta); annual factor broadcast, composite normalizations, the
`percent_gdp` exclusivity and the growth rule keep the `legacy` normalization
policy (program D2); the 10,000-point cap stays and is logged.

## 2. Where each root lives (module ownership)

| Legacy root(s)                                                                                                                                                                                                                                                          | Served by                                                         | Over                                                   | Notes                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executionAnalytics`, `entityAnalytics`, `aggregatedLineItems`, `heatmapCountyData`, `heatmapUATData`, `budgetSectors`, `fundingSources`, `functionalClassifications`, `economicClassifications`, `commitmentsSummary`, `commitmentsAggregated`, `commitmentsAnalytics` | **`budget` module**, new slice `shell/graphql/legacy/`            | `budget.*` + `core.*`                                  | the module's usecases are the only data access; the slice is input/output mapping only                                                                                                        |
| `entities`, `uats`                                                                                                                                                                                                                                                      | **`reference` module**, new slice `shell/graphql/legacy/`         | `core.public_entities`, `core.territories` (D1)        | `Entity.uat{…}` and `entities(filter.search)` over the kernel identity/territory hubs                                                                                                         |
| `datasets`, `staticChartAnalytics`                                                                                                                                                                                                                                      | **`datasets` module** registered on the kernel (fs-backed, no DB) | YAML on disk                                           | not Phoenix code; kept as is, mounted on the kernel                                                                                                                                           |
| `insDatasets`, `insDataset`, `insDatasetDimensionValues`, `insTerritories`, `insContexts`, `insObservations`, `insUatDashboard`, `insLatestDatasetValues`                                                                                                               | **new `ins` kernel module** (program slice 3.2)                   | `ins.*` in Chronos + `ins.member_territory` → D1 spine | the legacy INS schema is TEMPO-star-shaped over the legacy INS DB; the Chronos `ins` schema is the panel-approved design, so this is a re-implementation, not a port — last in the order (§5) |
| `health`, `ready`, `entity`, `uat`, `report(s)`, `executionLineItem(s)`, `budgetSector`, `fundingSource`, `functionalClassification`, `economicClassification`, `insUatIndicators`, `insCompare`, `commitmentsLineItems`, `commitmentVsExecution`                       | **not ported**                                                    | —                                                      | never sent by the client (inventory §4); the last two are dead fetchers. Their removal is deliberate and recorded in the golden-master corpus (`status: "dead"`).                             |

## 3. Mounting on the kernel: collisions and the three rules

The kernel merge gate (`src/modules/shared/shell/graphql/merge.ts:127-154`) rejects a
slice that re-declares a kernel base type or a type another slice defines, and a
field two slices add to the same type. Three legacy names collide:

| Collision                                                                                                                                                                                          | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Query.budgetSectors` — legacy `budgetSectors(filter, limit, offset): BudgetSectorConnection!` vs redesign `budgetSectors(search, ids): [BudgetSector!]!` (`budget/shell/graphql/typedefs.ts:552`) | **the legacy signature wins** (client-used). The redesign root is renamed `budgetSectorCatalog` — it is a new-API root, no client uses it (inventory §2), so this is not a compatibility change. Same treatment for any other redesign root that collides later.                                                                                                                                                                                                                                                                                                     |
| `Query.health`, `Query.entity` — kernel base roots (`shared/typedefs.ts:246,248`)                                                                                                                  | legacy roots **not ported** (never sent).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `type Entity`, `type PageInfo` — kernel base types                                                                                                                                                 | legacy `entities` returns `LegacyEntity` (fields `cui name entity_type is_uat uat{…}` unchanged; no client reads `__typename` here). `PageInfo`: the legacy connections need `totalCount` and `hasPreviousPage`; the kernel `PageInfo` (`shared/typedefs.ts:16-19`) lacks them → **`extend type PageInfo { totalCount: Int, hasPreviousPage: Boolean }`** in the legacy slice (nullable on the type; the legacy resolvers always populate them; kernel connections leave them null). Per-module `PageInfo` clones (`EntityAnalyticsPageInfo` etc.) keep their names. |

Rules for the legacy slices:

1. **Byte-identical SDL for the frozen types.** The legacy SDL strings move from the
   legacy modules into the owning kernel module's `shell/graphql/legacy/typedefs.ts`
   unchanged, minus the roots not ported and plus the three collision resolutions
   above. A CI test prints the legacy SDL before (from git history of the deleted
   module files, pinned as a fixture) and after, and asserts the only differences
   are the removed roots, the two collision renames and `@deprecated` additions.
2. **Thin resolvers.** A legacy resolver only (a) maps legacy args → the module's
   typed query (`AnalyticsFilterInput` → the budget filter spec + the `legacy`
   normalization policy), (b) calls the same usecase the `budget*` roots call, (c)
   maps the view model → the legacy result shape. **No SQL in the slice.** Where a
   legacy root needs a query shape the module lacks (e.g. `executionAnalytics`'s
   multi-year, multi-report-type, single-account-category aggregate with the
   `legacy` normalization policy), the module gains a **usecase**, not the slice.
3. **The two paths stay distinct.** `executionAnalytics` is a fact-path aggregate
   (`budget.execution_line_items`, pruning triple per period year, all report
   types when omitted); it may route to the summary MVs **only** when the request's
   exclusion set equals the set baked into the MVs (program §1.11). The rankings
   (`entityAnalytics`) and heatmaps read the MVs with the creditor collapse (BR-002)
   applied before ordering.

## 4. Per-root implementation notes (budget module)

| Root                                                                                      | Usecase (existing → needed)                                                                                                                                                                            | Mapping notes                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executionAnalytics(inputs)`                                                              | new `legacyExecutionSeries(inputs)` over the fact aggregate + SQL-level `legacy` normalization (D2 tables; until D2 lands, the module's embedded factor table is the interim source, labelled as such) | one series per input in input order; first error aborts the batch; `seriesId ?? 'default'`; `xAxis` per `PeriodType`; `yAxis` precedence growth → % GDP → currency/per-capita/real; sparse labels `YYYY` / `YYYY-QN` / `YYYY-MM`; growth after normalization, `0` for first/missing/zero predecessor; per-capita by one filter-wide population (legacy policy); 10,000-point cap logged |
| `entityAnalytics(filter, sort, limit, offset)`                                            | `rankEntities` + exact `totalCount` on the MV path (program S5, foundation §14.4 amendment)                                                                                                            | offset paging; `SortOrder{by, order}`; rows `entity_cui entity_name entity_type uat_id county_code county_name population amount total_amount per_capita_amount`; `uat_id` = `core.territories.id` (unchanged contract)                                                                                                                                                                 |
| `aggregatedLineItems(filter, limit, offset)`                                              | `aggregateByClassification` + `count`                                                                                                                                                                  | client aliases (`fn_c` …) are selection aliases — nothing to do server-side; `count` = line count                                                                                                                                                                                                                                                                                       |
| `heatmapCountyData` / `heatmapUATData`                                                    | `countyHeatmap` / `uatHeatmap` → after D1: one `territoryAggregate(level)`                                                                                                                             | snake_case fields; `county_entity{cui name}` resolved from the county node (D1), not a loader                                                                                                                                                                                                                                                                                           |
| `budgetSectors`, `fundingSources`, `functionalClassifications`, `economicClassifications` | dimension usecases                                                                                                                                                                                     | connections with the legacy `PageInfo` clones; `sector_id`/`source_id` as `ID` strings; `fundingSources.source_id` keeps the phoenix-ordinal compat view (D5) until `funding_source_codes` is approved                                                                                                                                                                                  |
| `commitmentsSummary` (union), `commitmentsAggregated`, `commitmentsAnalytics`             | commitment summary/timeseries usecases + a new aggregated usecase                                                                                                                                      | the union member `__typename`s are read by the client and are frozen; `exclude_transfers: Boolean = true` keeps its default                                                                                                                                                                                                                                                             |

## 5. Order and gates

1. **Harness first** (being built): `tests/golden-master` gains a baseline/target
   dual-endpoint mode, full-envelope capture (`errors[]` too), the classifier
   (contract-break / data-parity / rounding), and the corpus of the 51 client
   documents with realistic variables (inventory §7).
2. **Budget roots** (this doc §4) → replay → fix until zero contract breaks and every
   data-parity delta is explained per root (Phoenix vs Chronos data is the F0
   successor; a delta on `aggregatedLineItems`, heatmaps or `entityAnalytics` is
   structural until explained).
3. **Reference roots** (`entities`, `uats`) after D1 lands.
4. **`datasets`** mounted on the kernel (mechanical).
5. **INS** module (program slice 3.2) — the largest re-implementation; the
   statistici pages are the last to move.
6. **Client**: switch the legacy transport's base path to `/api/v1/graphql`
   (`src/lib/api/graphql.ts`), fix the four documents that are invalid today
   (`UatNames`, `BudgetSectorNames`, `FundingSourceNames` — `[String!]` in an
   `[ID!]` position; `GetDatasets` selects a non-existent `data` field), delete the
   `VITE_API_MODE` gate and its four hidden sections.
7. **Retire**: delete the legacy modules, `build-app.ts` → the composition root
   (program S7), the Phoenix pools and envs, the `REDESIGN_SURFACE_ENABLED` bridge;
   G0 (fix all known data defects) gates the prod release, not the code.

## 6. What the golden master must prove (acceptance)

- Every `status: "live"` document: identical `data` key set (aliases included),
  identical array order, identical `__typename` where selected, identical
  `pageInfo`, numbers equal at 2 dp with every exact difference listed; **no new
  `errors[]`**.
- Every `status: "invalid-today"` document: the same error envelope on both
  endpoints until the client fix ships, then valid on the new endpoint only.
- Every intentional delta from the compatibility manifest (§1) appears in the
  parity allowlist with a reason and before/after numbers.
- The replay runs against both the browser base URL and `INTERNAL_API_URL` (SSR).
