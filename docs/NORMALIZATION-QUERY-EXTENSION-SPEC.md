# Normalization Extension for Entity + Line Item Queries

## Goal

Extend the existing normalization system (mode, currency conversion, inflation adjustment, percent GDP, per-capita, growth) to the **Entity page queries** beyond `entityAnalytics` / `executionAnalytics`, while keeping backwards compatibility with the existing `Normalization` enum (`total`, `total_euro`, `per_capita`, `per_capita_euro`, `percent_gdp`).

This spec covers the missing/partial normalization behavior for the following client queries:

- `GetEntityDetails`:
  - `entity.totalIncome`
  - `entity.totalExpenses`
  - `entity.budgetBalance`
  - `entity.incomeTrend`
  - `entity.expensesTrend`
  - `entity.balanceTrend`
- `GetEntityLineItems`:
  - `entity.executionLineItems(...)`
- `GetExecutionLineItemsAnalytics`:
  - `executionAnalytics(inputs: ...)` (alignment fixes)

## Current State (What Exists Today)

### Entity totals/trends (partial normalization)

Implemented in `src/modules/entity/shell/graphql/resolvers.ts`.

- Accepts `normalization: Normalization` only.
- Applies:
  - Currency conversion for `total_euro` / `per_capita_euro` (EUR only)
  - `% GDP` for `percent_gdp`
  - Per-capita by dividing by entity population (UAT or county council)
- Missing:
  - `currency` selection (USD, explicit `Currency`)
  - `inflation_adjusted`
  - `show_period_growth` (for trends)
  - Correct frequency usage for non-year totals (totals normalize using `Frequency.YEAR` even when period is MONTH/QUARTER)

### Entity executionLineItems (partial normalization + performance)

Implemented in `src/modules/entity/shell/graphql/resolvers.ts`.

- Supports legacy normalization passed either:
  - as field arg `executionLineItems(normalization: ...)`, or
  - inside the `filter` object (`filter.normalization`) for backwards compatibility
- Applies only legacy `Normalization` enum (mode + EUR legacy mapping).
- Ignores `filter.currency` and `filter.inflation_adjusted` even though `AnalyticsFilterInput` defines them.
- Normalizes by calling `normalizationService.normalize()` **per item per column**, which is expensive for large `limit` (e.g. 15k).
- Uses yearly labels/frequency (`"YYYY"`, `Frequency.YEAR`) even for monthly/quarterly columns, which prevents frequency-matched factors.

### Root executionLineItems query (partial normalization)

Implemented in `src/modules/execution-line-items/shell/graphql/resolvers.ts`.

- Has separate arg `normalization: Normalization` at query level, but ignores `filter.currency` / `filter.inflation_adjusted`.
- Per-capita intentionally unsupported at root query level (no entity context).

### executionAnalytics normalization (needs alignment)

Implemented in `src/modules/execution-analytics/core/usecases/get-analytics-series.ts`.

Two correctness/consistency gaps:

1. **`percent_gdp` unit mismatch**:
   - Dataset `datasets/yaml/economics/ro.economics.gdp.yearly.yaml` is in **RON**, not **million RON**.
   - Current code multiplies GDP by `1_000_000`, which underestimates `% GDP` by 1e6.
2. **Inflation adjustment factor model**:
   - CPI dataset `datasets/yaml/economics/ro.economics.cpi.yearly.yaml` is a **year-over-year index** (e.g., `105.59` meaning +5.59%).
   - Implementations must derive a consistent **reference-year price level** (e.g., 2024) before computing real-value multipliers.

## Target Behavior (What We Want)

### Shared normalization options model

Across the listed queries, normalization should support the same option set:

- `normalization` (mode): `total | per_capita | percent_gdp`
- `currency`: `RON | EUR | USD` (ignored for `% GDP`)
- `inflation_adjusted`: boolean (ignored for `% GDP`)
- `show_period_growth`: boolean (trends only; returns growth % instead of amounts)

### Backwards compatibility rules

Clients may continue using the legacy `Normalization` enum:

- `total` → mode `total`, currency default `RON`
- `total_euro` → mode `total`, currency `EUR`
- `per_capita` → mode `per_capita`, currency default `RON`
- `per_capita_euro` → mode `per_capita`, currency `EUR`
- `percent_gdp` → mode `percent_gdp` (currency ignored)

If an explicit `currency` is provided (via new arg or filter field), it overrides the legacy-derived currency for `total`/`per_capita` modes.

### Entity totals/trends

- Add optional GraphQL args:
  - For totals: `currency`, `inflation_adjusted`
  - For trends: `currency`, `inflation_adjusted`, `show_period_growth`
- Use frequency-matched factors:
  - YEAR → `"YYYY"`
  - QUARTER → `"YYYY-QN"`
  - MONTH → `"YYYY-MM"`
- Trends: set y-axis metadata based on options:
  - Growth: `%`
  - `% GDP`: `% of GDP`
  - Otherwise: `${currency}` plus `/capita` when per-capita, and suffix for real terms when inflation-adjusted.

### executionLineItems (Entity field and root query)

- Respect `filter.currency` and `filter.inflation_adjusted` (and legacy normalization enum).
- Batch-normalize (per column) rather than per item:
  - Normalize all `ytd_amount` points (YEAR frequency)
  - Normalize all `monthly_amount` points using `"YYYY-MM"` labels (MONTH frequency)
  - Normalize all `quarterly_amount` points using `"YYYY-QN"` labels (QUARTER frequency)
- Per-capita:
  - Entity field: divide by entity population (UAT/county council)
  - Root query: remain unsupported (documented), but still allow currency/inflation/%GDP.

## Implementation Plan (Concrete Steps)

### 1. Add a shared “normalization request” resolver

Create a helper (module-local or common) that maps:

- legacy `Normalization` enum (optional)
- explicit `currency` (optional)
- `inflation_adjusted` / `show_period_growth` (optional)

to:

- `TransformationOptions` for `NormalizationService`
- a boolean `isPerCapita` flag (to apply population division separately where needed)

### 2. Entity GraphQL schema updates

Update `src/modules/entity/shell/graphql/schema.ts`:

- Add `currency` and `inflation_adjusted` args to `totalIncome`, `totalExpenses`, `budgetBalance`
- Add `currency`, `inflation_adjusted`, `show_period_growth` to trend fields

All new args are optional to keep compatibility.

### 3. Entity resolver updates

Update `src/modules/entity/shell/graphql/resolvers.ts`:

- Parse normalization options consistently for totals/trends.
- Apply inflation adjustment + USD conversion where requested.
- For trends, pass `showPeriodGrowth` into `NormalizationService.normalize(...)`.
- For per-capita, apply population division after the base normalization pipeline (to avoid using country-level population dataset).
- Use correct period frequency/labels for normalization.

### 4. execution-line-items resolver updates

Update `src/modules/execution-line-items/shell/graphql/resolvers.ts`:

- Read `args.normalization` and/or `args.filter.normalization` (compat)
- Read `args.filter.currency`, `args.filter.inflation_adjusted` (new)
- Batch-normalize by column using the normalization service.

### 5. Fix percent_gdp and inflation math alignment

- `executionAnalytics`: remove the `* 1_000_000` GDP scaling and treat GDP dataset as RON.
- Define a single CPI interpretation for inflation adjustment:
  - Derive reference-year price level (e.g., 2024) from year-over-year CPI index series.
  - Use `real = nominal * (priceLevelRef / priceLevelYear)`

### 6. Tests

Add/update unit tests to cover:

- Legacy enum mapping vs explicit `currency` override
- Inflation-adjusted normalization path (sanity: factor > 1 for years before reference)
- Batch line-item normalization preserves ordering and handles missing quarterly values
- `% GDP` output scales correctly (no 1e6 error)

Suggested targets:

- `tests/unit/entity/execution-line-items-normalization.test.ts`
- `tests/golden-master/specs/execution-analytics.gm.test.ts` (only if necessary)

## Non-Goals / Out of Scope

- SQL-level pagination correctness when ordering by normalized amounts across multiple years (see `docs/PAGINATION-NORMALIZATION-PROBLEM.md` and `docs/SQL-LEVEL-NORMALIZATION-SPEC.md`).
- Historical, per-entity population time series (per-capita currently uses current population from DB for entities).
