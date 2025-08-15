## Unified Analytics Filter Specification

### Objective

Provide a single, consistent filter input to power all client analytics views so users can switch seamlessly between:

- Map (UAT heatmap and county/județ heatmap)
- Table (entity analytics ranking)
- Charts (totals and trends)
- Line-item lists

This single filter object lives in UI state and is reused across views without rebuilding payloads.

### Design principles

- One filter type for all analytics endpoints
- Strongly typed, array-only for multi-select dimensions
- Exactly one budget category per query
- Clear separation of per-item thresholds vs aggregated thresholds
- View-specific fields remain optional; repositories ignore unsupported fields
- Missing/null population is treated as 0 for thresholds and normalization

### GraphQL schema

```graphql
enum ExpenseType {
  dezvoltare
  functionare
}

enum Normalization {
  total
  per_capita
}

input AnalyticsFilterInput {
  # Required scope
  years: [Int!]!
  account_category: AccountCategory!          # single required: vn or ch

  # Line-item dimensional filters (WHERE on ExecutionLineItems or joined dims)
  report_ids: [ID!]
  report_type: String                     # values from DB enum report_type
  reporting_years: [Int!]
  entity_cuis: [String!]
  functional_codes: [String!]
  functional_prefixes: [String!]
  economic_codes: [String!]
  economic_prefixes: [String!]
  funding_source_ids: [ID!]
  budget_sector_ids: [ID!]
  expense_types: [ExpenseType!]
  program_codes: [String!]

  # Geography / entity scope (joins to Entities/UATs)
  county_codes: [String!]
  regions: [String!]                          # UATs.region; primarily for heatmaps
  uat_ids: [ID!]
  entity_types: [String!]
  is_uat: Boolean
  search: String                              # pg_trgm/ILIKE on entity name

  # Population constraints (missing population is treated as 0)
  min_population: Int
  max_population: Int

  # Transform and aggregated thresholds (HAVING on aggregated measure)
  normalization: Normalization                # 'total' or 'per_capita'
  aggregate_min_amount: Float
  aggregate_max_amount: Float

  # Per-item thresholds (WHERE on eli.amount)
  item_min_amount: Float
  item_max_amount: Float
}
```

### Field semantics

- years: Required, non-empty. Applies to `ExecutionLineItems.year`.
- account_category: Required single value, one of {vn, ch}. No mixing within a single query.

- report_ids: Optional. Filters `eli.report_id IN (...)`.
- report_type: Optional. Filters `eli.report_type = '...'`. Value must match DB enum `report_type` strings.
- reporting_years: Optional. Filters `Reports.reporting_year IN (...)` (requires join).
- entity_cuis: Optional. Filters `eli.entity_cui IN (...)`.
- functional_codes/economic_codes: Exact code filters.
- functional_prefixes/economic_prefixes: Prefix match using `LIKE prefix%`.
  - If both codes and prefixes are provided for the same dimension, they are OR-ed within that dimension.
- funding_source_ids/budget_sector_ids/expense_types/program_codes: Direct filters on `eli.*`.

- county_codes: Optional. Filters by `UATs.county_code` via entity→UAT join.
- regions: Optional. Filters by `UATs.region` and honored by heatmaps.
- uat_ids: Optional. Filters by `Entities.uat_id`.
- entity_types: Optional. Filters by `Entities.entity_type`.
- is_uat: Optional. Filters by `Entities.is_uat`.
- search: Optional. Text search against entity name (ILIKE/pg_trgm). Applied in entity analytics; ignored elsewhere.

- min_population/max_population: Applied using population value with missing/null treated as 0.
  - UAT heatmap: `COALESCE(u.population, 0)`
  - County heatmap: county population expression; missing treated as 0
  - Entity analytics: entity-level population expression; missing treated as 0 for threshold checks

- normalization: Controls the aggregated amount returned:
  - total → `SUM(eli.amount)`
  - per_capita → `SUM(eli.amount) / population`, where population ≤ 0 (or null) yields per-capita amount 0

- aggregate_min_amount/aggregate_max_amount: HAVING constraints applied to the aggregated measure defined by `normalization`.
- item_min_amount/item_max_amount: WHERE constraints on per-line-item `eli.amount`.

### View behavior

#### 1) UAT heatmap (by UAT)

- Grouping: by UAT (`u.id`, `u.uat_code`, etc.).
- WHERE: years, account_category, functional/economic filters and prefixes, optional report_ids/report_type/reporting_years (JOIN Reports), entity_cuis, funding_source_ids, budget_sector_ids, expense_types, program_codes; geography (county_codes, regions), and explicit `uat_ids`. Population thresholds via `COALESCE(u.population, 0)`.
- HAVING: aggregate thresholds applied to either `SUM(eli.amount)` or `SUM(eli.amount) / NULLIF(COALESCE(u.population, 0), 0)`.
- Returned fields: total_amount, per_capita_amount, and `amount` matching `normalization`.

#### 2) County/Județ heatmap (by county)

- Grouping: by county (`u.county_code`, `u.county_name`).
- County population: computed using expression that identifies the county’s main administrative unit; missing treated as 0.
- WHERE: same filter set as UAT, including report/entity/program/funding filters, plus geography (county_codes, regions) and optional `uat_ids`.
- HAVING: aggregate thresholds per county; per-capita uses `NULLIF(population, 0)` in divisor and treats missing as 0.

#### 3) Entity analytics (ranked entities)

- Grouping: by entity and joined UAT attributes.
- Population expression:
  - If `e.is_uat = TRUE` → use `u.population`
  - If `e.entity_type = 'admin_county_council'` → use county population expression
  - Else → treat population as 0 for thresholds, and per-capita amount as 0
- WHERE: years, account_category, all dimensional and scope filters, per-item thresholds, search.
- HAVING: aggregate thresholds on `SUM(eli.amount)` or per-capita.
- Sorting: by aggregated `amount` by default; accepts sort overrides where supported.

#### 4) Line-item list

- WHERE: years, account_category, all dimensional/scope filters, per-item thresholds.
- Aggregated thresholds and normalization are ignored.

#### 5) Line-item totals/trends

- WHERE: same as list.
- Trends: group by `eli.year`.
- Aggregated thresholds are ignored to keep semantics predictable.

### Validation rules

- years is required and non-empty.
- account_category is required and must be one of {vn, ch}.
- normalization must be one of {total, per_capita}.
- population thresholds always use population with missing/null treated as 0.
- Codes vs prefixes: within each dimension (functional/economic), if both provided, combine with OR.

### Mapping to database schema (src/db/schema.sql)

- ExecutionLineItems (eli): report_id, report_type, entity_cui, budget_sector_id, funding_source_id, functional_code, economic_code, account_category, amount, program_code, expense_type, year
- Reports (r): report_id, reporting_year, report_type
- Entities (e): cui, name, entity_type, is_uat, uat_id
- UATs (u): id, uat_code, name, county_code, county_name, region, population

### Repository implementation notes

- Common WHERE fragments
  - years: `eli.year = ANY($::int[])`
  - account_category: `eli.account_category = $`
  - codes: `= ANY($::text[])`; prefixes: `LIKE ANY($::text[])` with `prefix%`
  - arrays for ids: `= ANY($::int[])` or `text[]` as appropriate
  - per-item thresholds: `eli.amount >= $` / `<= $`

- UAT heatmap (uatAnalyticsRepository)
  - Join: `eli` → `Entities e` → `UATs u` (by `e.cui = u.uat_code` or as implemented)
  - Population in WHERE: `COALESCE(u.population, 0)`
  - HAVING: use `SUM(eli.amount)` or `SUM(eli.amount) / NULLIF(COALESCE(u.population, 0), 0)`
  - Result amount: if per_capita, return per-capita; else total

- County heatmap (countyAnalyticsRepository)
  - Population expression returns 0 when not identifiable; reuse in WHERE/HAVING via `COALESCE(..., 0)`
  - Per-capita HAVING: divide by `NULLIF(population, 0)`; select per-capita with COALESCE to 0

- Entity analytics (entityAnalyticsRepository)
  - Add support for array filters: report_ids/reporting_years/program_codes
  - Prefix matching for functional/economic; codes and prefixes OR-ed within dimension
  - Entity scope and search via joins to Entities/UATs
  - Population expression per entity type; use `COALESCE(expr, 0)` in WHERE; per-capita uses `NULLIF(expr, 0)` and COALESCE result to 0
  - HAVING on aggregated or per-capita amount

- Line items (executionLineItemRepository)
  - Accept unified filter
  - Apply per-item thresholds in WHERE; ignore aggregate thresholds and normalization
  - Totals/trends: aggregate over WHERE results and group by year for trends

### Removed legacy fields

- Dropped singulars in favor of arrays and unified names: `account_categories`, `funding_source_id`, `budget_sector_id`, `county_code`, `program_code`, `report_id`, `report_type`, `reporting_year`, `year`, `start_year`, `end_year`, `min_amount`, `max_amount`.
- Use only the fields defined in `AnalyticsFilterInput` above.

### Examples

Per-capita expenses in 2023–2024 for education (functional prefix 65), limited to B & CJ counties:

```graphql
{
  years: [2023, 2024],
  account_category: ch,
  functional_prefixes: ["65"],
  normalization: per_capita,
  county_codes: ["B", "CJ"]
}
```

Entity analytics for county councils with aggregate threshold:

```graphql
{
  years: [2024],
  account_category: ch,
  entity_types: ["admin_county_council"],
  aggregate_min_amount: 1000000
}
```

Line-item list for revenue in 2024 with per-item threshold and economic prefix:

```graphql
{
  years: [2024],
  account_category: vn,
  economic_prefixes: ["20"],
  item_min_amount: 50000
}
```

Target specific entities by CUI:

```graphql
{
  years: [2024],
  account_category: ch,
  entity_cuis: ["12345678", "87654321"]
}
```

### Implementation plan

1) Schema updates (GraphQL)
- Add `Normalization` enum and `AnalyticsFilterInput` as defined above.
- Replace query args to use `AnalyticsFilterInput`:
  - `heatmapUATData(filter: AnalyticsFilterInput!)`
  - `heatmapCountyData(filter: AnalyticsFilterInput!)`
  - `entityAnalytics(filter: AnalyticsFilterInput!, sort: SortOrder, limit: Int, offset: Int)`
  - `executionLineItems(filter: AnalyticsFilterInput, sort: SortOrder, limit: Int, offset: Int)`
  - `executionAnalytics(inputs: [{ filter: AnalyticsFilterInput!, seriesId: String }!]!)`
- Remove legacy input types (`HeatmapFilterInput`, `ExecutionLineItemFilter`) and fields.

2) Shared TS types
- Create shared TS types in `src/types.ts`:
  - `export type NormalizationMode = 'total' | 'per_capita'`
  - `export type ExpenseType = 'dezvoltare' | 'functionare'`
  - `export interface AnalyticsFilter` matching the schema.

3) Repositories
- `entityAnalyticsRepository`
  - Switch filter type to `AnalyticsFilter`.
  - Update WHERE builder: equality for `account_category`, `years ANY`, arrays for ids/types/codes/prefixes, `program_codes ANY`, `reporting_years ANY` with Reports join.
  - Use `COALESCE(u.population, 0)` for population thresholds; per-capita uses `NULLIF(population, 0)` and `COALESCE(..., 0)` for results.
  - HAVING uses `aggregate_min_amount/aggregate_max_amount`.
- `uatAnalyticsRepository`
  - Switch to `AnalyticsFilter`.
  - Add support for prefixes, arrays for ids/types, regions, item thresholds.
  - Population thresholds via `COALESCE(u.population, 0)`; HAVING on aggregate_*; compute per-capita safely.
- `countyAnalyticsRepository`
  - Switch to `AnalyticsFilter`.
  - Use county population expression with `COALESCE(..., 0)` in thresholds; per-capita as above.
- `executionLineItemRepository`
  - Update filter interface to unified shape.
  - Apply `item_*` thresholds in WHERE; ignore aggregate_* and normalization.
  - Update validator to require single `account_category`.

4) Resolvers
- Update resolver signatures to expect `AnalyticsFilterInput`.
- Remove legacy normalization aliasing; accept `Normalization.per_capita`.
- Pass filters through to repos (no back-compat mapping).

5) Build & test
- Run `npx tsc -b --noEmit` to ensure compile.
- Smoke test GraphQL queries locally for map/table/chart flows.

6) Docs
- Update examples and any routes/docs referencing old filters.

### Notes

- Report type values must match DB enum strings in `schema.sql` (report_type).
- Treat undefined/empty arrays as “no filter” for that dimension.
- Performance: leverage existing indexes (year, entity, account_category, etc.), and use `ANY($::type[])` for array filters.
