# Monthly Execution Table Design and Implementation Strategy

## Overview

The current database schema uses the `ExecutionLineItems` table to store annual budget execution line items. These are linked to reports with yearly aggregation. To support monthly execution data for different analytical purposes, we need a new table specifically for monthly line items. This document explores options for implementing this, including database design, optimization strategies, repository integration, analytics exposure, and insertion mechanisms.

The key requirements are:
- Separate tables for annual and monthly data to allow distinct analytics and optimizations.
- Handle potentially large volumes of monthly data efficiently.
- Maintain type safety, performance, and adherence to project architecture (e.g., repositories for data access, services for business logic).
- Expose monthly data via GraphQL resolvers similar to existing ones.

## Current State Analysis

- **Schema (from schema.sql)**:
  - `ExecutionLineItems` includes fields like `report_id`, `entity_cui`, `year`, `functional_code`, `economic_code`, `amount`, etc.
  - Linked to `Reports` table, which has `reporting_year` and `reporting_period` (VARCHAR(10), potentially usable for periods like 'monthly').
  - Optimized with indexes for year-based queries, BRIN indexes for time-series, and materialized views for aggregations.

- **Resolvers (from executionLineItemResolver.ts and analyticsResolver.ts)**:
  - `executionLineItemResolver` handles queries for individual items and paginated lists using `executionLineItemRepository`.
  - `analyticsResolver` uses repositories like `executionLineItemRepository` for trends (e.g., yearly) and entity analytics.
  - Analytics often filter by year, account category, etc.

- **Data Volume Considerations**:
  - Annual data: Fewer rows per entity/year.
  - Monthly data: 12x more rows per year, potentially millions if scaled to many entities. Needs partitioning or indexing for time-based queries.

- **Insertion**:
  - Current data likely comes from XML reports processed via `xmlProcessor.js` or seeding scripts.
  - Monthly data would need similar processing, but triggered monthly (e.g., via cron job or API endpoint).

## Options for Implementation

### Option 1: Fully Separate Table (Recommended)
Create a new table `MonthlyExecutionLineItems` with a similar structure to `ExecutionLineItems`, but add a `month` field (INT, 1-12) and reference the same dimension tables (e.g., Entities, FunctionalClassifications).

**Schema Changes**:
- New table:
  ```
  CREATE TABLE MonthlyExecutionLineItems (
      line_item_id BIGSERIAL PRIMARY KEY,
      report_id TEXT NOT NULL,
      entity_cui VARCHAR(20) NOT NULL,
      -- ... other fields similar to ExecutionLineItems ...
      year INT NOT NULL,
      month INT NOT NULL CHECK (month >= 1 AND month <= 12),
      amount DECIMAL(18,2) NOT NULL,
      -- Foreign keys same as ExecutionLineItems
      UNIQUE(report_id, entity_cui, functional_code, economic_code, year, month) -- Prevent duplicates
  );
  ```
- Add indexes: Similar to existing (e.g., idx on (entity_cui, year, month), BRIN on (year, month)).
- Materialized views: Create new ones for monthly aggregations (e.g., `vw_MonthlyBudgetSummary`).

**Insertion Strategy**:
- Use a new service method in `xmlProcessor.js` or a dedicated `monthlyXmlProcessor.ts` to parse monthly reports and insert via a new repository.
- Transactional inserts to ensure data integrity (e.g., using Prisma transactions).
- Deduplication: Check for existing report_id + month before inserting.

**Repository Integration**:
- New `monthlyExecutionLineItemRepository.ts` mirroring `executionLineItemRepository.ts`.
- Methods: `getAll(filter: MonthlyFilter, sort, limit, offset)`, `getById(id)`, `insertBatch(items)`.
- Filters extended to include `month` or `date_range` (e.g., { startMonth: '2024-01', endMonth: '2024-12' }).

**Analytics Exposure**:
- New GraphQL resolvers in `monthlyExecutionLineItemResolver.ts` (similar to existing).
- Extend `analyticsResolver.ts` with queries like `monthlyExecutionAnalytics` using the new repo.
- New types in GraphQL schema: `MonthlyExecutionLineItem`, `MonthlyAnalyticsSeries`.

**Pros**:
- Clear separation: Monthly analytics (e.g., month-over-month trends) can be optimized independently.
- No schema pollution in existing table.
- Easier to scale: Can partition `MonthlyExecutionLineItems` by (year, month) using PostgreSQL partitioning.
- Performance: Queries won't scan irrelevant annual data.

**Cons**:
- Schema duplication: Maintenance overhead for similar structures.
- Code duplication: New repo and resolvers needed.
- Joins: If cross-annual/monthly analytics are needed later, would require UNION queries.

**Optimization**:
- Partition by (year, month) for large datasets (e.g., subpartitions per month).
- Use TimescaleDB extension if data grows massively for time-series optimizations.
- Cache frequent monthly aggregates using Redis (via `cache.js`).

### Option 2: Partitioned Table Approach
Use PostgreSQL table partitioning on a single table (e.g., extend `ExecutionLineItems` with a `period_type` ENUM ('annual', 'monthly') and `month` field). Partition by `period_type` or by range on a composite (year, month) key.

**Schema Changes**:
- Alter `ExecutionLineItems` to add `period_type` and `month`.
- Set up partitions: e.g., one for annual (month=NULL), subpartitions for monthly by year/month.

**Insertion Strategy**:
- Same processor, but set `period_type='monthly'` and insert into the appropriate partition.

**Repository Integration**:
- Modify existing `executionLineItemRepository` to handle `period_type` in filters.
- Add methods like `getMonthly(filter)` that implicitly add `period_type='monthly'`.

**Analytics Exposure**:
- Update existing resolvers to accept `periodType` arg and filter accordingly.
- Analytics queries can use the same repo but branch based on period.

**Pros**:
- Single table: Easier maintenance, no duplication.
- Efficient querying: Partitions prune irrelevant data automatically.
- Flexible: Can query across periods with UNION-like behavior.

**Cons**:
- Violates user's preference for separate tables.
- Mixing data types could complicate analytics (e.g., annual vs. monthly calculations).
- Partitioning adds complexity to schema management.
- Potential performance hit if queries don't specify partition key.

**Optimization**:
- Built-in partitioning handles large data well; add BRIN indexes per partition.

### Option 3: Same Table with Period Flag
Add a `is_monthly` BOOLEAN or `period` ENUM to `ExecutionLineItems`, plus `month` field. No partitioning.

**Schema Changes**:
- Simple ALTER TABLE to add columns.

**Insertion/Repo/Analytics**:
- Similar to Option 2, but without partitioning.

**Pros**:
- Minimal changes; easy to implement.
- Single codebase for repos/resolvers.

**Cons**:
- Data mixing: Queries must always filter by flag, risking errors.
- Optimization issues: Indexes span all data, slower for large monthly volumes.
- Not ideal for distinct analytics; goes against separation requirement.

## Recommended Approach
Go with **Option 1 (Fully Separate Table)** to honor the requirement for separation and enable tailored optimizations/analytics. Start without partitioning, monitor data growth, and add it if row count exceeds ~10M. Use Prisma for type-safe interactions in repositories.

## Next Steps
1. Update `schema.sql` with new table and indexes.
2. Create `monthlyExecutionLineItemRepository.ts`.
3. Add insertion logic in a new service (e.g., `monthlyDataService.ts`).
4. Extend GraphQL schema and resolvers for monthly data.
5. Implement monthly-specific materialized views and refresh function.
6. Test with sample data: Run `npx tsc -b --noEmit` to verify compilation.
7. Document any new APIs in `specs/`.
