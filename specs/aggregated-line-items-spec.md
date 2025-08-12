# Aggregated Line Items Endpoint

## 1. Overview

The `aggregatedLineItems` GraphQL endpoint provides a flexible way to query and analyze aggregated budget execution data across multiple entities. Unlike entity-specific queries, this endpoint allows for a nationwide or county-level view of financial data, grouped by functional and economic classifications. This is essential for understanding spending patterns, comparing financial data across different regions, and generating high-level reports.

## 2. Problem Statement

Currently, the system lacks a dedicated endpoint to analyze aggregated execution line items across a broad scope (e.g., all entities, entities within a specific county). While the `entityAnalytics` endpoint provides detailed information for individual entities, it does not support high-level aggregation without being tied to a specific entity. The new endpoint will address this gap by enabling queries that are not constrained to a single entity, thus allowing for macroeconomic analysis and cross-entity comparisons.

## 3. Proposed Solution

We will introduce a new top-level query in our GraphQL schema named `aggregatedLineItem`. This query will accept the existing `AnalyticsFilterInput` to allow for powerful and flexible filtering. The endpoint will return a paginated list of aggregated execution line items, where each item represents a unique combination of a functional and an economic classification code.

### 3.1. GraphQL Schema Changes

We will define a new type, `AggregatedLineItem`, to represent the aggregated data. This type will include the functional and economic classification details, the total aggregated amount, and a count of the line items that were grouped together.

```graphql
type AggregatedLineItem {
  functional_classification_code: String!
  functional_classification_name: String!
  economic_classification_code: String!
  economic_classification_name: String!
  total_amount: Float!
  line_item_count: Int!
}

type AggregatedLineItemConnection {
  nodes: [AggregatedLineItem!]!
  pageInfo: PageInfo!
}

# Add to Query type
type Query {
  # ... existing queries
  aggregatedLineItem(
    filter: AnalyticsFilterInput!
    limit: Int = 50
    offset: Int = 0
  ): AggregatedLineItemConnection!
}
```

### 3.2. Backend Implementation

- **Repository**: A new repository, `aggregatedLineItemsRepository`, will be created to handle the database queries. This repository will be responsible for building and executing a SQL query that:
  - Filters `ExecutionLineItems` based on the provided `AnalyticsFilterInput`.
  - Joins with `FunctionalClassifications` and `EconomicClassifications` to retrieve the names.
  - Groups the results by `functional_code` and `economic_code`.
  - Aggregates the `amount` using `SUM()` and counts the line items using `COUNT()`.
  - Implements pagination using `LIMIT` and `OFFSET`.

- **Resolver**: A new resolver will be created for the `aggregatedLineItem` query. This resolver will:
  - Call the `aggregatedLineItemsRepository` to fetch the data.
  - Handle pagination logic and return the data in the shape of `AggregatedLineItemConnection`.

## 4. Use Cases

- **National Spending Analysis**: Query all expenses nationwide for a specific functional classification (e.g., education, healthcare) to understand the total spending in that area.
- **County-Level Budget Comparison**: Compare the spending on public infrastructure between two or more counties by filtering by `county_codes`.
- **Funding Source Analysis**: Analyze how much money from a specific funding source (e.g., EU funds) is being spent on different economic classifications.
- **Trend Analysis**: By using the `years` filter, analysts can observe how spending in different categories has evolved over time.

## 5. Pagination and Sorting

The endpoint will support pagination through `limit` and `offset` arguments to handle large datasets efficiently. Initially, sorting will be defaulted to the aggregated amount in descending order to show the most significant results first.
