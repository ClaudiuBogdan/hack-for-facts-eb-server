# Strategy Document  

Introducing a Monthly Execution Line Items capability  
(author: AI pair-programming assistant)

---

## 1. Business & Technical Goals  

1. Store monthly-granularity budget execution data without bloating the existing annual `ExecutionLineItems` table.  
2. Run analytics on both annual and monthly data—sometimes together (trend lines), sometimes separately (in-month heat-maps).  
3. Keep ingest latency low (monthly files can be hundreds of thousands of rows).  
4. Preserve our current layered architecture and repository conventions.

---

## 2. Data-model Options

| # | Approach | Summary | Pros | Cons |
|---|----------|---------|------|------|
| A | **Separate table (`MonthlyExecutionLineItems`)** | New fact table, same columns + `month` int(1-12). Annual table unchanged. | • Zero impact on existing queries <br>• Tailored indexes/materialized views <br>• Simpler retention policies | • Need duplicate repo code <br>• Hard to join annual+monthly in one query |
| B | **Partitioned Global Table** | One logical `ExecutionLineItems` but partitioned **by period type** (`ANNUAL` vs `MONTHLY`) or by `reporting_frequency` + `year`/`month`. | • Uniform schema, one repo <br>• PG can skip irrelevant partitions automatically <br>• Easy UNION queries | • Adds partition-maintenance scripts <br>• Harder to change existing code (needs trigger or default partition) |
| C | **Monthly as child table of annual** | Inherit all cols via PostgreSQL table-inheritance; child adds `month`. | • Save DDL duplication | • Inheritance is semi-deprecated vs declarative partitions; planner may scan parent unless `ONLY` keyword used |

**Recommended**: Option **B** if you foresee mixed (annual+monthly) analytics; otherwise Option **A** is simplest and safest.

---

## 3. Suggested Schema (Option A baseline)

```sql
CREATE TABLE MonthlyExecutionLineItems (
  line_item_id      BIGSERIAL PRIMARY KEY,
  report_id         TEXT NOT NULL REFERENCES Reports(report_id) ON DELETE CASCADE,
  entity_cui        VARCHAR(20) NOT NULL REFERENCES Entities(cui),
  main_creditor_cui VARCHAR(20) REFERENCES Entities(cui),
  budget_sector_id  INT  NOT NULL REFERENCES BudgetSectors(sector_id),
  funding_source_id INT  NOT NULL REFERENCES FundingSources(source_id),
  functional_code   VARCHAR(20) NOT NULL REFERENCES FunctionalClassifications(functional_code),
  economic_code     VARCHAR(20) NULL REFERENCES EconomicClassifications(economic_code),
  account_category  CHAR(2) NOT NULL CHECK (account_category IN ('vn','ch')),
  month             INT  NOT NULL CHECK (month BETWEEN 1 AND 12),
  year              INT  NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  amount            DECIMAL(18,2) NOT NULL,
  expense_type      expense_type NULL,
  program_code      VARCHAR(50) NULL,
  -- same CHECK for economic_code != NULL when account_category='ch'
  CHECK (account_category!='ch' OR economic_code IS NOT NULL)
);
```

### Indexes

1. Covering composite: `(entity_cui, year, month, account_category) INCLUDE(amount, functional_code, economic_code)`  
2. Monthly trend: `(year, month)` BRIN for time-series scans.  
3. Same foreign-key look-ups as annual.

If data > 50 M rows consider **partitioning by year** inside the monthly table:

```sql
CREATE TABLE MonthlyExecutionLineItems_2024 PARTITION OF MonthlyExecutionLineItems
FOR VALUES IN (2024);
```

---

## 4. Ingestion / ETL Pipeline

1. **Staging table** (`stg_monthly_eli` text columns)  
2. Bulk import CSV via `COPY` (fastest).  
3. Validate FK & domain constraints **after** load with `INSERT … SELECT … ON CONFLICT DO NOTHING` into main table inside a `BEGIN; … COMMIT;` transaction.  
4. Refresh materialized views (same function `refresh_all_materialized_views`, add monthly views).

For very large months you can:

* Disable secondary indexes during insert, rebuild after (not recommended if using partitions).  
* Use `pg_partman` or time-based partition extension for automation.

---

## 5. Repository Layer

### Current Pattern  

`executionLineItemRepository` (annual) implements:

* `getAll(filter,…​)`  
* `count(filter)`  
* `getById()`  
* `getYearlyTrend(filter)` …

### Option 1 – Two distinct repositories  

```
src/db/repositories/
  ├── executionLineItemRepository.ts   // Annual
  └── monthlyExecutionLineItemRepository.ts
```

Both extend a small **BaseExecutionRepo** that implements shared logic (SQL builder utilities, common filters). The monthly version adds `month` filters plus extra analytics helpers (e.g., moving average).

### Option 2 – Parameterised repository  

Single repo with table name param:

```ts
function makeExecutionRepo(table: 'ExecutionLineItems'|'MonthlyExecutionLineItems') {
  // returns an object with the same methods but bound to table
}
export const executionLineItemRepository  = makeExecutionRepo('ExecutionLineItems');
export const monthlyExecutionLineItemRepository = makeExecutionRepo('MonthlyExecutionLineItems');
```

Advantage: no code duplication; downside: a bit more indirection.

---

## 6. GraphQL / Service Layer

### Schema additions

```graphql
type MonthlyExecutionLineItem {
  line_item_id: ID!
  report: Report!
  entity: Entity!
  ... same fields ...
  month: Int!
  year: Int!
}

extend type Query {
  monthlyExecutionLineItem(id: ID!): MonthlyExecutionLineItem
  monthlyExecutionLineItems(
    filter: AnalyticsFilter
    sort: SortOrderOption
    limit: Int = 100
    offset: Int = 0
  ): ExecutionLineItemConnection
}
```

### Resolvers

Mirror the current `executionLineItemResolver` but pull from `monthlyExecutionLineItemRepository`. Re-use sub-field resolvers (`report`, `entity`, etc.) because FK relationships are identical.

### Analytics endpoints

* `executionAnalytics` currently returns yearly trend from annual table.  
  * Add `monthlyExecutionAnalytics` returning `xAxis` = `YYYY-MM`.  
  * Alternatively add a `frequency` argument (`'ANNUAL' | 'MONTHLY'`) so the resolver selects the correct repository.

* Heat-map queries already designed for monthly data? If not, copy pattern from `heatmapUATData` to use the monthly repo.

---

## 7. Materialized Views & Reporting

1. **Monthly summary**: replicate `vw_BudgetSummary_ByEntityPeriod` but include `month`, call it `vw_BudgetSummary_ByEntityMonth`.  
2. Incremental refresh—only refresh the partition (or month) that was loaded:  

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY vw_BudgetSummary_ByEntityMonth
WITH DATA
WITH NO DATA FOR TABLE MonthlyExecutionLineItems_2024;
```

3. Consider `timescaledb` or `citus` if volume > 500 M rows and analytics is heavy.

---

## 8. Performance & Storage

* Estimate: 3 × (city × functional × economic codes) per month → tens of millions rows/year.  
* Use **BRIN** on `(year, month)` and **partition** yearly to keep index size minimal (BRIN pages ~ few MB per billion rows).  
* `COPY` into partitions avoids global index maintenance.  
* Use `CLUSTER` or `ALTER TABLE … SET (autovacuum_vacuum_scale_factor = 0.01)` on large partitions.

---

## 9. Security & Validation

* Same FK and CHECK constraints guarantee data integrity.  
* Keep staging table in separate schema (`staging`) with minimal permissions.  
* Add row-level audits (trigger to `INSERT INTO ingestion_log`).

---

## 10. Roll-out Plan

1. Add new table + indexes / partitions.  
2. Create repository + unit tests (mock pool) for new queries.  
3. Add GraphQL types/resolvers behind a feature flag.  
4. Write migration script to populate 2023–2024 monthly data; benchmark.  
5. Add monitoring: count rows per month, ingest durations, index usage (your existing `analyze_index_usage()` function).

---

## 11. Summary of Recommendations

* **Schema**: Separate table or declarative partition—choose based on cross-period analytics needs; default to separate table for simplicity, migrate to partitioning if needed later (PG allows attaching existing tables as partitions).  
* **Ingestion**: `COPY` into staging → validated insert → partitioned target; run inside transaction; refresh targeted mat-views.  
* **Repository Layer**: generate table-aware repo via factory to minimise duplication.  
* **Analytics Exposure**: replicate resolver pattern; optionally unify via `frequency` argument.  
* **Indexes**: highly selective composite + BRIN; yearly partitions for maintenance.  
* **Maintenance**: yearly detach/archive old partitions, background `VACUUM ANALYZE`.  
* **Testing**: random-sampled back-to-back comparisons between annual & monthly aggregates to ensure correctness.

This design keeps the codebase aligned with the existing layered architecture, scales to high data volumes, and isolates monthly logic for future analytical features.
