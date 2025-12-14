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
  gdp_ron DECIMAL(18, 2),
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
        eli.ytd_amount / nf.gdp_ron * 100
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

### 5. App-Computed Factor Map Passed to SQL (Recommended)

**Approach:** Compute a single combined multiplier per year in the app layer, pass it to SQL as a lightweight lookup structure.

The key insight is that all normalization transforms can be **pre-combined into a single multiplier per year**:

```typescript
// App layer computes combined factor per year
function computeCombinedFactors(
  options: TransformationOptions,
  factors: NormalizationFactors,
  years: number[]
): Map<number, Decimal> {
  const combined = new Map<number, Decimal>();

  for (const year of years) {
    let multiplier = new Decimal(1);
    const label = String(year);

    // Compose all transforms into single multiplier
    if (options.normalization === 'percent_gdp') {
      const gdp = factors.gdp.get(label);
      if (gdp && !gdp.isZero()) {
        multiplier = new Decimal(100).div(gdp);
      }
    } else {
      if (options.inflationAdjusted) {
        const cpi = factors.cpi.get(label);
        if (cpi) multiplier = multiplier.mul(cpi);
      }
      if (options.currency === 'EUR') {
        const rate = factors.eur.get(label);
        if (rate && !rate.isZero()) multiplier = multiplier.div(rate);
      }
      if (options.currency === 'USD') {
        const rate = factors.usd.get(label);
        if (rate && !rate.isZero()) multiplier = multiplier.div(rate);
      }
      if (options.normalization === 'per_capita') {
        const pop = factors.population.get(label);
        if (pop && !pop.isZero()) multiplier = multiplier.div(pop);
      }
    }

    combined.set(year, multiplier);
  }

  return combined;
}
```

**SQL Implementation Options:**

#### Option A: VALUES clause (PostgreSQL)

Pass factors as a virtual table using VALUES:

```sql
WITH factors(year, multiplier) AS (
  VALUES
    (2020, 1.234567),
    (2021, 1.198234),
    (2022, 1.156789),
    (2023, 1.089012),
    (2024, 1.000000)
)
SELECT
  e.cui,
  e.name,
  SUM(eli.ytd_amount * f.multiplier) AS normalized_amount
FROM executionlineitems eli
JOIN factors f ON eli.year = f.year
JOIN entities e ON eli.entity_cui = e.cui
WHERE eli.year BETWEEN 2020 AND 2024
GROUP BY e.cui, e.name
ORDER BY normalized_amount DESC
LIMIT 50 OFFSET 0;
```

#### Option B: CASE expression (simpler, no CTE)

For small year ranges, inline the factors:

```sql
SELECT
  e.cui,
  e.name,
  SUM(eli.ytd_amount * CASE eli.year
    WHEN 2020 THEN 1.234567
    WHEN 2021 THEN 1.198234
    WHEN 2022 THEN 1.156789
    WHEN 2023 THEN 1.089012
    WHEN 2024 THEN 1.000000
    ELSE 1.0
  END) AS normalized_amount
FROM executionlineitems eli
JOIN entities e ON eli.entity_cui = e.cui
WHERE eli.year BETWEEN 2020 AND 2024
GROUP BY e.cui, e.name
ORDER BY normalized_amount DESC
LIMIT 50 OFFSET 0;
```

#### Option C: JSONB parameter (most flexible)

Pass factors as JSONB and extract in query:

```sql
-- Parameter: $factors = '{"2020": 1.234567, "2021": 1.198234, ...}'
SELECT
  e.cui,
  e.name,
  SUM(eli.ytd_amount * COALESCE(
    ($factors::jsonb ->> eli.year::text)::numeric,
    1.0
  )) AS normalized_amount
FROM executionlineitems eli
JOIN entities e ON eli.entity_cui = e.cui
WHERE eli.year BETWEEN 2020 AND 2024
GROUP BY e.cui, e.name
ORDER BY normalized_amount DESC
LIMIT 50 OFFSET 0;
```

**Kysely Implementation Example (Option A - VALUES):**

```typescript
async function queryWithNormalization(
  db: BudgetDbClient,
  filter: AnalyticsFilter,
  factorMap: Map<number, Decimal>,
  limit: number,
  offset: number
) {
  // Build VALUES clause dynamically
  const factorValues = Array.from(factorMap.entries())
    .map(([year, mult]) => sql`(${year}, ${mult.toNumber()})`)
    .reduce((acc, val, i) => (i === 0 ? val : sql`${acc}, ${val}`));

  const query = sql`
    WITH factors(year, multiplier) AS (
      VALUES ${factorValues}
    )
    SELECT
      e.cui,
      e.name,
      SUM(eli.ytd_amount * f.multiplier) AS normalized_amount
    FROM executionlineitems eli
    JOIN factors f ON eli.year = f.year
    JOIN entities e ON eli.entity_cui = e.cui
    WHERE eli.account_category = ${filter.account_category}
      AND eli.year BETWEEN ${startYear} AND ${endYear}
      AND eli.is_yearly = true
    GROUP BY e.cui, e.name
    ORDER BY normalized_amount DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return query.execute(db);
}
```

**Pros:**

- True SQL-level pagination with correct ordering
- No database schema changes required
- Factors computed once in app, reused in SQL
- Single multiplier per year = simple and fast
- Datasets stay in YAML (single source of truth)
- Works with existing Kysely patterns

**Cons:**

- Slightly more complex query building
- VALUES clause has practical limits (~1000 rows, but we have ~10-20 years max)
- JSONB option may have minor performance overhead

**Why This Is The Best Approach:**

1. **Separation of concerns**: App layer handles factor computation logic, SQL handles aggregation/pagination
2. **No schema migration**: Factors are passed as query parameters, not stored in DB
3. **Efficient**: Single multiplication per row, database optimizer handles the rest
4. **Flexible**: Easy to add new normalization modes without SQL changes
5. **Testable**: Factor computation is pure function, easily unit tested

## Recommended Path Forward

### Short-term (Current)

Accept in-memory pagination for `aggregatedLineItems`. The classification space is bounded (~5K-20K combinations), and the current implementation is correct.

### When Implementing Entity Queries (Top Spenders, etc.)

Use **Approach 5: App-Computed Factor Map** with the VALUES clause:

1. **Compute combined factor map** in use case layer using existing `NormalizationService`
2. **Pass factors to repository** as `Map<number, Decimal>`
3. **Build SQL with VALUES CTE** for the factor lookup
4. **Let PostgreSQL handle** sorting, pagination, and aggregation

Implementation steps:

```typescript
// 1. Add to ports.ts
interface EntityRankingRepository {
  getTopEntities(
    filter: AnalyticsFilter,
    factorMap: Map<number, Decimal>, // Pre-computed multipliers
    limit: number,
    offset: number
  ): Promise<Result<EntityRanking[], Error>>;
}

// 2. Use case computes factors, passes to repo
async function getTopEntities(deps, input) {
  const factors = await deps.normalization.generateFactors(...);
  const factorMap = computeCombinedFactors(input.options, factors, years);
  return deps.repo.getTopEntities(input.filter, factorMap, input.limit, input.offset);
}

// 3. Repository builds SQL with VALUES clause
// (see Option A example above)
```

This approach:

- Keeps normalization logic in the app layer (testable, uses existing code)
- Enables true SQL-level pagination
- Requires no database schema changes
- Is efficient (single multiplication per row)

## References

- `src/modules/aggregated-line-items/` - Current implementation (in-memory pagination)
- `src/modules/normalization/` - NormalizationService for factor generation
- `datasets/yaml/` - Source YAML files for normalization factors
