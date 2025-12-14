# Analytics Modules Specification

This document describes the analytics modules architecture, their responsibilities, and key technical decisions.

---

## 1. Module Overview

The analytics system consists of three modules that provide different views of budget data:

| Module                  | Purpose                  | Grouping                       | Population Handling        |
| ----------------------- | ------------------------ | ------------------------------ | -------------------------- |
| `execution-analytics`   | Time-series aggregation  | By period (year/quarter/month) | Filter-based constant      |
| `aggregated-line-items` | Classification breakdown | By functional × economic code  | Filter-based constant      |
| `entity-analytics`      | Entity ranking           | By entity (CUI)                | Per-entity (UAT or county) |

---

## 2. Shared Infrastructure

### 2.1 SQL Condition Builders

Located in `src/modules/execution-analytics/shell/repo/`:

- **`period-filter-builder.ts`** - Builds period-based SQL conditions with proper tuple comparison for month/quarter frequencies
- **`sql-condition-builder.ts`** - Builds complete WHERE clauses from AnalyticsFilter
- **`query-helpers.ts`** - Utilities for join detection, ID conversion, date formatting

These are shared by `entity-analytics` (raw SQL) and `aggregated-line-items` (raw SQL path).

### 2.2 Filter Support Matrix

All modules support the same filter interface (`AnalyticsFilter`):

| Filter                                | Description                   | Join Required |
| ------------------------------------- | ----------------------------- | ------------- |
| `account_category`                    | Income (vn) or Expense (ch)   | None          |
| `report_type`                         | Report aggregation level      | None          |
| `entity_cuis`                         | Specific entities             | None          |
| `functional_codes`                    | Exact functional codes        | None          |
| `functional_prefixes`                 | Functional code LIKE patterns | None          |
| `economic_codes`                      | Exact economic codes          | None          |
| `economic_prefixes`                   | Economic code LIKE patterns   | None          |
| `entity_types`                        | Entity type filter            | Entity        |
| `is_uat`                              | UAT status filter             | Entity        |
| `uat_ids`                             | Specific UATs                 | Entity        |
| `search`                              | Entity name ILIKE search      | Entity        |
| `county_codes`                        | County filter                 | UAT           |
| `regions`                             | Region filter                 | UAT           |
| `min_population` / `max_population`   | Population range              | UAT           |
| `item_min_amount` / `item_max_amount` | Per-item amount filter        | None          |
| `exclude.*`                           | Exclusion filters (NULL-safe) | Varies        |

### 2.3 NULL-Safe Exclusions

For columns that can be NULL (via LEFT JOIN), exclusions use the pattern:

```sql
(column IS NULL OR column NOT IN (...))
```

This preserves rows where the join didn't find a match. Affected exclusions:

- `exclude.entity_types`
- `exclude.uat_ids`
- `exclude.county_codes`
- `exclude.regions`

---

## 3. execution-analytics Module

### Purpose

Returns time-series data aggregated by period for charting and trend analysis.

### Key Characteristics

- **Output**: `DataSeries` with chronologically ordered `DataPoint[]`
- **Grouping**: By year (+ month or quarter depending on frequency)
- **Normalization**: Applied after SQL aggregation using `NormalizationService`
- **Population**: Filter-based constant (same for all data points)

### Query Pattern

```sql
SELECT year, <period> as period_value, COALESCE(SUM(<amount_col>), 0) as amount
FROM executionlineitems eli
[LEFT JOIN entities e ON eli.entity_cui = e.cui]
[LEFT JOIN uats u ON e.uat_id = u.id]
WHERE <filters>
GROUP BY year, <period>
ORDER BY year ASC, <period> ASC
```

### Implementation

Uses Kysely fluent API in `analytics-repo.ts`.

---

## 4. aggregated-line-items Module

### Purpose

Returns budget data grouped by classification (functional × economic code) with SQL-level normalization and pagination.

### Key Characteristics

- **Output**: Paginated list of `AggregatedClassification` items
- **Grouping**: By functional_code, economic_code
- **Normalization**: Applied in SQL via VALUES CTE with pre-computed multipliers
- **Population**: Filter-based constant (included in multiplier)

### Query Pattern (Normalized)

```sql
WITH factors(period_key, multiplier) AS (VALUES ...)
SELECT
  fc.functional_code, fc.functional_name,
  COALESCE(eli.economic_code, 'N/A'), COALESCE(ec.economic_name, 'N/A'),
  SUM(eli.<amount_col> * f.multiplier) AS normalized_amount,
  COUNT(*) OVER() AS total_count
FROM executionlineitems eli
INNER JOIN factors f ON eli.year::text = f.period_key
...
GROUP BY ...
ORDER BY normalized_amount DESC
LIMIT $limit OFFSET $offset
```

### Implementation

- Kysely fluent API for non-normalized queries
- Raw SQL with shared builders for normalized queries (`buildWhereConditions`)

---

## 5. entity-analytics Module

### Purpose

Returns entity-level budget data with per-entity population for per-capita calculations.

### Key Characteristics

- **Output**: Paginated list of `EntityAnalyticsRow` items
- **Grouping**: By entity_cui
- **Normalization**: Applied in SQL via VALUES CTE
- **Population**: Per-entity (varies by entity type)

### Population Logic

| Entity Type                                             | Population Source            |
| ------------------------------------------------------- | ---------------------------- |
| UAT (`is_uat = true`)                                   | UAT's own population         |
| County Council (`entity_type = 'admin_county_council'`) | County aggregate population  |
| Other                                                   | NULL (per_capita_amount = 0) |

### Query Pattern

```sql
WITH
  county_populations AS (...),
  factors(period_key, multiplier) AS (VALUES ...),
  filtered_aggregates AS (
    SELECT entity_cui, SUM(<amount> * multiplier) AS normalized_amount
    FROM executionlineitems eli
    INNER JOIN factors f ON eli.year::text = f.period_key
    ...
    GROUP BY entity_cui
  )
SELECT
  e.cui, e.name, e.entity_type,
  <population_expression> AS population,
  fa.normalized_amount AS total_amount,
  <per_capita_expression> AS per_capita_amount,
  COUNT(*) OVER() AS total_count
FROM filtered_aggregates fa
INNER JOIN entities e ON fa.entity_cui = e.cui
LEFT JOIN uats u ON e.uat_id = u.id
LEFT JOIN county_populations cp ON u.county_code = cp.county_code
ORDER BY <sort_field> <sort_order> NULLS LAST
LIMIT $limit OFFSET $offset
```

### Implementation

Uses raw SQL with shared builders (`buildWhereConditions`).

---

## 6. Frequency Handling

### Amount Columns

| Frequency | Amount Column      | Filter                |
| --------- | ------------------ | --------------------- |
| MONTH     | `monthly_amount`   | None                  |
| QUARTER   | `quarterly_amount` | `is_quarterly = true` |
| YEAR      | `ytd_amount`       | `is_yearly = true`    |

### Period Labels

| Frequency | Format    | Examples  |
| --------- | --------- | --------- |
| YEAR      | `YYYY`    | "2024"    |
| QUARTER   | `YYYY-QN` | "2024-Q1" |
| MONTH     | `YYYY-MM` | "2024-03" |

### Monthly Data Model

There is no `is_monthly` flag in the database. `monthly_amount` is populated on ALL rows (`NOT NULL`), while quarterly and yearly are subsets flagged by `is_quarterly` and `is_yearly`.

---

## 7. Normalization Pipeline

### Factor Types

| Factor       | Source                                           | Varies By                   |
| ------------ | ------------------------------------------------ | --------------------------- |
| CPI          | Dataset (`ro.economics.cpi.yearly`)              | Year                        |
| EUR Exchange | Dataset (`ro.economics.exchange.ron_eur.yearly`) | Year                        |
| USD Exchange | Dataset (`ro.economics.exchange.ron_usd.yearly`) | Year                        |
| GDP          | Dataset (`ro.economics.gdp.yearly`)              | Year                        |
| Population   | Database (`PopulationRepository`)                | Filter (constant per query) |

### Combined Multiplier

All factors are pre-combined into a single multiplier per period:

```
Standard path:
  multiplier = cpi_factor / exchange_rate / population

Percent GDP path (exclusive):
  multiplier = 100 / gdp
```

See [SQL-LEVEL-NORMALIZATION-SPEC.md](./SQL-LEVEL-NORMALIZATION-SPEC.md) for details.

---

## 8. Performance Considerations

### Key Indexes

The database schema includes comprehensive indexes for analytics queries:

- **Covering index**: `idx_eli_analytics_coverage` includes frequency flags, account_category, report_type, codes, and amount columns
- **Partial indexes**: `idx_executionlineitems_yearly`, `idx_executionlineitems_quarterly`
- **Pattern indexes**: `varchar_pattern_ops` for LIKE prefix searches
- **GIN indexes**: Trigram indexes for entity/UAT name search

See [PERFORMANCE-ANALYSIS.md](./PERFORMANCE-ANALYSIS.md) for full index coverage analysis.

### Query Timeout

All analytics queries use a 30-second statement timeout (`SET LOCAL statement_timeout`).

---

## 9. Related Documentation

- [NORMALIZATION-FACTORS.md](./NORMALIZATION-FACTORS.md) - Factor computation and dataset requirements
- [SQL-LEVEL-NORMALIZATION-SPEC.md](./SQL-LEVEL-NORMALIZATION-SPEC.md) - SQL-level normalization implementation
- [PAGINATION-NORMALIZATION-PROBLEM.md](./PAGINATION-NORMALIZATION-PROBLEM.md) - Problem analysis and solution
- [PERFORMANCE-ANALYSIS.md](./PERFORMANCE-ANALYSIS.md) - Database index coverage
- [TEMPORAL-DATA.md](./TEMPORAL-DATA.md) - Time-series data interface specification
