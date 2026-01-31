# Commitments API - Implementation Plan

**Status**: Draft
**Date**: 2026-01-29
**References**:

- `docs/specs/specs-commitments-api.md`
- `src/infra/database/budget/schema.sql`

## 1. Scope & Principles

Implement the GraphQL API described in `docs/specs/specs-commitments-api.md`:

- `commitmentsSummary`
- `commitmentsLineItems`
- `commitmentsAnalytics`
- `commitmentsAggregated`
- `commitmentVsExecution`

Implementation constraints (repo conventions):

- `core/` returns `Result<T, E>` (`neverthrow`), no throws.
- Use `decimal.js` for calculations; convert to JS numbers only at GraphQL boundary.
- Prefer MV-backed reads when valid per spec; auto-fallback to fact-table when required.
- Follow patterns from `src/modules/execution-analytics/`, `src/modules/aggregated-line-items/`, `src/modules/execution-line-items/`.

Decisions adopted (from spec + your follow-up recommendations):

- Rates:
  - `execution_rate = (plati_trezor / credite_bugetare_definitive) * 100`
  - `commitment_rate = (credite_angajament / credite_angajament_definitive) * 100`
  - compute for QUARTER and YEAR summaries only; return `null` when denominator is 0 (or missing)
- `commitmentVsExecution`:
  - always join at month grain, then roll up to requested frequency (MONTH/QUARTER/YEAR)
  - `report_type` required (deterministic cross-table comparison)
  - metric is client-selectable, default `PLATI_TREZOR`
- `report_type` requirement:
  - required for `commitmentsLineItems` and `commitmentVsExecution`
  - optional (fallback allowed) for `commitmentsSummary`, `commitmentsAnalytics`, `commitmentsAggregated`
- `show_period_growth`:
  - honored for `commitmentsAnalytics` and `commitmentVsExecution`
  - ignored for `commitmentsSummary`, `commitmentsLineItems`, `commitmentsAggregated`

## 2. Ground Truth: Database Objects We Will Use

From `src/infra/database/budget/schema.sql`:

- Fact table: `angajamentelineitems`
  - Keys: `year`, `month`, `report_type`, `line_item_id`
  - Dimensions: `entity_cui`, `main_creditor_cui`, `budget_sector_id`, `funding_source_id`, `functional_code`, `economic_code`
  - Period flags: `is_quarterly`, `quarter`, `is_yearly`
  - Metrics:
    - YTD: 13 columns
    - Monthly deltas: 5 columns
    - Quarterly deltas: 13 `quarterly_*` columns

- Summary MVs:
  - `mv_angajamente_summary_monthly` (5 metrics only)
  - `mv_angajamente_summary_quarterly` (13 metrics, quarterly deltas)
  - `mv_angajamente_summary_annual` (13 metrics, latest YTD)

Transfer exclusion is hard-coded into all 3 MVs; fact-table must apply NULL-safe exclusion when `exclude_transfers = true`.

## 3. Work Plan (Phased)

### Phase 1 - Database Typings and Shared Types

1. Extend Kysely budget DB typings:

- Update `src/infra/database/budget/types.ts`:
  - Widen `ReportType` to include the 3 commitments enum labels (the DB enum includes both execution + angajamente values).
  - Add table typings:
    - `angajamentelineitems`
  - Add MV typings:
    - `mv_angajamente_summary_monthly`
    - `mv_angajamente_summary_quarterly`
    - `mv_angajamente_summary_annual`
  - Add these to `BudgetDatabase`.

2. Add shared domain utilities:

- Create `src/common/types/commitments.ts`:
  - DB report type strings (3) + GraphQL enum values (3) + mapping.
  - Metric mapping:
    - period + metric -> DB column (monthly*\*, quarterly*\*, or base YTD)
  - `isMetricAvailableForPeriod(metric, periodType)` per spec (MONTH supports 5; QUARTER/YEAR supports 13).
  - `shouldUseMV(filter)` per routing decision in spec (classification filters, exclude-by-code, sector/source filters, per-item thresholds, `exclude_transfers=false` => fact-table).

Acceptance:

- `pnpm typecheck` passes after typing additions (no implementation yet).

### Phase 2 - GraphQL Schema + Module Skeleton

1. Create module structure:

- `src/modules/commitments/core/` (errors/types/ports/usecases)
- `src/modules/commitments/shell/graphql/` (schema + resolvers)
- `src/modules/commitments/shell/repo/` (Kysely repo)
- `src/modules/commitments/index.ts` (public API)

2. Define missing GraphQL contract types (spec references them but does not spell them out):

- `CommitmentsExcludeInput`
- `CommitmentsSummaryConnection` (`nodes` + `PageInfo`)
- `CommitmentsLineItemConnection` (`nodes` + `PageInfo`)
- `CommitmentsAnalyticsInput`, `CommitmentsAnalyticsSeries`
- `CommitmentsAggregatedInput`, `CommitmentsAggregatedConnection`
- `CommitmentExecutionComparisonInput` (include `commitments_metric: CommitmentsMetric = PLATI_TREZOR`)
- `CommitmentExecutionDataPoint`

3. Avoid duplicate GraphQL type names:

- Reuse existing `AnomalyType` enum if already present in the composed schema (currently defined in execution-analytics).

4. Register schema + resolvers in `src/app/build-app.ts`.

Acceptance:

- App builds and schema composes (even if repos return "not implemented" errors initially).

### Phase 3 - Repository: Summary + Analytics

Implement `CommitmentsRepository` with MV/fact-table routing:

1. `commitmentsSummary(filter, limit, offset)`

- Determine frequency from `filter.report_period.type` (MONTH/QUARTER/YEAR).
- Choose data source:
  - MV when allowed by `shouldUseMV(filter)`
  - otherwise fact-table aggregation.
- Report type:
  - If explicit `report_type`, filter directly.
  - If omitted, resolve using fallback priority per `(entity_cui, year)` and allow mixed types across results (spec decision 4.1).
    - MV path: query MV without report_type filter and prune in application (safe because MV result set is small).
    - Fact-table path: pre-resolve report_type per `(entity, year)` first, then query with those constraints.
- Apply amount thresholds semantics (spec decision 4.5):
  - `aggregate_*_amount` applies to aggregated `plati_trezor`.
  - `item_*_amount` forces fact-table; apply as row-level filter on the row’s period-appropriate `plati_trezor` value.
- Compute:
  - `total_plati = plati_trezor + plati_non_trezor`
  - `execution_rate` and `commitment_rate` per adopted formulas (QUARTER/YEAR only; `null` on div-by-zero).
- Apply transforms:
  - When requested, apply normalization to all monetary metric fields in the returned rows.
  - Ignore `show_period_growth` (this is not a time series; the flag is treated as a no-op).

2. `commitmentsAnalytics(inputs)`

- Validate metric availability for period (MONTH only supports 5 metrics).
- Route MV vs fact table per `shouldUseMV(filter)`.
- Return series shape consistent with execution analytics (Axis + data points).
- Apply transforms consistently (normalization, currency, inflation, per_capita, percent_gdp, growth).

Acceptance:

- Integration tests for MV-backed monthly/quarterly/year summary.
- Integration tests for MONTH + invalid metric error.

### Phase 4 - Repository: Line Items + Aggregated

1. `commitmentsLineItems(filter, limit, offset)`

- Always fact-table.
- Enforce `filter.report_type` required; return validation error if omitted.
  - Note: `CommitmentsFilterInput.report_type` is optional in the shared filter type; we will enforce this constraint at runtime.
  - Alternative (stricter schema): introduce `CommitmentsLineItemsFilterInput` with `report_type: CommitmentsReportType!` and use it only for this query.
- Apply period flags first for index use:
  - YEAR => `is_yearly = true`
  - QUARTER => `is_quarterly = true`
  - MONTH => no flag
- Apply report_period selection constraints (tuple filtering for (year,month) and (year,quarter) like execution-line-items).
- Apply optional filters:
  - report_type (required; no fallback)
  - entity_cuis / main_creditor_cui
  - sector/source, classifications, exclusions, geography (join entities/uats as needed)
- Join dimensions for names as per output type:
  - entities, budgetsectors, fundingsources, functionalclassifications, economicclassifications.
- Apply transfer exclusion depending on `exclude_transfers` (NULL-safe).
- Apply `item_*_amount` to period-appropriate `plati_trezor` (spec decision 4.5).
- Enforce max limit (recommend 1000).
- Ignore `show_period_growth` (raw rows).

2. `commitmentsAggregated(input)`

- Aggregate by `(functional_code, economic_code)`; keep economic fields nullable.
- Amount column selection:
  - MONTH => use monthly delta columns (5 metrics only)
  - QUARTER => use `quarterly_*`
  - YEAR => use YTD columns
- Apply thresholds to selected metric (spec decision 4.5).
- Apply normalization pipeline to the aggregated amount only.
- Ignore `show_period_growth` (breakdown, not time series).

Acceptance:

- Integration tests for economic_code null handling.
- Pagination tests (`PageInfo.totalCount`, hasNext/hasPrevious).

### Phase 5 - commitmentVsExecution

Implement as a single query pipeline with pre-aggregation (spec decision 4.6):

0. Enforce required inputs:

- `filter.report_type` is required.
- `commitments_metric` is optional, default `PLATI_TREZOR`.
- Validate `commitments_metric` is available for the requested period (MONTH supports only the 5 monthly metrics).
  - Note: `CommitmentsFilterInput.report_type` is optional; we will enforce this constraint at runtime for this query.
  - Alternative (stricter schema): introduce `CommitmentExecutionComparisonFilterInput` with `report_type: CommitmentsReportType!`.

1. Pre-aggregate both sides to the join keys:

- Commitments: sum selected metric per `(year, month, entity_cui, main_creditor_cui, report_type, functional_code, economic_code, budget_sector_id, funding_source_id)`.
- Execution: sum expenses per same key set, with `account_category = 'ch'` and report_type mapped.

2. FULL OUTER JOIN on the join keys (NULL-safe on nullable keys via `IS NOT DISTINCT FROM`).

3. Produce:

- Always compute month-grain joined results first, then roll up to requested frequency:
  - MONTH: group by `(year, month)`
  - QUARTER: group by `(year, quarter)` derived from month
  - YEAR: group by `year`
- totals and difference:
  - treat missing side as 0 for arithmetic totals (while still tracking unmatched counts)
  - `difference = commitment_value - execution_value`
  - `difference_percent = (difference / commitment_value) * 100`, `null` when `commitment_value = 0`
  - `overall_difference_percent` computed from totals using the same denominator choice
  - TODO(review): confirm this denominator choice remains aligned with product copy/UX (an execution-denominator variant answers a different question).
  - Trade-off: using commitment as denominator aligns with "how much of commitment is not executed"; using execution as denominator answers a different question ("how much execution exceeds commitment").
- match counts (matched/unmatched).

4. Apply transforms:

- Apply normalization at month-grain first (frequency = MONTH), then roll up.
  - Trade-off: this is more correct for monthly exchange rates / partial quarters, but it costs more CPU than applying yearly factors on rolled-up totals.
- When `show_period_growth = true`, compute growth percentages for the time series output (see note below).

Growth behavior for comparison (implementation choice to document):

- We will not change the meaning of `commitment_value` / `execution_value`.
- We will add optional fields to `CommitmentExecutionDataPoint`:
  - `commitment_growth_percent`, `execution_growth_percent`, `difference_growth_percent`
  - each computed period-over-period on the corresponding value (NULL when previous is 0).
  - Trade-off: adds schema surface area, but avoids reinterpreting existing fields as growth.
  - TODO(review): ensure GraphQL schema additions are acceptable (if not, fall back to "transform existing fields" approach behind the flag).

Acceptance:

- Integration test that proves no row multiplication and match counts behave as expected on a fixture dataset.

### Phase 6 - Caching + Composition

1. Add cache namespaces to `src/infra/cache/key-builder.ts` per spec’s caching table.
2. Add cached wrappers in `src/app/cache-wrappers.ts` for:

- summary (MV vs fact-table should be part of key)
- line items
- analytics
- aggregated
- commitment vs execution
- report type resolution helper (optional but recommended)

3. Wire wrapped repo in `src/app/build-app.ts`.

Acceptance:

- Repeated identical queries hit cache (manual verification + unit test on key generation).

### Phase 7 - Tests & Rollout

- Unit tests:
  - `isMetricAvailableForPeriod`
  - MV routing (`shouldUseMV`)
  - report type fallback priority selection
- Integration tests:
  - one per endpoint (happy path) + at least one validation error case
- (Optional) Golden-master snapshots if these endpoints are included in the golden-master suite.

## 4. Risks & Mitigations

- **Report type fallback on large scopes**: resolving per `(entity, year)` may add a pre-query; mitigate with caching and guardrails (limit number of pairs).
- **Fact-table fallback performance**: mitigate with strict period constraints, `statement_timeout`, and forcing `is_yearly/is_quarterly` predicates early.
- **Normalization on multi-metric outputs**: can be CPU-heavy; mitigate by applying transforms only when requested and by reusing factor maps per request.

## 5. Open Questions (Only If You Want to Refine Behavior)

1. For `commitmentVsExecution`, should we also allow omitting `filter.report_type` and applying the same fallback logic as summary/analytics (at the cost of more pre-queries), or keep it strictly required as decided?
2. For the comparison growth fields, do you prefer the additional optional fields approach (documented above), or should we instead return growth-transformed values in the existing fields when `show_period_growth=true`?
