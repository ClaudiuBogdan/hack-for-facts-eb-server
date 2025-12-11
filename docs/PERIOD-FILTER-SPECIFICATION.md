# Period Filter Specification

This document explains how period filtering works in the ExecutionLineItems table, including the relationship between period types, database columns, and SQL query construction.

## Overview

The `ExecutionLineItems` table stores budget execution data at **monthly granularity** but provides pre-computed amounts for different reporting frequencies:

- **Monthly** (`monthly_amount`) - Amount for a specific month
- **Quarterly** (`quarterly_amount`) - Aggregated amount for a quarter (computed from YTD differences)
- **Yearly** (`ytd_amount`) - Year-to-date cumulative amount

The period filter determines which rows to select and which amount column to use.

## Database Schema (Relevant Columns)

```sql
CREATE TABLE ExecutionLineItems (
  year  INT  NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month INT  NOT NULL CHECK (month BETWEEN 1 AND 12),

  -- Amount columns
  ytd_amount NUMERIC(18,2) NOT NULL,        -- Year-to-date cumulative
  monthly_amount NUMERIC(18,2) NOT NULL,    -- Single month amount
  quarterly_amount NUMERIC(18,2),           -- Quarter total (computed)

  -- Period flag columns
  is_quarterly BOOLEAN NOT NULL DEFAULT FALSE,  -- True for end-of-quarter rows
  is_yearly BOOLEAN NOT NULL DEFAULT FALSE,     -- True for latest-month-of-year rows
  quarter INT CHECK (quarter BETWEEN 1 AND 4),  -- 1-4, only set when is_quarterly=true

  -- Constraint: is_yearly implies is_quarterly
  CHECK (NOT is_yearly OR is_quarterly)
);
```

## Period Types and Their Semantics

### 1. MONTH Period

**Use case**: Monthly time series, month-over-month analysis.

**Selection criteria**:

- No flag filter needed (all rows have monthly data)
- Filter by `(year, month)` tuple

**Amount column**: `monthly_amount`

**Example filter**: "January 2024 to March 2024"

```sql
WHERE (eli.year, eli.month) >= (2024, 1)
  AND (eli.year, eli.month) <= (2024, 3)
```

### 2. QUARTER Period

**Use case**: Quarterly reporting, Q/Q analysis.

**Selection criteria**:

- Filter by `is_quarterly = true` (only rows flagged as quarter-end)
- Filter by `(year, quarter)` tuple

**Amount column**: `quarterly_amount`

**Example filter**: "Q1 2024 to Q2 2024"

```sql
WHERE eli.is_quarterly = true
  AND (eli.year, eli.quarter) >= (2024, 1)
  AND (eli.year, eli.quarter) <= (2024, 2)
```

### 3. YEAR Period

**Use case**: Annual reporting, Y/Y analysis.

**Selection criteria**:

- Filter by `is_yearly = true` (only rows flagged as year-end)
- Filter by `year`

**Amount column**: `ytd_amount`

**Example filter**: "2022 to 2024"

```sql
WHERE eli.is_yearly = true
  AND eli.year BETWEEN 2022 AND 2024
```

## Period Flags Explained

### `is_quarterly`

Set to `true` for rows that represent the **end of a quarter** or the **latest available month for the year**.

Quarter-end months: 3 (March), 6 (June), 9 (September), 12 (December)

The `quarterly_amount` is computed as:

```
quarterly_amount = ytd_amount - previous_quarter_ytd_amount
```

For Q1, previous quarter YTD is 0, so `quarterly_amount = ytd_amount`.

### `is_yearly`

Set to `true` for the row representing the **latest available month** for an entity/year/report_type combination.

If December data is available, `is_yearly = true` for December rows.
If only data through October is available, `is_yearly = true` for October rows.

**Invariant**: `is_yearly = true` implies `is_quarterly = true`.

### `quarter`

Integer 1-4 indicating which quarter the row belongs to.

Only populated when `is_quarterly = true`.

Computed as: `CEILING(month / 3.0)`

| Month | Quarter |
| ----- | ------- |
| 1-3   | Q1      |
| 4-6   | Q2      |
| 7-9   | Q3      |
| 10-12 | Q4      |

## Period Selection Types

The API accepts two selection modes:

### 1. Interval Selection

```typescript
interface IntervalSelection {
  interval: {
    start: PeriodDate; // e.g., "2024-01", "2024-Q1", "2024"
    end: PeriodDate; // e.g., "2024-03", "2024-Q2", "2024"
  };
}
```

### 2. Discrete Dates Selection

```typescript
interface DatesSelection {
  dates: PeriodDate[]; // e.g., ["2024-01", "2024-03", "2024-06"]
}
```

### Date Format by Period Type

| Period Type | Format    | Example   |
| ----------- | --------- | --------- |
| MONTH       | `YYYY-MM` | `2024-03` |
| QUARTER     | `YYYY-QN` | `2024-Q1` |
| YEAR        | `YYYY`    | `2024`    |

## SQL Generation Rules

### Amount Column Selection

```typescript
function getAmountColumn(frequency: Frequency, alias = 'eli'): string {
  if (frequency === Frequency.MONTH) return `${alias}.monthly_amount`;
  if (frequency === Frequency.QUARTER) return `${alias}.quarterly_amount`;
  return `${alias}.ytd_amount`; // YEAR
}
```

### Period Flag Conditions

```typescript
function getPeriodFlagCondition(frequency: Frequency, alias = 'eli'): string {
  if (frequency === Frequency.YEAR) return `${alias}.is_yearly = true`;
  if (frequency === Frequency.QUARTER) return `${alias}.is_quarterly = true`;
  return ''; // MONTH: no flag needed
}
```

### Interval Filtering

For **MONTH** frequency with interval `{start: "2024-01", end: "2024-06"}`:

```sql
WHERE (eli.year, eli.month) >= (2024, 1)
  AND (eli.year, eli.month) <= (2024, 6)
```

For **QUARTER** frequency with interval `{start: "2024-Q1", end: "2024-Q3"}`:

```sql
WHERE eli.is_quarterly = true
  AND (eli.year, eli.quarter) >= (2024, 1)
  AND (eli.year, eli.quarter) <= (2024, 3)
```

For **YEAR** frequency with interval `{start: "2022", end: "2024"}`:

```sql
WHERE eli.is_yearly = true
  AND eli.year >= 2022
  AND eli.year <= 2024
```

### Discrete Dates Filtering

For **MONTH** frequency with dates `["2024-01", "2024-03", "2024-06"]`:

```sql
WHERE (
  (eli.year = 2024 AND eli.month = 1) OR
  (eli.year = 2024 AND eli.month = 3) OR
  (eli.year = 2024 AND eli.month = 6)
)
```

For **QUARTER** frequency with dates `["2024-Q1", "2024-Q3"]`:

```sql
WHERE eli.is_quarterly = true
  AND (
    (eli.year = 2024 AND eli.quarter = 1) OR
    (eli.year = 2024 AND eli.quarter = 3)
  )
```

For **YEAR** frequency with dates `["2022", "2023", "2024"]`:

```sql
WHERE eli.is_yearly = true
  AND eli.year IN (2022, 2023, 2024)
```

## Complete Query Example

Query monthly expenses for functional code prefix "70" from Q1 2024:

```sql
SELECT
  eli.year,
  eli.month as period_value,
  COALESCE(SUM(eli.monthly_amount), 0) as amount
FROM ExecutionLineItems eli
WHERE eli.account_category = 'ch'
  AND eli.report_type = 'Executie bugetara detaliata'
  AND eli.functional_code LIKE '70%'
  AND (eli.year, eli.month) >= (2024, 1)
  AND (eli.year, eli.month) <= (2024, 3)
GROUP BY eli.year, eli.month
ORDER BY eli.year ASC, eli.month ASC;
```

Query quarterly income totals for 2023:

```sql
SELECT
  eli.year,
  eli.quarter as period_value,
  COALESCE(SUM(eli.quarterly_amount), 0) as amount
FROM ExecutionLineItems eli
WHERE eli.account_category = 'vn'
  AND eli.is_quarterly = true
  AND eli.year = 2023
GROUP BY eli.year, eli.quarter
ORDER BY eli.year ASC, eli.quarter ASC;
```

## Date Parsing

The `parsePeriodDate` function parses date strings into their components:

```typescript
interface ParsedPeriod {
  year: number;
  month?: number; // 1-12, only for YYYY-MM format
  quarter?: number; // 1-4, only for YYYY-QN format
}

function parsePeriodDate(dateStr: string): ParsedPeriod | null {
  // YYYY format
  if (/^\d{4}$/.test(dateStr)) {
    return { year: parseInt(dateStr, 10) };
  }

  // YYYY-MM format
  const monthMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(dateStr);
  if (monthMatch) {
    return { year: parseInt(monthMatch[1], 10), month: parseInt(monthMatch[2], 10) };
  }

  // YYYY-QN format
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(dateStr);
  if (quarterMatch) {
    return { year: parseInt(quarterMatch[1], 10), quarter: parseInt(quarterMatch[2], 10) };
  }

  return null;
}
```

## Output Date Formatting

The `formatDateFromRow` function formats database rows back to date strings:

```typescript
function formatDateFromRow(year: number, periodValue: number, frequency: Frequency): string {
  if (frequency === Frequency.MONTH) {
    return `${year}-${String(periodValue).padStart(2, '0')}`; // "2024-03"
  }
  if (frequency === Frequency.QUARTER) {
    return `${year}-Q${periodValue}`; // "2024-Q1"
  }
  return String(year); // "2024"
}
```

## Amount Constraints

When applying `item_min_amount` or `item_max_amount` filters, use the amount column matching the frequency:

```typescript
function buildAmountConditions(
  filter: AmountFilter,
  frequency: Frequency,
  alias: string
): string[] {
  const column = getAmountColumn(frequency, alias);
  const conditions: string[] = [];

  if (filter.item_min_amount != null) {
    conditions.push(`${column} >= ${filter.item_min_amount}`);
  }
  if (filter.item_max_amount != null) {
    conditions.push(`${column} <= ${filter.item_max_amount}`);
  }

  return conditions;
}
```

## Why Tuple Comparisons?

For MONTH and QUARTER queries, we use tuple comparisons `(year, column) >= (value1, value2)` instead of separate conditions because:

1. **Correct boundary handling**: `year >= 2023 AND month >= 10` would incorrectly include January 2024 with month=1 < 10.

2. **PostgreSQL optimization**: Row comparison operators work efficiently with composite indexes.

3. **Semantic clarity**: The tuple represents a single temporal point, not two independent values.

**Wrong approach**:

```sql
-- This fails: excludes 2024-01 through 2024-09 because month < 10
WHERE eli.year >= 2023 AND eli.month >= 10
  AND eli.year <= 2024 AND eli.month <= 3
```

**Correct approach**:

```sql
-- This works: 2023-10 <= (year, month) <= 2024-03
WHERE (eli.year, eli.month) >= (2023, 10)
  AND (eli.year, eli.month) <= (2024, 3)
```

## Year-Only Date Parsing for Intervals

When parsing year-only date strings (`"2024"`) for interval queries with QUARTER or MONTH frequency, the parser uses context-aware defaults:

- **Start date**: Defaults to Q1 or Month 01 (first period of the year)
- **End date**: Defaults to Q4 or Month 12 (last period of the year)

This ensures that `{ start: '2020', end: '2024' }` correctly covers:

- For QUARTER: Q1 2020 through Q4 2024
- For MONTH: January 2020 through December 2024

```typescript
function parseQuarterDate(date: string, position: 'start' | 'end'): ParsedQuarter | null {
  // ... parse YYYY-QN format ...

  // Year-only format - use position-aware default
  const yearMatch = /^(\d{4})$/.exec(date);
  if (yearMatch) {
    const defaultQuarter = position === 'end' ? 4 : 1;
    return { year: parseInt(yearMatch[1], 10), quarter: defaultQuarter };
  }
  return null;
}
```

## Report Type Handling

Budget queries require a `report_type` filter. The system supports three report types:

| GraphQL Enum           | Database Value (Romanian)                                      | Priority    |
| ---------------------- | -------------------------------------------------------------- | ----------- |
| `PRINCIPAL_AGGREGATED` | `'Executie bugetara agregata la nivel de ordonator principal'` | 1 (highest) |
| `SECONDARY_AGGREGATED` | `'Executie bugetara agregata la nivel de ordonator secundar'`  | 2           |
| `DETAILED`             | `'Executie bugetara detaliata'`                                | 3 (lowest)  |

### Entity Default Report Type

Each entity has a `default_report_type` field that determines which report type to use when the client doesn't specify one. This is **fundamental** for data filtering because:

1. **Different entities have different report types available** - A municipality might only have detailed reports, while a county council might have aggregated reports.

2. **The default is computed automatically** - The system analyzes `ExecutionLineItems` to determine which report types exist for each entity and sets the default to the **highest priority** available type.

3. **All analytics queries use this default** - When querying trends, totals, or line items without specifying a report type, the entity's default is used.

#### Priority Order

The default report type is selected based on this priority (highest first):

```
1. PRINCIPAL_AGGREGATED  →  Aggregated at principal creditor level
2. SECONDARY_AGGREGATED  →  Aggregated at secondary creditor level
3. DETAILED              →  Detailed line-item reports
```

#### How the Default is Computed

The `mv_report_availability` materialized view tracks which report types exist for each entity:

```sql
CREATE MATERIALIZED VIEW mv_report_availability AS
SELECT
    entity_cui,
    year,
    report_type,
    CASE
        WHEN report_type = 'Executie bugetara agregata la nivel de ordonator principal' THEN 1
        WHEN report_type = 'Executie bugetara agregata la nivel de ordonator secundar' THEN 2
        WHEN report_type = 'Executie bugetara detaliata' THEN 3
        ELSE 4
    END as priority,
    ...
FROM ExecutionLineItems
GROUP BY entity_cui, year, report_type;
```

The `set_entities_default_report_type()` function updates each entity's default:

```sql
-- Sets default_report_type to highest-priority available report per entity
WITH chosen AS (
    SELECT DISTINCT ON (entity_cui)
        entity_cui,
        report_type
    FROM mv_report_availability
    ORDER BY entity_cui, priority  -- Lowest priority number = highest priority
)
UPDATE Entities e
SET default_report_type = c.report_type
FROM chosen c
WHERE e.cui = c.entity_cui;
```

#### Why This Matters

Consider two entities:

| Entity           | Available Reports              | Default              |
| ---------------- | ------------------------------ | -------------------- |
| Municipality A   | DETAILED only                  | DETAILED             |
| County Council B | PRINCIPAL_AGGREGATED, DETAILED | PRINCIPAL_AGGREGATED |

When a client queries `entity.incomeTrend(period: {...})` without specifying `reportType`:

- For Municipality A: queries DETAILED reports
- For County Council B: queries PRINCIPAL_AGGREGATED reports

This ensures each entity returns its most comprehensive data by default.

#### Fallback Behavior

If an entity has no `default_report_type` set (rare edge case), the system falls back to `'Executie bugetara detaliata'` (DETAILED).

```typescript
const DEFAULT_REPORT_TYPE: DbReportType = 'Executie bugetara detaliata';

const getDbReportType = (parent: Entity, gqlReportType?: string): string => {
  // ... resolution logic ...
  return parent.default_report_type ?? DEFAULT_REPORT_TYPE;
};
```

### Report Type Resolution

The `getDbReportType` function resolves report types from multiple input formats:

1. **GraphQL enum values** (e.g., `PRINCIPAL_AGGREGATED`) - mapped to DB string
2. **DB string values** (e.g., `'Executie bugetara detaliata'`) - returned as-is
3. **Entity default** - uses `entity.default_report_type` if no arg provided
4. **System default** - falls back to `'Executie bugetara detaliata'`

This flexibility supports both new clients using GraphQL enums and legacy clients passing DB values directly.

```typescript
// Example: GraphQL enum input
getDbReportType(entity, 'PRINCIPAL_AGGREGATED');
// Returns: 'Executie bugetara agregata la nivel de ordonator principal'

// Example: DB string input (already resolved)
getDbReportType(entity, 'Executie bugetara detaliata');
// Returns: 'Executie bugetara detaliata'

// Example: No input - uses entity default
getDbReportType(entity, undefined);
// Returns: entity.default_report_type or 'Executie bugetara detaliata'
```

## Sorting by Amount

When sorting by `amount`, the system maps this virtual field to the correct column based on frequency:

| Frequency | Sort Column        |
| --------- | ------------------ |
| MONTH     | `monthly_amount`   |
| QUARTER   | `quarterly_amount` |
| YEAR      | `ytd_amount`       |

This allows clients to use a generic `amount` sort field without knowing the underlying column structure.

## Implementation Files

- `src/modules/execution-analytics/shell/repo/period-filter-builder.ts` - Period SQL condition builders
- `src/modules/execution-analytics/shell/repo/query-helpers.ts` - Date parsing and formatting utilities
- `src/modules/execution-analytics/shell/repo/sql-condition-builder.ts` - Complete SQL condition builder
- `src/modules/execution-analytics/shell/repo/analytics-repo.ts` - Query execution with Kysely
- `src/modules/execution-line-items/shell/repo/execution-line-items-repo.ts` - Line items with amount sorting
- `src/modules/entity/shell/repo/entity-analytics-repo.ts` - Entity trends from materialized views
- `src/modules/entity/shell/graphql/resolvers.ts` - Report type resolution (`getDbReportType`)
- `src/common/types/temporal.ts` - Frequency enum and temporal types
- `src/common/types/analytics.ts` - Filter types and period selection types

## Related Documentation

- [SQL-LEVEL-NORMALIZATION-SPEC.md](./SQL-LEVEL-NORMALIZATION-SPEC.md) - Normalization applied after period filtering
- [TEMPORAL-DATA.md](./TEMPORAL-DATA.md) - Temporal data types and conventions
