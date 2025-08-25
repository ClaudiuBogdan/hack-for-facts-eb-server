https://gemini.google.com/app/d7fbd85e7633eae5

Of course. Here is the unified specification document for implementing the new monthly execution line items feature, based on an analysis of the provided documents and the decision to use a separate, partitioned table.

-----

## Unified Specification: Monthly Budget Execution Data Implementation

### 1\. Executive Summary & Guiding Principles

This document provides the definitive architectural and implementation plan for integrating **monthly budget execution data** into the application. The primary business goal is to enable granular, time-series analysis of monthly financial data without compromising the performance or stability of the existing annual reporting system.

The chosen strategy is to create a **new, fully separate fact table named `MonthlyExecutionLineItems`**. This approach was selected to guarantee:

  * **Isolation & Performance**: Queries against annual data are completely unaffected by the much larger volume of monthly data. Each dataset can have its own tailored indexing, partitioning, and optimization strategies.
  * **Analytical Clarity**: A clear separation prevents accidental aggregation of data with different granularities (e.g., mixing annual totals with monthly figures), ensuring analytical integrity.
  * **Scalability & Maintainability**: The monthly dataset, which is expected to grow at least 12 times faster than the annual data, can be managed independently. This simplifies data retention policies, archiving, and maintenance tasks like vacuuming and index rebuilding.

-----

### 2\. Database Layer Implementation

The foundation of this feature is a well-designed, partitioned table for monthly data and a corresponding table for monthly report metadata.

#### 2.1. Schema Definition

We will introduce two new tables: `MonthlyReports` and `MonthlyExecutionLineItems`.

1.  **`MonthlyReports` Table**: This table will store metadata for each monthly report, ensuring clear separation from the existing `Reports` table.

    ```sql
    CREATE TABLE MonthlyReports (
        monthly_report_id TEXT PRIMARY KEY,
        entity_cui VARCHAR(20) NOT NULL REFERENCES Entities(cui) ON DELETE RESTRICT,
        report_type report_type NOT NULL,
        main_creditor_cui VARCHAR(20) REFERENCES Entities(cui) ON DELETE RESTRICT,
        report_date DATE NOT NULL,
        reporting_year INT NOT NULL,
        reporting_month INT NOT NULL CHECK (reporting_month >= 1 AND reporting_month <= 12),
        budget_sector_id INT NOT NULL REFERENCES BudgetSectors(sector_id) ON DELETE RESTRICT,
        file_source TEXT,
        import_timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        download_links TEXT[],
        UNIQUE (entity_cui, reporting_year, reporting_month, main_creditor_cui, budget_sector_id)
    );

    COMMENT ON TABLE MonthlyReports IS 'Metadata for each imported monthly budget execution report.';
    ```

2.  **`MonthlyExecutionLineItems` Partitioned Table**: This will be the main fact table. It will be declaratively partitioned by year to ensure efficient querying and maintenance.

    ```sql
    CREATE TABLE MonthlyExecutionLineItems (
        line_item_id        BIGSERIAL,
        monthly_report_id   TEXT NOT NULL REFERENCES MonthlyReports(monthly_report_id) ON DELETE CASCADE,
        entity_cui          VARCHAR(20) NOT NULL REFERENCES Entities(cui),
        -- ... other dimension columns identical to ExecutionLineItems (funding_source_id, etc.)
        account_category    CHAR(2) NOT NULL CHECK (account_category IN ('vn','ch')),
        amount              DECIMAL(18,2) NOT NULL,
        year                INT NOT NULL,
        month               INT NOT NULL CHECK (month BETWEEN 1 AND 12),
        -- The partition key 'year' must be part of the primary key
        PRIMARY KEY (line_item_id, year)
    ) PARTITION BY RANGE (year);

    COMMENT ON TABLE MonthlyExecutionLineItems IS 'Fact table for monthly execution data, partitioned by year.';
    ```

#### 2.2. Partitioning Strategy

Partitioning is crucial for managing this large dataset. We will use **RANGE partitioning on the `year` column**.

  * **Rationale**: This strategy physically separates data by year. Queries filtered by a specific year or a range of months within a year will only scan the relevant partitions (**partition pruning**), dramatically improving performance. It also makes archival or deletion of old data (e.g., dropping the 2020 partition) an instantaneous metadata operation.

  * **Implementation**: Partitions must be created manually or via an automated script.

    ```sql
    -- Example partitions for 2024 and 2025
    CREATE TABLE MonthlyExecutionLineItems_2024 PARTITION OF MonthlyExecutionLineItems
        FOR VALUES FROM (2024) TO (2025);

    CREATE TABLE MonthlyExecutionLineItems_2025 PARTITION OF MonthlyExecutionLineItems
        FOR VALUES FROM (2025) TO (2026);
    ```

#### 2.3. Indexing Strategy

Indexes will be created on the parent partitioned table, and PostgreSQL will automatically create them on each partition.

  * **Primary Access Path Index**: A composite index to cover the most common query pattern: filtering by entity and time. The `INCLUDE` clause adds leaf data to the index, allowing for **index-only scans** for many analytical queries.
    ```sql
    CREATE INDEX idx_monthly_eli_entity_year_month
    ON MonthlyExecutionLineItems (entity_cui, year, month)
    INCLUDE (amount, functional_code, economic_code, account_category);
    ```
  * **Time-Series BRIN Index**: A **BRIN (Block Range Index)** is highly efficient for large, naturally ordered data like time-series. It has a very small footprint and speeds up sequential scans over date ranges.
    ```sql
    CREATE INDEX idx_monthly_eli_year_month_brin
    ON MonthlyExecutionLineItems USING brin(year, month);
    ```
  * **Foreign Key & Dimension Indexes**: Standard B-tree indexes should be placed on all foreign key columns (`funding_source_id`, `functional_code`, etc.) to optimize joins.

#### 2.4. Materialized Views

To support fast analytical queries, we will create monthly equivalents of the existing annual materialized views.

```sql
CREATE MATERIALIZED VIEW vw_MonthlyBudgetSummary_ByEntity AS
SELECT
    eli.year,
    eli.month,
    eli.entity_cui,
    e.name AS entity_name,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.amount ELSE 0 END) AS total_expense
FROM MonthlyExecutionLineItems eli
JOIN Entities e ON eli.entity_cui = e.cui
GROUP BY eli.year, eli.month, eli.entity_cui, e.name;

-- An index on the materialized view is critical for performance
CREATE INDEX idx_mv_monthly_summary_entity_year_month ON vw_MonthlyBudgetSummary_ByEntity(entity_cui, year, month);
```

-----

### 3\. Application Layer Implementation

To ensure clean data encapsulation and avoid code duplication, we will create a dedicated repository for monthly data while abstracting shared logic.

#### 3.1. Repository Architecture

A new repository, `monthlyExecutionLineItemRepository.ts`, will be created.

  * **Shared Logic**: Common query-building logic (e.g., applying filters for entities, functional codes, etc.) currently in `executionLineItemRepository.ts` must be extracted into a shared utility or a `BaseExecutionRepository` class. This ensures that both repositories remain DRY.

  * **Repository Factory (Recommended)**: To enforce consistency and eliminate duplication, a factory pattern is the best approach.

    ```typescript
    // src/db/repositories/executionRepoFactory.ts
    function createExecutionRepository(tableName: 'ExecutionLineItems' | 'MonthlyExecutionLineItems') {
      // Contains all shared logic (buildFilterQuery, etc.) that works on either table
      // Returns an object with methods like getAll, count, etc.
    }

    // src/db/repositories/executionLineItemRepository.ts
    export const executionLineItemRepository = createExecutionRepository('ExecutionLineItems');

    // src/db/repositories/monthlyExecutionLineItemRepository.ts
    export const monthlyExecutionLineItemRepository = createExecutionRepository('MonthlyExecutionLineItems');
    ```

  * **Monthly-Specific Analytics**: The `monthlyExecutionLineItemRepository` will contain new methods for monthly analytics, such as `getMonthOverMonthGrowth`, `getSeasonalTrends`, or `getYearOverYearComparison`.

#### 3.2. Type Definitions

New TypeScript types will be created for monthly filters.

```typescript
// src/db/repositories/monthlyExecutionLineItemRepository.ts
export interface MonthlyAnalyticsFilter extends Omit<AnalyticsFilter, 'years'> {
    years: number[];
    months?: number[]; // Optional: array of months 1-12
    dateRange?: {
        start: string; // 'YYYY-MM'
        end: string;   // 'YYYY-MM'
    };
}
```

-----

### 4\. API Layer (GraphQL)

The GraphQL API will be extended with new types and queries dedicated to monthly data. This provides a clear, unambiguous interface for clients.

#### 4.1. GraphQL Schema Extensions

```graphql
# New type for a single monthly line item
type MonthlyExecutionLineItem {
    lineItemId: ID!
    monthlyReport: MonthlyReport!
    entity: Entity!
    # ... other fields similar to ExecutionLineItem
    year: Int!
    month: Int!
    amount: Float!
}

# New input filter for monthly queries
input MonthlyAnalyticsFilterInput {
    # ... fields similar to AnalyticsFilterInput but with years/months
    years: [Int!]
    months: [Int!]
    entityCUI: [String!]
    # ... etc
}

# Extend the main Query type
extend type Query {
    monthlyExecutionLineItem(id: ID!): MonthlyExecutionLineItem

    monthlyExecutionLineItems(
        filter: MonthlyAnalyticsFilterInput
        limit: Int = 100
        offset: Int = 0
    ): [MonthlyExecutionLineItem!]

    monthlyExecutionAnalytics(
        inputs: [AnalyticsInput!]!
    ): [AnalyticsSeries!]!
}
```

*Note*: The `monthlyExecutionAnalytics` query will return an `AnalyticsSeries` where the `x` value of each data point is a string like `"2025-01"`.

#### 4.2. Resolvers

New resolvers will be implemented in `monthlyExecutionLineItemResolver.ts` and `analyticsResolver.ts`. These resolvers will exclusively call the new `monthlyExecutionLineItemRepository` to fetch data, keeping the concerns completely separate from the annual data resolvers.

-----

### 5\. Data Ingestion (ETL) Strategy

A robust, transactional ETL process is required for loading large monthly data files.

1.  **Staging Table**: Data will first be bulk-loaded into a transient staging table (`stg_monthly_line_items`) using the fast `COPY` command.
2.  **Validation & Transformation**: In a single transaction, a `INSERT INTO ... SELECT FROM` statement will move data from the staging table into the correct `MonthlyExecutionLineItems` partition. This step will perform all necessary validations, foreign key lookups, and transformations.
3.  **Conflict Handling**: The `INSERT` statement should use an `ON CONFLICT DO NOTHING` clause with a unique constraint on the source data's natural key (e.g., `report_id`, `functional_code`, `economic_code`, `month`) to ensure idempotency.
4.  **Materialized View Refresh**: After the transaction successfully commits, a separate process will be triggered to refresh the monthly materialized views (`REFRESH MATERIALIZED VIEW CONCURRENTLY ...`).

-----

### 6\. Implementation Plan & Rollout

1.  **Phase 1: Database Setup**

      * Create the `MonthlyReports` and partitioned `MonthlyExecutionLineItems` tables in `schema.sql`.
      * Define and apply the indexing strategy.
      * Create the new monthly materialized views.
      * Write scripts to automate the creation of future yearly partitions.

2.  **Phase 2: Application Backend**

      * Refactor shared logic out of the existing repository and create the repository factory.
      * Implement `monthlyExecutionLineItemRepository.ts` with its specific methods and filters.
      * Implement the ETL data ingestion service.
      * Add unit and integration tests for the new repository and data loaders.

3.  **Phase 3: API Exposure**

      * Extend the GraphQL schema with the new monthly types, inputs, and queries.
      * Implement the corresponding resolvers, connecting the API to the new repository.

4.  **Phase 4: Deployment & Monitoring**

      * Deploy the changes behind a feature flag.
      * Perform a benchmark data import of several years of monthly data to test performance.
      * Set up monitoring on query performance for the new tables and index hit rates using the `analyze_index_usage()` function.
      * Enable the feature flag once performance is validated.