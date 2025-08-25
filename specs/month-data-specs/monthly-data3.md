# Monthly Execution Line Items - Analysis & Implementation Strategy

## Executive Summary

This document analyzes the optimal approach for implementing monthly execution line items in the budget execution system. The current system processes annual data through the `ExecutionLineItems` table. The requirement is to introduce monthly data as a separate table to enable different analytical capabilities while maintaining performance and scalability.

## Current System Analysis

### Database Schema (`schema.sql`)
- **Core Table**: `ExecutionLineItems` (lines 154-185)
  - Stores annual execution data with `BIGSERIAL` primary key
  - 15 columns including dimensional references and fiscal amounts
  - Extensive indexing for query performance (221-312)
  - Materialized views for analytics (`vw_BudgetSummary_ByEntityPeriod`, `vw_Category_Aggregated_Metrics`)

### Repository Pattern (`executionLineItemRepository.ts`)
- **Architecture**: Repository pattern with extensive caching (3 cache types)
- **Query Building**: Complex filter builder (`buildExecutionLineItemFilterQuery`) supports 20+ filter criteria
- **Analytics**: Sophisticated yearly trend analysis with normalization modes (total, per capita, Euro conversion)
- **Performance**: BRIN indexes for time-series data, GIN indexes for text search

### GraphQL Layer
- **Resolver**: `executionLineItemResolver.ts` provides standard CRUD operations
- **Analytics**: `analyticsResolver.ts` exposes heatmap data and execution analytics
- **Filtering**: Uses unified `AnalyticsFilter` with 25+ filter options

## Implementation Options Analysis

### Option 1: Separate Monthly Table (RECOMMENDED)

**Implementation:**
```sql
CREATE TABLE MonthlyExecutionLineItems (
    monthly_line_item_id BIGSERIAL PRIMARY KEY,
    report_id TEXT NOT NULL,
    report_type report_type NOT NULL,
    entity_cui VARCHAR(20) NOT NULL,
    main_creditor_cui VARCHAR(20),
    budget_sector_id INT NOT NULL,
    funding_source_id INT NOT NULL,
    functional_code VARCHAR(20) NOT NULL,
    economic_code VARCHAR(20) NULL,
    account_category CHAR(2) NOT NULL,
    amount DECIMAL(18, 2) NOT NULL,
    program_code VARCHAR(50) NULL,
    expense_type expense_type NULL,
    year INT NOT NULL,
    month INT NOT NULL CHECK (month >= 1 AND month <= 12),
    -- Monthly-specific constraints and foreign keys similar to annual table
    CONSTRAINT unique_monthly_report_item UNIQUE (report_id, functional_code, economic_code, month),
    -- Foreign key constraints...
);
```

**Pros:**
- **Data Separation**: Clear logical separation between annual and monthly data
- **Schema Optimization**: Different indexing strategies optimized for each data type
- **Query Performance**: No data mixing reduces query complexity and improves cache efficiency
- **Analytical Clarity**: Separate analytics paths prevent accidental data aggregation across different time granularities
- **Scalability**: Monthly data will grow 12x faster - separate table allows independent optimization
- **Maintenance**: Easier to partition, archive, and maintain monthly data independently

**Cons:**
- **Code Duplication**: Need separate repository and resolver implementations
- **Maintenance Overhead**: Two schemas to maintain and keep in sync
- **GraphQL Complexity**: Separate types and resolvers for monthly operations

### Option 2: Single Table with Time Granularity Flag

**Implementation:**
```sql
ALTER TABLE ExecutionLineItems 
ADD COLUMN time_granularity VARCHAR(10) NOT NULL DEFAULT 'annual',
ADD COLUMN month INT NULL CHECK (month IS NULL OR (month >= 1 AND month <= 12)),
ADD CONSTRAINT granularity_month_check CHECK (
    (time_granularity = 'annual' AND month IS NULL) OR
    (time_granularity = 'monthly' AND month IS NOT NULL)
);
```

**Pros:**
- **Unified Interface**: Single repository and resolver can handle both data types
- **Code Reuse**: Existing filter and analytics logic can be extended
- **Schema Simplicity**: One table to maintain

**Cons:**
- **Performance Impact**: 12x data volume in single table affects all queries
- **Index Bloat**: Indexes become less efficient with mixed granularity data
- **Query Complexity**: All queries need granularity filtering
- **Analytical Confusion**: Risk of accidentally mixing annual and monthly data
- **Cache Pollution**: Unified cache stores mixed data types reducing efficiency

### Option 3: Partitioned Single Table

**Implementation:**
```sql
-- Create partitioned table
CREATE TABLE ExecutionLineItems (
    -- existing columns
    time_granularity VARCHAR(10) NOT NULL,
    month INT,
    -- ... other columns
) PARTITION BY LIST (time_granularity);

-- Create partitions
CREATE TABLE ExecutionLineItems_Annual PARTITION OF ExecutionLineItems 
    FOR VALUES IN ('annual');
CREATE TABLE ExecutionLineItems_Monthly PARTITION OF ExecutionLineItems 
    FOR VALUES IN ('monthly');
```

**Pros:**
- **Performance**: Partition elimination provides good query performance
- **Unified Interface**: Single table interface with automatic routing
- **Storage Optimization**: Each partition can have optimized indexes

**Cons:**
- **PostgreSQL Limitations**: Complex constraints across partitions
- **Migration Complexity**: Requires careful migration planning
- **Maintenance Overhead**: Partition management adds operational complexity

## Recommended Architecture: Option 1 - Separate Monthly Table

### Database Layer

#### 1. New Monthly Schema
```sql
-- Monthly Reports table
CREATE TABLE MonthlyReports (
    monthly_report_id TEXT PRIMARY KEY,
    entity_cui VARCHAR(20) NOT NULL,
    report_type report_type NOT NULL,
    main_creditor_cui VARCHAR(20),
    report_date DATE NOT NULL,
    reporting_year INT NOT NULL,
    reporting_month INT NOT NULL CHECK (reporting_month >= 1 AND reporting_month <= 12),
    budget_sector_id INT NOT NULL,
    file_source TEXT,
    import_timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    download_links TEXT[],
    -- Foreign keys and constraints...
    UNIQUE (entity_cui, reporting_year, reporting_month, main_creditor_cui, budget_sector_id)
);

-- Monthly Execution Line Items
CREATE TABLE MonthlyExecutionLineItems (
    monthly_line_item_id BIGSERIAL PRIMARY KEY,
    monthly_report_id TEXT NOT NULL,
    -- Same structure as annual table but with monthly_report_id reference
    FOREIGN KEY (monthly_report_id) REFERENCES MonthlyReports(monthly_report_id) ON DELETE CASCADE
);
```

#### 2. Optimized Indexing Strategy
```sql
-- Time-series optimized indexes for monthly data
CREATE INDEX idx_monthly_eli_year_month_brin ON MonthlyExecutionLineItems USING brin(year, month);
CREATE INDEX idx_monthly_eli_entity_year_month ON MonthlyExecutionLineItems (entity_cui, year, month);
CREATE INDEX idx_monthly_eli_monthly_covering ON MonthlyExecutionLineItems(entity_cui, year, month, account_category) 
    INCLUDE (amount, functional_code, economic_code);

-- Monthly-specific materialized views
CREATE MATERIALIZED VIEW vw_MonthlyBudgetSummary_ByEntityPeriod AS
SELECT 
    r.reporting_year,
    r.reporting_month,
    eli.entity_cui,
    e.name AS entity_name,
    SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN eli.account_category = 'ch' THEN eli.amount ELSE 0 END) AS total_expense
FROM MonthlyExecutionLineItems eli
JOIN MonthlyReports r ON eli.monthly_report_id = r.monthly_report_id
JOIN Entities e ON eli.entity_cui = e.cui
GROUP BY r.reporting_year, r.reporting_month, eli.entity_cui, e.name;
```

### Application Layer

#### 1. Repository Architecture
```typescript
// src/db/repositories/monthlyExecutionLineItemRepository.ts
export interface MonthlyAnalyticsFilter extends Omit<AnalyticsFilter, 'years'> {
    years: number[];
    months?: number[];
}

export const monthlyExecutionLineItemRepository = {
    async getAll(filters: Partial<MonthlyAnalyticsFilter>, ...): Promise<MonthlyExecutionLineItem[]>
    async getMonthlyTrend(filters: MonthlyAnalyticsFilter): Promise<{ year: number; month: number; value: number }[]>
    async getYearOverYearComparison(filters: MonthlyAnalyticsFilter): Promise<ComparisonData[]>
    // Monthly-specific analytical methods
};
```

#### 2. GraphQL Schema Extensions
```graphql
type MonthlyExecutionLineItem {
    monthlyLineItemId: ID!
    monthlyReport: MonthlyReport!
    month: Int!
    # ... same fields as annual version
}

type MonthlyAnalyticsSeries {
    seriesId: String!
    xAxis: Axis!
    yAxis: Axis!
    data: [MonthlyAnalyticsDataPoint!]!
}

type MonthlyAnalyticsDataPoint {
    x: String!
    y: Float!
    month: Int!
}

extend type Query {
    monthlyExecutionLineItems(filter: MonthlyAnalyticsFilter): MonthlyExecutionLineItemsConnection
    monthlyExecutionAnalytics(inputs: [MonthlyAnalyticsInput!]!): [MonthlyAnalyticsSeries!]!
}
```

#### 3. Analytics Capabilities
```typescript
// Monthly-specific analytics methods
export const monthlyAnalyticsRepository = {
    async getSeasonalTrends(filters): Promise<SeasonalTrendData[]>
    async getMonthOverMonthGrowth(filters): Promise<GrowthData[]>
    async getCumulativeAnalysis(filters): Promise<CumulativeData[]>
    async getQuarterlyAggregation(filters): Promise<QuarterlyData[]>
};
```

## Performance Optimization Strategy

### 1. Partitioning Strategy for Monthly Table
```sql
-- Partition monthly data by year for better performance
CREATE TABLE MonthlyExecutionLineItems (
    -- columns...
) PARTITION BY RANGE (year);

-- Create yearly partitions
CREATE TABLE MonthlyExecutionLineItems_2024 PARTITION OF MonthlyExecutionLineItems 
    FOR VALUES FROM (2024) TO (2025);
```

### 2. Caching Strategy
```typescript
// Separate cache instances for monthly data
const monthlyAnalyticsCache = createCache({
    name: 'monthlyExecutionLineItemAnalytics',
    maxSize: 200 * 1024 * 1024, // Larger cache for monthly data
    maxItems: 30000,
});
```

### 3. Materialized View Refresh Strategy
```sql
-- Function to refresh monthly views
CREATE OR REPLACE FUNCTION refresh_monthly_materialized_views() RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY vw_MonthlyBudgetSummary_ByEntityPeriod;
    -- Additional monthly views...
END;
$$ LANGUAGE plpgsql;
```

## Migration Strategy

### Phase 1: Database Setup
1. Create monthly tables and indexes
2. Set up partitioning for monthly data
3. Create monthly-specific materialized views

### Phase 2: Repository Layer
1. Implement `MonthlyExecutionLineItemRepository`
2. Create monthly analytics repositories
3. Add monthly-specific filter builders

### Phase 3: GraphQL Layer
1. Extend schema with monthly types
2. Implement monthly resolvers
3. Add monthly analytics resolvers

### Phase 4: Data Import & Testing
1. Implement monthly data import processes
2. Performance testing with realistic data volumes
3. Validate analytical accuracy

## Operational Considerations

### 1. Data Volume Management
- **Estimated Growth**: Monthly data will be ~12x larger than annual
- **Retention Policy**: Consider archiving older monthly data
- **Backup Strategy**: Separate backup schedules for monthly vs annual data

### 2. Query Performance Monitoring
```sql
-- Monitor query performance on monthly data
SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes 
WHERE tablename LIKE '%monthly%'
AND idx_scan = 0;
```

### 3. Maintenance Procedures
```sql
-- Automated cleanup for old monthly partitions
CREATE OR REPLACE FUNCTION cleanup_old_monthly_partitions(cutoff_year INT) 
RETURNS void AS $$
BEGIN
    -- Drop partitions older than cutoff_year
    -- Implementation details...
END;
$$ LANGUAGE plpgsql;
```

## Risk Assessment & Mitigation

### Technical Risks
1. **Performance Impact**: Large monthly datasets may impact query performance
   - *Mitigation*: Implement partitioning and optimized indexing
2. **Storage Growth**: 12x data growth needs storage planning
   - *Mitigation*: Implement data archiving and compression strategies
3. **Code Complexity**: Duplicate repository logic increases maintenance
   - *Mitigation*: Extract common functionality into shared utilities

### Business Risks
1. **Data Inconsistency**: Different aggregation methods between annual/monthly
   - *Mitigation*: Implement validation queries to ensure consistency
2. **Analytical Confusion**: Users might accidentally compare annual vs monthly
   - *Mitigation*: Clear UI labeling and separate analytical endpoints

## Conclusion

The separate monthly table approach (Option 1) provides the best balance of performance, maintainability, and analytical capability. While it requires additional implementation effort, the benefits of data separation, optimized performance, and clear analytical boundaries outweigh the costs.

Key success factors:
- Implement comprehensive partitioning strategy
- Create monthly-specific analytics capabilities
- Maintain separate caching and indexing strategies
- Plan for 12x data volume growth
- Ensure clear separation in GraphQL schema

This approach positions the system for scalable monthly analytics while maintaining the performance and reliability of the existing annual data processing.