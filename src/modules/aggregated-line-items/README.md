# Aggregated Line Items Module

Provides aggregated budget execution data grouped by functional and economic classification codes.

## Purpose

This module enables macroeconomic analysis by aggregating individual budget line items into classification-level totals. It supports:

- Cross-entity budget comparisons
- Functional/economic classification breakdowns
- Multi-year analysis with proper normalization

## Business Logic

### Normalize-Then-Aggregate Pattern

The critical design decision is that **normalization happens before aggregation**:

```
Raw DB Data (per classification, per year)
    │
    ▼
Apply Year-Specific Normalization Factors
    │ (CPI, exchange rates, GDP, population vary by year)
    ▼
Aggregate by Classification (sum across years)
    │
    ▼
Sort by Amount DESC → Paginate
```

This ensures correct handling of multi-year data where inflation rates and exchange rates differ.

### Transformation Pipeline

| Step         | Description                                                  |
| ------------ | ------------------------------------------------------------ |
| 1. Fetch     | Query DB grouped by `(functional_code, economic_code, year)` |
| 2. Normalize | Apply per-year factors based on normalization mode           |
| 3. Aggregate | Sum amounts by `(functional_code, economic_code)`            |
| 4. Filter    | Apply `aggregate_min_amount` / `aggregate_max_amount`        |
| 5. Sort      | Order by amount descending                                   |
| 6. Paginate  | Apply `limit` and `offset`                                   |

### Normalization Modes

| Mode          | Calculation                            |
| ------------- | -------------------------------------- |
| `total`       | Raw sum in RON (or converted currency) |
| `per_capita`  | Amount ÷ population                    |
| `percent_gdp` | (Amount ÷ GDP) × 100                   |

**Additional transforms:**

- `inflation_adjusted`: Multiplies by CPI factor (reference year 2024)
- `currency: EUR/USD`: Divides by exchange rate

**Important:** `percent_gdp` ignores inflation and currency settings (enforces nominal/nominal ratio).

### Amount Column Selection

The correct amount column depends on the period type:

| Period Type | Amount Column      |
| ----------- | ------------------ |
| `YEAR`      | `ytd_amount`       |
| `QUARTER`   | `quarterly_amount` |
| `MONTH`     | `monthly_amount`   |

### Economic Code Handling

- NULL economic codes default to `'00.00.00'`
- NULL economic names default to `'Unknown economic classification'`
- Economic code exclusions apply only to expense accounts (`account_category != 'vn'`)

## GraphQL Interface

```graphql
query {
  aggregatedLineItems(
    filter: AnalyticsFilterInput!
    limit: Int = 50
    offset: Int = 0
  ): AggregatedLineItemConnection!
}

type AggregatedLineItem {
  functional_code: String!
  functional_name: String!
  economic_code: String!
  economic_name: String!
  amount: Float!
  count: Int!
}
```

## Example Query

```graphql
query NationalEducationSpending {
  aggregatedLineItems(
    filter: {
      account_category: ch
      report_period: { type: YEAR, selection: { interval: { start: "2020", end: "2024" } } }
      functional_prefixes: ["65"] # Education
      normalization: per_capita
      inflation_adjusted: true
    }
    limit: 10
  ) {
    nodes {
      functional_code
      functional_name
      amount
      count
    }
    pageInfo {
      totalCount
      hasNextPage
    }
  }
}
```

## Dependencies

- **NormalizationService**: Provides year-specific factors for CPI, exchange rates, GDP, population
- **AnalyticsFilter**: Reuses the same filter interface as `executionAnalytics`
