# Execution Line Items Analytics Module

This module provides advanced analytics capabilities for budget execution line items. It allows users to query aggregated time-series data with powerful filtering and normalization options.

## Overview

The Execution Analytics module enables the visualization of budget trends over time (monthly, quarterly, yearly). It sits on top of the `ExecutionLineItems` fact table and provides a flexible GraphQL API (`executionAnalytics`) to generate data series for charts and dashboards.

## Architecture

This module follows the project's **Hexagonal Architecture**:

- **Core (`/core`)**: Contains the pure business logic for analytics.
  - **Data Retrieval**: Fetches aggregated data from the database based on filters.
  - **Normalization Pipeline**: Applies financial transformations (inflation adjustment, currency conversion, per capita normalization) to the raw data.
  - **Types**: Defines the strict interfaces for filters and normalization options.
- **Shell (`/shell`)**: Adapts the core logic to the outside world.
  - **GraphQL**: Maps GraphQL `AnalyticsInput` to core types and returns `AnalyticsSeries`.
  - **Repository**: Implements the database queries using Kysely.

## Key Features

### 1. Reusable Filter Logic (`AnalyticsFilter`)

The module uses a unified `AnalyticsFilterInput` that allows filtering by any dimension of the budget data:

- **Time**: Period (Month/Quarter/Year), Interval.
- **Classification**: Functional & Economic codes (exact or prefix), Funding Sources, Budget Sectors.
- **Entity**: Specific Entities (CUI), UATs, Regions, Counties.
- **Attributes**: Expense Type (Development/Operational), Account Category (Income/Expenses).

### 2. Normalization Pipeline

Raw data from the database is always in **Nominal RON**. The normalization pipeline transforms this data based on user request:

1. **Inflation Adjustment**: Adjusts historical values to "Real 2024 terms" using CPI data.
2. **Currency Conversion**: Converts values to EUR or USD using historical average exchange rates.
3. **Normalization**:
   - `total`: Raw sum.
   - `per_capita`: Divides by the population of the relevant entity/region.
   - `percent_gdp`: Expresses the value as a percentage of the GDP.

### 3. Time Series Generation

The module returns `AnalyticsSeries` objects compatible with frontend charting libraries, supporting:

- Dynamic X-Axis (Dates).
- Multiple Series comparison.
- Metadata (Units, Axis types).

## Data Flow

1. **GraphQL Request**: User requests `executionAnalytics` with filters and normalization options.
2. **Query Construction**: The Repository constructs an optimized SQL query to aggregate `ExecutionLineItems` by time period.
3. **Raw Aggregation**: Database returns raw sums (Nominal RON) grouped by period.
4. **Normalization**: The Logic layer processes each data point:
   - `Value = normalize(RawValue, Year, Options)`
5. **Response**: Returns formatted `AnalyticsSeries`.

## Usage

### GraphQL Query Example

```graphql
query GetEducationExpenses {
  executionAnalytics(
    inputs: [
      {
        seriesId: "education_expenses_real_euro"
        filter: {
          account_category: ch
          report_period: { type: YEAR, selection: { interval: { start: "2016", end: "2023" } } }
          functional_prefixes: ["65"] # Education
          inflation_adjusted: true
          currency: EUR
          normalization: per_capita
        }
      }
    ]
  ) {
    seriesId
    data {
      x
      y
    }
  }
}
```
