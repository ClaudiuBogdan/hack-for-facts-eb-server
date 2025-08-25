https://www.perplexity.ai/search/your-class-cost-soft-architect-lT_RafXJRLe3.jf4nlv07A

# Unified Specification for Implementing Monthly Execution Line Items

This document consolidates the analyses from the provided proposals into a single, cohesive specification for adding monthly budget execution data to the application. The approach emphasizes a separate table to maintain isolation from annual data, ensuring distinct analytics, optimized performance, and scalability. This separation aligns with the need for different query patterns—such as month-over-month trends—while preserving the existing annual system's integrity.

The design prioritizes PostgreSQL best practices, including yearly partitioning for efficient data management, dedicated indexing for time-series queries, and encapsulation of monthly logic in repositories and services to minimize code duplication. Reasons for key decisions are included inline to justify choices based on data volume estimates (potentially millions of rows per year), performance requirements, and maintainability.

## 1. Business and Technical Objectives

- Enable storage and analysis of monthly-granularity budget execution data without impacting the annual `ExecutionLineItems` table.
- Support analytics like monthly trends, seasonal patterns, and heat maps, often combining with entity or classification filters.
- Handle high ingest volumes (hundreds of thousands of rows per monthly file) with low latency.
- Maintain the layered architecture: schema isolation, repository encapsulation, and GraphQL exposure.
- Ensure scalability for 12x higher data growth compared to annual, with easy archiving of old data.

**Rationale**: Monthly data serves finer-grained insights (e.g., intra-year fluctuations) that differ from annual aggregates. Separation prevents query interference and allows tailored optimizations, reducing risks like index bloat or analytical errors.

## 2. Database Schema Design

Create a new table, `MonthlyExecutionLineItems`, mirroring the structure of `ExecutionLineItems` but with monthly-specific fields and optimizations. Use declarative partitioning by year to manage large volumes, enabling partition pruning for time-range queries and simplifying retention (e.g., dropping old partitions).

### 2.1. Table Definition

```sql
CREATE TABLE MonthlyExecutionLineItems (
    monthly_line_item_id BIGSERIAL PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES Reports(report_id) ON DELETE CASCADE,
    entity_cui VARCHAR(20) NOT NULL REFERENCES Entities(cui) ON DELETE RESTRICT,
    main_creditor_cui VARCHAR(20) REFERENCES Entities(cui) ON DELETE RESTRICT,
    budget_sector_id INT NOT NULL REFERENCES BudgetSectors(sector_id) ON DELETE RESTRICT,
    funding_source_id INT NOT NULL REFERENCES FundingSources(source_id) ON DELETE RESTRICT,
    functional_code VARCHAR(20) NOT NULL REFERENCES FunctionalClassifications(functional_code) ON DELETE RESTRICT,
    economic_code VARCHAR(20) NULL REFERENCES EconomicClassifications(economic_code) ON DELETE RESTRICT,
    account_category CHAR(2) NOT NULL CHECK (account_category IN ('vn', 'ch')),
    month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
    year INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
    amount DECIMAL(18,2) NOT NULL,
    expense_type expense_type NULL,
    program_code VARCHAR(50) NULL,
    -- Integrity constraint: economic_code required for expenses
    CHECK (account_category != 'ch' OR economic_code IS NOT NULL),
    -- Prevent duplicates within a month
    UNIQUE (report_id, entity_cui, functional_code, economic_code, year, month)
) PARTITION BY RANGE (year);
```

- **Key Additions**: `monthly_line_item_id` for unique identification, `month` for granularity, and `year` for partitioning and filtering.
- **Partitioning**: Range-based on `year` to limit partition sizes (e.g., tens of millions of rows per year). Create yearly partitions manually or via automation scripts.

```sql
-- Example partition for 2024
CREATE TABLE MonthlyExecutionLineItems_2024 PARTITION OF MonthlyExecutionLineItems
    FOR VALUES FROM (2024) TO (2025);
-- Repeat for other years; use pg_partman for automation if volumes grow.
```

**Rationale**: Partitioning encapsulates data by year, improving query speed (pruning skips irrelevant years) and maintenance (e.g., vacuum or drop old partitions without affecting current data). It addresses estimated growth: 3x (entities × functional × economic codes) per month, scaling to millions annually.

### 2.2. Indexes

Apply indexes per partition to keep them compact and efficient.

- Composite covering index: `(entity_cui, year, month, account_category) INCLUDE (amount, functional_code, economic_code)` for entity-specific monthly queries.
- Time-series index: `(year, month)` using BRIN for sequential scans on large ranges.
- Additional: `(functional_code)`, `(economic_code) WHERE economic_code IS NOT NULL`, `(funding_source_id)`.

**Rationale**: These support common filters (e.g., entity + time range) while BRIN minimizes index size for time-ordered data, ideal for append-only monthly ingests.

### 2.3. Materialized Views

Create monthly-specific views for aggregates, refreshed post-ingestion.

```sql
CREATE MATERIALIZED VIEW vw_MonthlyBudgetSummary_ByEntityMonth AS
SELECT 
    r.reporting_year, r.reporting_month,
    eli.entity_cui, e.name AS entity_name,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.amount ELSE 0 END) AS total_expense
FROM MonthlyExecutionLineItems eli
JOIN Reports r ON eli.report_id = r.report_id
JOIN Entities e ON eli.entity_cui = e.cui
GROUP BY r.reporting_year, r.reporting_month, eli.entity_cui, e.name;

-- Refresh function extension
CREATE OR REPLACE FUNCTION refresh_all_materialized_views() RETURNS void AS $$
BEGIN
    -- Existing refreshes...
    REFRESH MATERIALIZED VIEW CONCURRENTLY vw_MonthlyBudgetSummary_ByEntityMonth;
END;
$$ LANGUAGE plpgsql;
```

**Rationale**: Views encapsulate complex aggregates, speeding up analytics. Concurrent refresh allows updates without locking, suitable for monthly loads.

## 3. Data Ingestion and ETL Pipeline

- **Staging Table**: Create `stg_monthly_eli` with text columns for raw CSV import via `COPY`.
- **Process**: Bulk load via `COPY`, validate FKs and constraints, then `INSERT ... SELECT ... ON CONFLICT DO NOTHING` into the partitioned table within a transaction.
- **Deduplication**: Enforced by the unique constraint.
- **Large Loads**: Disable non-primary indexes temporarily if needed; use partitions to avoid global maintenance.

**Rationale**: This encapsulates validation and ensures atomicity, handling high volumes efficiently while maintaining data integrity. Transactions prevent partial imports.

## 4. Repository Layer

Use a factory pattern for encapsulation and to minimize duplication.

```typescript
// shared/executionRepoFactory.ts
function makeExecutionRepo(table: 'ExecutionLineItems' | 'MonthlyExecutionLineItems') {
    // Shared logic: filter builders, query utilities
    return {
        getAll(filters, sort, limit, offset) { /* implementation bound to table */ },
        getTrend(filters) { /* monthly uses YYYY-MM */ },
        // Add monthly-specific: getMonthOverMonthGrowth, etc.
    };
}

export const executionLineItemRepository = makeExecutionRepo('ExecutionLineItems');
export const monthlyExecutionLineItemRepository = makeExecutionRepo('MonthlyExecutionLineItems');
```

- **Filters**: Extend for monthly with `months: number[]`, `startMonth: string`, `endMonth: string`.
- **Caching**: Separate namespaces (e.g., `monthly:` prefix) to encapsulate caches.

**Rationale**: Factory encapsulates shared code (e.g., SQL builders), reducing duplication while allowing monthly-specific methods like seasonal trends. This preserves the repository pattern's data access encapsulation.

## 5. GraphQL and Service Layer

- **Schema Additions**:

```graphql
type MonthlyExecutionLineItem {
    monthlyLineItemId: ID!
    month: Int!
    year: Int!
    # Mirror other fields
}

extend type Query {
    monthlyExecutionLineItems(filter: MonthlyAnalyticsFilter): [MonthlyExecutionLineItem!]!
    monthlyExecutionAnalytics(inputs: [MonthlyAnalyticsInput!]!): [MonthlyAnalyticsSeries!]!
}
```

- **Resolvers**: Mirror annual but use `monthlyExecutionLineItemRepository`; add `frequency` arg if unifying later.
- **Services**: New `monthlyDataService.ts` for ingestion logic.

**Rationale**: Encapsulates monthly exposure, preventing API pollution. Separate endpoints clarify usage and support distinct analytics like quarterly aggregations.

## 6. Performance and Operational Considerations

- **Monitoring**: Track row counts per month, ingest times, and index usage via `analyze_index_usage()`.
- **Security**: Use staging schema with limited permissions; add audit triggers.
- **Rollout**: Add table/indexes, repositories with tests, GraphQL behind feature flag, migrate sample data.
- **Risks and Mitigations**: Data growth—partition and archive; inconsistency—validation queries; complexity—shared utilities.

**Rationale**: These encapsulate operational needs, ensuring the system scales reliably. Partitioning and caching address performance, while phased rollout minimizes disruption.

This specification provides a complete, implementable plan. Proceed by updating `schema.sql` with the new table and partitions, then build out the repositories and services. If data volumes exceed expectations, consider TimescaleDB for advanced time-series features.
<span style="display:none">[^1][^2][^3][^4][^5][^6]</span>

<div style="text-align: center">⁂</div>

[^1]: monthly-data1.md

[^2]: monthly-data2.md

[^3]: monthly-data3.md

[^4]: monthly-data4.md

[^5]: monthly-data5.md

[^6]: schema.sql

