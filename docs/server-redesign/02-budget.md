# 02 — Budget module (`budget-official` + `anaf-extranet`)

> **Conforms to** [`00-foundation-shared-kernel.md`](./00-foundation-shared-kernel.md)
> (the binding contract). Where a section number is cited (e.g. §14.10) it refers
> to that document. This is the **largest and most performance-critical** module:
> `budget.execution_line_items` ≈ **126.8M rows** across 298 partitions,
> `budget.commitment_line_items` ≈ **32.6M rows**, plus six summary MVs and a
> `budget_staging` recompute schema (not API-facing).
>
> **Design inputs reconciled:** `prod-db/BUDGET_SERVING_DESIGN.md`,
> `prod-db/BUDGET_NOTES.md`, `prod-db/BUDGET_MIGRATION_INVESTIGATION.md`, the
> scrapper prod-migrations (`20260612T1101..1104`, `20260612T120000`), the live
> `\d+` introspection on griffin (partition tree + leaf indexes verified
> 2026-06-16), and the legacy GraphQL modules being consolidated
> (`execution-line-items`, `aggregated-line-items`, `commitments`,
> `execution-analytics`, `entity`'s `entity-analytics-repo`, `county-analytics`,
> `budget-sector`, `funding-sources`, `classification`, `report`) plus the legacy
> filter DSL (`src/infra/database/query-filters/`). This module **supersedes all
> of those** (§11).

---

## 0. Partition / rollup scheme (REQUIRED — §3, §14.10)

This subsection is the load-bearing performance contract. **Every list/aggregate
endpoint below cites the pruning predicate it relies on.** Verified live on
griffin 2026-06-16 against `pg_inherits` + `pg_indexes`; matches
`20260612T110200__budget_facts.ts` exactly.

### 0.1 Parent tables, partition keys, child naming

| Parent | Partition strategy | Child naming (verified live) | Levels |
|--------|--------------------|------------------------------|--------|
| `budget.execution_line_items` | **RANGE(`reporting_year`) → LIST(`report_type`) → LIST(`account_category`)** | `…_y2016` … `…_y2030` + `…_default`; under each year: `…_y2025_rt1` / `_rt2` / `_rt3` + `…_y2025_default`; under each year×rt: `…_y2025_rt1_vn` / `_ch` + `…_y2025_rt1_default` | **3** |
| `budget.commitment_line_items` | **RANGE(`reporting_year`) → LIST(`report_type`)** (two levels — decision 16) | `…_y2025_rt1/_rt2/_rt3` + `…_y2025_default` + table default | **2** |
| `budget_staging.execution_line_items_ytd`, `…commitment_line_items_ytd` | RANGE(`reporting_year`) only | `…_y2016`…`_y2030` + `_default` | 1 (not API-facing) |

> Leaf count is **not load-bearing** (the 298-table figure in the module header
> counts every parent+intermediate+leaf relation across both fact trees + staging).
> The **invariant the perf-guard test (§12) asserts is "every fact query prunes to
> ≤1 leaf"** — not a specific count. What matters is the *shape* above: a pruned
> execution read hits exactly one `…_yYYYY_rtN_{vn|ch}` leaf; a commitment read hits
> one `…_yYYYY_rtN`.

`report_type` LIST values (verified — these are the exact partition keys, NOT a
normalized enum):

- **execution** rt1=`'Executie bugetara detaliata'`, rt2=`'…agregata la nivel de
  ordonator principal'`, rt3=`'…agregata la nivel de ordonator secundar'`.
- **commitment** rt1=`'Executie - Angajamente bugetare agregat principal'`,
  rt2=`'…agregat secundar'`, rt3=`'…detaliat'`.
- `account_category` LIST values: `'vn'` (venituri/income ≈ 18–26%) and `'ch'`
  (cheltuieli/expense).

> The redesigned API exposes **clean enums** (`ReportType.EXECUTION_DETAILED`,
> `AccountCategory.EXPENSE`, etc.); a kernel-internal `REPORT_TYPE_LABELS` map
> translates enum → partition literal at the repo boundary. The DB literals never
> leak to the surface, but the SQL always uses the literal so the planner prunes.

### 0.2 Leaf indexes (inherited per leaf, verified on `…_y2025_rt1_ch`)

Every leaf carries: a UNIQUE `(reporting_year, report_type, account_category,
report_id, line_key)`; three **partial period-scope** indexes
`WHERE is_monthly` / `WHERE is_quarterly` / `WHERE is_yearly`, each leading
`(reporting_year, [reporting_month|quarter,] entity_cui, report_type,
budget_sector_id, main_creditor_cui)`; the line-identity index
`(account_category, expense_type, functional_code, economic_code, funding_source,
program_code)`; and `text_pattern_ops` btrees on `functional_code` and
`economic_code` (for `LIKE 'prefix%'`). Commitments: same minus
`account_category` in the unique/identity keys. MVs: unique + `entity_period` +
`period_plati`/`year_balance` ranking indexes (verified, see §0.4).

### 0.3 The pruning predicate (the rule every fact query obeys)

**This gate applies to the FACT path only** (`execution_line_items` /
`commitment_line_items`). On the **MV path** (§0.4) `account_category` is **not** a
predicate at all — the MVs pre-pivot income/expense into the columns
`total_income`/`total_expense`/`budget_balance`, so an MV read needs only `(year,
report_type)` and `account_category` becomes a **column selector** (INCOME →
`total_income`, EXPENSE → `total_expense`, BALANCE → `budget_balance`). This
fact-vs-MV split is the source of the C1/C2 review fix and is encoded by using
**two separate filter specs** (§7.1 fact spec vs §7.3 MV spec) rather than one
shared spec.

A FACT-path query MUST supply, as parameterized equality/range predicates, in this
order:

1. `reporting_year` — **mandatory** (single value or `BETWEEN`/`IN` bounded list).
   Prunes the RANGE level. No endpoint scans all years; default = latest loaded
   year (resolved at boot from `MAX(reporting_year)`, see §10).
2. `report_type` — **mandatory** equality (one partition literal). Prunes LIST L2.
   Defaults to the entity's `core.public_entities.default_report_type` when an
   entity is in scope, else `EXECUTION_DETAILED`.
3. `account_category` — **mandatory for execution** (`'vn'` | `'ch'`). Prunes
   LIST L3. (Legacy already requires this — see `DimensionFilter.account_category`
   required.) **Commitments have NO account_category** (single grain per row) —
   the commitment fact gate is the two-field `(year, report_type)` triple, and any
   request that sends `accountCategory` to a commitment endpoint is rejected
   `InvalidInput`.
4. A period-flag predicate (`is_monthly` / `is_quarterly` / `is_yearly`) selecting
   the matching partial scope index, plus the `(year, month|quarter)` tuple. The
   period-flag predicate is what guarantees `quarter`/`quarterly_amount` are
   populated (the migration's `is_quarterly ⇒ quarter IS NOT NULL` check); amount
   ranges on the period column are therefore NULL-excluding **by design**.

The execution fact gate `(year, report_type, account_category)` (commitments:
`(year, report_type)`) is enforced by the **grain gate in the FACT-collection spec**
(§7.1): the spec marks these fields `default`-ed and non-removable;
`canonicalizeFilters` fills them; `toConditionBuilders` refuses to emit a
fact-table query without all of them. **Because balance (income − expense) needs
both vn and ch leaves, balance is computable only on the MV path** — the fact path
is single-`account_category` by construction and cannot return a balance. A request
that omits the gate fields and cannot be defaulted (e.g. an unbounded cross-year
aggregate over a fact-only column) is rejected `InvalidInput` ("unbounded budget
scan: supply year + report_type + account_category, or use /aggregate or a summary
endpoint").

### 0.4 MV-first rollup routing (the key architectural decision)

Entity/period **summaries and rankings never scan the 126M-row facts** — they read
the six MVs, which are pre-aggregated at `(year[,month|quarter], entity_cui,
main_creditor_cui, report_type)` grain — **note: NO `account_category` in the MV
grain** — with transfer exclusions baked in. The execution MVs pre-pivot income vs
expense into the columns `total_income`/`total_expense`/`budget_balance`, so an MV
read filters only on `(year, report_type)` (+ entity/period/geo) and selects which
**column** to read/rank from `accountCategory` (INCOME/EXPENSE/BALANCE). The
implementer must NOT add `WHERE account_category = …` on an MV read (the column does
not exist — it would error):

| MV | Grain | Driving index | Powers |
|----|-------|---------------|--------|
| `mv_execution_summary_{monthly,quarterly,annual}` | entity×period×report_type; `total_income`/`total_expense`/`budget_balance` | `…_entity_period`, `…_year_balance` (annual) | entity summary, balance/income/expense rankings, time-series |
| `mv_commitment_summary_{monthly,quarterly,annual}` | entity×period×report_type; 13 angajamente metrics | `…_entity_period`, `…_period_plati` | commitment summary + rankings (by `plati_trezor`) |

**Routing rule** (`shouldUseMV`, ported from legacy `commitments`): an aggregate
request whose group-by is a subset of `{entity_cui, main_creditor_cui, year,
month, quarter, report_type}` and whose only filters are entity/period/report_type
→ **MV path** (1–3 ms, index-only). Any request that filters on a fact-only column
(`functional_code`, `economic_code`, `program_code`, `funding_source_id`,
`budget_sector_id`, `expense_type`, row-level amount, `exclude.*` codes) or groups
by classification → **fact path**, which then MUST carry the §0.3 pruning triple.
The benchmark (BUDGET_NOTES GATE-B): MV entity-period lookup **1.8 ms vs 146.9 ms**
legacy (80×); full-leaf entity ranking over 5.9M rows = 3.1 s (so rankings use the
MV, where per-year normalization factors apply algebraically to MV sums — see §3.4).

### 0.5 `budget_official` facts (un-partitioned, modest)

`approved_budget_facts` (3.31M), `bgc_official_facts`, `quarterly_allocations`,
`bgc_reconciliation`, and the `execution_vs_budget` **view** are plain B-tree-indexed
tables (`budget_year`, `period_year/_month`, `allocation` keys). They are the
"official/planned vs actual" surface. **Live caveat (BUDGET_NOTES 2026-06-14):**
`bgc_official_facts` and `quarterly_allocations` currently load **0 rows** (extract
defect, tracked); `approved_budget_facts` is fully loaded. The plan exposes the
`budget_official` endpoints but **capability-gates** them: if a table is empty the
endpoint returns `{ data: [], caveats: ['budget-official execution facts not yet
loaded'] }` rather than 404/500 (§10).

---

## 1. Summary & data status

**In prod now** (`transparenta_prod`, griffin `transparenta-eu-etl-prod`,
verified 2026-06-16):

| Table | Rows | Coverage |
|-------|------|----------|
| `budget.execution_line_items` | **126,778,624** | 2016–2026 (m1–5); detailed ≈ 11–14M/yr |
| `budget.commitment_line_items` | **32,589,802** | 2019–2026 (angajamente; pre-2019 correctly absent) |
| `budget.reports` | **3,820,780** | 2016–2026 report registry (file_source/download_links resolved at parse) |
| `budget.approved_budget_facts` | **3,307,226** | national budget law measures (2016+) |
| `budget.bgc_official_facts` | **0** ⚠ | execution-bulletin extract defect (tracked, additive dataset) |
| `budget.quarterly_allocations` | **0** ⚠ | same extract defect |
| `budget.{functional,economic}_classifications`, `budget.budget_sectors`, `budget.funding_sources` | dims | MFin catalogs (3,970 rows); `funding_source_id` resolved at load (0 = unresolved) |
| `budget.mv_*_summary_*` (6) | refreshed | entity×period rollups (refresh ≈ 2m09s full, CONCURRENTLY thereafter) |
| `core.public_entities` | 15,002 | CUI PK + `default_report_type` + SIRUTA link |
| `core.territories` | 3,228 | SIRUTA hub (surrogate `id` = legacy `uat_id`) |

**Schemas served:** `budget.*` (facts, dims, MVs, official, `execution_vs_budget`
view), the kernel `core.*` (identity + territory) for entity/geo enrichment.
**Not served:** `budget_staging.*` (parse/recompute working set — internal to the
loader); `bgc_reconciliation` (loader QA artifact — exposed only as a single
freshness/quality signal, not a queryable collection).

**Deferred / not yet wired (flag, don't block):**
- Budget facts are **not yet in `flows.money_flows`** (no `budget_*` flow_type
  live — verified: only `direct_acquisition`/`procurement_*`/`pnrr_*`). So the
  cross-source flow view (kernel `FlowsRepo`) carries **no budget rows today**.
  This module owns its native facts; it registers a `FLOW_TYPES` value
  (`budget_execution`) for when the scrapper `flows` lane projects budget (§4.3),
  but the contributor's flow slice is **capability-gated to empty** until then.
- Budget facts are **not yet in `search.documents`** (no `budget_*` doc_type live).
  The module declares `budget_entity` / `budget_report` doc_types it will own
  (§9), gated until the scrapper `search` lane writes them.
- `bgc_official_facts` / `quarterly_allocations` empty (above).

---

## 2. Schema → domain model

`src/modules/budget/core/types.ts` view models (camelCase; scalars per §14.1 —
**all money = `string`** `numeric(18,2)`, `org_id` never surfaces here since
budget keys on `entity_cui`).

### 2.1 Identity & territory linkage

- **CUI is the join key.** Facts carry `entity_cui text` (the reporting entity) and
  `main_creditor_cui text` (the principal ordonator). Both link to
  `core.public_entities` (CUI PK) — **not** `core.organizations` (budget world is
  the public-entity registry, §4.1). Enrichment (`name`, `entity_type`, `is_uat`,
  `default_report_type`, `territorial_siruta_code`) comes from a LEFT JOIN to
  `core.public_entities` keyed on CUI. Linkage is **link-not-merge**; ~99.98% of
  May CUIs resolve (3 unresolved = warn-tier, surfaced as `caveats`).
- **Territory** resolves via `core.public_entities.territorial_siruta_code` →
  `core.territories` (SIRUTA hub). The legacy `uat_id` contract = `core.territories.id`
  (surrogate int). County/region/population come from the territory hub (kernel
  `TerritoryRepo`); the geo filter family (§7.2) resolves through it. The budget
  territory join is **text = text** (`public_entities.territorial_siruta_code` →
  `core.territories.territorial_siruta_code`, both `text`) — **no cast needed**;
  the `siruta_code::text` cast in §14.1 applies to `core.organizations`, which
  budget does not touch.

### 2.2 Core view models

```ts
// fact row (execution) — the wide legacy shape, money columns as string
export interface ExecutionLineItem {
  readonly executionLineItemId: string;   // bigint → string
  readonly reportId: string;
  readonly reportingYear: number;
  readonly reportingMonth: number;
  readonly quarter: number | null;
  readonly entityCui: string;
  readonly mainCreditorCui: string | null;
  readonly reportType: ReportType;        // enum, mapped to/from partition literal
  readonly accountCategory: AccountCategory; // 'vn'|'ch' → INCOME|EXPENSE
  readonly budgetSectorId: number;
  readonly expenseType: string | null;
  readonly functionalCode: string;        readonly functionalName: string | null;
  readonly economicCode: string | null;   readonly economicName: string | null;
  readonly fundingSource: string | null;  readonly fundingSourceId: number;
  readonly programCode: string | null;
  readonly ytdAmount: string;             // Money
  readonly monthlyAmount: string;
  readonly quarterlyAmount: string | null;
  readonly period: { isMonthly: boolean; isQuarterly: boolean; isYearly: boolean };
  readonly anomaly: string | null;
}

export interface CommitmentLineItem { /* same key/period shape; 13 metric families
  each with ytd/monthly/quarterly/latest as Money strings (crediteAngajament,
  limitaCreditAngajament, crediteBugetare, …Initiale, …Definitive, …Disponibile,
  receptiiTotale, platiTrezor, platiNonTrezor, receptiiNeplatite) */ }

export interface BudgetEntitySummary {     // from mv_execution_summary_*
  readonly entityCui: string; readonly mainCreditorCui: string | null;
  readonly reportType: ReportType;
  readonly period: { year: number; month?: number; quarter?: number };
  readonly totalIncome: string; readonly totalExpense: string; readonly budgetBalance: string;
}
export interface CommitmentEntitySummary { /* entity×period; 13 metrics as Money */ }

export interface BudgetReport {            // from budget.reports + core join
  readonly reportId: string; readonly entityCui: string; readonly entityName: string | null;
  readonly reportType: ReportType; readonly mainCreditorCui: string | null;
  readonly reportDate: string | null; readonly reportingYear: number;
  readonly reportingPeriod: string; readonly budgetSectorId: number | null;
  readonly fileSource: string | null; readonly downloadLinks: readonly string[];
}

export interface AggregatedBudgetRow {     // by functional+economic classification
  readonly functionalCode: string; readonly functionalName: string | null;
  readonly economicCode: string | null;   // economic_code IS nullable in the facts
  readonly economicName: string | null;    // null bucket kept distinct, not coerced
  readonly amount: string;                // Money (normalized when requested)
}

export interface ApprovedBudgetFact { /* budget.approved_budget_facts */ }
export interface BudgetVsExecutionRow { /* budget.execution_vs_budget view */ }
```

### 2.3 PII / excluded columns

Budget data is **public, no PII**. Excluded from default projections for noise/size,
not privacy: `budget_staging.*` entirely; `metadata jsonb` / `field_trace` /
`issues` (loader provenance — available only via an explicit `?include=provenance`
debug flag, never in list/aggregate); `recomputed_at`, `loaded_at`, `import_timestamp`
(internal). `bgc_reconciliation.formula_details` not projected. Raw provenance
pointers (`document_id`, `source_file_id`, `xml_*`) on official facts are dropped
from default projections (they reference the raw DB).

---

## 3. Repo interface (ports)

`src/modules/budget/core/ports.ts`. All methods return `Result<T, ApiError>`
(neverthrow). Repos receive the typed Kysely `ProdDatabase` instance; they touch
**only** `budget.*` + the kernel `core.*` (read). No writes. Each method below
notes its driving partition/index and the §0.3/§0.4 routing.

```ts
export interface BudgetRepo {
  // ---- line-item facts (fact path; pruning triple MANDATORY) ----
  // year+report_type+account_category pruned to a single L3 leaf; period-flag
  // partial index drives the scope. Cursor pagination (no COUNT on 126M rows).
  listExecutionLineItems(q: ExecutionLineItemQuery): Promise<Result<Page<ExecutionLineItem>, ApiError>>;
  getExecutionLineItem(id: string): Promise<Result<ExecutionLineItem | null, ApiError>>;
  listCommitmentLineItems(q: CommitmentLineItemQuery): Promise<Result<Page<CommitmentLineItem>, ApiError>>;

  // ---- entity/period summaries (MV path; index-only, §0.4) ----
  getEntitySummary(cui: string, q: SummaryQuery): Promise<Result<BudgetEntitySummary[], ApiError>>;
  getCommitmentSummary(cui: string, q: SummaryQuery): Promise<Result<CommitmentEntitySummary[], ApiError>>;
  // time series for one entity/filter set — reads the MV at the requested grain
  executionTimeseries(q: TimeseriesQuery): Promise<Result<SeriesPoint[], ApiError>>;
  commitmentTimeseries(q: TimeseriesQuery): Promise<Result<SeriesPoint[], ApiError>>;

  // ---- rankings (MV path + normalization factors applied to MV sums, §3.4) ----
  // year+report_type mandatory; ORDER BY (income|expense|balance|per_capita) on the
  // annual/monthly MV; cursor or offset+estimated-total (§14.4). Never the fact leaf.
  rankEntities(q: EntityRankingQuery): Promise<Result<Page<RankedEntity>, ApiError>>;
  rankCommitmentEntities(q: CommitmentRankingQuery): Promise<Result<Page<RankedCommitmentEntity>, ApiError>>;

  // ---- classification aggregate (fact path; pruning triple MANDATORY) ----
  // GROUP BY (functional_code, functional_name, economic_code, economic_name)
  // within ONE pruned leaf; HAVING on aggregate amount; LIMIT≤100. Uses the
  // factors VALUES-CTE for normalize-then-aggregate (§3.4).
  aggregateByClassification(q: ClassificationAggregateQuery): Promise<Result<AggregatedBudgetRow[], ApiError>>;

  // ---- geo heatmap (MV path: entity×year MV → county rollup, §3.4) ----
  countyHeatmap(q: HeatmapQuery): Promise<Result<CountyHeatmapPoint[], ApiError>>;

  // ---- reports (metadata; bounded by entity/year indexes) ----
  listReports(q: ReportQuery): Promise<Result<Page<BudgetReport>, ApiError>>;
  getReport(reportId: string): Promise<Result<BudgetReport | null, ApiError>>;

  // ---- dimensions (small reference tables; pg_trgm name search) ----
  listFunctionalClassifications(q: DimensionQuery): Promise<Result<Page<Classification>, ApiError>>;
  listEconomicClassifications(q: DimensionQuery): Promise<Result<Page<Classification>, ApiError>>;
  listBudgetSectors(q: DimensionQuery): Promise<Result<Page<BudgetSector>, ApiError>>;
  listFundingSources(q: DimensionQuery): Promise<Result<Page<FundingSource>, ApiError>>;

  // ---- budget-official (un-partitioned; capability-gated on row presence) ----
  listApprovedBudgetFacts(q: ApprovedFactQuery): Promise<Result<Page<ApprovedBudgetFact>, ApiError>>;
  budgetVsExecution(q: VsBudgetQuery): Promise<Result<Page<BudgetVsExecutionRow>, ApiError>>;

  // ---- contributor support (§4.4) ----
  presenceFor(cui: string): Promise<Result<SourcePresence | null, ApiError>>;   // 1 MV index probe
  profileSlice(cui: string): Promise<Result<BudgetProfileSlice | null, ApiError>>; // latest-year summary

  // ---- freshness ----
  latestLoadedYear(): Promise<Result<number, ApiError>>;
  asOf(): Promise<Result<{ year: number; refreshedAt: string | null }, ApiError>>;
}

export interface BudgetDiscoveryRepo {       // name→value resolution (§7.4)
  resolveEntity(q: string, limit: number): Promise<Result<EntityMatch[], ApiError>>;        // core.public_entities pg_trgm
  resolveTerritory(q: string, limit: number): Promise<Result<TerritoryMatch[], ApiError>>;  // kernel TerritoryRepo
  resolveFunctional(q: string, limit: number): Promise<Result<CodeMatch[], ApiError>>;
  resolveEconomic(q: string, limit: number): Promise<Result<CodeMatch[], ApiError>>;
}
```

### 3.1 `ExecutionLineItemQuery` (the canonical fact query)

```ts
interface ExecutionLineItemQuery {
  reportingYear: number;                 // REQUIRED — prunes RANGE
  reportType: ReportType;                // REQUIRED — prunes LIST L2
  accountCategory: AccountCategory;      // REQUIRED — prunes LIST L3
  frequency: 'MONTH'|'QUARTER'|'YEAR';   // selects is_monthly/quarterly/yearly + amount col
  period?: { months?: number[]; quarters?: number[] };  // tuple predicate within the year
  entityCuis?: string[]; mainCreditorCui?: string;
  budgetSectorIds?: number[]; fundingSourceIds?: number[]; expenseTypes?: string[];
  functionalCodes?: string[]; functionalPrefixes?: string[];
  economicCodes?: string[]; economicPrefixes?: string[]; programCodes?: string[];
  geo?: GeographicFilter;                // resolved via core join (entity/territory)
  amount?: { min?: number; max?: number };           // row-level on monthly|quarterly|ytd
  exclude?: BudgetExclusion;
  sort: ExecutionSortKey; cursor?: string; limit: number; // ≤100
}
```

The repo composes the WHERE from the kernel filter pipeline (§7) — the `(year,
report_type, account_category)` literals always come first so the planner prunes
to one leaf before any other predicate. The `frequency` flag picks the partial
scope index. `entityCuis`/`mainCreditorCui` then ride the leading columns of that
index. Joins to `core.public_entities`/`core.territories` happen only when
`geo`/entity-name filters or enriched output are requested (`needsEntityJoin`/
`needsUatJoin`, ported).

### 3.2 Cursor instead of `COUNT(*) OVER()` (the headline perf fix)

The legacy fact-list paths all used `offset + COUNT(*) OVER()` (verified across
`execution-line-items`, `aggregated-line-items`, all `commitments` paged queries,
`entity-analytics`) — every page recomputes the full filtered count over the
partition. **The redesign uses cursor pagination on all fact + ranking endpoints**
(§5.3, §14.3): keyset on the sort tuple (e.g. `(monthly_amount DESC,
execution_line_item_id)`), no COUNT. Where a UI needs a total it gets the planner
estimate `{ total, estimated: true }` (§14.4), never a blocking `COUNT(*)`.
Bounded dimension lists keep **offset + cheap COUNT** (small tables).

### 3.3 Statement-timeout classes (§5.5)

5 s default reads (line-item lists, dimension lists, report detail); **15 s
aggregates** (classification aggregate, rankings, heatmap, timeseries — all
MV-or-single-leaf-bounded); 30 s reserved for `ask`/cross-source (kernel).

### 3.4 Consolidated analytics (the three divergent normalizers → one)

Legacy has **three** implementations of the same per-year normalization
(`execution-analytics` pure-TS per point, `county-analytics` TS per year,
`entity-analytics` SQL `factors(period_key, multiplier)` VALUES-CTE). The redesign
adopts the **SQL VALUES-CTE** (`buildFactorValuesCTE` +
`CommonJoins.factorsOnPeriod(frequency)`) as the single mechanism, lifted into
`shared/` analytics helpers (it is source-agnostic). Rules carried verbatim:

- **Normalization factor** = CPI(base 2024 carry-forward) × (1/FX) for
  total_euro/inflation_adjusted, or `100/gdp` for percent_gdp; population is
  **deliberately excluded from the factor map** and divided per-entity in SQL
  (`populationCaseExpr`/`perCapitaExpr`) — this is the correct entity-grain design.
- **Rankings apply the factor to MV sums, not fact rows** (BUDGET_NOTES: "per-year
  normalization factors are algebraically identical applied to MV sums"). So
  `rankEntities` reads `mv_execution_summary_annual` (or monthly), multiplies each
  period's sum by the period factor, and orders — ~2 ms, never the 3.1 s leaf scan.
- **Transfer exclusions** are **already baked into the MV definitions** — the API
  must NOT re-apply them on MV reads (double-exclusion bug). On the **fact path**
  they are an opt-in `excludeTransfers` flag (ported from `commitments`), which
  MUST use the **exact same set the MVs bake in**, verbatim, so fact-path and
  MV-path "exclude transfers" answers are identical: economic prefixes `'51.01%'`,
  `'51.02%'` (expense side only); functional prefixes `'36.02.05%'`, `'37.02.03%'`,
  `'37.02.04%'`, `'47.02.04%'` (income side). This set is a single shared constant
  (`BUDGET_TRANSFER_EXCLUSIONS`) referenced by the fact-path builder; if it ever
  diverges from the MV migration the perf/parity tests (§12) must fail.
- The Bucharest `siruta='179132'` / `cui='179132'` special-case (duplicated in 4
  legacy repos) is **centralized once** in the kernel `TerritoryRepo` (per §4.2)
  and consumed here — not re-hardcoded.

---

## 4. Usecases

`src/modules/budget/core/usecases/` — framework-free, over ports, `Result`-returning.
Each REST handler, GraphQL resolver, and MCP handler calls the **same** usecase
(§14.7 tri-surface equivalence).

| Usecase | Signature | Notes |
|---------|-----------|-------|
| `listExecutionLineItems` | `(q) => Result<Page<ExecutionLineItem>>` | fact path; grain gate enforced |
| `listCommitmentLineItems` | `(q) => Result<Page<CommitmentLineItem>>` | fact path |
| `getEntityBudget` | `(cui, q) => Result<BudgetEntitySummary[]>` | MV path; powers contributor `profileSlice` |
| `getEntityCommitments` | `(cui, q) => Result<CommitmentEntitySummary[]>` | MV path |
| `budgetTimeseries` | `(q) => Result<SeriesPoint[]>` | MV path; normalization applied per-point |
| `rankEntities` | `(q) => Result<Page<RankedEntity>>` | MV + factor; income/expense/balance/per_capita |
| `rankCommitmentEntities` | `(q) => Result<Page<RankedCommitmentEntity>>` | MV; by plati_trezor etc. |
| `aggregateByClassification` | `(q) => Result<AggregatedBudgetRow[]>` | fact path (one leaf); normalize-then-aggregate |
| `countyHeatmap` | `(q) => Result<CountyHeatmapPoint[]>` | MV→county rollup |
| `listReports` / `getReport` | `(q\|id) => Result<…>` | metadata |
| `commitmentVsExecution` | `(q) => Result<…>` | the legacy FULL OUTER JOIN coverage cross-check (fact path, both leaves) |
| `budgetVsApproved` | `(q) => Result<Page<BudgetVsExecutionRow>>` | reads `execution_vs_budget` view; capability-gated |
| dimension list usecases (4) | `(q) => Result<Page<…>>` | reference |
| `resolveBudgetFilter` | `(dim, q) => Result<Match[]>` | discovery (§7.4) |

### 4.1 Cross-source contributor (§4.4 / §14.7)

```ts
export const makeBudgetContributor = (repo: BudgetRepo): SourceContributor => ({
  source: 'budget',
  // 1 index probe on mv_execution_summary_annual for the latest year
  presenceFor: (cui) => repo.presenceFor(cui),
  // latest-year income/expense/balance + top functional categories (MV path)
  profileSlice: (cui) => repo.profileSlice(cui),
});
```

- **`flow_type` registered:** `budget_execution` (added to kernel `FLOW_TYPES`).
  **But:** budget has **no rows in `flows.money_flows` yet** (verified). So the
  contributor's flow participation is **capability-gated empty** — the entity-360
  flow summary (kernel `FlowsRepo`) returns no budget flows until the scrapper
  `flows` lane projects them; budget participates in entity-360 only via its
  native `profileSlice` (income/expense/balance), labeled grain
  `budget_summary_annual`. This is the **Grain Gate** (§14.6) in action: budget's
  authoritative answers come from its MVs, not `flows.money_flows`.
- **`doc_type` registered:** `budget_entity`, `budget_report` (§9) — gated until
  the search lane writes them.

---

## 5. REST endpoints

Prefix `/api/v1/budget/`. Every route declares `config: { public: true }` (§14.11),
a TypeBox query schema (derived from the §7 spec via `toTypeBox`), the response
envelope (§5.2), pagination kind, cache TTL, and timeout class. Each module exports
an OpenAPI fragment merged at `/api/v1/openapi.json`.

| Method | Path | Query (TypeBox, from spec) | Response | Pagination | Cache | Timeout |
|--------|------|----------------------------|----------|------------|-------|---------|
| GET | `/budget/execution-line-items` | `BudgetFactFilter` (year,report_type,account_category req) + sort + cursor + limit | `ExecutionLineItem[]` | **cursor** | 60 s | 5 s |
| GET | `/budget/execution-line-items/:id` | — | `ExecutionLineItem` | — | 300 s | 5 s |
| GET | `/budget/commitment-line-items` | `CommitmentFactFilter` (year,report_type req) | `CommitmentLineItem[]` | **cursor** | 60 s | 5 s |
| GET | `/budget/entities/:cui/summary` | `SummaryQuery` (year/from-to, freq, report_type?) | `BudgetEntitySummary[]` | offset (cheap, MV) | 300 s | 15 s |
| GET | `/budget/entities/:cui/commitments` | `SummaryQuery` | `CommitmentEntitySummary[]` | offset | 300 s | 15 s |
| GET | `/budget/timeseries` | `TimeseriesQuery` (filter + freq + normalization) | `SeriesPoint[]` | none (bounded ≤10k) | 120 s | 15 s |
| GET | `/budget/rankings/entities` | `EntityRankingQuery` (year,report_type req; metric; normalization) | `RankedEntity[]` | **cursor** (+est total) | 120 s | 15 s |
| GET | `/budget/rankings/commitment-entities` | `CommitmentRankingQuery` | `RankedCommitmentEntity[]` | cursor | 120 s | 15 s |
| GET | `/budget/aggregate` | `BudgetFactFilter` + `groupBy=classification` + aggregate amount HAVING | `AggregatedBudgetRow[]` | offset≤100 | 120 s | 15 s |
| GET | `/budget/analytics/county-heatmap` | `HeatmapQuery` (year,report_type req; normalization) | `CountyHeatmapPoint[]` | none (≤47) | 300 s | 15 s |
| GET | `/budget/reports` | `ReportQuery` (≥1 of entity_cui\|year\|report_type REQUIRED) + date range, search | `BudgetReport[]` | offset + **cheap COUNT only when bounded** | 120 s | 5 s |
| GET | `/budget/reports/:id` | — | `BudgetReport` | — | 300 s | 5 s |
| GET | `/budget/classifications/functional` | `DimensionQuery` (search, codes) | `Classification[]` | offset | 1 h | 5 s |
| GET | `/budget/classifications/economic` | `DimensionQuery` | `Classification[]` | offset | 1 h | 5 s |
| GET | `/budget/sectors` | `DimensionQuery` | `BudgetSector[]` | offset | 1 h | 5 s |
| GET | `/budget/funding-sources` | `DimensionQuery` | `FundingSource[]` | offset | 1 h | 5 s |
| GET | `/budget/official/approved` | `ApprovedFactQuery` (budget_year, measure_kind…) | `ApprovedBudgetFact[]` | offset (cheap) | 1 h | 5 s |
| GET | `/budget/official/vs-execution` | `VsBudgetQuery` | `BudgetVsExecutionRow[]` | offset | 1 h | 15 s |
| GET | `/budget/filters/resolve` | `?dim={entity\|territory\|functional\|economic}&q=` | `Match[]` | none (≤20) | 300 s | 5 s |

Notes: `year`/`report_type`/`account_category` are **required** query params on the
fact endpoints (TypeBox `minimum`/enum), defaulted by the handler to latest-year /
`EXECUTION_DETAILED` / `EXPENSE` when absent **only** where a default is safe;
otherwise 400 `InvalidInput` with the §0.3 message. Arrays are CSV params (declared
in OpenAPI). Ranges are `…From`/`…To`. Exclusion is `exclude.<field>` (bracket).
Every response carries `meta.asOf = { year, refreshedAt }` (§10) and `requestId`
(§14.11).

---

## 6. GraphQL

Schema-stitched (§6.2). All types domain-prefixed `Budget*` / `Commitment*` (§14.8,
no bare `Summary`/`Report`/`Status`). Filter `input`s generated from the §7 spec via
`toGraphQLInput` so REST/GraphQL never drift.

```graphql
# --- enums (clean; mapped to partition literals at the repo) ---
enum BudgetReportType { EXECUTION_DETAILED EXECUTION_AGG_PRINCIPAL EXECUTION_AGG_SECONDARY }
enum BudgetCommitmentReportType { COMMITMENT_AGG_PRINCIPAL COMMITMENT_AGG_SECONDARY COMMITMENT_DETAILED }
enum BudgetAccountCategory { INCOME EXPENSE }                 # vn | ch
enum BudgetFrequency { MONTH QUARTER YEAR }
enum BudgetNormalization { TOTAL TOTAL_EURO PER_CAPITA PER_CAPITA_EURO PERCENT_GDP }
enum BudgetEntitySortKey { TOTAL_AMOUNT INCOME EXPENSE BALANCE PER_CAPITA ENTITY_NAME POPULATION COUNTY }
enum BudgetLineItemSortKey { AMOUNT_DESC AMOUNT_ASC LINE_ORDER }

scalar Money   # (kernel) numeric(18,2) as string
scalar CUI scalar SIRUTA scalar Date scalar JSON

type BudgetExecutionLineItem {
  executionLineItemId: ID!
  reportId: ID! reportingYear: Int! reportingMonth: Int! quarter: Int
  entityCui: CUI! mainCreditorCui: CUI
  reportType: BudgetReportType! accountCategory: BudgetAccountCategory!
  budgetSectorId: Int! expenseType: String
  functionalCode: String! functionalName: String
  economicCode: String economicName: String
  fundingSource: String fundingSourceId: Int! programCode: String
  ytdAmount: Money! monthlyAmount: Money! quarterlyAmount: Money
  isMonthly: Boolean! isQuarterly: Boolean! isYearly: Boolean! anomaly: String
  entity: Entity                      # lazy join to core via DataLoader (CUI)
}
type BudgetEntitySummary { entityCui: CUI! mainCreditorCui: CUI reportType: BudgetReportType!
  year: Int! month: Int quarter: Int totalIncome: Money! totalExpense: Money! budgetBalance: Money! }
type BudgetCommitmentLineItem { """13 metric families as Money""" … }
type BudgetCommitmentSummary { … }
type BudgetReport { reportId: ID! entityCui: CUI! entityName: String reportType: BudgetReportType!
  mainCreditorCui: CUI reportDate: Date reportingYear: Int! reportingPeriod: String!
  budgetSectorId: Int fileSource: String downloadLinks: [String!]! entity: Entity }
type BudgetAggregatedRow { functionalCode: String! functionalName: String
  economicCode: String economicName: String amount: Money! }   # economicCode nullable: economic_code IS NULL is a real bucket (un-coerced)
type BudgetCountyHeatmapPoint { countyCode: String! countyName: String year: Int! amount: Money! perCapita: Money }
type BudgetRankedEntity { entityCui: CUI! entity: Entity year: Int! reportType: BudgetReportType!
  amount: Money! perCapita: Money population: Int }
type BudgetApprovedFact { … } type BudgetVsExecutionRow { … }

# Relay connections (same cursor encoder as REST, §14.3)
type BudgetExecutionLineItemConnection { edges: [BudgetExecutionLineItemEdge!]! pageInfo: PageInfo! estimatedTotal: Int }
type BudgetExecutionLineItemEdge { node: BudgetExecutionLineItem! cursor: String! }
# …Commitment…, …RankedEntity… connections likewise

extend type Query {
  budgetExecutionLineItem(id: ID!): BudgetExecutionLineItem
  budgetExecutionLineItems(filter: BudgetFactFilterInput!, sort: BudgetLineItemSortKey, first: Int = 20, after: String): BudgetExecutionLineItemConnection!
  budgetCommitmentLineItems(filter: BudgetCommitmentFactFilterInput!, sort: BudgetLineItemSortKey, first: Int = 20, after: String): BudgetCommitmentLineItemConnection!
  budgetEntitySummary(cui: CUI!, year: Int, yearFrom: Int, yearTo: Int, frequency: BudgetFrequency = YEAR, reportType: BudgetReportType): [BudgetEntitySummary!]!
  budgetTimeseries(filter: BudgetFactFilterInput!, frequency: BudgetFrequency!, normalization: BudgetNormalization = TOTAL): [BudgetSeriesPoint!]!
  budgetEntityRanking(filter: BudgetRankingFilterInput!, sort: BudgetEntitySortKey = TOTAL_AMOUNT, normalization: BudgetNormalization = TOTAL, first: Int = 50, after: String): BudgetRankedEntityConnection!
  budgetAggregateByClassification(filter: BudgetFactFilterInput!, minAmount: Money, maxAmount: Money, limit: Int = 50): [BudgetAggregatedRow!]!
  budgetCountyHeatmap(filter: BudgetRankingFilterInput!, normalization: BudgetNormalization = TOTAL): [BudgetCountyHeatmapPoint!]!
  budgetReports(filter: BudgetReportFilterInput!, first: Int = 20, page: Int): BudgetReportConnection!
  budgetReport(reportId: ID!): BudgetReport
  budgetFunctionalClassifications(search: String, codes: [String!], page: Int, pageSize: Int): BudgetClassificationConnection!
  budgetEconomicClassifications(search: String, codes: [String!], page: Int, pageSize: Int): BudgetClassificationConnection!
  budgetSectors(search: String, ids: [Int!]): [BudgetSector!]!
  budgetFundingSources(search: String, ids: [Int!]): [BudgetFundingSource!]!
  budgetApprovedFacts(filter: BudgetApprovedFactFilterInput!, page: Int, pageSize: Int): BudgetApprovedFactConnection!
  budgetVsExecution(filter: BudgetVsExecutionFilterInput!, page: Int, pageSize: Int): BudgetVsExecutionConnection!
  budgetResolveFilter(dim: BudgetFilterDim!, q: String!, limit: Int = 10): [BudgetFilterMatch!]!
}

# Entity join type extension (§6.2 / §14.7) — resolved via contributor.profileSlice
extend type Entity {
  budget: BudgetEntityProfile          # latest-year income/expense/balance + top categories
}
type BudgetEntityProfile { presence: Boolean! latestYear: Int totalIncome: Money totalExpense: Money
  budgetBalance: Money reportType: BudgetReportType }
```

**`Entity.budget` resolver** calls `budgetContributor.profileSlice(cui)` — the
identical usecase REST entity-360 calls (§14.7) — through a **DataLoader keyed on
CUI** (§14.1) batching `presenceFor`/`profileSlice` so an entity-list fan-out is
one MV probe per batch, not N. Resolvers are thin (parse args → usecase). The CI
schema-merge conflict test (§14.8) guards the `Budget*` namespace.

---

## 7. Filters — the budget collection specs (PRIORITY)

Budget is **the** filter-heavy domain — the legacy `query-filters` DSL was derived
from it. The redesign **does not invent a DSL**; it declares
`CollectionFilterSpec`s that the kernel pipeline (§14.2) consumes
(`toTypeBox`/`toGraphQLInput`/`toConditionBuilders`/`canonicalizeFilters`). The
kernel ships the families (Entity/Territory/Period/Amount/Classification/Text/
Status/Exclusion); budget declares which fields, ops, and driving columns.

### 7.1 The fact-collection spec (`budget.execution_line_items`)

Each row: field → ops → driving column (`{alias,column}`, partition/index-aware) →
REST param ↔ GraphQL input ↔ MCP input. `eli` = fact alias, `e` =
`core.public_entities`, `t` = `core.territories`.

| Field | type | ops | driving column | index/partition | REST ↔ GraphQL ↔ MCP |
|-------|------|-----|----------------|-----------------|----------------------|
| `reportingYear` | int | `eq`,`between`,`in` | `eli.reporting_year` | **RANGE L1 (prune)** | `year`/`yearFrom`/`yearTo` ↔ `year`/`yearFrom`/`yearTo` ↔ same; **default = latest, non-removable** |
| `reportType` | enum | `eq` | `eli.report_type` | **LIST L2 (prune)** | `reportType` ↔ enum ↔ enum; default `EXECUTION_DETAILED` |
| `accountCategory` | enum | `eq` | `eli.account_category` | **LIST L3 (prune)** | `accountCategory` ↔ enum ↔ enum; default `EXPENSE`; **required** |
| `frequency` | enum | `eq` | `eli.is_{monthly,quarterly,yearly}` | partial scope idx | selects amount col + flag |
| `months` / `quarters` | int[] | `in` | `eli.reporting_month`/`quarter` | tuple in scope idx | `months`/`quarters` CSV ↔ list ↔ list |
| `entityCuis` | string[] | `in` | `eli.entity_cui` | scope idx col 3 | `entityCui` CSV ↔ `[CUI!]` ↔ list |
| `mainCreditorCui` | string | `eq` | `eli.main_creditor_cui` | scope idx tail | same |
| `budgetSectorIds` | int[] | `in` | `eli.budget_sector_id` | scope idx | `budgetSectorIds` |
| `fundingSourceIds` | int[] | `in` | `eli.funding_source_id` | — (resolved at load) | `fundingSourceIds` |
| `expenseTypes` | string[] | `in` | `eli.expense_type` | identity idx | `expenseTypes` |
| `functionalCodes` | string[] | `in` | `eli.functional_code` | identity idx | `functionalCodes` |
| `functionalPrefixes` | string[] | `prefix` | `eli.functional_code` | **text_pattern_ops btree** | `functionalPrefixes` (`LIKE 'x%'`) |
| `economicCodes` | string[] | `in` | `eli.economic_code` | identity idx | `economicCodes` |
| `economicPrefixes` | string[] | `prefix` | `eli.economic_code` | **text_pattern_ops btree** | `economicPrefixes` |
| `programCodes` | string[] | `in` | `eli.program_code` | identity idx | `programCodes` |
| `entityTypes` | string[] | `in` | `e.entity_type` | core (join) | `entityTypes` (needs entity join) |
| `isUat` | bool | `eq` | `e.is_uat` | core | `isUat` |
| `uatIds` | int[] | `in` | `t.id` | core (territory) | `uatIds` |
| `countyCodes` | string[] | `in` | `t.county_code` | core | `countyCodes` |
| `regions` | string[] | `in` | `t.region` | core | `regions` |
| `minPopulation`/`maxPopulation` | int | `gte`/`lte` | `t.population` | core | `minPopulation`/`maxPopulation` |
| `q` | string | `contains` | `e.name` | **pg_trgm** (kernel identity repo) | `search` ↔ `q` — text engine = **Postgres trigram** (entity name); not Meili/OS on this collection |
| `minAmount`/`maxAmount` | number | `gte`/`lte` | `eli.{monthly\|quarterly\|ytd}_amount` (by `frequency`) | — (row filter) | `minAmount`/`maxAmount` |
| `excludeTransfers` | bool | — | functional/economic prefix set | — | opt-in (fact path only; MVs pre-exclude) |
| `exclude` | nested | negation | report_ids, entity_cuis, functional_codes/_prefixes, economic_codes/_prefixes, entity_types, uat_ids, county_codes, regions (`exclude:true` fields only, §14.2) | NULL-safe `(col IS NULL OR col NOT IN …)` | `exclude.<field>` ↔ `exclude: {...}` ↔ nested |

`sort`: default `LINE_ORDER`; allowed `{ AMOUNT_DESC, AMOUNT_ASC, LINE_ORDER }`
(maps to `monthly\|quarterly\|ytd_amount` per frequency + tiebreak
`execution_line_item_id`). **`canonicalizeFilters`** fills the §0.3 triple,
lowercases, sorts arrays → produces the cache key + cursor `fhash` + tri-surface
equivalence key.

### 7.2 The commitment-fact spec

Same as 7.1 **minus** `accountCategory`/`expenseType` (commitment rows have no
account split) and with the `report_type` enum = `BudgetCommitmentReportType`.
Amount fields map to the chosen **metric** (`metric` enum: `crediteAngajament`,
`platiTrezor`, …) × frequency column. Pruning triple here is `(year, report_type)`
(two-level — §0.3).

### 7.3 The ranking / summary / heatmap spec

Reads MVs, so the spec restricts fields to MV columns: `{ year/yearFrom/yearTo,
month, quarter, reportType, entityCuis, mainCreditorCui, countyCodes, regions,
isUat, minPopulation, maxPopulation }` + `normalization` + `sort` + `metric`. **No
fact-only field is accepted here** — supplying one routes the request to the fact
path or errors (the §0.4 routing). This is what keeps rankings off the 126M-row
leaves.

### 7.4 Dimension / report / official specs

- Dimension specs (functional/economic/sector/funding): `{ search (pg_trgm),
  codes/ids (in) }`, offset pagination, default sort by code/name.
- Report spec: `{ entityCui, reportingYear, reportingPeriod, reportType,
  mainCreditorCui, reportDateFrom/To, q (entity name) }`; sort `report_date`.
  **`budget.reports` is 3.82M rows, so an unbounded list + COUNT is forbidden**
  (§14.4): the spec requires **at least one** of `entityCui`
  (`reports_entity_cui_idx`), `reportingYear` (`reports_reporting_year_idx`), or
  `reportType` (`reports_report_type_idx`) — each is indexed, making the offset
  COUNT cheap. A request with none → `InvalidInput`. (If a future unfiltered feed
  is needed, switch reports to cursor + estimated total like the facts.)
- Approved spec: `{ budgetYear, measureYear, measureKind, budgetComponent,
  functionalCode, economicCode }`. Vs-execution spec: period + component keys.

### 7.5 Discovery / resolve dimensions (§7.4)

`/budget/filters/resolve?dim=` and the MCP discovery tool resolve: **entity**
(name → CUI via `core.public_entities` pg_trgm + the kernel identity hub),
**territory** (locality/county → SIRUTA/uat_id via kernel `TerritoryRepo`),
**functional** (label → functional_code), **economic** (label → economic_code).
Report-type / account-category are closed enums (no resolution needed; documented
literal map). Every resolve echoes the matched id + a confidence/ambiguity flag
(Entity Resolution Gate — catalog).

### 7.6 Golden question → filter examples (from the catalog + budget reality)

| Q | Intent | Resolved filter | Path |
|---|--------|-----------------|------|
| "Cheltuielile Primăriei Cluj-Napoca în 2024" | entity expense, one year | `{year:2024, reportType:EXECUTION_DETAILED, accountCategory:EXPENSE, entityCuis:[<resolved>], frequency:YEAR}` | MV summary |
| "Pe ce a cheltuit ministerul X pe categorii funcționale, 2023" | spend by functional category | `{year:2023, reportType:EXECUTION_DETAILED, accountCategory:EXPENSE, entityCuis:[X], groupBy:classification}` | fact aggregate (one leaf) |
| "Top 20 UAT-uri după cheltuieli pe locuitor, 2025" | per-capita ranking | `{year:2025, reportType:EXECUTION_DETAILED, accountCategory:EXPENSE, isUat:true, normalization:PER_CAPITA, sort:PER_CAPITA, limit:20}` | MV ranking + factor |
| "Veniturile județului Iași lunar în 2024" | income timeseries | `{year:2024, reportType:EXECUTION_AGG_PRINCIPAL, accountCategory:INCOME, regions/county resolved, frequency:MONTH}` | MV monthly series |
| "Angajamente plătite din trezorerie de entitatea Y, Q1–Q4 2025" | commitment metric | `{year:2025, reportType:COMMITMENT_AGG_PRINCIPAL, entityCuis:[Y], metric:platiTrezor, frequency:QUARTER}` | commitment MV |
| "Cât a alocat legea bugetului 2024 pe componenta Z vs execuția" | planned vs actual | `budgetVsExecution{budgetYear:2024, component:Z}` | official view (gated) |

These ship as integration golden-filter cases (§11).

---

## 8. MCP tools

`src/modules/budget/shell/mcp/`. TypeBox input+output; handler → core usecase;
output `{ ok, kind, query, link, item|items, summary?, evidence?, coverage?,
caveats? }` (the catalog's verification envelope). Rate-limited; bounded sizes.
**Two families** (§6.3):

### 8.1 Discovery tool — `resolve_budget_filter`

```
input  { dim: 'entity'|'territory'|'functional'|'economic', q: string, limit?: int }
output { ok, kind:'resolution', items:[{ id, label, kind, confidence, ambiguous }], summary }
```
Calls `resolveBudgetFilter`. Wraps `/budget/filters/resolve` (§14.11). Mandatory
first step for any name-based budget question (Entity Resolution Gate).

### 8.2 Query tools

| Tool | Input (key fields) | Usecase | Output `kind` | `link` |
|------|--------------------|---------|----------------|--------|
| `get_budget_entity_snapshot` | `cui`, `year?`, `reportType?` | `getEntityBudget` (+commitments) | `entity_snapshot` | `/entities/{cui}/budget?year=` |
| `rank_budget_entities` | `year`, `reportType`, `accountCategory`, `metric`, `normalization?`, `geo?`, `limit?` | `rankEntities` | `ranking` | `/budget/rankings?...` |
| `aggregate_budget_by_classification` | `year`, `reportType`, `accountCategory`, `entityCui?`, `minAmount?` | `aggregateByClassification` | `aggregate` | `/budget/aggregate?...` |
| `get_budget_timeseries` | filter + `frequency` + `normalization?` | `budgetTimeseries` | `timeseries` | `/budget/timeseries?...` |
| `compare_budget_vs_approved` | `budgetYear`, component/entity | `budgetVsApproved` | `comparison` | `/budget/official/vs-execution?...` (gated) |

Every aggregate output includes (catalog Core Rule): `value`, `evidence` (entity
CUIs / report_ids), `filters` (the canonicalized set actually applied),
`denominator` (rows/entities considered), `coverage` (CUI→core match rate, missing
count), `confidence` (deterministic tier), `caveats` (e.g. "transfer exclusions
applied", "3 CUIs unmatched", "official execution facts not loaded"). The
**Amount/Coverage/Grain gates** are encoded: rankings declare base grain
(`execution_detailed`/`vn|ch`), region rankings disclose territory coverage, and
"biggest by value" never mixes execution + commitment grains (§14.6).

`summary` template: e.g. `"{entityName} ({cui}) had {totalExpense} RON expenses and
{totalIncome} RON income in {year} (report type {reportType}); balance
{budgetBalance} RON."` — LLM-friendly, numbers from SQL only (LLM Safety Gate).

---

## 9. Search integration

`doc_type`s this module **will own**: `budget_entity` (one doc per entity×latest
year: name, CUI, county, latest income/expense/balance → for autocomplete + entity
discovery) and `budget_report` (optional, per significant report). **Status:
deferred** — verified there are **no `budget_*` rows in `search.documents` today**
(only portal/procurement/legal/parliament/mo/pnrr). Projection is written by the
**scrapper `search` lane** (server only reads). Until present:

- **Meili**: budget entity-name autocomplete falls back to the kernel identity
  hub's pg_trgm search over `core.public_entities` (the discovery tool already does
  this). When `budget_entity` lands, the index name is `budget_entities` (Meili) /
  `documents` filtered `doc_type=budget_entity` (OS).
- **Semantic/pgvector**: not applicable to budget (numeric facts; no body text) —
  semantic is **capability-gated off** for this module (§14.5); never errors.
- Text filter `q` on budget collections is **Postgres trigram on entity name**
  (declared §7.1), not OS full-text — budget is analytics, not document retrieval.

---

## 10. Sync / freshness impact on serving

- **Loader cadence:** budget refreshes incrementally as new ANAF months load
  (recompute `budget_staging` → `budget` facts, then MV refresh ≈ 2 m full /
  CONCURRENTLY incremental). Live e2e proven for May 2026 (BUDGET_NOTES). Cadence:
  monthly (new reporting month) + ad-hoc re-downloads (source re-publications).
- **As-of semantics:** every read surfaces `meta.asOf = { year: latestLoadedYear,
  latestCompleteYear, refreshedAt: mv refresh ts }`. `latestLoadedYear` =
  `MAX(reporting_year)` resolved at boot **and** re-read on a short TTL (facts are
  append-mostly within a year; the latest month grows during the month). **The
  default-year for annual summaries/rankings binds to `latestCompleteYear`** (the
  newest year whose 12 months are loaded — 2025 today, since 2026 is partial m1–5)
  so "show me the budget" doesn't silently return a partial-year picture;
  month/quarter time-series and "current" views use `latestLoadedYear`. Both are
  surfaced so the client can label partial periods.
- **Cache invalidation (§14.11):** TTL by default (table above) **plus** a
  per-domain loader-completion version stamp if `system_control`/`etl` exposes one;
  if not (interim — state explicitly), TTL-only, with the MV refresh timestamp as
  the surfaced watermark. MV-backed endpoints get longer TTLs (300 s) since MVs only
  change on refresh; fact lists get 60 s.
- **Mutable rows:** within a reporting year, monthly YTD rows are recomputed (not
  appended) — the unique `(year, report_type, account_category, report_id,
  line_key)` index means upserts converge; the server need only respect `asOf` and
  let TTL expire. No "as-of historical snapshot" API in v1 (deferred).

---

## 11. Wiring

```ts
// src/modules/budget/index.ts
export const makeBudgetModule = (deps: {
  db: Kysely<ProdDatabase>;
  identityRepo: IdentityRepo;      // kernel (CUI resolution + pg_trgm)
  territoryRepo: TerritoryRepo;    // kernel (SIRUTA hub, Bucharest special-case)
  cache: Cache; clock: Clock; capabilities: SearchCapabilities;
}): BudgetModule => ({ restPlugin, graphql: { typeDefs, resolvers }, mcpTools,
   contributor: makeBudgetContributor(repo), repos: { budgetRepo, discoveryRepo } });
```

- **Deps:** kernel db + identity/territory repos + cache + capabilities. No source
  imports. `build-app.ts` constructs it, registers REST plugin under
  `/api/v1/budget`, merges GraphQL slice, registers MCP tools, registers the
  contributor (`source: 'budget'`) into the kernel registry, and registers
  `FLOW_TYPES.budget_execution` + `DOC_TYPES.{budget_entity,budget_report}`.
- **Env additions:** none beyond kernel (`PROD_DATABASE_URL`, pool/limit knobs).
  Budget-specific knobs (optional): `BUDGET_DEFAULT_YEAR` override,
  `BUDGET_FACT_STMT_TIMEOUT_MS`. Module feature-flag: `MODULES` env list.
- **Legacy superseded (all):** `budget-sector`, `execution-line-items`,
  `aggregated-line-items`, `commitments`, `execution-analytics`, `county-analytics`,
  `funding-sources`, `classification`, `report`, and `entity`'s
  `entity-analytics-repo` (the SQL factors-CTE moves to `shared/` analytics). The
  legacy `infra/database/query-filters/` DSL is **generalized into the kernel**
  (§14.2) — its builders (period tuple, code prefix, exclusion NULL-safety, amount
  column-by-frequency) are the proven seed. Legacy modules keep running during
  transition (fresh `Budget*` types/prefixes don't collide, §10 foundation).

---

## 12. Testing

- **Unit** (`tests/unit/budget/`): usecases with mocked ports; **filter spec → SQL
  compilation snapshot tests** (assert the §0.3 pruning triple literals appear in
  WHERE order; assert no fact query lacks year+report_type+account_category; assert
  MV routing for entity/period-only filters); `canonicalizeFilters` determinism
  (same `fhash` for reordered arrays); cursor encode/decode + `fhash` mismatch →
  `InvalidInput`; the enum↔partition-literal map; transfer-exclusion **not**
  re-applied on MV reads.
- **Integration** (`tests/integration/budget/`): REST + GraphQL + MCP against a
  seeded fixture schema (a few entities × 2 years × vn/ch, the 6 MVs populated);
  **tri-surface equivalence** — identical filters yield identical data across REST/
  GraphQL/MCP (via `canonicalizeFilters`); pagination correctness (cursor keyset
  vs offset); capability-gating (empty `bgc_official_facts` → `caveats`, not error).
- **Golden filters** (§7.6): the catalog questions as fixtures, each with expected
  normalized filters + an independent SQL recomputation on the frozen snapshot
  (Aggregate Accuracy Gate) + expected coverage/denominator + refusal cases
  (unbounded scan, mixed grain, region without coverage).
- **Perf guard:** an EXPLAIN test asserting fact-list/aggregate plans show
  `Index Scan`/partition pruning to ≤1 leaf (no `Seq Scan` over the parent, no
  all-partition append).

---

## 13. Open questions / risks

1. **Budget in `flows.money_flows` (deferred, scrapper-owned).** Budget facts are
   not projected into the cross-source flow graph yet. Until the scrapper `flows`
   lane adds `budget_execution` flows, entity-360 shows budget only via the native
   `profileSlice` (summary), not as flow edges. **Decision needed:** is a budget→
   flow projection in scope for v1, or is summary-only entity-360 acceptable? (I
   recommend summary-only for v1 — budget is a balance-sheet grain, not a
   payer→payee transaction grain; forcing it into `money_flows` risks the grain-mix
   the §14.6 gate forbids.)
2. **`bgc_official_facts` / `quarterly_allocations` empty (extract defect).** The
   `/budget/official/*` endpoints ship capability-gated. Risk: client shows an
   empty "vs budget" surface. Mitigation: the gate returns explicit `caveats`;
   document as known. **Verified live 2026-06-16: `SELECT count(*) FROM
   budget.execution_vs_budget` = 0** — the view's FROM is `bgc_official_facts`
   (LEFT JOIN approved), so with bgc empty the view returns **zero rows**, NOT
   "approved with null execution." Therefore `/budget/official/vs-execution` is
   **fully empty** until the bgc extract is fixed; the capability gate keys on
   `bgc_official_facts` row count (not `approved_budget_facts`) and returns
   `{ data: [], caveats: ['budget-official execution bulletins not yet loaded;
   vs-execution comparison unavailable'] }`. `approved_budget_facts` (3.3M) IS
   available, so `/budget/official/approved` works on its own.
3. **`search.documents` budget projection deferred.** Autocomplete uses the kernel
   identity hub fallback. Risk: budget entities not in global search until the
   search lane writes `budget_entity` docs. Acceptable (discovery tool covers it).
4. **Default-year + within-month mutability.** The latest reporting month grows
   during the month; cached fact lists may lag by the TTL. Acceptable (60 s) but
   surfaced via `asOf`. **No historical as-of API in v1.**
5. **Ranking estimated totals.** Cursor + planner-estimate total on rankings means
   the UI total is approximate for very large filtered sets (§14.4). The legacy
   exact `COUNT(*) OVER()` is intentionally dropped (it was the 126M-row hazard);
   confirm the client tolerates `{ total, estimated: true }`.
6. **`report_type` enum vs partition literal coupling.** If the loader ever adds a
   4th report type, the enum + `REPORT_TYPE_LABELS` map + the default partition
   absorb it, but the enum needs a new value (and a `_default` leaf already exists
   so no data loss). Tracked: enum is closed; new literal → falls to `_default`
   leaf + surfaces as `caveats: ['unmapped report type']`.
7. **`bgc_reconciliation` exposure.** Currently only a quality signal, not a
   collection. Confirm no client needs the reconciliation residuals as a queryable
   surface (else add a small read-only endpoint).
