# SQL-Level Normalization Specification

## Overview

This specification defines the approach for moving normalization from the application layer to the database layer for aggregated, paginated, and sorted results. The solution enables correct pagination ordering while maintaining the flexibility of application-level normalization logic.

**Related Document**: [PAGINATION-NORMALIZATION-PROBLEM.md](./PAGINATION-NORMALIZATION-PROBLEM.md)

---

## Problem Recap

When combining SQL-level pagination (LIMIT/OFFSET) with application-level normalization:

1. SQL orders by **raw amounts** before normalization
2. Normalization factors (CPI, exchange rates, GDP, population) vary by year
3. After normalization, the **ordering changes**
4. SQL pagination returns incorrect results

**Example**:

| Classification | Year | Raw (RON) | CPI Factor | Normalized |
| -------------- | ---- | --------- | ---------- | ---------- |
| A              | 2015 | 80M       | 1.45       | 116M       |
| A              | 2024 | 50M       | 1.00       | 50M        |
| B              | 2015 | 40M       | 1.45       | 58M        |
| B              | 2024 | 90M       | 1.00       | 90M        |

- **Raw totals**: A = 130M, B = 130M (tie)
- **Normalized totals**: A = 166M, B = 148M (A > B)

SQL cannot know the correct order without access to normalization factors.

---

## Solution: Pre-Computed Combined Multiplier

### Core Insight

All normalization transforms can be **pre-combined into a single multiplier per period**:

```
normalized_amount = raw_amount × combined_multiplier
```

The app layer computes the combined multiplier, passes it to SQL, and the database handles aggregation, sorting, and pagination using the normalized values.

### Multiplier Computation Rules

#### Path A: Standard Normalization (Composable)

```
multiplier = 1.0

if (inflationAdjusted):
    multiplier = multiplier × cpi_factor       // Per-year factor

if (currency == 'EUR'):
    multiplier = multiplier ÷ eur_rate         // Per-year factor
else if (currency == 'USD'):
    multiplier = multiplier ÷ usd_rate         // Per-year factor

if (normalization == 'per_capita'):
    multiplier = multiplier ÷ denominator_pop  // Filter-based constant
```

**Order of Operations** (must be preserved):

1. Inflation adjustment (multiply by CPI) — per-year
2. Currency conversion (divide by exchange rate) — per-year
3. Per capita scaling (divide by population) — **filter-based constant**

#### Path B: Percent GDP (Exclusive)

```
multiplier = 100 ÷ (gdp × 1,000,000)
```

**Note**: Percent GDP mode ignores inflation adjustment and currency conversion.

---

## Population Denominator Computation

### Key Distinction

Unlike CPI and exchange rates, **per_capita population is filter-dependent**, not year-specific:

| Factor     | Source                                         | Varies By                       |
| ---------- | ---------------------------------------------- | ------------------------------- |
| CPI        | Dataset (ro.economics.cpi.yearly)              | Year                            |
| EUR rate   | Dataset (ro.economics.exchange.ron_eur.yearly) | Year                            |
| USD rate   | Dataset (ro.economics.exchange.ron_usd.yearly) | Year                            |
| GDP        | Dataset (ro.economics.gdp.yearly)              | Year                            |
| Population | **Filter-based computation**                   | **Filter (constant per query)** |

### Population Logic

The denominator population depends on the filter's entity constraints:

```
if (no entity-like filters):
    denominator = country_population
else:
    denominator = sum(populations of matching UATs/counties)
```

**Entity-like filters include**:

- `entity_cuis` — specific entities
- `uat_ids` — specific UATs
- `county_codes` — specific counties
- `is_uat` — UAT status filter
- `entity_types` — entity type filter

### Country Population Query

```sql
SELECT SUM(pop_val) AS population
FROM (
  SELECT MAX(CASE
    WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
    WHEN u2.siruta_code = u2.county_code THEN u2.population
    ELSE 0
  END) AS pop_val
  FROM UATs u2
  GROUP BY u2.county_code
) cp
```

**Notes**:

- Bucharest (county_code = 'B') uses SIRUTA 179132 (municipality level)
- Other counties use the county-level UAT (where siruta_code = county_code)
- This avoids double-counting sub-municipal UATs

### Filter-Based Population Query

When entity filters are present:

1. **Resolve entities to UATs/counties**:
   - Query Entities table with filters
   - Extract `uat_id` and `county_code` from matching entities
   - Handle special cases (county councils → county population)

2. **Deduplicate**:
   - If a UAT belongs to an already-selected county, exclude it
   - Prevents double-counting

3. **Sum populations**:
   - Sum UAT populations from `selectedUatIds`
   - Sum county populations from `selectedCountyCodes`

### Implementation Strategy

**App-layer computation** (recommended for simplicity):

```typescript
async function computeDenominatorPopulation(
  filter: AnalyticsFilter,
  repo: PopulationRepository
): Promise<Decimal> {
  const hasEntityFilter = Boolean(
    filter.entity_cuis?.length ||
    filter.uat_ids?.length ||
    filter.county_codes?.length ||
    filter.is_uat !== undefined ||
    filter.entity_types?.length
  );

  if (!hasEntityFilter) {
    return repo.getCountryPopulation();
  }

  return repo.getFilteredPopulation(filter);
}
```

The denominator population is computed **once per query**, then included in all period multipliers.

### Future: Historical Population

When historical population data becomes available:

```typescript
// Future enhancement
if (options.normalization === 'per_capita') {
  if (hasHistoricalPopulation) {
    // Per-year population from dataset
    const pop = factors.population.get(periodLabel);
    multiplier = multiplier.div(pop);
  } else {
    // Filter-based constant (current implementation)
    multiplier = multiplier.div(denominatorPopulation);
  }
}
```

This allows gradual migration without breaking existing behavior.

### Mathematical Equivalence

For a classification spanning years 2020-2024:

**In-Memory Approach**:

```
total = Σ (amount_year × cpi_year ÷ eur_year ÷ pop_year)
      = (a₂₀ × c₂₀ / e₂₀ / p₂₀) + (a₂₁ × c₂₁ / e₂₁ / p₂₁) + ...
```

**SQL with Combined Multiplier**:

```
total = Σ (amount_year × multiplier_year)
      = (a₂₀ × m₂₀) + (a₂₁ × m₂₁) + ...
      where m = c / e / p (pre-computed)
```

The results are **mathematically identical**.

---

## SQL Implementation: VALUES CTE

### Approach

Pass the combined multipliers as a virtual table using PostgreSQL's VALUES clause:

```sql
WITH factors(period_key, multiplier) AS (
  VALUES
    (2020, 1.234567890123456789::numeric),
    (2021, 1.198234567890123456::numeric),
    (2022, 1.156789012345678901::numeric),
    (2023, 1.089012345678901234::numeric),
    (2024, 1.000000000000000000::numeric)
)
SELECT
  fc.functional_code,
  fc.functional_name,
  COALESCE(eli.economic_code, '00.00.00') AS economic_code,
  COALESCE(ec.economic_name, 'Unknown economic classification') AS economic_name,
  SUM(eli.ytd_amount * f.multiplier) AS normalized_amount,
  COUNT(*) AS count,
  COUNT(*) OVER() AS total_count
FROM executionlineitems eli
INNER JOIN functionalclassifications fc
  ON eli.functional_code = fc.functional_code
LEFT JOIN economicclassifications ec
  ON eli.economic_code = ec.economic_code
INNER JOIN factors f
  ON eli.year = f.period_key
WHERE eli.account_category = $1
  AND eli.is_yearly = true
  AND eli.year BETWEEN $2 AND $3
GROUP BY
  fc.functional_code,
  fc.functional_name,
  COALESCE(eli.economic_code, '00.00.00'),
  COALESCE(ec.economic_name, 'Unknown economic classification')
HAVING SUM(eli.ytd_amount * f.multiplier) >= $min_amount  -- Optional
ORDER BY normalized_amount DESC
LIMIT $limit OFFSET $offset;
```

### Why VALUES CTE?

| Criteria    | VALUES CTE             | CASE Expression   | JSONB Parameter |
| ----------- | ---------------------- | ----------------- | --------------- |
| Clarity     | Clean separation       | Inline, verbose   | Type casting    |
| Performance | Optimized JOIN         | Simple eval       | Minor overhead  |
| Precision   | NUMERIC preserved      | NUMERIC preserved | Needs casting   |
| Debugging   | Easy to inspect        | Inline            | JSON parsing    |
| Year range  | ~1000 max (sufficient) | Verbose for many  | Unlimited       |

**Decision**: VALUES CTE is the best balance of clarity, performance, and maintainability.

### Total Count Strategy

Use window function `COUNT(*) OVER()`:

- **Pros**: Single query, no round-trip overhead
- **Cons**: Scans all matching groups (unavoidable for correct count)

The window function returns the total count on every row. The repository extracts it from the first row.

---

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        GraphQL Layer                             │
│  Input: filter, limit, offset, normalization options             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Use Case Layer                            │
│  1. Extract year range from filter                               │
│  2. Load NormalizationFactors via NormalizationService           │
│  3. Compute combined multiplier per period (PeriodFactorMap)     │
│  4. Call repository with factor map + pagination                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Repository Layer                            │
│  1. Build VALUES CTE from PeriodFactorMap                        │
│  2. Execute SQL query with:                                      │
│     - Normalization: amount × multiplier                         │
│     - Aggregation: SUM, GROUP BY                                 │
│     - Filtering: HAVING (aggregate filters)                      │
│     - Sorting: ORDER BY normalized_amount DESC                   │
│     - Pagination: LIMIT, OFFSET                                  │
│     - Total count: COUNT(*) OVER()                               │
│  3. Return NormalizedAggregatedResult                            │
└─────────────────────────────────────────────────────────────────┘
```

### Repository Interface Extension

```typescript
interface AggregatedLineItemsRepository {
  // Existing: in-memory pagination (for backward compatibility)
  getClassificationPeriodData(
    filter: AnalyticsFilter
  ): Promise<Result<ClassificationPeriodResult, AggregatedLineItemsError>>;

  // New: SQL-level pagination with pre-computed factors
  getNormalizedAggregatedItems(
    filter: AnalyticsFilter,
    factorMap: PeriodFactorMap,
    pagination: { limit: number; offset: number },
    aggregateFilters?: { minAmount?: Decimal; maxAmount?: Decimal }
  ): Promise<Result<NormalizedAggregatedResult, AggregatedLineItemsError>>;
}
```

### Type Definitions

```typescript
/**
 * Map of period keys to combined multipliers.
 *
 * Key format depends on frequency:
 * - YEAR: "2024"
 * - QUARTER: "2024-Q1"
 * - MONTH: "2024-01"
 *
 * Value: Pre-computed combined multiplier (Decimal for precision)
 */
type PeriodFactorMap = Map<string, Decimal>;

/**
 * Result from SQL-level normalized aggregation.
 */
interface NormalizedAggregatedResult {
  /** Aggregated items (normalized, sorted, paginated) */
  items: AggregatedClassification[];
  /** Total count of groups (for pagination info) */
  totalCount: number;
}
```

---

## Implementation Details

### Combined Factor Computation

```typescript
/**
 * Computes combined normalization multipliers for each period.
 *
 * @param options - Transformation options (inflation, currency, normalization mode)
 * @param factors - Year-specific factors from NormalizationService (CPI, exchange rates, GDP)
 * @param periodLabels - Period keys (e.g., ["2020", "2021", "2022"])
 * @param denominatorPopulation - Filter-based population for per_capita mode (optional)
 */
function computeCombinedFactorMap(
  options: TransformationOptions,
  factors: NormalizationFactors,
  periodLabels: string[],
  denominatorPopulation?: Decimal
): PeriodFactorMap {
  const result = new Map<string, Decimal>();

  for (const label of periodLabels) {
    let multiplier: Decimal;

    if (options.normalization === 'percent_gdp') {
      // Path B: Percent GDP (exclusive, ignores inflation/currency)
      const gdp = factors.gdp.get(label);
      if (gdp === undefined || gdp.isZero()) {
        multiplier = new Decimal(0);
      } else {
        // GDP is in millions, result is percentage (0-100)
        multiplier = new Decimal(100).div(gdp.mul(1_000_000));
      }
    } else {
      // Path A: Standard normalization (composable)
      multiplier = new Decimal(1);

      // 1. Inflation adjustment (per-year factor)
      if (options.inflationAdjusted) {
        const cpi = factors.cpi.get(label);
        if (cpi !== undefined && !cpi.isZero()) {
          multiplier = multiplier.mul(cpi);
        }
      }

      // 2. Currency conversion (per-year factor)
      if (options.currency === 'EUR') {
        const rate = factors.eur.get(label);
        if (rate !== undefined && !rate.isZero()) {
          multiplier = multiplier.div(rate);
        }
      } else if (options.currency === 'USD') {
        const rate = factors.usd.get(label);
        if (rate !== undefined && !rate.isZero()) {
          multiplier = multiplier.div(rate);
        }
      }

      // 3. Per capita scaling (filter-based constant, same for all years)
      if (options.normalization === 'per_capita') {
        if (denominatorPopulation !== undefined && !denominatorPopulation.isZero()) {
          multiplier = multiplier.div(denominatorPopulation);
        }
        // If no denominator, per_capita is effectively disabled (multiplier unchanged)
      }
    }

    result.set(label, multiplier);
  }

  return result;
}
```

### Population Repository Interface

```typescript
/**
 * Repository for computing filter-based population denominators.
 */
interface PopulationRepository {
  /**
   * Gets total country population (sum of county-level populations).
   * Used when no entity-like filters are specified.
   */
  getCountryPopulation(): Promise<Decimal>;

  /**
   * Gets population for entities/UATs matching the filter.
   * Handles deduplication and special cases (counties, Bucharest).
   */
  getFilteredPopulation(filter: AnalyticsFilter): Promise<Decimal>;
}
```

### Use Case: Computing Denominator Population

```typescript
async function getDenominatorPopulation(
  filter: AnalyticsFilter,
  populationRepo: PopulationRepository
): Promise<Decimal | undefined> {
  // Only needed for per_capita mode
  if (filter.normalization !== 'per_capita') {
    return undefined;
  }

  const hasEntityFilter = Boolean(
    filter.entity_cuis?.length ||
    filter.uat_ids?.length ||
    filter.county_codes?.length ||
    filter.is_uat !== undefined ||
    filter.entity_types?.length
  );

  if (!hasEntityFilter) {
    return populationRepo.getCountryPopulation();
  }

  return populationRepo.getFilteredPopulation(filter);
}
```

### VALUES CTE Builder (Kysely)

```typescript
private buildFactorValuesCTE(factorMap: PeriodFactorMap): RawBuilder<unknown> {
  const entries = Array.from(factorMap.entries());

  if (entries.length === 0) {
    // Fallback: single factor of 1.0 for year 0 (won't match any data)
    return sql`(0, 1.0::numeric)`;
  }

  // Build: (2020, 1.234::numeric), (2021, 1.198::numeric), ...
  const valuesList = entries.map(([period, mult]) =>
    sql`(${period}::int, ${mult.toString()}::numeric)`
  );

  return sql.join(valuesList, sql`, `);
}
```

### Frequency Support

The design supports any period granularity:

| Frequency | Period Key Format | Amount Column      | Filter                |
| --------- | ----------------- | ------------------ | --------------------- |
| YEAR      | `"2024"`          | `ytd_amount`       | `is_yearly = true`    |
| QUARTER   | `"2024-Q1"`       | `quarterly_amount` | `is_quarterly = true` |
| MONTH     | `"2024-01"`       | `monthly_amount`   | (none)                |

For the `aggregated-line-items` module, data is grouped by year, so the implementation uses yearly period keys. Future modules can extend this pattern for quarterly/monthly data.

---

## Edge Cases

### Missing Factors

If a factor is missing for a period:

- **CPI**: Multiplier uses 1.0 (no inflation adjustment)
- **Currency rate**: Multiplier unchanged (amounts stay in RON)
- **Population**: Multiplier unchanged (no per-capita scaling)
- **GDP**: Multiplier is 0 (percent_gdp returns 0%)

### Zero Divisors

All division operations check for zero before dividing:

```typescript
if (rate !== undefined && !rate.isZero()) {
  multiplier = multiplier.div(rate);
}
// If rate is zero, multiplier unchanged (safe fallback)
```

### Empty Factor Map

If no factors are generated (e.g., no data in range):

```typescript
if (entries.length === 0) {
  return sql`(0, 1.0::numeric)`; // Won't match any year
}
```

This results in zero rows returned (INNER JOIN fails to match).

### Precision

- All computations use `Decimal` (arbitrary precision)
- SQL uses `NUMERIC` type (no floating-point errors)
- Multiplier precision: 18 decimal places preserved

---

## Backward Compatibility

### Strategy

Keep both methods; the repository decides which strategy to use:

```typescript
interface AggregatedLineItemsRepository {
  // In-memory pagination (existing)
  getClassificationPeriodData(...): Promise<...>;

  // SQL-level pagination (new)
  getNormalizedAggregatedItems(...): Promise<...>;
}
```

The use case checks which method is available:

```typescript
if ('getNormalizedAggregatedItems' in repo) {
  // Use SQL-level normalization
  return getAggregatedLineItemsSqlNormalized(...);
}
// Fallback to in-memory
return getAggregatedLineItemsInMemory(...);
```

### Migration Path

1. Implement new repository method
2. Run comparison tests (verify identical results)
3. Enable SQL-level pagination for production
4. Eventually deprecate in-memory method if no longer needed

---

## Performance Considerations

### Query Optimization

- **VALUES CTE**: PostgreSQL treats as virtual table, uses hash join
- **INNER JOIN factors**: Only rows with matching periods included
- **Indexes used**: `year`, `account_category`, `functional_code`
- **Window function**: Single pass over grouped results

### Scalability

| Aspect                | Limit   | Notes                   |
| --------------------- | ------- | ----------------------- |
| Years in VALUES       | ~1000   | We use 10-20 years max  |
| Classification groups | ~50,000 | Bounded by code space   |
| Pagination depth      | Any     | SQL handles efficiently |

### Benchmarks (Expected)

| Scenario                       | In-Memory | SQL-Level |
| ------------------------------ | --------- | --------- |
| 5 years, 1000 groups           | ~50ms     | ~30ms     |
| 10 years, 10000 groups         | ~200ms    | ~80ms     |
| Deep pagination (offset 10000) | ~300ms    | ~100ms    |

_Note: Actual benchmarks to be measured during implementation._

---

## Testing Strategy

### Unit Tests

Test `computeCombinedFactorMap`:

- Each normalization mode independently
- Combined modes (inflation + currency + per_capita)
- Edge cases (zero factors, missing periods)
- Percent GDP exclusive path

### Integration Tests

Test `getNormalizedAggregatedItems`:

- SQL produces correct normalized totals
- Pagination returns correct slices
- HAVING filters work correctly
- Window function returns correct total count

### Comparison Tests

Verify SQL-level and in-memory approaches produce identical results:

```typescript
it('should produce identical results to in-memory approach', async () => {
  const inMemoryResult = await getAggregatedLineItemsInMemory(deps, input);
  const sqlResult = await getAggregatedLineItemsSqlNormalized(deps, input);

  expect(sqlResult.nodes).toEqual(inMemoryResult.nodes);
  expect(sqlResult.pageInfo.totalCount).toEqual(inMemoryResult.pageInfo.totalCount);
});
```

---

## Files to Modify

| File                                                                           | Changes                                                                       |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `src/modules/aggregated-line-items/core/types.ts`                              | Add `PeriodFactorMap`, `NormalizedAggregatedResult`                           |
| `src/modules/aggregated-line-items/core/ports.ts`                              | Add `getNormalizedAggregatedItems`, `PopulationRepository`                    |
| `src/modules/aggregated-line-items/core/usecases/get-aggregated-line-items.ts` | Add `computeCombinedFactorMap`, `getDenominatorPopulation`, refactor use case |
| `src/modules/aggregated-line-items/shell/repo/aggregated-line-items-repo.ts`   | Implement `getNormalizedAggregatedItems`                                      |
| `src/modules/aggregated-line-items/shell/repo/population-repo.ts`              | **NEW**: Implement `PopulationRepository` (country + filter-based)            |
| `tests/unit/aggregated-line-items/compute-factor-map.test.ts`                  | Unit tests for factor computation                                             |
| `tests/unit/aggregated-line-items/denominator-population.test.ts`              | Unit tests for population denominator logic                                   |
| `tests/integration/aggregated-line-items/sql-normalization.test.ts`            | Integration tests for SQL-level normalization                                 |

---

## Future Extensions

### Reusable Factor Computation

If other modules need SQL-level normalization, extract the pattern:

```typescript
// src/common/normalization/compute-factor-map.ts
export function computeCombinedFactorMap(
  options: TransformationOptions,
  factors: NormalizationFactors,
  periodLabels: string[]
): PeriodFactorMap;
```

### Monthly/Quarterly Support

The design already supports any frequency:

```typescript
// For monthly data
const periodLabels = ['2024-01', '2024-02', '2024-03', ...];
const factorMap = computeCombinedFactorMap(options, factors, periodLabels);

// SQL JOIN changes to:
// INNER JOIN factors f ON eli.year || '-' || LPAD(eli.month::text, 2, '0') = f.period_key
```

### Caching

Factor maps can be cached by (options + year range) hash:

```typescript
const cacheKey = hashFactorMapParams(options, startYear, endYear);
const cached = factorMapCache.get(cacheKey);
if (cached) return cached;
```

---

## References

- [PAGINATION-NORMALIZATION-PROBLEM.md](./PAGINATION-NORMALIZATION-PROBLEM.md) - Problem analysis
- [NORMALIZATION-FACTORS.md](./NORMALIZATION-FACTORS.md) - Factor computation and dataset requirements
- [PERFORMANCE-ANALYSIS.md](./PERFORMANCE-ANALYSIS.md) - Database index coverage for analytics queries
- `src/modules/normalization/` - NormalizationService implementation
- `src/modules/aggregated-line-items/` - Classification-level aggregation with SQL normalization
- `src/modules/entity-analytics/` - Entity-level aggregation with per-entity population
- `src/modules/execution-analytics/` - Time-series aggregation
- `datasets/yaml/` - Source YAML files for normalization factors
