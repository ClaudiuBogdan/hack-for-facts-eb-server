# Strategy for Integrating Monthly Execution Line Items

## 1. Introduction

The goal is to extend the application to store, process, and analyze monthly budget execution line items. Currently, the `ExecutionLineItems` table is designed for annual data. Introducing high-frequency monthly data requires a robust strategy to ensure performance, scalability, and maintainability without disrupting existing functionality.

This document outlines two primary architectural options for achieving this, analyzes their pros and cons, and provides a final recommendation.

## 2. Current State Analysis

The existing system is built around the `ExecutionLineItems` fact table, which contains annual financial data. Key characteristics of the current implementation include:

-   **Schema**: A large, indexed `ExecutionLineItems` table linked to dimension tables like `Reports`, `Entities`, `FunctionalClassifications`, etc. The `Reports` table contains a `reporting_year` and `reporting_period`, which defines the time granularity.
-   **Repository**: A highly dynamic `executionLineItemRepository` builds complex SQL queries with multiple filters and joins. It is heavily optimized with caching.
-   **Analytics**: The GraphQL `analyticsResolver` leverages the repository to provide yearly trend analysis, often using the materialized view `vw_BudgetSummary_ByEntityPeriod` which aggregates data by `reporting_year`.

The core challenge is that introducing a dataset that is potentially 12 times larger per year could degrade the performance of existing annual analytics and require significant changes to this optimized structure.

## 3. Option A: A New, Separate Table for Monthly Data

This approach involves creating a new, dedicated table for monthly data, keeping it physically and logically separate from the existing annual data.

### 3.1. Concept

We would create a new table, `MonthlyExecutionLineItems`, with a schema nearly identical to `ExecutionLineItems`, but optimized for monthly time-series analysis.

### 3.2. Proposed Schema Changes

```sql
-- In schema.sql, add a new table for monthly data
CREATE TABLE MonthlyExecutionLineItems (
    line_item_id BIGSERIAL PRIMARY KEY,
    report_id TEXT NOT NULL,
    -- Other columns identical to ExecutionLineItems...
    year INT NOT NULL,
    month INT NOT NULL CHECK (month >= 1 AND month <= 12),
    -- ...
    FOREIGN KEY (report_id) REFERENCES Reports(report_id) ON DELETE CASCADE,
    -- etc. for other foreign keys
    -- A composite index on year and month would be crucial
    CONSTRAINT unique_monthly_report UNIQUE (report_id) -- Assuming one report per month per entity
);

CREATE INDEX idx_monthly_executionitems_year_month ON MonthlyExecutionLineItems (year, month);
-- Add other indexes optimized for monthly queries as needed
```

### 3.3. Impact on Code

-   **Repository Layer**: A new `monthlyExecutionLineItemRepository.ts` would be created. Much of the logic from `executionLineItemRepository.ts` (like `build...FilterQuery`) could be extracted into a shared utility to avoid code duplication.
-   **GraphQL Layer**: New queries and types would be added to the GraphQL schema and resolvers (e.g., `monthlyExecutionAnalytics`, `MonthlyExecutionLineItem`). This would cleanly separate the APIs for annual and monthly data.
-   **Business Logic**: New services would be required for processing and analyzing monthly data. Existing services would remain untouched.

### 3.4. Pros and Cons

| Pros                                                              | Cons                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| ✅ **Total Isolation**: Zero risk to existing annual data and APIs. | ❌ **Code Duplication**: Risk of duplicated logic in repositories.   |
| ✅ **Optimized Performance**: Each table is indexed for its specific use case. | ❌ **Complex Cross-Queries**: Comparing monthly to annual data requires `UNION` queries. |
| ✅ **Simplicity**: Easy to understand and implement without major refactoring. | ❌ **Maintenance Overhead**: Two sets of tables, repositories, and APIs to maintain. |

---

## 4. Option B: Partitioning the `ExecutionLineItems` Table

This is a more advanced database-centric approach that uses PostgreSQL's native partitioning feature to manage the data within a single logical table.

### 4.1. Concept

The `ExecutionLineItems` table would be converted into a partitioned table. The application would continue to query a single `ExecutionLineItems` table, but PostgreSQL would automatically route queries to smaller, more manageable sub-tables (partitions) based on the date.

A good partitioning key would be the `report_date` from the `Reports` table. We can partition by `RANGE(report_date)`.

### 4.2. Proposed Schema Changes

This is a significant, one-time migration.

```sql
-- 1. Rename the existing table
ALTER TABLE ExecutionLineItems RENAME TO ExecutionLineItems_old;

-- 2. Create the new partitioned table
CREATE TABLE ExecutionLineItems (
    -- Columns are identical to the original table
    line_item_id BIGSERIAL,
    report_id TEXT NOT NULL,
    -- ... all other columns
    -- report_date is the partition key, so it must be present
    report_date DATE NOT NULL 
) PARTITION BY RANGE (report_date);

-- The primary key must include the partition key
ALTER TABLE ExecutionLineItems ADD PRIMARY KEY (line_item_id, report_date);

-- 3. Create partitions (e.g., monthly)
CREATE TABLE execution_line_items_2023_01 PARTITION OF ExecutionLineItems
    FOR VALUES FROM ('2023-01-01') TO ('2023-02-01');
CREATE TABLE execution_line_items_2023_02 PARTITION OF ExecutionLineItems
    FOR VALUES FROM ('2023-02-01') TO ('2023-03-01');
-- ... and so on. A script would be needed to manage partition creation.

-- 4. Migrate data
-- This is a simplified view; a more robust migration script is needed
INSERT INTO ExecutionLineItems (SELECT eli.*, r.report_date FROM ExecutionLineItems_old eli JOIN Reports r ON eli.report_id = r.report_id);

-- 5. Re-create indexes and foreign keys on the partitioned table
```

### 4.3. Impact on Code

-   **Repository Layer**: The main benefit is that the repository layer requires *minimal changes*. The `buildExecutionLineItemFilterQuery` function would need to be updated to filter on `report_date` to leverage partition pruning. Queries for "annual" data would specify a date range for the entire year, while monthly queries would specify a monthly range.
-   **GraphQL Layer**: Existing resolvers would continue to work. New analytical resolvers could be added for monthly trends, reusing the same repository methods with different filters.
-   **Data Loading**: The data import process needs to ensure `report_date` is correctly populated and passed through.

### 4.4. Pros and Cons

| Pros                                                                       | Cons                                                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ✅ **Superior Performance**: Queries for specific time ranges are extremely fast. | ❌ **High Implementation Complexity**: Requires significant DB expertise and a careful migration. |
| ✅ **Unified Interface**: The application interacts with a single logical table. | ❌ **Schema Rigidity**: The partition key must be part of the primary key and unique constraints. |
| ✅ **Simplified Maintenance**: Old data can be archived/deleted by dropping partitions. | ❌ **Requires Downtime**: The migration from a non-partitioned to a partitioned table is complex. |
| ✅ **DRY Principle**: Avoids duplicating data access and business logic.       |                                                                               |

---

## 5. Comparison and Recommendation

| Criteria                  | Option A: Separate Table                                  | Option B: Partitioning                                    |
| ------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| **Implementation Effort** | **Low** - Straightforward, minimal risk.                  | **High** - Complex, requires DB migration.                |
| **Performance**           | **Good** - Isolated tables prevent interference.          | **Excellent** - Partition pruning is ideal for time-series. |
| **Scalability**           | **Good** - Scales well, but joins are a concern.          | **Excellent** - The canonical way to scale large tables in Postgres. |
| **Maintainability**       | **Medium** - Code duplication can lead to higher overhead. | **Good** - A single, clean data access layer.             |

### Recommendation

For a core application feature where large data volumes are expected, **Option B (Partitioning) is the technically superior long-term solution.** It aligns with database best practices for time-series data and provides the best possible performance and scalability, while keeping the application code clean and unified.

However, the implementation complexity and migration effort are significant.

Therefore, I propose the following:

1.  **Ideal Path**: Pursue **Option B (Partitioning)**. This is the right long-term investment for a core feature. It will pay dividends in performance and maintainability as the dataset grows. This path requires allocating time for careful planning and execution of the database migration.

2.  **Pragmatic Path**: If development speed and minimizing risk to the existing system are the absolute top priorities, **Option A (Separate Table)** is a valid and acceptable alternative. It fully meets the requirement of separating the datasets and can be implemented much faster. The team should be prepared to address the code duplication by creating shared utilities and accept the limitations on queries that span both datasets.

Given the importance you've placed on this feature, I recommend investing the effort in **Option B**.
