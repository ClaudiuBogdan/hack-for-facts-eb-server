# Commitments (Angajamente Bugetare) API Specification

> **Status**: Draft
> **Created**: 2025-01-28
> **Updated**: 2025-01-29

---

## 1. Overview

### Purpose

Expose Romanian public budget commitment (Angajamente Bugetare) data via GraphQL API for:

- Dashboard summaries and analytics
- Time-series charting
- Classification breakdowns
- Commitment vs execution comparisons

### Data Scale

| Metric       | Value                                                    |
| ------------ | -------------------------------------------------------- |
| Total rows   | **41M+** in CommitmentsLineItems                         |
| Years        | 2019 - 2025                                              |
| Report types | 3 (Detailed, Principal Aggregated, Secondary Aggregated) |
| Metrics      | 13 YTD, 5 monthly deltas, 13 quarterly deltas            |

---

## 2. Data Layer

### 2.1 Source Fact Table: `CommitmentsLineItems`

Partitioned by `year`. Contains budget commitment line items.

**Key Dimensions:**

- `entity_cui` - Reporting entity
- `main_creditor_cui` - Main creditor (nullable)
- `budget_sector_id` - Budget sector
- `funding_source_id` - Funding source
- `functional_code` - COFOG functional classification
- `economic_code` - Economic classification (nullable)
- `report_type` - One of 3 commitments report types

**YTD Metrics (13):**
| Metric | Description |
|--------|-------------|
| `credite_angajament` | Commitment credits |
| `limita_credit_angajament` | Commitment credit limit |
| `credite_bugetare` | Budget credits |
| `credite_angajament_initiale` | Initial commitment credits |
| `credite_bugetare_initiale` | Initial budget credits |
| `credite_angajament_definitive` | Final commitment credits |
| `credite_bugetare_definitive` | Final budget credits |
| `credite_angajament_disponibile` | Available commitment credits |
| `credite_bugetare_disponibile` | Available budget credits |
| `receptii_totale` | Total receipts |
| `plati_trezor` | Treasury payments |
| `plati_non_trezor` | Non-treasury payments |
| `receptii_neplatite` | Unpaid receipts |

**Monthly Delta Metrics (5 only):**

- `monthly_credite_angajament`
- `monthly_plati_trezor`
- `monthly_plati_non_trezor`
- `monthly_receptii_totale`
- `monthly_receptii_neplatite_change` (note: this is the change, not absolute)

**Quarterly Delta Metrics:** All 13 metrics have `quarterly_*` variants.

**Period Flags:**

- `is_quarterly` - True for months 3, 6, 9, 12 or max available month
- `quarter` - 1-4 when `is_quarterly = true`
- `is_yearly` - True for the max month per entity/year

### 2.2 Materialized Views

| View                               | Period  | Metrics    | GROUP BY                                                  |
| ---------------------------------- | ------- | ---------- | --------------------------------------------------------- |
| `mv_angajamente_summary_monthly`   | Month   | **5 only** | year, month, entity_cui, main_creditor_cui, report_type   |
| `mv_angajamente_summary_quarterly` | Quarter | All 13     | year, quarter, entity_cui, main_creditor_cui, report_type |
| `mv_angajamente_summary_annual`    | Year    | All 13     | year, entity_cui, main_creditor_cui, report_type          |

**Key Constraints:**

1. **Monthly MV has only 5 metrics** - Matches fact table storage; other metrics only available for QUARTER/YEAR periods

2. **MVs exclude `budget_sector_id` and `funding_source_id`** - Filtering by these requires fact table query

3. **Transfer exclusion is hard-coded** - All MVs permanently exclude economic codes `51.01%`, `51.02%` and functional codes `36.02.05%`, `37.02.03%`, `37.02.04%`, `47.02.04%`

4. **No report availability MV exists** - Unlike ExecutionLineItems, there's no pre-computed view for commitments report type availability

### 2.3 Report Types

| GraphQL Enum           | Database Value                                    |
| ---------------------- | ------------------------------------------------- |
| `DETAILED`             | Executie - Angajamente bugetare detaliat          |
| `PRINCIPAL_AGGREGATED` | Executie - Angajamente bugetare agregat principal |
| `SECONDARY_AGGREGATED` | Executie - Angajamente bugetare agregat secundar  |

**Priority order** (when not specified): PRINCIPAL > SECONDARY > DETAILED

---

## 3. GraphQL Schema

### 3.1 Enums

```graphql
enum CommitmentsReportType {
  DETAILED
  PRINCIPAL_AGGREGATED
  SECONDARY_AGGREGATED
}

enum CommitmentsMetric {
  # Available for all periods (MONTH, QUARTER, YEAR)
  CREDITE_ANGAJAMENT
  PLATI_TREZOR
  PLATI_NON_TREZOR
  RECEPTII_TOTALE
  RECEPTII_NEPLATITE_CHANGE # Monthly delta only
  # Only available for QUARTER and YEAR periods
  LIMITA_CREDIT_ANGAJAMENT
  CREDITE_BUGETARE
  CREDITE_ANGAJAMENT_INITIALE
  CREDITE_BUGETARE_INITIALE
  CREDITE_ANGAJAMENT_DEFINITIVE
  CREDITE_BUGETARE_DEFINITIVE
  CREDITE_ANGAJAMENT_DISPONIBILE
  CREDITE_BUGETARE_DISPONIBILE
  RECEPTII_NEPLATITE # Absolute YTD value
}

enum AnomalyType {
  YTD_ANOMALY
  MISSING_LINE_ITEM
}
```

### 3.2 Filter Input

```graphql
input CommitmentsFilterInput {
  # Required
  report_period: ReportPeriodInput!

  # Report type (optional - uses priority fallback if omitted)
  report_type: CommitmentsReportType

  # Entity scope
  entity_cuis: [String!]
  main_creditor_cui: String
  entity_types: [String!]
  is_uat: Boolean
  search: String

  # Classifications (forces fact table query if used)
  functional_codes: [String!]
  functional_prefixes: [String!]
  economic_codes: [String!]
  economic_prefixes: [String!]

  # Budget dimensions (forces fact table query if used)
  funding_source_ids: [ID!]
  budget_sector_ids: [ID!]

  # Geography
  county_codes: [String!]
  regions: [String!]
  uat_ids: [ID!]

  # Population
  min_population: Int
  max_population: Int

  # Amount thresholds (apply to plati_trezor metric)
  aggregate_min_amount: Float # Post-aggregation filter
  aggregate_max_amount: Float
  item_min_amount: Float # Per-row filter, forces fact table
  item_max_amount: Float

  # Transforms
  normalization: Normalization
  currency: Currency
  inflation_adjusted: Boolean
  show_period_growth: Boolean

  # Exclusions
  exclude: CommitmentsExcludeInput
  exclude_transfers: Boolean = true # See constraints below
}
```

### 3.3 Output Types

```graphql
# Summary types vary by period
type CommitmentsMonthlySummary {
  year: Int!
  month: Int!
  entity_cui: String!
  entity_name: String!
  main_creditor_cui: String
  report_type: CommitmentsReportType!
  # Only 5 metrics available
  credite_angajament: Float!
  plati_trezor: Float!
  plati_non_trezor: Float!
  receptii_totale: Float!
  receptii_neplatite_change: Float!
  total_plati: Float!
}

type CommitmentsQuarterlySummary {
  year: Int!
  quarter: Int!
  entity_cui: String!
  entity_name: String!
  main_creditor_cui: String
  report_type: CommitmentsReportType!
  # All 13 metrics available
  # ... (all YTD metrics)
  total_plati: Float!
  execution_rate: Float
  commitment_rate: Float
}

type CommitmentsAnnualSummary {
  year: Int!
  entity_cui: String!
  entity_name: String!
  main_creditor_cui: String
  report_type: CommitmentsReportType!
  # All 13 metrics available
  # ... (all YTD metrics)
  total_plati: Float!
  execution_rate: Float
  commitment_rate: Float
}

union CommitmentsSummaryResult =
  | CommitmentsMonthlySummary
  | CommitmentsQuarterlySummary
  | CommitmentsAnnualSummary

type CommitmentsLineItem {
  id: ID!
  year: Int!
  month: Int!
  report_type: CommitmentsReportType!
  entity_cui: String!
  entity_name: String!
  main_creditor_cui: String
  budget_sector_id: Int!
  budget_sector_name: String!
  funding_source_id: Int!
  funding_source_name: String!
  functional_code: String!
  functional_name: String!
  economic_code: String
  economic_name: String
  # All 13 YTD metrics + 5 monthly metrics
  # Period flags: is_quarterly, quarter, is_yearly
  anomaly: AnomalyType
}

type CommitmentsAggregatedItem {
  functional_code: String!
  functional_name: String!
  economic_code: String # May be null
  economic_name: String # May be null
  amount: Float!
  count: Int!
}

type CommitmentExecutionComparison {
  frequency: PeriodType!
  data: [CommitmentExecutionDataPoint!]!
  total_commitment: Float!
  total_execution: Float!
  total_difference: Float!
  overall_difference_percent: Float
  matched_count: Int!
  unmatched_commitment_count: Int!
  unmatched_execution_count: Int!
}
```

### 3.4 Query Operations

```graphql
extend type Query {
  # Entity-level summaries (uses MVs when possible)
  commitmentsSummary(
    filter: CommitmentsFilterInput!
    limit: Int = 50
    offset: Int = 0
  ): CommitmentsSummaryConnection!

  # Detailed line items (always uses fact table)
  commitmentsLineItems(
    filter: CommitmentsFilterInput!
    limit: Int = 50
    offset: Int = 0
  ): CommitmentsLineItemConnection!

  # Time series for charts
  commitmentsAnalytics(inputs: [CommitmentsAnalyticsInput!]!): [CommitmentsAnalyticsSeries!]!

  # Classification breakdown
  commitmentsAggregated(input: CommitmentsAggregatedInput!): CommitmentsAggregatedConnection!

  # Cross-table comparison
  commitmentVsExecution(input: CommitmentExecutionComparisonInput!): CommitmentExecutionComparison!
}
```

---

## 4. Key Decisions

### 4.1 Report Type Resolution

**Decision**: Optional with fallback.

- If provided: use directly
- If omitted: resolve per (entity, year) combination using priority order
- **Results may mix report types** when querying multiple entities or years
- Each result row includes `report_type` so clients know the source

### 4.2 Transfer Exclusion

**Decision**: Real toggle, but MV-constrained.

| Query Source | `exclude_transfers: true` | `exclude_transfers: false`       |
| ------------ | ------------------------- | -------------------------------- |
| MV           | Exclusions applied        | **Same as true** (MV limitation) |
| Fact table   | Exclusions applied        | No exclusions                    |

Setting `exclude_transfers: false` only has effect for queries that use the fact table.

### 4.3 Monthly Metric Availability

**Decision**: Return validation error for unavailable metrics.

- MONTH period: only 5 metrics available
- QUARTER/YEAR period: all 13 metrics available
- `RECEPTII_NEPLATITE_CHANGE` = monthly delta (MONTH only)
- `RECEPTII_NEPLATITE` = absolute YTD value (QUARTER/YEAR only)

### 4.4 MV vs Fact Table Routing

**Decision**: Automatic routing based on filter complexity.

Use fact table (skip MV) when any of these are present:

- `funding_source_ids` or `budget_sector_ids` filters
- Classification code filters or prefixes
- Exclusions by code (`exclude.*_codes`, `exclude.*_prefixes`)
- `exclude_transfers: false`
- Per-item amount thresholds (`item_min_amount`, `item_max_amount`)

### 4.5 Amount Threshold Semantics

**Decision**: Apply to `plati_trezor` metric.

- `aggregate_*_amount`: Post-aggregation filter (HAVING clause equivalent)
- `item_*_amount`: Per-row filter, forces fact table query

For `commitmentsAggregated`, thresholds apply to the selected metric instead.

### 4.6 Commitment vs Execution Comparison

**Decision**: Full dimensional join with pre-aggregation.

**Join dimensions**: year, month, entity_cui, main_creditor_cui, report_type (mapped), functional_code, economic_code, budget_sector_id, funding_source_id

**Report type mapping**:
| Commitments | Execution |
|-------------|-----------|
| DETAILED | Executie bugetara detaliata |
| PRINCIPAL_AGGREGATED | Executie bugetara agregata la nivel de ordonator principal |
| SECONDARY_AGGREGATED | Executie bugetara agregata la nivel de ordonator secundar |

**Execution side filter**: `account_category = 'ch'` (expenses only)

**Pre-aggregation required**: Both tables must be aggregated to join keys before joining to avoid row multiplication (ExecutionLineItems has `program_code` and `expense_type` not present in commitments).

**Output**: Includes match counts to surface data alignment issues.

---

## 5. Constraints & Limitations

| Constraint                               | Impact                                     | Workaround                                     |
| ---------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| Monthly MV has 5 metrics                 | Cannot query 8 metrics for MONTH           | Return error for unsupported metric+period     |
| MVs exclude budget_sector/funding_source | Filtering by these is slower               | Auto-fallback to fact table                    |
| Transfer exclusion hard-coded in MVs     | Cannot include transfers via MVs           | Use fact table with `exclude_transfers: false` |
| No commitments report availability MV    | Report type resolution requires fact table | Cache results or create MV                     |
| `economic_code` is nullable              | NULL in aggregated results                 | Handle in UI display                           |

---

## 6. Caching Recommendations

| Query                               | TTL | Notes                  |
| ----------------------------------- | --- | ---------------------- |
| `commitmentsSummary` (historical)   | 24h | MV-backed, stable data |
| `commitmentsSummary` (current year) | 1h  | May update monthly     |
| `commitmentsSummary` (fact table)   | 15m | Complex filters        |
| `commitmentsLineItems`              | 15m | Always fact table      |
| `commitmentsAnalytics`              | 4h  | Aggregated charts      |
| `commitmentVsExecution`             | 1h  | Cross-table join       |

---

## 7. Future Considerations

1. **`mv_angajamente_report_availability`** - Would improve report type resolution performance

2. **Additional monthly delta columns** - Would enable all 13 metrics for MONTH period (requires ETL change)

3. **Add `budget_sector_id` to MV GROUP BY** - Would enable sector filtering via MVs (trade-off: larger MVs)

---

## References

- Database schema: `hack-for-facts-eb-scrapper/src/seed/schema.sql`
- Server schema: `src/infra/database/budget/schema.sql`
- Business logic: `hack-for-facts-eb-scrapper/docs/ANGAJAMENTE_BUGETARE_EXTRACTION.md`
- Pattern reference: `src/modules/execution-analytics/`
