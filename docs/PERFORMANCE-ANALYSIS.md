# Analytics Performance Analysis

This document analyzes the query patterns used by the analytics modules and reviews index coverage for optimization opportunities.

---

## 1. Query Patterns by Module

### 1.1 execution-analytics (KyselyAnalyticsRepo)

**Purpose:** Time-series aggregation of budget amounts by period.

**Query Pattern:**

```sql
SELECT eli.year, eli.<period> as period_value, COALESCE(SUM(eli.<amount_col>), 0) as amount
FROM executionlineitems eli
[LEFT JOIN entities e ON eli.entity_cui = e.cui]
[LEFT JOIN uats u ON e.uat_id = u.id]
WHERE <filters>
GROUP BY eli.year, eli.<period>
ORDER BY eli.year ASC, eli.<period> ASC
LIMIT 10000
```

**Key Filter Columns (executionlineitems):**

- `account_category` (required, always filtered)
- `year` (always in partition key + period filter)
- `report_type` (optional, common filter)
- `is_quarterly` / `is_yearly` (frequency flag)
- `month` / `quarter` (period filtering)
- `entity_cui` (optional)
- `functional_code` (optional, exact + LIKE prefix)
- `economic_code` (optional, exact + LIKE prefix)
- `budget_sector_id` (optional)
- `funding_source_id` (optional)
- `expense_type` (optional)
- `monthly_amount` / `quarterly_amount` / `ytd_amount` (amount constraints)

**Key Filter Columns (entities) - via LEFT JOIN:**

- `entity_type`
- `is_uat`
- `uat_id`
- `name` (ILIKE search)

**Key Filter Columns (uats) - via LEFT JOIN:**

- `county_code`
- `region`
- `population`

---

### 1.2 entity-analytics (KyselyEntityAnalyticsRepo)

**Purpose:** Entity-level budget aggregation with per-capita calculations.

**Query Pattern:**

```sql
WITH
  county_populations AS (...),
  factors(period_key, multiplier) AS (VALUES ...),
  filtered_aggregates AS (
    SELECT eli.entity_cui, COALESCE(SUM(eli.<amount_col> * f.multiplier), 0) AS normalized_amount
    FROM executionlineitems eli
    INNER JOIN factors f ON eli.year::text = f.period_key
    [INNER JOIN entities e ON eli.entity_cui = e.cui]
    [LEFT JOIN uats u ON e.uat_id = u.id]
    WHERE <filters>
    GROUP BY eli.entity_cui
    HAVING <aggregate_filters>
  )
SELECT e.cui, e.name, e.entity_type, ...
FROM filtered_aggregates fa
INNER JOIN entities e ON fa.entity_cui = e.cui
LEFT JOIN uats u ON e.uat_id = u.id
LEFT JOIN county_populations cp ON u.county_code = cp.county_code
ORDER BY <sort_field> <sort_order> NULLS LAST
LIMIT $limit OFFSET $offset
```

**Additional Requirements:**

- Groups by `entity_cui`
- Joins factors CTE on `year::text`
- Sorting on 8 different fields

---

### 1.3 aggregated-line-items (KyselyAggregatedLineItemsRepo)

**Purpose:** Classification-level budget aggregation (functional × economic codes).

**Query Pattern (Kysely path):**

```sql
SELECT fc.functional_code, fc.functional_name,
       COALESCE(eli.economic_code, 'N/A'), COALESCE(ec.economic_name, 'N/A'),
       eli.year, COALESCE(SUM(eli.<amount_col>), 0), COUNT(*)
FROM executionlineitems eli
INNER JOIN functionalclassifications fc ON eli.functional_code = fc.functional_code
LEFT JOIN economicclassifications ec ON eli.economic_code = ec.economic_code
[LEFT JOIN entities e ON eli.entity_cui = e.cui]
[LEFT JOIN uats u ON e.uat_id = u.id]
WHERE <filters>
GROUP BY fc.functional_code, fc.functional_name,
         COALESCE(eli.economic_code, 'N/A'), COALESCE(ec.economic_name, 'N/A'),
         eli.year
LIMIT 100000
```

**Query Pattern (Raw SQL path with normalization):**

```sql
WITH factors(period_key, multiplier) AS (VALUES ...)
SELECT ..., SUM(eli.<amount_col> * f.multiplier) AS normalized_amount, COUNT(*) OVER() AS total_count
FROM executionlineitems eli
INNER JOIN functionalclassifications fc ON ...
LEFT JOIN economicclassifications ec ON ...
INNER JOIN factors f ON eli.year::text = f.period_key
[LEFT JOIN entities e ON ...]
[LEFT JOIN uats u ON ...]
WHERE <filters>
GROUP BY functional_code, functional_name, economic_code, economic_name
HAVING <aggregate_filters>
ORDER BY normalized_amount DESC
LIMIT $limit OFFSET $offset
```

---

## 2. Existing Index Coverage

### 2.1 ExecutionLineItems Indexes

| Index Name                                               | Columns                                                                                                                                                         | Condition                                               | Covers                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------- |
| `PRIMARY KEY`                                            | `(year, report_type, line_item_id)`                                                                                                                             | -                                                       | Partition key                    |
| `idx_executionlineitems_yearly`                          | `(entity_cui, year, report_type)`                                                                                                                               | `is_yearly = true`                                      | Yearly entity queries            |
| `idx_executionlineitems_quarterly`                       | `(entity_cui, year, report_type)`                                                                                                                               | `is_quarterly = true`                                   | Quarterly entity queries         |
| `idx_executionlineitems_report_type_year_acct_yearly`    | `(report_type, year, account_category, is_yearly)`                                                                                                              | `is_yearly = true`                                      | Main filter combo                |
| `idx_executionlineitems_year_quarter`                    | `(year, quarter)`                                                                                                                                               | `quarter IS NOT NULL`                                   | Quarter lookups                  |
| `idx_eli_analytics_coverage`                             | `(is_yearly, is_quarterly, account_category, report_type, functional_code, economic_code, entity_cui)` INCLUDE `(ytd_amount, monthly_amount, quarterly_amount)` | -                                                       | **Covering index for analytics** |
| `idx_executionlineitems_entity_cui_type_func_ch`         | `(entity_cui, report_type, functional_code)`                                                                                                                    | `account_category = 'ch'`                               | Expense drill-down               |
| `idx_executionlineitems_entity_cui_type_econ_ch_notnull` | `(entity_cui, report_type, economic_code)`                                                                                                                      | `account_category = 'ch' AND economic_code IS NOT NULL` | Expense drill-down               |
| `idx_executionlineitems_functional_code_vpo`             | `(functional_code varchar_pattern_ops)`                                                                                                                         | -                                                       | LIKE prefix search               |
| `idx_executionlineitems_economic_code_vpo`               | `(economic_code varchar_pattern_ops)`                                                                                                                           | -                                                       | LIKE prefix search               |
| `idx_executionlineitems_func_code_year`                  | `(functional_code, year)`                                                                                                                                       | -                                                       | Classification × time            |
| `idx_executionlineitems_econ_code_year`                  | `(economic_code, year)`                                                                                                                                         | `economic_code IS NOT NULL`                             | Classification × time            |
| `idx_executionlineitems_report_id`                       | `(report_id)`                                                                                                                                                   | -                                                       | FK support                       |
| `idx_executionlineitems_funding_source_id`               | `(funding_source_id)`                                                                                                                                           | -                                                       | FK support                       |
| `idx_executionlineitems_budget_sector_id`                | `(budget_sector_id)`                                                                                                                                            | -                                                       | FK support                       |
| `idx_executionlineitems_main_creditor_cui`               | `(main_creditor_cui)`                                                                                                                                           | -                                                       | FK support                       |

### 2.2 Entities Indexes

| Index Name              | Columns               | Covers                    |
| ----------------------- | --------------------- | ------------------------- |
| `PRIMARY KEY`           | `(cui)`               | PK lookups                |
| `idx_entities_uat_id`   | `(uat_id)`            | UAT joins                 |
| `idx_entities_type`     | `(entity_type)`       | `entity_type IS NOT NULL` |
| `idx_gin_entities_name` | `(name gin_trgm_ops)` | ILIKE search              |

### 2.3 UATs Indexes

| Index Name                         | Columns                      | Covers            |
| ---------------------------------- | ---------------------------- | ----------------- |
| `PRIMARY KEY`                      | `(id)`                       | PK lookups        |
| `idx_uats_county_code`             | `(county_code)`              | County filtering  |
| `idx_uats_region`                  | `(region)`                   | Region filtering  |
| `idx_uats_id`                      | `(id)`                       | Redundant with PK |
| `idx_uats_uat_code`                | `(uat_code)`                 | Code lookups      |
| `idx_uats_siruta_code`             | `(siruta_code)`              | SIRUTA lookups    |
| `idx_uats_county_code_siruta_code` | `(county_code, siruta_code)` | County population |
| `idx_gin_uats_name`                | `(name gin_trgm_ops)`        | ILIKE search      |

---

## 3. Analysis & Recommendations

### 3.1 Well-Covered Patterns ✅

1. **Frequency-based filtering** (`is_yearly`, `is_quarterly`)
   - `idx_eli_analytics_coverage` leads with these columns
   - `idx_executionlineitems_yearly` and `idx_executionlineitems_quarterly` provide partial indexes

2. **Account category filtering** (`account_category`)
   - Covered by `idx_eli_analytics_coverage` in position 3
   - Also by `idx_executionlineitems_report_type_year_acct_yearly`

3. **Functional/Economic code prefix searches** (LIKE 'XX.%')
   - `varchar_pattern_ops` indexes exist for both

4. **Entity name search** (ILIKE '%term%')
   - GIN trigram index provides excellent coverage

5. **Classification code joins**
   - `functional_code` and `economic_code` are indexed on eli

### 3.2 Potential Gaps & Recommendations

#### Gap 1: expense_type filtering

**Status:** No dedicated index

**Analysis:** `expense_type` is filtered when users want to see only "development" or "operational" expenses. Current queries must scan more rows than necessary.

**Recommendation:** LOW PRIORITY - The column has only 2 enum values ('dezvoltare', 'functionare'), so selectivity is poor. PostgreSQL may choose sequential scan anyway. Consider adding if query plans show this as bottleneck.

```sql
-- Optional: Add only if EXPLAIN shows expense_type as slow
CREATE INDEX idx_executionlineitems_expense_type ON ExecutionLineItems (expense_type)
WHERE expense_type IS NOT NULL;
```

#### Gap 2: month column filtering (MONTH frequency queries)

**Status:** Not directly indexed

**Analysis:** Monthly queries filter by `(year, month)` tuples. The table is partitioned by year, but month is not indexed.

**Current mitigation:** `idx_eli_analytics_coverage` should help via index-only scans.

**Recommendation:** MONITOR - The covering index should help. Add dedicated index only if monthly queries show poor performance.

```sql
-- Optional: Add only if monthly queries are slow
CREATE INDEX idx_executionlineitems_year_month ON ExecutionLineItems (year, month);
```

#### Gap 3: entity_cui on eli without report_type

**Status:** `entity_cui` is indexed but always with `report_type`

**Analysis:** Entity analytics groups by `entity_cui` without `report_type` in the GROUP BY. Current indexes lead with other columns.

**Current mitigation:** `idx_eli_analytics_coverage` includes `entity_cui` in position 7, which is sufficient for the aggregation.

**Recommendation:** NO ACTION NEEDED - Entity grouping happens after filtering, and the covering index handles this well.

#### Gap 4: population range filtering

**Status:** No index on `population`

**Analysis:** `min_population`/`max_population` filters are used for filtering UATs by population range.

**Recommendation:** LOW PRIORITY - UATs table is small (~3200 rows). Sequential scan is likely efficient enough.

```sql
-- Optional: Add only if population filtering shows in EXPLAIN as slow
CREATE INDEX idx_uats_population ON UATs (population);
```

#### Gap 5: Composite index for common analytics filter pattern

**Status:** No single index optimized for `(account_category, report_type, year, is_yearly/is_quarterly)`

**Analysis:** Most analytics queries filter by:

1. `account_category` (required)
2. `is_yearly` or `is_quarterly` (frequency flag)
3. `year` (period)
4. `report_type` (common optional filter)

The existing `idx_eli_analytics_coverage` leads with `is_yearly, is_quarterly` which forces PostgreSQL to scan two index entries (one for each boolean value) when querying without frequency flag.

**Recommendation:** MEDIUM PRIORITY - Consider a more targeted partial index for yearly analytics:

```sql
-- Optimized for yearly analytics (most common)
CREATE INDEX idx_eli_yearly_analytics ON ExecutionLineItems (
    account_category,
    report_type,
    year,
    entity_cui,
    functional_code
)
INCLUDE (ytd_amount)
WHERE is_yearly = true;
```

### 3.3 Index Size Considerations

Before adding indexes, consider:

- ExecutionLineItems is a partitioned table - indexes are per-partition
- Each partition (year × report_type) has its own index copies
- Adding a new index adds ~15 copies (2016-2030 × 3 report_types per year)

### 3.4 Redundant Index Review

**Potentially redundant:**

- `idx_uats_id` - Duplicates PRIMARY KEY functionality

**Recommendation:** Consider dropping `idx_uats_id` to save space.

---

## 4. Query Plan Analysis Checklist

For production performance monitoring, run these EXPLAIN ANALYZE queries:

```sql
-- 1. Yearly analytics with common filters
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT eli.year, eli.year as period_value, COALESCE(SUM(eli.ytd_amount), 0) as amount
FROM executionlineitems eli
WHERE eli.account_category = 'ch'
  AND eli.is_yearly = true
  AND eli.year BETWEEN 2020 AND 2023
GROUP BY eli.year
ORDER BY eli.year;

-- 2. Entity analytics with geographic filter
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT eli.entity_cui, SUM(eli.ytd_amount) as total
FROM executionlineitems eli
INNER JOIN entities e ON eli.entity_cui = e.cui
LEFT JOIN uats u ON e.uat_id = u.id
WHERE eli.account_category = 'ch'
  AND eli.is_yearly = true
  AND eli.year = 2023
  AND u.county_code = 'CJ'
GROUP BY eli.entity_cui;

-- 3. Classification aggregation
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT eli.functional_code, eli.economic_code, eli.year, SUM(eli.ytd_amount)
FROM executionlineitems eli
WHERE eli.account_category = 'ch'
  AND eli.is_yearly = true
  AND eli.year BETWEEN 2020 AND 2023
  AND eli.functional_code LIKE '70%'
GROUP BY eli.functional_code, eli.economic_code, eli.year;

-- 4. Search by entity name
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT e.cui, e.name
FROM entities e
WHERE e.name ILIKE '%primaria%';
```

**What to look for:**

- `Index Scan` or `Index Only Scan` (good)
- `Seq Scan` on large tables (potentially bad)
- `Bitmap Heap Scan` (acceptable for complex conditions)
- High `actual rows` vs `rows` (indicates stale statistics - run ANALYZE)

---

## 5. Summary

| Priority | Recommendation                       | Impact                     |
| -------- | ------------------------------------ | -------------------------- |
| ✅ Done  | Existing indexes cover most patterns | -                          |
| Monitor  | Monthly frequency queries            | Low                        |
| Low      | expense_type index                   | Low selectivity            |
| Low      | population range index               | Small table                |
| Medium   | Optimized yearly analytics index     | May improve common queries |
| Cleanup  | Drop redundant idx_uats_id           | Save ~100KB                |

---

## 6. Next Steps

1. **Baseline current performance** - Run the EXPLAIN queries above in production
2. **Monitor slow queries** - Enable `pg_stat_statements` if not already enabled
3. **Add indexes incrementally** - Start with Medium priority if baseline shows issues
4. **Re-measure after changes** - Compare query plans before/after
