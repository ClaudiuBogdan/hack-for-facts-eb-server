# Pagination with Normalization Problem

## Overview

When combining **SQL-level pagination** (LIMIT/OFFSET) with **application-level normalization**, we face a fundamental ordering problem. This document describes the challenge and potential solutions for future implementation.

## The Problem

### Context

Budget data requires normalization to be meaningful across time periods:

- **Inflation adjustment**: 100M RON in 2015 ≠ 100M RON in 2024
- **Currency conversion**: Exchange rates vary by year
- **Per capita scaling**: Population changes over time
- **Percent GDP**: GDP values differ each year

These normalization factors are **year-specific**, meaning the same raw amount transforms differently depending on which year it belongs to.

### The Conflict

SQL pagination requires knowing the final sort order **before** applying LIMIT/OFFSET:

```sql
SELECT ... ORDER BY amount DESC LIMIT 50 OFFSET 0
```

But the final `amount` depends on normalization factors that:

1. Vary by year
2. Are stored outside the database (YAML datasets)
3. Must be applied **before** aggregation across years

### Why SQL-Level Pagination Fails

Consider two classifications spanning multiple years:

| Classification | Year | Raw Amount (RON) | CPI Factor | Normalized Amount |
| -------------- | ---- | ---------------- | ---------- | ----------------- |
| A              | 2015 | 80,000,000       | 1.45       | 116,000,000       |
| A              | 2024 | 50,000,000       | 1.00       | 50,000,000        |
| B              | 2015 | 40,000,000       | 1.45       | 58,000,000        |
| B              | 2024 | 90,000,000       | 1.00       | 90,000,000        |

**Raw totals (what SQL sees):**

- A: 130,000,000 RON
- B: 130,000,000 RON (tie)

**Normalized totals (correct ordering):**

- A: 166,000,000 RON (inflation-adjusted)
- B: 148,000,000 RON (inflation-adjusted)

If SQL orders by raw amount, it might return B before A (or in arbitrary order for ties). But the correct normalized order is A > B.

**The ordering changes after normalization.** SQL cannot know this without access to the normalization factors.

### Current Implementation

The `aggregatedLineItems` module currently:

1. Fetches **all** data from DB grouped by `(classification, year)`
2. Applies normalization in the application layer
3. Re-aggregates by classification
4. Sorts and paginates **in memory**

```typescript
// Current flow in get-aggregated-line-items.ts
const rows = await repo.getClassificationPeriodData(filter); // All rows
const normalized = normalizeAndAggregate(rows, options, factors); // In-memory
const sorted = normalized.sort((a, b) => b.amount - a.amount); // In-memory
const paged = sorted.slice(offset, offset + limit); // In-memory pagination
```

This works but has scalability concerns for large datasets.

## Affected Use Cases

This problem will recur in any query that combines:

1. **Sorting by normalized amounts**
2. **Pagination (LIMIT/OFFSET)**
3. **Multi-year data aggregation**

Examples:

- Top N entities by spending (normalized)
- Top N entities by income (normalized)
- Classification rankings with pagination
- Entity comparisons with normalized amounts

## Potential Solutions

### 1. Factor Tables in Database

**Approach:** Store normalization factors in PostgreSQL tables and perform normalization in SQL.

```sql
CREATE TABLE normalization_factors (
  year INT PRIMARY KEY,
  cpi_factor DECIMAL(10, 6),
  eur_rate DECIMAL(10, 6),
  usd_rate DECIMAL(10, 6),
  gdp_millions DECIMAL(15, 2),
  population BIGINT
);
```

**Query with SQL-side normalization:**

```sql
SELECT
  e.cui,
  e.name,
  SUM(
    CASE
      WHEN :normalization = 'per_capita' AND :inflation_adjusted THEN
        eli.ytd_amount * nf.cpi_factor / nf.population
      WHEN :normalization = 'percent_gdp' THEN
        eli.ytd_amount / (nf.gdp_millions * 1000000) * 100
      WHEN :inflation_adjusted THEN
        eli.ytd_amount * nf.cpi_factor
      ELSE
        eli.ytd_amount
    END
  ) AS normalized_amount
FROM executionlineitems eli
JOIN normalization_factors nf ON eli.year = nf.year
JOIN entities e ON eli.entity_cui = e.cui
GROUP BY e.cui, e.name
ORDER BY normalized_amount DESC
LIMIT :limit OFFSET :offset;
```

**Pros:**

- True SQL-level pagination
- Database handles sorting efficiently
- Consistent with existing query patterns

**Cons:**

- Requires database migration
- Need sync mechanism: YAML datasets → DB tables
- More complex SQL queries
- Must handle all normalization mode combinations in SQL

### 2. Accept In-Memory Pagination for Bounded Data

**Approach:** If the result set is bounded (e.g., <50K classifications), in-memory pagination is acceptable.

**Analysis of bounds:**

- Functional codes: ~200 unique values
- Economic codes: ~500 unique values
- Theoretical max: 100,000 combinations
- Practical max: ~5,000-20,000 (most combinations don't exist)

**Optimizations:**

- Add result caching with filter hash as key
- Stream large responses
- Set reasonable MAX_LIMIT

**Pros:**

- Simple implementation (current approach)
- No database changes needed
- Correct results guaranteed

**Cons:**

- Memory usage scales with total results
- Deep pagination (offset > 10,000) may be slow
- Not suitable for unbounded entity queries

### 3. Cursor-Based Pagination with Caching

**Approach:** Generate full result set once, cache it, return cursor-based pages.

```typescript
interface CursorConnection {
  nodes: AggregatedLineItem[];
  pageInfo: {
    endCursor: string; // Encrypted cache key + offset
    hasNextPage: boolean;
  };
}
```

**Pros:**

- Consistent pagination (no shifting results)
- Amortizes computation cost across pages

**Cons:**

- Cache invalidation complexity
- Memory/storage for cached results
- Cursor expiration handling

### 4. Hybrid Approach

**Approach:** Use different strategies based on query characteristics.

```typescript
if (needsNormalization && hasMultipleYears) {
  // Use in-memory aggregation with caching
  return inMemoryPaginatedQuery();
} else {
  // Use SQL-level pagination
  return sqlPaginatedQuery();
}
```

**Pros:**

- Optimizes common cases
- Falls back safely for complex cases

**Cons:**

- Code complexity
- Inconsistent behavior

## Recommended Path Forward

### Short-term (Current)

Accept in-memory pagination for `aggregatedLineItems`. The classification space is bounded, and the current implementation is correct.

### Medium-term

When implementing entity-level queries (top spenders, etc.), evaluate:

1. **Cardinality**: How many entities exist? If bounded (<100K), in-memory may suffice.
2. **Query patterns**: Do users need deep pagination? Often only top-N matters.
3. **Caching opportunity**: Can we cache normalized results for common queries?

### Long-term

If SQL-level pagination becomes necessary:

1. Create `normalization_factors` table
2. Build sync job from YAML datasets to DB (on startup or via migration)
3. Implement SQL-side normalization for supported modes
4. Keep app-level normalization as fallback for edge cases

## References

- `src/modules/aggregated-line-items/` - Current implementation
- `src/modules/normalization/` - Normalization service and factors
- `datasets/yaml/` - Source YAML files for normalization factors
