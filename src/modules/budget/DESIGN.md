# Budget module — design notes

GraphQL + MCP surface (no REST) over live read-only `transparenta_prod`. Conforms
to `docs/server-redesign/02-budget.md` (binding, esp §0) + `00-foundation`. The
largest, partitioned domain: `budget.execution_line_items` ≈ 126.8M rows (3-level
RANGE(year)→LIST(report_type)→LIST(account_category)); `commitment_line_items` ≈
32.6M (2-level); 6 summary MVs.

## The two load-bearing invariants

1. **Partition pruning (§0.3).** Every FACT query supplies `(reporting_year,
report_type, account_category)` literals FIRST so the planner prunes to ONE
   leaf. The surface exposes CLEAN enums; `constants.ts` maps enum→partition
   literal at the repo boundary (verified live). `resolveExecutionGate` /
   `resolveCommitmentGate` enforce the gate and reject year-less queries
   ("unbounded budget scan"). EXPLAIN-proven: a pruned read hits exactly one
   `…_yYYYY_rtN_{vn|ch}` leaf via the partial period-scope index.
2. **MV-first rollup (§0.4).** Summaries/rankings/timeseries/heatmap read the 6
   MVs, never the 126M facts. Execution MVs pre-pivot vn/ch into
   `total_income`/`total_expense`/`budget_balance`, so MV reads filter on
   `(year, report_type)` only and select the COLUMN from the metric (INCOME→
   total_income …). **No `account_category` predicate on an MV read** (the column
   does not exist). Transfer exclusions are baked into the MVs — never re-applied
   on MV reads; the fact path has an opt-in `excludeTransfers` using the exact
   same code set (`BUDGET_TRANSFER_EXCLUSIONS`).

## The kernel-spec split (the prune-safety fix)

The kernel `toConditionBuilders` applies a field's `default` for ANY absent field.
The fact spec defaults `reportType`/`accountCategory`/`frequency` (for surface
generation), but those map to partition LITERALS / a virtual column — a kernel-
compiled `report_type = 'EXECUTION_DETAILED'` matches zero rows and breaks pruning.
Fix: the repo composes with a **kernel-spec variant** (`budgetFactKernelSpec`,
`budgetCommitmentFactKernelSpec`, `budgetRankingKernelSpec`) that DROPS the repo-
intercepted fields; the FULL spec is still used for GraphQL/TypeBox + the `fhash`.
`BUDGET_FACT_VIRTUAL_FIELDS` is the intercepted set.

## Deviations from the plan (verified live 2026-06-17)

- **Classification catalogs are EMPTY in prod** (`functional_classifications`,
  `economic_classifications` = 0 rows). Names are denormalized on the facts. So
  the dimension-list endpoints return `[] + caveat`, and `functional`/`economic`
  resolve is code-prefix-only (a name query returns empty, not a 126M-row scan).
  `budget_sectors`(5) + `funding_sources`(10) ARE populated.
- **`bgc_official_facts` / `quarterly_allocations` / `execution_vs_budget` view = 0
  rows.** `/vs-execution` is capability-gated empty + caveat (the gate keys on
  `bgc_official_facts` presence, the view's FROM). `approved_budget_facts` (3.37M)
  works standalone.
- Latest loaded year 2026 (m1–5 partial); latest COMPLETE year 2025. Annual
  summaries/rankings default to `latestCompleteYear`; `asOf()` reads the small MVs
  (NOT the 126M facts) and is only called when no year bound is supplied.

## Multi-model review fixes incorporated (Codex gpt-5.5 xhigh + GLM-5.1 high)

- P0: monthly commitment summary selected a non-existent column for the 9 metrics
  the monthly MV lacks → now returns `null` for those (`MONTHLY_COMMITMENT_METRICS`).
- Commitment metric enum narrowed to the 4 frequency-safe metrics.
- Commitment-list cursor key now frequency-aware (`${freq}_${metric}`), matching
  the repo sort column (was always `ytd`).
- Timeseries normalization moved into `numeric` SQL (`factorCaseExpr`) — no JS
  float precision loss on large sums.
- Aggregate applies the normalization factor (numeric SQL); per-capita rejected
  (no bucket-grain population); non-TOTAL requires a single `reportingYear`.
- Commitment ASC cursor null-section made symmetric (reachable + no dup).
- `Entity.budget` batched through a per-tick DataLoader (no N+1 on entity lists).

## Funding-source id convention (A1 — ANAF_EXTRANET_REVIEW §A1)

Prod mints `budget.funding_sources.source_id` as an arbitrary IDENTITY surrogate
(assigned in DISTINCT-scan arrival order), which BROKE the phoenix convention where
the numeric id equals the ANAF letter-code ordinal (A=1 … J=10). The stable
convention survives only in `source_code`. A bookmarked `fundingSourceIds=2` (phoenix:
Credite externe / B) would silently select the wrong source once the API points at
`transparenta_prod`. The fix is a serving-boundary translation — no fact rewrite:

- **`sourceId` is the LEGACY convention key** — reproduced deterministically by the
  scrapper view `budget.v_funding_sources_compat`
  (`row_number() over (order by source_code)` → the phoenix A..J ordinal + a
  0=Unknown row). `listFundingSources` reads that view; fact rows expose
  `fundingSourceId` as the CONVENTIONAL id (`funding-source-map.ts` translates the
  stored `funding_source_id` column → public id, O(1)/row via a cached dim map).
- **`sourceCode` (A..J) is the DURABLE public key.** Clients should filter with the
  additive `fundingSourceCodes: [String!]` input (matched on the inline
  `funding_source` letter column — no id translation) and treat the numeric id as a
  legacy compatibility field. `fundingSourceIds` stays supported: PUBLIC ids are
  translated to the stored column value before SQL (unknown public id → empty set).
- **Deploy-order dependency (cutover prerequisite):** the module depends on
  `budget.v_funding_sources_compat` existing in whatever DB `BUDGET_DATABASE_URL`
  targets. Deploy the scrapper migration `20260709T170000` BEFORE repointing the API
  at `transparenta_prod`. Convention pin: the `order by source_code` projection
  reproduces phoenix only while new ANAF codes stay alphabetically sequential
  (A..J → K → …); re-validate if a non-sequential code appears. It also assumes
  ONE dim row per `source_code` (the table is unique on
  `(source_code, source_description)`, not on code alone) — a description drift that
  creates a 2nd row for a code would shift the projected ids; re-validate then.

## Deferred (flagged, scrapper-owned)

- Budget facts not yet in `flows.money_flows` (`budget_execution` flow_type
  declared; contributor flow slice gated empty — entity-360 budget is summary-only).
- Budget facts not yet in `search.documents` (`budget_entity`/`budget_report`
  doc_types declared; autocomplete falls back to the kernel identity hub pg_trgm).
- The embedded CPI/FX/GDP factor tables in `analytics.ts` are interim until a
  serving reference-data port exposes them.
- Multi-year fact reads (`reportingYear` IN/between) prune to multiple leaves
  (still pruned, but not single-leaf); cross-year aggregates should prefer the MVs.

## Golden anchor (tests)

MUNICIPIUL CLUJ-NAPOCA, CUI `4305857` (UAT, default report type AGG_PRINCIPAL).
2025 DETAILED MV: income `2371025424.36` / expense `1522424280.79` / balance
`848601143.57`. Its entity-360 slice uses AGG_PRINCIPAL (expense `2259241251.68`).
