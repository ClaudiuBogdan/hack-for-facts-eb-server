# Client Normalization Implementation Guide

## Overview

This document provides the specification for implementing normalization controls in the Transparenta.eu client application. Normalization transforms raw budget amounts into comparable metrics by adjusting for inflation, converting currencies, scaling by population, or expressing as percentage of GDP.

**Normalization is available across multiple GraphQL queries:**

| Query / Field                                   | Use Case                         |
| ----------------------------------------------- | -------------------------------- |
| `entityAnalytics`                               | Entity rankings and comparisons  |
| `executionAnalytics`                            | Time series charts and trends    |
| `executionLineItems`                            | Line item lists (root query)     |
| `entity.executionLineItems`                     | Line items for a specific entity |
| `entity.totalIncome/Expenses/Balance`           | Entity summary totals            |
| `entity.incomeTrend/expensesTrend/balanceTrend` | Entity trend charts              |

---

## Quick Reference

### Normalization Options Summary

| Option                   | GraphQL Field        | Type                 | Default | Description                        |
| ------------------------ | -------------------- | -------------------- | ------- | ---------------------------------- |
| **Mode**                 | `normalization`      | `Normalization` enum | `total` | How to scale amounts               |
| **Currency**             | `currency`           | `Currency` enum      | `RON`   | Output currency                    |
| **Inflation Adjustment** | `inflation_adjusted` | `Boolean`            | `false` | Adjust to constant 2024 prices     |
| **Period Growth**        | `show_period_growth` | `Boolean`            | `false` | Show % change from previous period |

### Normalization Modes

| Mode              | Description                  | Use Case                                        |
| ----------------- | ---------------------------- | ----------------------------------------------- |
| `total`           | Raw amounts (no scaling)     | Absolute budget comparisons                     |
| `total_euro`      | Amounts converted to EUR     | International comparisons (legacy)              |
| `per_capita`      | Amount divided by population | Fair comparison across different-sized entities |
| `per_capita_euro` | Per capita in EUR            | International per-person comparisons (legacy)   |
| `percent_gdp`     | Amount as % of GDP           | Macroeconomic context                           |

### Currency Options

| Value | Description            |
| ----- | ---------------------- |
| `RON` | Romanian Leu (default) |
| `EUR` | Euro                   |
| `USD` | US Dollar              |

---

## GraphQL API Reference

### Enums and Input Types

```graphql
enum Normalization {
  total
  total_euro # Legacy - prefer: normalization: total + currency: EUR
  per_capita
  per_capita_euro # Legacy - prefer: normalization: per_capita + currency: EUR
  percent_gdp
}

enum Currency {
  RON
  EUR
  USD
}

enum AccountCategory {
  vn # Income (venituri)
  ch # Expenses (cheltuieli)
}

enum PeriodType {
  MONTH
  QUARTER
  YEAR
}

input ReportPeriodInput {
  type: PeriodType!
  selection: PeriodSelection!
}

input PeriodSelection @oneOf {
  interval: PeriodIntervalInput # { start: "2020", end: "2024" }
  dates: [PeriodDate!] # ["2020", "2022", "2024"]
}
```

### AnalyticsFilterInput (Common Filter with Normalization)

```graphql
input AnalyticsFilterInput {
  # Required
  account_category: AccountCategory!
  report_period: ReportPeriodInput!

  # Dimension Filters
  report_type: ReportType
  entity_cuis: [String!]
  functional_codes: [String!]
  economic_codes: [String!]
  funding_source_ids: [ID!]
  budget_sector_ids: [ID!]
  expense_types: [ExpenseType!]
  county_codes: [String!]
  # ... more filters

  # Normalization Options
  normalization: Normalization # Mode: total, per_capita, percent_gdp
  currency: Currency # RON, EUR, USD
  inflation_adjusted: Boolean # Adjust for inflation (default: false)
  show_period_growth: Boolean # Show period-over-period growth (default: false)
}
```

---

## Query-Specific Documentation

### 1. Entity Analytics (`entityAnalytics`)

**Use case:** Entity rankings, comparisons, and leaderboards.

```graphql
query EntityAnalytics($filter: AnalyticsFilterInput!, $limit: Int, $offset: Int, $sort: SortOrder) {
  entityAnalytics(filter: $filter, limit: $limit, offset: $offset, sort: $sort) {
    nodes {
      entity_cui
      entity_name
      entity_type
      county_code
      county_name
      population
      amount # Display amount (normalized)
      total_amount # Total after normalization
      per_capita_amount # Amount per person
    }
    pageInfo {
      totalCount
      hasNextPage
      hasPreviousPage
    }
  }
}
```

**Supported normalization options:** All (normalization, currency, inflation_adjusted, show_period_growth)

---

### 2. Execution Analytics (`executionAnalytics`)

**Use case:** Time series charts showing budget trends over time.

```graphql
query ExecutionAnalytics($inputs: [AnalyticsInput!]!) {
  executionAnalytics(inputs: $inputs) {
    seriesId
    xAxis {
      name
      type
      unit
    }
    yAxis {
      name
      type
      unit
    }
    data {
      x
      y
    }
  }
}
```

**Input structure:**

```graphql
input AnalyticsInput {
  filter: AnalyticsFilterInput!
  seriesId: String # Optional identifier for the series
}
```

**Supported normalization options:** All (normalization, currency, inflation_adjusted, show_period_growth)

**Y-axis unit is automatically set based on options:**

| Options                                    | Y-Axis Unit       |
| ------------------------------------------ | ----------------- |
| `show_period_growth: true`                 | `%`               |
| `normalization: percent_gdp`               | `% of GDP`        |
| `currency: EUR, inflation_adjusted: true`  | `EUR (real 2024)` |
| `normalization: per_capita, currency: RON` | `RON/capita`      |

---

### 3. Execution Line Items (`executionLineItems`)

**Use case:** Detailed line item listings with filtering and pagination.

#### Root Query (No Entity Context)

```graphql
query ExecutionLineItems(
  $filter: AnalyticsFilterInput!
  $normalization: Normalization
  $limit: Int
  $offset: Int
  $sort: SortOrder
) {
  executionLineItems(
    filter: $filter
    normalization: $normalization
    limit: $limit
    offset: $offset
    sort: $sort
  ) {
    nodes {
      line_item_id
      entity_cui
      functional_code
      economic_code
      year
      month
      quarter
      ytd_amount # Year-to-date (normalized)
      monthly_amount # Monthly (normalized)
      quarterly_amount # Quarterly (normalized, nullable)
    }
    pageInfo {
      totalCount
      hasNextPage
      hasPreviousPage
    }
  }
}
```

**Supported normalization options:**

- `normalization`: `total`, `total_euro`, `percent_gdp` (NOT `per_capita` - no entity context)
- `currency`: RON, EUR, USD
- `inflation_adjusted`: true/false

> **Note:** `per_capita` and `per_capita_euro` are NOT supported at root query level because there's no single entity context to determine population. Use `entity.executionLineItems` instead.

#### Entity Field (With Entity Context)

```graphql
query GetEntityLineItems($cui: ID!, $filter: AnalyticsFilterInput, $normalization: Normalization) {
  entity(cui: $cui) {
    cui
    name
    executionLineItems(filter: $filter, normalization: $normalization, limit: 10000) {
      nodes {
        line_item_id
        functional_code
        ytd_amount
        monthly_amount
        quarterly_amount
      }
      pageInfo {
        totalCount
      }
    }
  }
}
```

**Supported normalization options:** All (including `per_capita` since entity provides population context)

**Per-capita population source:**

| Entity Type          | Population Source           |
| -------------------- | --------------------------- |
| UAT (`is_uat: true`) | UAT's own population        |
| County Council       | County aggregate population |
| Other entities       | No per-capita available     |

---

### 4. Entity Totals (`totalIncome`, `totalExpenses`, `budgetBalance`)

**Use case:** Summary KPIs for an entity page header.

```graphql
query GetEntityDetails($cui: ID!, $period: ReportPeriodInput!) {
  entity(cui: $cui) {
    cui
    name

    totalIncome(period: $period, normalization: total, currency: RON, inflation_adjusted: false)

    totalExpenses(
      period: $period
      normalization: per_capita
      currency: EUR
      inflation_adjusted: true
    )

    budgetBalance(period: $period, normalization: percent_gdp)
  }
}
```

**Field signatures:**

```graphql
type Entity {
  totalIncome(
    period: ReportPeriodInput!
    reportType: ReportType
    normalization: Normalization
    currency: Currency
    inflation_adjusted: Boolean
    main_creditor_cui: String
  ): Float

  totalExpenses(
    period: ReportPeriodInput!
    reportType: ReportType
    normalization: Normalization
    currency: Currency
    inflation_adjusted: Boolean
    main_creditor_cui: String
  ): Float

  budgetBalance(
    period: ReportPeriodInput!
    reportType: ReportType
    normalization: Normalization
    currency: Currency
    inflation_adjusted: Boolean
    main_creditor_cui: String
  ): Float
}
```

**Supported normalization options:** All (normalization, currency, inflation_adjusted)

---

### 5. Entity Trends (`incomeTrend`, `expensesTrend`, `balanceTrend`)

**Use case:** Charts showing entity budget evolution over time.

```graphql
query GetEntityTrends($cui: ID!, $period: ReportPeriodInput!) {
  entity(cui: $cui) {
    cui
    name

    incomeTrend(
      period: $period
      normalization: total
      currency: RON
      inflation_adjusted: true
      show_period_growth: false
    ) {
      seriesId
      xAxis {
        name
        type
        unit
      }
      yAxis {
        name
        type
        unit
      }
      data {
        x
        y
      }
    }

    expensesTrend(
      period: $period
      normalization: per_capita
      currency: EUR
      inflation_adjusted: false
      show_period_growth: true
    ) {
      seriesId
      xAxis {
        name
        type
        unit
      }
      yAxis {
        name
        type
        unit
      }
      data {
        x
        y
      }
    }
  }
}
```

**Field signatures:**

```graphql
type Entity {
  incomeTrend(
    period: ReportPeriodInput!
    reportType: ReportType
    normalization: Normalization
    currency: Currency
    inflation_adjusted: Boolean
    show_period_growth: Boolean
    main_creditor_cui: String
  ): AnalyticsSeries!

  expensesTrend(
    period: ReportPeriodInput!
    reportType: ReportType
    normalization: Normalization
    currency: Currency
    inflation_adjusted: Boolean
    show_period_growth: Boolean
    main_creditor_cui: String
  ): AnalyticsSeries!

  balanceTrend(
    period: ReportPeriodInput!
    reportType: ReportType
    normalization: Normalization
    currency: Currency
    inflation_adjusted: Boolean
    show_period_growth: Boolean
    main_creditor_cui: String
  ): AnalyticsSeries!
}
```

**Supported normalization options:** All (normalization, currency, inflation_adjusted, show_period_growth)

---

## Implementation Guide

### 1. Normalization Presets (Recommended)

For most use cases, offer a simple dropdown with predefined combinations:

```typescript
// Predefined normalization presets
const NORMALIZATION_PRESETS = {
  total_ron: {
    normalization: 'total',
    currency: 'RON',
    inflation_adjusted: false,
  },
  total_ron_real: {
    normalization: 'total',
    currency: 'RON',
    inflation_adjusted: true,
  },
  total_eur: {
    normalization: 'total',
    currency: 'EUR',
    inflation_adjusted: false,
  },
  per_capita_ron: {
    normalization: 'per_capita',
    currency: 'RON',
    inflation_adjusted: false,
  },
  per_capita_eur: {
    normalization: 'per_capita',
    currency: 'EUR',
    inflation_adjusted: false,
  },
  percent_gdp: {
    normalization: 'percent_gdp',
    currency: 'RON', // Ignored for percent_gdp
    inflation_adjusted: false, // Ignored for percent_gdp
  },
} as const;
```

### 2. UI Component Structure

```typescript
interface NormalizationControlsProps {
  value: NormalizationOptions;
  onChange: (options: NormalizationOptions) => void;
  /** Set to true when in entity context (enables per_capita) */
  allowPerCapita?: boolean;
  /** Set to true for trend queries (enables show_period_growth) */
  allowGrowth?: boolean;
}

interface NormalizationOptions {
  normalization: 'total' | 'per_capita' | 'percent_gdp';
  currency: 'RON' | 'EUR' | 'USD';
  inflation_adjusted: boolean;
  show_period_growth: boolean;
}
```

### 3. Recommended UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Display Mode                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Total Amount              ▼                          │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Currency                                                   │
│  ○ RON    ○ EUR    ○ USD                                   │
│                                                             │
│  ☐ Adjust for inflation (constant 2024 prices)             │
│  ☐ Show period-over-period growth (trends only)            │
└─────────────────────────────────────────────────────────────┘
```

### 4. Conditional UI Based on Context

```typescript
function NormalizationControls({
  value,
  onChange,
  allowPerCapita = false,
  allowGrowth = false
}: NormalizationControlsProps) {
  const modeOptions = [
    { value: 'total', label: 'Total Amount' },
    ...(allowPerCapita ? [{ value: 'per_capita', label: 'Per Capita' }] : []),
    { value: 'percent_gdp', label: '% of GDP' },
  ];

  const isPercentGdp = value.normalization === 'percent_gdp';

  return (
    <div>
      <Select
        label="Display Mode"
        options={modeOptions}
        value={value.normalization}
        onChange={(v) => onChange({ ...value, normalization: v })}
      />

      {/* Currency disabled for percent_gdp */}
      <RadioGroup
        label="Currency"
        options={['RON', 'EUR', 'USD']}
        value={value.currency}
        onChange={(v) => onChange({ ...value, currency: v })}
        disabled={isPercentGdp}
      />

      {/* Inflation disabled for percent_gdp */}
      <Checkbox
        label="Adjust for inflation (constant 2024 prices)"
        checked={value.inflation_adjusted}
        onChange={(v) => onChange({ ...value, inflation_adjusted: v })}
        disabled={isPercentGdp}
      />

      {/* Growth only shown for trend queries */}
      {allowGrowth && (
        <Checkbox
          label="Show period-over-period growth"
          checked={value.show_period_growth}
          onChange={(v) => onChange({ ...value, show_period_growth: v })}
        />
      )}
    </div>
  );
}
```

---

## Normalization Logic Details

### Processing Order

The server applies transformations in this specific order:

```
1. If percent_gdp mode:
   └── value = (raw_amount / GDP) × 100
   └── STOP (inflation and currency ignored)

2. Else (standard path):
   ├── If inflation_adjusted:
   │   └── value = value × CPI_factor
   ├── If currency != RON:
   │   └── value = value / exchange_rate
   └── If per_capita mode:
       └── value = value / population

3. If show_period_growth:
   └── value = ((current - previous) / previous) × 100
```

### Important Behaviors

#### Inflation Adjustment

- **Reference Year**: 2024 (CPI = 100)
- **Effect**: Earlier years get multiplied up to 2024 equivalent purchasing power
- **Example**: 2020 amount × 1.25 CPI factor = 2024-equivalent value
- **Note**: CPI factors are derived from year-over-year indices, chained to build cumulative price levels

#### Currency Conversion

- Uses **period-specific** exchange rates (not current rates)
- 2020 data uses 2020 average EUR/USD rate
- Ensures historical accuracy

#### Per Capita Population Source

Population depends on entity type:

| Entity Type         | Population Source              |
| ------------------- | ------------------------------ |
| UAT (is_uat = true) | UAT's own population           |
| County Council      | County aggregate population    |
| Other entities      | No population (per_capita = 0) |

#### Percent GDP

- **Exclusive mode**: Ignores inflation_adjusted and currency settings
- **Output range**: 0-100 (percentage)
- Uses **nominal GDP** for the corresponding year
- GDP dataset is in full RON (not millions)

#### Frequency-Matched Factors

For line items, different amount columns use different frequencies for factor lookup:

| Column             | Factor Frequency | Label Format |
| ------------------ | ---------------- | ------------ |
| `ytd_amount`       | YEAR             | `"2023"`     |
| `monthly_amount`   | MONTH            | `"2023-06"`  |
| `quarterly_amount` | QUARTER          | `"2023-Q2"`  |

---

## Display Formatting

### Recommended Number Formats

| Mode           | Format                       | Example             |
| -------------- | ---------------------------- | ------------------- |
| Total RON      | `#,###,### RON`              | `1,234,567,890 RON` |
| Total EUR/USD  | `#,###,### €` / `$#,###,###` | `234,567,890 €`     |
| Per Capita RON | `#,### RON/loc`              | `1,234 RON/loc`     |
| Per Capita EUR | `#,### €/loc`                | `234 €/loc`         |
| Percent GDP    | `#.##%`                      | `0.45%`             |
| Growth         | `+#.#%` / `-#.#%`            | `+12.3%`            |

### Label Suggestions

| Mode                           | Y-Axis Label      | Tooltip Label                 |
| ------------------------------ | ----------------- | ----------------------------- |
| Total RON                      | "Suma (RON)"      | "Total: X RON"                |
| Total RON (inflation adjusted) | "Suma (RON 2024)" | "Total (prețuri 2024): X RON" |
| Total EUR                      | "Suma (EUR)"      | "Total: X EUR"                |
| Per Capita                     | "RON/locuitor"    | "Per capita: X RON/loc"       |
| Percent GDP                    | "% din PIB"       | "X% din PIB"                  |

---

## Sort Configuration

### Available Sort Fields (Entity Analytics)

| Field               | Description               | Best With                   |
| ------------------- | ------------------------- | --------------------------- |
| `TOTAL_AMOUNT`      | Sort by normalized total  | `normalization: total`      |
| `PER_CAPITA_AMOUNT` | Sort by per-capita value  | `normalization: per_capita` |
| `AMOUNT`            | Sort by display amount    | Any mode                    |
| `ENTITY_NAME`       | Alphabetical by name      | Any mode                    |
| `POPULATION`        | Sort by entity population | `normalization: per_capita` |
| `COUNTY_NAME`       | Alphabetical by county    | Geographic analysis         |

### Available Sort Fields (Execution Line Items)

| Field              | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `year`             | Sort by year                                                    |
| `ytd_amount`       | Sort by year-to-date amount                                     |
| `monthly_amount`   | Sort by monthly amount                                          |
| `quarterly_amount` | Sort by quarterly amount                                        |
| `amount`           | Virtual field - maps to appropriate column based on period type |
| `functional_code`  | Sort by functional classification                               |
| `economic_code`    | Sort by economic classification                                 |

### Default Sort Behavior

| Normalization Mode                   | Default Sort             |
| ------------------------------------ | ------------------------ |
| `total`, `total_euro`, `percent_gdp` | `TOTAL_AMOUNT DESC`      |
| `per_capita`, `per_capita_euro`      | `PER_CAPITA_AMOUNT DESC` |

---

## Legacy Mode Migration

The `total_euro` and `per_capita_euro` modes are **legacy** values for backward compatibility. New implementations should use the explicit combination:

| Legacy Mode       | Modern Equivalent                             |
| ----------------- | --------------------------------------------- |
| `total_euro`      | `normalization: total` + `currency: EUR`      |
| `per_capita_euro` | `normalization: per_capita` + `currency: EUR` |

The server automatically handles this mapping internally via `resolveNormalizationRequest()`.

---

## Error Handling

### Common Scenarios

| Scenario                          | API Behavior                   | Client Handling          |
| --------------------------------- | ------------------------------ | ------------------------ |
| Missing population for per_capita | Returns `per_capita_amount: 0` | Show "N/A" or filter out |
| Missing GDP for percent_gdp       | Returns `0` for that period    | Show "N/A"               |
| per_capita at root query level    | Works but divides by 0 → 0     | Use entity context       |
| Invalid normalization value       | GraphQL validation error       | Form validation          |
| No data for period                | Empty `nodes` array            | Show "No data" message   |

---

## Complete TypeScript Example

```typescript
import { gql, useQuery } from '@apollo/client';

// Types
interface NormalizationOptions {
  normalization: 'total' | 'per_capita' | 'percent_gdp';
  currency: 'RON' | 'EUR' | 'USD';
  inflationAdjusted: boolean;
  showPeriodGrowth: boolean;
}

// GraphQL Query for Entity Page
const ENTITY_PAGE_QUERY = gql`
  query EntityPage(
    $cui: ID!
    $period: ReportPeriodInput!
    $normalization: Normalization
    $currency: Currency
    $inflationAdjusted: Boolean
    $showPeriodGrowth: Boolean
  ) {
    entity(cui: $cui) {
      cui
      name
      entity_type

      # Summary totals
      totalIncome(
        period: $period
        normalization: $normalization
        currency: $currency
        inflation_adjusted: $inflationAdjusted
      )
      totalExpenses(
        period: $period
        normalization: $normalization
        currency: $currency
        inflation_adjusted: $inflationAdjusted
      )
      budgetBalance(
        period: $period
        normalization: $normalization
        currency: $currency
        inflation_adjusted: $inflationAdjusted
      )

      # Trends
      incomeTrend(
        period: $period
        normalization: $normalization
        currency: $currency
        inflation_adjusted: $inflationAdjusted
        show_period_growth: $showPeriodGrowth
      ) {
        seriesId
        xAxis { name type unit }
        yAxis { name type unit }
        data { x y }
      }

      expensesTrend(
        period: $period
        normalization: $normalization
        currency: $currency
        inflation_adjusted: $inflationAdjusted
        show_period_growth: $showPeriodGrowth
      ) {
        seriesId
        xAxis { name type unit }
        yAxis { name type unit }
        data { x y }
      }
    }
  }
`;

// React Hook
function useEntityPage(cui: string, options: NormalizationOptions) {
  return useQuery(ENTITY_PAGE_QUERY, {
    variables: {
      cui,
      period: {
        type: 'YEAR',
        selection: {
          interval: { start: '2020', end: '2024' },
        },
      },
      normalization: options.normalization,
      currency: options.currency,
      inflationAdjusted: options.inflationAdjusted,
      showPeriodGrowth: options.showPeriodGrowth,
    },
  });
}

// Usage
function EntityPage({ cui }: { cui: string }) {
  const [normalization, setNormalization] = useState<NormalizationOptions>({
    normalization: 'total',
    currency: 'RON',
    inflationAdjusted: false,
    showPeriodGrowth: false,
  });

  const { data, loading, error } = useEntityPage(cui, normalization);

  // Format amount based on normalization options
  const formatAmount = (value: number | null) => {
    if (value === null) return 'N/A';

    if (normalization.normalization === 'percent_gdp') {
      return `${value.toFixed(2)}%`;
    }

    const symbol = normalization.currency === 'EUR' ? '€'
                 : normalization.currency === 'USD' ? '$'
                 : 'RON';

    if (normalization.normalization === 'per_capita') {
      return `${value.toLocaleString()} ${symbol}/loc`;
    }

    return `${value.toLocaleString()} ${symbol}`;
  };

  // Get Y-axis label suffix
  const getYAxisSuffix = () => {
    if (normalization.showPeriodGrowth) return '';
    if (normalization.inflationAdjusted) return ' (prețuri 2024)';
    return '';
  };

  if (loading) return <Loading />;
  if (error) return <Error error={error} />;

  return (
    <div>
      <NormalizationControls
        value={normalization}
        onChange={setNormalization}
        allowPerCapita={true}  // Entity context available
        allowGrowth={true}     // Trends available
      />

      <StatsCards>
        <StatCard label="Venituri" value={formatAmount(data.entity.totalIncome)} />
        <StatCard label="Cheltuieli" value={formatAmount(data.entity.totalExpenses)} />
        <StatCard label="Sold" value={formatAmount(data.entity.budgetBalance)} />
      </StatsCards>

      <TrendChart
        title={`Venituri${getYAxisSuffix()}`}
        series={data.entity.incomeTrend}
      />

      <TrendChart
        title={`Cheltuieli${getYAxisSuffix()}`}
        series={data.entity.expensesTrend}
      />
    </div>
  );
}
```

---

## Related Documentation

- [NORMALIZATION-FACTORS.md](./NORMALIZATION-FACTORS.md) - Technical details on CPI, exchange rates, GDP, and population factors
- [NORMALIZATION-QUERY-EXTENSION-SPEC.md](./NORMALIZATION-QUERY-EXTENSION-SPEC.md) - Server-side implementation specification
- [SQL-LEVEL-NORMALIZATION-SPEC.md](./SQL-LEVEL-NORMALIZATION-SPEC.md) - SQL-level normalization for pagination
- [ENTITY-RANKING-SPEC.md](./ENTITY-RANKING-SPEC.md) - Entity ranking and comparison features
