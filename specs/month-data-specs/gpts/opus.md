https://claude.ai/chat/78279fd5-5642-419f-926c-ebfcfc62b0ab

# Monthly Execution Line Items - Unified Implementation Specification

## Executive Summary

This specification defines the implementation of monthly budget execution data storage and analytics using a **separate, partitioned table architecture**. This approach provides complete data isolation between annual and monthly datasets while leveraging PostgreSQL's declarative partitioning for optimal performance at scale.

## 1. Database Architecture

### 1.1 Core Table Design

Create a new partitioned table `MonthlyExecutionLineItems` that mirrors the structure of the annual table but is optimized for monthly time-series operations.

```sql
-- Base partitioned table with monthly granularity
CREATE TABLE MonthlyExecutionLineItems (
    monthly_line_item_id BIGSERIAL,
    report_id TEXT NOT NULL,
    report_type report_type NOT NULL,
    entity_cui VARCHAR(20) NOT NULL,
    main_creditor_cui VARCHAR(20),
    budget_sector_id INT NOT NULL,
    funding_source_id INT NOT NULL,
    functional_code VARCHAR(20) NOT NULL,
    economic_code VARCHAR(20),
    account_category CHAR(2) NOT NULL,
    amount DECIMAL(18, 2) NOT NULL,
    program_code VARCHAR(50),
    expense_type expense_type,
    -- Temporal columns
    period_month DATE NOT NULL,
    year INT GENERATED ALWAYS AS (EXTRACT(YEAR FROM period_month)::INT) STORED,
    month INT GENERATED ALWAYS AS (EXTRACT(MONTH FROM period_month)::INT) STORED,
    -- Constraints
    PRIMARY KEY (monthly_line_item_id, period_month),
    CHECK (account_category IN ('vn', 'ch')),
    CHECK (account_category != 'ch' OR economic_code IS NOT NULL),
    CHECK (period_month = date_trunc('month', period_month)),
    -- Foreign keys
    FOREIGN KEY (report_id) REFERENCES Reports(report_id) ON DELETE CASCADE,
    FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
    FOREIGN KEY (main_creditor_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
    FOREIGN KEY (budget_sector_id) REFERENCES BudgetSectors(sector_id) ON DELETE RESTRICT,
    FOREIGN KEY (funding_source_id) REFERENCES FundingSources(source_id) ON DELETE RESTRICT,
    FOREIGN KEY (functional_code) REFERENCES FunctionalClassifications(functional_code) ON DELETE RESTRICT,
    FOREIGN KEY (economic_code) REFERENCES EconomicClassifications(economic_code) ON DELETE RESTRICT
) PARTITION BY RANGE (period_month);
```

**Design Rationale:**
- `period_month` as `DATE`: Stored as first day of month for efficient range queries and partition pruning
- Generated columns for `year` and `month`: Enables efficient filtering without computation
- Composite primary key includes partition key: Required by PostgreSQL for global uniqueness
- Check constraint on `period_month`: Ensures data integrity at month boundaries

### 1.2 Partitioning Strategy

Implement yearly partitions with automatic management:

```sql
-- Create yearly partitions (example for 2021-2025)
CREATE TABLE MonthlyExecutionLineItems_2021 
    PARTITION OF MonthlyExecutionLineItems 
    FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');

CREATE TABLE MonthlyExecutionLineItems_2022 
    PARTITION OF MonthlyExecutionLineItems 
    FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');

CREATE TABLE MonthlyExecutionLineItems_2023 
    PARTITION OF MonthlyExecutionLineItems 
    FOR VALUES FROM ('2023-01-01') TO ('2024-01-01');

CREATE TABLE MonthlyExecutionLineItems_2024 
    PARTITION OF MonthlyExecutionLineItems 
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

CREATE TABLE MonthlyExecutionLineItems_2025 
    PARTITION OF MonthlyExecutionLineItems 
    FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

-- Default partition for unexpected dates
CREATE TABLE MonthlyExecutionLineItems_default 
    PARTITION OF MonthlyExecutionLineItems DEFAULT;

-- Function to automatically create future partitions
CREATE OR REPLACE FUNCTION create_monthly_partition(year_num INT) 
RETURNS void AS $$
DECLARE
    partition_name TEXT;
    start_date DATE;
    end_date DATE;
BEGIN
    partition_name := 'MonthlyExecutionLineItems_' || year_num;
    start_date := (year_num || '-01-01')::DATE;
    end_date := ((year_num + 1) || '-01-01')::DATE;
    
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF MonthlyExecutionLineItems FOR VALUES FROM (%L) TO (%L)',
        partition_name, start_date, end_date);
    
    RAISE NOTICE 'Created partition % for year %', partition_name, year_num;
END;
$$ LANGUAGE plpgsql;
```

**Partitioning Benefits:**
- **Query Performance**: Partition pruning eliminates irrelevant data from scans
- **Maintenance**: Easy archival by detaching old partitions
- **Parallel Processing**: Enables parallel query execution across partitions
- **Index Management**: Smaller, more efficient indexes per partition

### 1.3 Indexing Strategy

Create optimized indexes per partition for common access patterns:

```sql
-- Function to create indexes on a partition
CREATE OR REPLACE FUNCTION create_monthly_partition_indexes(partition_name TEXT) 
RETURNS void AS $$
BEGIN
    -- Primary access pattern: entity + time
    EXECUTE format('CREATE INDEX idx_%s_entity_month ON %I (entity_cui, period_month)', 
        partition_name, partition_name);
    
    -- Covering index for analytics queries
    EXECUTE format('CREATE INDEX idx_%s_covering ON %I (entity_cui, period_month, account_category) INCLUDE (amount, functional_code, economic_code)', 
        partition_name, partition_name);
    
    -- Category-based queries
    EXECUTE format('CREATE INDEX idx_%s_category_month ON %I (account_category, period_month)', 
        partition_name, partition_name);
    
    -- Dimensional lookups
    EXECUTE format('CREATE INDEX idx_%s_functional ON %I (functional_code)', 
        partition_name, partition_name);
    EXECUTE format('CREATE INDEX idx_%s_economic ON %I (economic_code) WHERE economic_code IS NOT NULL', 
        partition_name, partition_name);
    EXECUTE format('CREATE INDEX idx_%s_funding ON %I (funding_source_id)', 
        partition_name, partition_name);
    
    -- BRIN for time-series scans (if partition is large)
    EXECUTE format('CREATE INDEX idx_%s_month_brin ON %I USING brin (period_month)', 
        partition_name, partition_name);
END;
$$ LANGUAGE plpgsql;

-- Apply indexes to existing partitions
DO $$
DECLARE
    year_num INT;
BEGIN
    FOR year_num IN 2021..2025 LOOP
        PERFORM create_monthly_partition_indexes('monthlyexecutionlineitems_' || year_num);
    END LOOP;
END $$;
```

## 2. Data Encapsulation and Repository Pattern

### 2.1 Shared Query Builder

Extract common query building logic to avoid duplication:

```typescript
// src/db/repositories/queryBuilders/executionQueryBuilder.ts
export interface ExecutionQueryConfig {
    tableName: string;
    tableAlias: string;
    temporalColumn: 'year' | 'period_month';
    temporalGrouping: 'year' | 'month';
}

export interface QueryResult {
    query: string;
    values: any[];
    joinClauses: string[];
    whereClause: string;
}

export function buildExecutionFilterQuery(
    filters: Partial<ExecutionFilter>,
    config: ExecutionQueryConfig
): QueryResult {
    // Shared implementation for both annual and monthly
    // Handles all common filters: entity_cui, functional_code, etc.
    // Adapts temporal filters based on config
}
```

### 2.2 Monthly Repository Implementation

```typescript
// src/db/repositories/monthlyExecutionLineItemRepository.ts
export interface MonthlyAnalyticsFilter extends Omit<AnalyticsFilter, 'years'> {
    years?: number[];
    months?: number[];  // 1-12
    startMonth?: string;  // 'YYYY-MM'
    endMonth?: string;    // 'YYYY-MM'
    periodRange?: { start: Date; end: Date };
}

export interface MonthlyTrendPoint {
    month: string;  // 'YYYY-MM'
    value: number;
    metadata?: {
        entityCount: number;
        isComplete: boolean;
    };
}

class MonthlyExecutionLineItemRepository {
    private readonly queryConfig: ExecutionQueryConfig = {
        tableName: 'MonthlyExecutionLineItems',
        tableAlias: 'meli',
        temporalColumn: 'period_month',
        temporalGrouping: 'month'
    };

    async getAll(
        filters: Partial<MonthlyAnalyticsFilter>,
        sort?: SortOrderOption,
        limit?: number,
        offset?: number
    ): Promise<MonthlyExecutionLineItem[]> {
        // Implementation using shared query builder
    }

    async getMonthlyTrend(
        filters: MonthlyAnalyticsFilter,
        normalizationMode?: 'total' | 'per_capita' | 'euro'
    ): Promise<MonthlyTrendPoint[]> {
        // Monthly trend analysis with optional normalization
    }

    async getSeasonalAnalysis(
        filters: MonthlyAnalyticsFilter
    ): Promise<SeasonalPattern[]> {
        // Month-over-month and year-over-year comparisons
    }

    async getCumulativeAnalysis(
        filters: MonthlyAnalyticsFilter
    ): Promise<CumulativeData[]> {
        // Running totals within fiscal year
    }
}

export const monthlyExecutionLineItemRepository = new MonthlyExecutionLineItemRepository();
```

### 2.3 Caching Strategy

Implement separate cache instances for monthly data:

```typescript
// src/db/cache/monthlyCache.ts
import { createCache } from './cacheFactory';

export const monthlyDataCache = createCache({
    name: 'monthlyExecutionData',
    maxSize: 300 * 1024 * 1024,  // 300MB - larger due to higher volume
    maxItems: 50000,
    ttl: 3600,  // 1 hour - shorter TTL for frequently updated monthly data
    keyPrefix: 'monthly:'
});

export const monthlyAnalyticsCache = createCache({
    name: 'monthlyAnalytics',
    maxSize: 200 * 1024 * 1024,
    maxItems: 30000,
    ttl: 7200,  // 2 hours - longer for computed analytics
    keyPrefix: 'monthly:analytics:'
});
```

## 3. Materialized Views for Monthly Analytics

### 3.1 Monthly Budget Summary

```sql
CREATE MATERIALIZED VIEW vw_MonthlyBudgetSummary AS
SELECT 
    meli.entity_cui,
    e.name AS entity_name,
    e.entity_type,
    u.uat_code,
    u.name AS uat_name,
    u.county_name,
    u.region,
    date_trunc('month', meli.period_month) AS month,
    meli.year,
    SUM(CASE WHEN meli.account_category = 'vn' THEN meli.amount ELSE 0 END) AS total_income,
    SUM(CASE WHEN meli.account_category = 'ch' THEN meli.amount ELSE 0 END) AS total_expense,
    SUM(CASE WHEN meli.account_category = 'vn' THEN meli.amount ELSE -meli.amount END) AS budget_balance,
    COUNT(DISTINCT meli.report_id) AS report_count,
    COUNT(DISTINCT meli.functional_code) AS functional_diversity,
    -- Metadata for data quality
    BOOL_AND(meli.period_month <= CURRENT_DATE) AS is_historical,
    MAX(meli.period_month) AS latest_data_month
FROM MonthlyExecutionLineItems meli
JOIN Entities e ON meli.entity_cui = e.cui
LEFT JOIN UATs u ON e.uat_id = u.id
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;

-- Unique index for concurrent refresh
CREATE UNIQUE INDEX idx_mv_monthly_summary_unique 
ON vw_MonthlyBudgetSummary (entity_cui, month);

-- Performance indexes
CREATE INDEX idx_mv_monthly_summary_entity_year 
ON vw_MonthlyBudgetSummary (entity_cui, year);
CREATE INDEX idx_mv_monthly_summary_month 
ON vw_MonthlyBudgetSummary (month);
```

### 3.2 Monthly Category Metrics

```sql
CREATE MATERIALIZED VIEW vw_MonthlyCategory_Metrics AS
SELECT 
    date_trunc('month', meli.period_month) AS month,
    meli.year,
    meli.account_category,
    fc.functional_code,
    fc.functional_name,
    ec.economic_code,
    ec.economic_name,
    fs.source_id AS funding_source_id,
    fs.source_description,
    SUM(meli.amount) AS total_amount,
    COUNT(DISTINCT meli.entity_cui) AS entity_count,
    AVG(meli.amount) AS avg_amount,
    STDDEV(meli.amount) AS stddev_amount,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY meli.amount) AS median_amount
FROM MonthlyExecutionLineItems meli
JOIN FunctionalClassifications fc ON meli.functional_code = fc.functional_code
LEFT JOIN EconomicClassifications ec ON meli.economic_code = ec.economic_code
JOIN FundingSources fs ON meli.funding_source_id = fs.source_id
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;

CREATE UNIQUE INDEX idx_mv_monthly_category_unique 
ON vw_MonthlyCategory_Metrics (month, account_category, functional_code, COALESCE(economic_code, ''), funding_source_id);
```

## 4. GraphQL API Specification

### 4.1 Type Definitions

```graphql
type MonthlyExecutionLineItem {
    monthlyLineItemId: ID!
    report: Report!
    entity: Entity!
    mainCreditor: Entity
    budgetSector: BudgetSector!
    fundingSource: FundingSource!
    functionalClassification: FunctionalClassification!
    economicClassification: EconomicClassification
    accountCategory: AccountCategory!
    amount: Float!
    programCode: String
    expenseType: ExpenseType
    periodMonth: String!  # 'YYYY-MM'
    year: Int!
    month: Int!
}

input MonthlyAnalyticsFilterInput {
    entityCuis: [String!]
    years: [Int!]
    months: [Int!]  # 1-12
    startMonth: String  # 'YYYY-MM'
    endMonth: String    # 'YYYY-MM'
    functionalCodes: [String!]
    economicCodes: [String!]
    accountCategories: [AccountCategory!]
    fundingSources: [Int!]
    # ... other standard filters
}

type MonthlyAnalyticsSeries {
    seriesId: String!
    label: String!
    xAxis: Axis!
    yAxis: Axis!
    data: [MonthlyDataPoint!]!
    metadata: SeriesMetadata
}

type MonthlyDataPoint {
    x: String!  # 'YYYY-MM'
    y: Float!
    metadata: DataPointMetadata
}

extend type Query {
    monthlyExecutionLineItems(
        filter: MonthlyAnalyticsFilterInput
        sort: SortOrderOption
        limit: Int = 100
        offset: Int = 0
    ): MonthlyExecutionLineItemConnection!
    
    monthlyExecutionAnalytics(
        inputs: [MonthlyAnalyticsInput!]!
    ): [MonthlyAnalyticsSeries!]!
    
    monthlySeasonalAnalysis(
        filter: MonthlyAnalyticsFilterInput
    ): SeasonalAnalysisResult!
}
```

## 5. ETL and Data Ingestion

### 5.1 Staging Table for Bulk Loading

```sql
CREATE UNLOGGED TABLE MonthlyExecutionLineItems_staging (
    LIKE MonthlyExecutionLineItems INCLUDING ALL
);

-- Function for validated insertion from staging
CREATE OR REPLACE FUNCTION insert_monthly_data_from_staging(
    target_month DATE,
    deduplicate BOOLEAN DEFAULT TRUE
) RETURNS TABLE(inserted_count INT, rejected_count INT) AS $$
DECLARE
    v_inserted_count INT;
    v_rejected_count INT;
BEGIN
    -- Validate month alignment
    IF target_month != date_trunc('month', target_month) THEN
        RAISE EXCEPTION 'Target month must be first day of month';
    END IF;
    
    -- Insert with deduplication
    IF deduplicate THEN
        WITH validated_data AS (
            SELECT DISTINCT ON (report_id, entity_cui, functional_code, 
                              COALESCE(economic_code, ''), account_category)
                *
            FROM MonthlyExecutionLineItems_staging
            WHERE period_month = target_month
        )
        INSERT INTO MonthlyExecutionLineItems
        SELECT * FROM validated_data
        ON CONFLICT DO NOTHING;
    ELSE
        INSERT INTO MonthlyExecutionLineItems
        SELECT * FROM MonthlyExecutionLineItems_staging
        WHERE period_month = target_month;
    END IF;
    
    GET DIAGNOSTICS v_inserted_count = ROW_COUNT;
    
    -- Count rejected rows
    SELECT COUNT(*) INTO v_rejected_count
    FROM MonthlyExecutionLineItems_staging
    WHERE period_month = target_month;
    
    v_rejected_count := v_rejected_count - v_inserted_count;
    
    -- Clear staging table
    TRUNCATE MonthlyExecutionLineItems_staging;
    
    RETURN QUERY SELECT v_inserted_count, v_rejected_count;
END;
$$ LANGUAGE plpgsql;
```

### 5.2 Import Process

```typescript
// src/services/monthlyDataImportService.ts
export class MonthlyDataImportService {
    async importMonthlyData(
        filePath: string,
        targetMonth: string,  // 'YYYY-MM'
        options: ImportOptions = {}
    ): Promise<ImportResult> {
        const connection = await pool.connect();
        
        try {
            await connection.query('BEGIN');
            
            // 1. Load into staging
            await this.loadToStaging(connection, filePath);
            
            // 2. Validate data integrity
            const validationErrors = await this.validateStagingData(connection);
            if (validationErrors.length > 0 && !options.ignoreValidation) {
                throw new ValidationError(validationErrors);
            }
            
            // 3. Insert into partitioned table
            const result = await connection.query(
                'SELECT * FROM insert_monthly_data_from_staging($1, $2)',
                [targetMonth + '-01', options.deduplicate !== false]
            );
            
            // 4. Refresh materialized views
            if (!options.skipMaterializedViews) {
                await this.refreshMaterializedViews(connection, targetMonth);
            }
            
            await connection.query('COMMIT');
            
            // 5. Clear caches
            await this.clearRelatedCaches(targetMonth);
            
            return {
                inserted: result.rows[0].inserted_count,
                rejected: result.rows[0].rejected_count,
                month: targetMonth
            };
            
        } catch (error) {
            await connection.query('ROLLBACK');
            throw error;
        } finally {
            connection.release();
        }
    }
}
```

## 6. Performance Optimization Guidelines

### 6.1 Query Optimization

```sql
-- Enable partition-wise operations for better performance
ALTER SYSTEM SET enable_partitionwise_aggregate = on;
ALTER SYSTEM SET enable_partitionwise_join = on;
ALTER SYSTEM SET constraint_exclusion = partition;

-- Increase work memory for large aggregations
ALTER SYSTEM SET work_mem = '256MB';

-- Auto-analyze after bulk loads
ALTER TABLE MonthlyExecutionLineItems SET (autovacuum_analyze_scale_factor = 0.02);
```

### 6.2 Monitoring Queries

```sql
-- Monitor partition sizes and performance
CREATE VIEW vw_monthly_partition_stats AS
SELECT 
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
    pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
    pg_size_pretty(pg_indexes_size(schemaname||'.'||tablename)) AS indexes_size,
    n_tup_ins AS rows_inserted,
    n_tup_upd AS rows_updated,
    n_tup_del AS rows_deleted,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE tablename LIKE 'monthlyexecutionlineitems_%'
ORDER BY tablename;
```

## 7. Migration and Rollout Plan

### Phase 1: Infrastructure (Week 1)
1. Create partitioned table structure
2. Set up initial partitions (2021-2025)
3. Create indexes and materialized views
4. Deploy partition management functions

### Phase 2: Application Layer (Week 2)
1. Implement shared query builder
2. Create monthly repository
3. Add caching layer
4. Unit test all repository methods

### Phase 3: API Layer (Week 3)
1. Extend GraphQL schema
2. Implement resolvers
3. Add monthly analytics endpoints
4. Integration testing

### Phase 4: Data Migration (Week 4)
1. Historical data import (if available)
2. Set up automated monthly import
3. Validate data integrity
4. Performance testing with production-scale data

### Phase 5: Production Rollout (Week 5)
1. Deploy to staging environment
2. Run parallel validation
3. Gradual production rollout
4. Monitor performance metrics

## 8. Operational Procedures

### 8.1 Automated Partition Management

```sql
-- Scheduled job to create next year's partition
CREATE OR REPLACE FUNCTION ensure_future_partitions() RETURNS void AS $$
DECLARE
    next_year INT;
BEGIN
    next_year := EXTRACT(YEAR FROM CURRENT_DATE)::INT + 1;
    PERFORM create_monthly_partition(next_year);
END;
$$ LANGUAGE plpgsql;

-- Schedule via pg_cron or external scheduler
```

### 8.2 Data Retention Policy

```sql
-- Archive and drop old partitions
CREATE OR REPLACE FUNCTION archive_old_monthly_data(retention_years INT) 
RETURNS void AS $$
DECLARE
    cutoff_year INT;
    partition_name TEXT;
BEGIN
    cutoff_year := EXTRACT(YEAR FROM CURRENT_DATE)::INT - retention_years;
    partition_name := 'MonthlyExecutionLineItems_' || cutoff_year;
    
    -- Archive to cold storage (implementation specific)
    -- PERFORM archive_partition_to_s3(partition_name);
    
    -- Detach and drop partition
    EXECUTE format('ALTER TABLE MonthlyExecutionLineItems DETACH PARTITION %I', partition_name);
    EXECUTE format('DROP TABLE %I', partition_name);
    
    RAISE NOTICE 'Archived and removed partition %', partition_name;
END;
$$ LANGUAGE plpgsql;
```

## 9. Success Metrics

- **Query Performance**: 95th percentile query time < 100ms for single-month queries
- **Data Freshness**: Monthly data available within 24 hours of period close
- **Storage Efficiency**: < 20% storage overhead from indexes and materialized views
- **Availability**: 99.9% uptime for monthly analytics endpoints
- **Scalability**: Support for 10M+ rows per year without degradation

## Conclusion

This specification provides a robust, scalable architecture for monthly execution line items that:
- **Maintains complete separation** between annual and monthly data
- **Leverages PostgreSQL partitioning** for optimal performance at scale
- **Implements proper encapsulation** through repository patterns
- **Ensures data integrity** through comprehensive validation
- **Provides operational excellence** through monitoring and automation

The design balances immediate implementation needs with long-term scalability, ensuring the system can grow to handle millions of monthly records while maintaining sub-second query performance.