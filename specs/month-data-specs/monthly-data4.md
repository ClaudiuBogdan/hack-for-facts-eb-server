## Monthly Execution Line Items: Design Options and Recommendations

### Context and goals

We currently store annual budget execution data in `ExecutionLineItems` and expose analytics through repositories and GraphQL resolvers. You want to also ingest and analyze execution data at a monthly granularity, keeping monthly and annual data in separate tables because they serve different analytics and have different query patterns.

This document evaluates schema options, partitioning/indexing strategies, repository patterns, GraphQL exposure, ETL/refresh paths, caching, and operational concerns. It concludes with a recommendation and an implementation plan outline.

### Summary of existing model (relevant bits)

- Facts: `ExecutionLineItems` (annual) with dimensions: `entity_cui`, `funding_source_id`, `functional_code`, `economic_code`, `account_category`, `budget_sector_id`, `program_code`, `expense_type`, `year`, plus report metadata via `report_id` → `Reports`.
- Performance: many helpful indexes (btree, prefix, trigram), BRIN on `year`, materialized views: `vw_BudgetSummary_ByEntityPeriod`, `vw_Category_Aggregated_Metrics`.
- Repositories: `executionLineItemRepository` builds filter queries and computes yearly trends with optional normalization; analytics cache keys by filter.
- GraphQL: `AnalyticsSeries` for trends; `executionAnalytics` returns yearly series; heatmaps and entity analytics use the unified `AnalyticsFilterInput`.

### Requirements for monthly data

- Separate storage for monthly facts to avoid mixing granularities and to optimize each for its common queries.
- Efficient time-range queries (e.g., last 12/24/60 months), entity scoped queries, and multi-dimensional breakdowns (functional/economic/funding source) at monthly resolution.
- Ability to expose monthly trends and aggregates in GraphQL without impacting annual endpoints.
- Bulk insert monthly data each month; dedupe and validate; support backfills and re-imports.

---

## Schema design options

### Option A: Separate monthly fact table (recommended)

Introduce `MonthlyExecutionLineItems` with a dedicated temporal column at month precision, keeping a schema parallel to annual but optimized for time-series queries.

Key choices inside Option A:

- Temporal column: add `period_month DATE NOT NULL` set to the first day of the month; enforce `CHECK (period_month = date_trunc('month', period_month))`.
- Generated year: `year INT GENERATED ALWAYS AS (EXTRACT(YEAR FROM period_month)::INT) STORED` to support common filters and partition pruning.
- Reference `Reports` or a new `MonthlyReports`:
  - Reuse `Reports` and store monthly entries with `reporting_period` set to the month label and `report_date` within the month.
  - Or create `MonthlyReports` if you want complete isolation and different uniqueness constraints.

Illustrative DDL (simplified):

```sql
-- Base partitioned table (PostgreSQL declarative partitions)
CREATE TABLE MonthlyExecutionLineItems (
  line_item_id BIGSERIAL PRIMARY KEY,
  report_id TEXT NOT NULL,
  report_type report_type NOT NULL,
  entity_cui VARCHAR(20) NOT NULL,
  main_creditor_cui VARCHAR(20),
  budget_sector_id INT NOT NULL,
  funding_source_id INT NOT NULL,
  functional_code VARCHAR(20) NOT NULL,
  economic_code VARCHAR(20),
  account_category CHAR(2) NOT NULL CHECK (account_category IN ('vn','ch')),
  amount DECIMAL(18,2) NOT NULL,
  program_code VARCHAR(50),
  expense_type expense_type,
  period_month DATE NOT NULL CHECK (period_month = date_trunc('month', period_month)),
  year INT GENERATED ALWAYS AS (EXTRACT(YEAR FROM period_month)::INT) STORED,
  FOREIGN KEY (report_id) REFERENCES Reports(report_id) ON DELETE CASCADE,
  FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
  FOREIGN KEY (funding_source_id) REFERENCES FundingSources(source_id) ON DELETE RESTRICT,
  FOREIGN KEY (functional_code) REFERENCES FunctionalClassifications(functional_code) ON DELETE RESTRICT,
  FOREIGN KEY (economic_code) REFERENCES EconomicClassifications(economic_code) ON DELETE RESTRICT,
  FOREIGN KEY (budget_sector_id) REFERENCES BudgetSectors(sector_id) ON DELETE RESTRICT
) PARTITION BY RANGE (period_month);

-- Year partitions (optionally with monthly sub-partitions if volume mandates):
CREATE TABLE MonthlyExecutionLineItems_2021
  PARTITION OF MonthlyExecutionLineItems
  FOR VALUES FROM ('2021-01-01') TO ('2022-01-01');

CREATE TABLE MonthlyExecutionLineItems_2022
  PARTITION OF MonthlyExecutionLineItems
  FOR VALUES FROM ('2022-01-01') TO ('2023-01-01');

-- Create partitions per year going forward; keep a DEFAULT partition for unexpected dates
CREATE TABLE MonthlyExecutionLineItems_default PARTITION OF MonthlyExecutionLineItems DEFAULT;

-- Indexing strategy (per-partition btree + global BRIN on parent is not supported; indexes are per partition)
CREATE INDEX ON MonthlyExecutionLineItems_2021 (entity_cui, period_month);
CREATE INDEX ON MonthlyExecutionLineItems_2021 (account_category, period_month);
CREATE INDEX ON MonthlyExecutionLineItems_2021 (functional_code);
CREATE INDEX ON MonthlyExecutionLineItems_2021 (economic_code) WHERE economic_code IS NOT NULL;
CREATE INDEX ON MonthlyExecutionLineItems_2021 (funding_source_id);

-- BRIN on time for very large yearly partitions (optional, benchmark-driven)
CREATE INDEX idx_meli_2021_period_month_brin ON MonthlyExecutionLineItems_2021 USING brin (period_month);
```

Pros:

- Physically and logically separate; easy to tune independently; no risk of mixing granularities in analytics.
- Declarative partitioning by `period_month` gives good pruning for time-range queries and simplifies retention.
- Reuses existing dimensions and foreign keys; low cognitive load for developers.

Cons:

- Duplicates some repository code unless shared query builders are extracted.
- Requires operational automation to create future partitions.

When to sub-partition: If a single year’s monthly data becomes too large (e.g., hundreds of millions of rows per year), use sub-partitions by `HASH (entity_cui)` under each yearly partition to parallelize scans and constrain index sizes.

### Option B: Single table with `granularity` and `period_date` (not preferred here)

Add a `granularity ENUM('annual','monthly')` and `period_date DATE` then store both annual and monthly facts in one table, partitioned by `(granularity, period_date)`.

Pros:

- One repository; code paths can be unified; one set of MVs.

Cons:

- Mixed workloads and index trade-offs; hard to optimize for both simultaneously.
- Higher risk of accidental cross-granularity queries and analytics contamination.
- You explicitly prefer separation for correctness and clarity.

### Option C: Monthly as source of truth + annual derived (future direction)

Store only monthly facts long term, and derive annual facts from monthly via ETL or materialized views; deprecate annual table over time.

Pros:

- Single ingestion; avoids double storage of the same business facts.
- Annual analytics always consistent with monthly.

Cons:

- Migration effort; impacts current annual repository/queries.
- Higher compute cost at query or refresh time.

### Option D: TimescaleDB hypertable for monthly facts

Convert monthly table into a hypertable for automatic chunking, compression, and retention.

Pros:

- Excellent time-series performance features; built-in policies; compression.

Cons:

- Additional dependency and operational complexity; license considerations for advanced features.
- Not necessary unless data scale and query profiles demand it.

---

## Indexing and partitioning strategy (Option A)

- Partitioning: RANGE by `period_month` with one partition per year. This gives predictable, small-ish partitions and good pruning for ranges like last N months/years.
- Secondary indexes (per partition):
  - `btree(entity_cui, period_month)` covering the most common access path.
  - `btree(account_category, period_month)` to split income vs expense quickly.
  - `btree(funding_source_id)`, `btree(functional_code)`, `btree(economic_code) WHERE economic_code IS NOT NULL`.
  - Optional INCLUDE columns for covering queries: `(entity_cui, period_month) INCLUDE (amount, functional_code, economic_code)`.
- BRIN: Consider a BRIN on `period_month` for extremely large partitions; benchmark to ensure it helps.
- Planner knobs: ensure `enable_partitionwise_aggregate = on` and `enable_partitionwise_join = on` at the session level for heavy analytics.

Materialized views (monthly):

- `vw_MonthlyBudgetSummary_ByEntityMonth` analogous to the annual view but groups by `date_trunc('month', period_month)`.
- `vw_MonthlyCategory_Aggregated_Metrics` analogous to `vw_Category_Aggregated_Metrics` but includes `period_month` for trend breakdowns.
- Refresh policy: monthly after ingestion; optionally incremental by refreshing only the newest partitions.

---

## Repository patterns

Goal: Share query building between annual and monthly repos without coupling storage.

Recommended layout:

- Extract a shared query builder (e.g., `db/repositories/queryBuilders/executionLineItemQuery.ts`) with:
  - `buildFilterQuery(filters, { tableAlias, tableName, temporalColumn })` returning `{ joinClauses, whereClause, values, nextParamIndex }`.
  - Support additional monthly-specific filters: `months: string[] (YYYY-MM)`, `start_month`, `end_month`, or `period_range: { start: Date, end: Date }`.
- Implement two repositories:
  - `executionLineItemRepository` (annual, unchanged public API).
  - `monthlyExecutionLineItemRepository` with parallel methods: `getAll`, `count`, `getMonthlyTrend`, `getSnapshotTotals(month)`, and aggregation helpers.
- Caching: separate caches by dataset key, e.g., prefix cache keys with `annual:` vs `monthly:` to avoid collisions.

Signatures to mirror annual repo:

```ts
// New filter for monthly
type MonthlyAnalyticsFilter = Omit<AnalyticsFilter, 'years'> & {
  months?: string[];           // ['2023-01','2023-02']
  start_month?: string;        // 'YYYY-MM'
  end_month?: string;          // 'YYYY-MM'
};

// Repository methods
getAll(filters: Partial<MonthlyAnalyticsFilter>, sort?: SortOrderOption, limit?: number, offset?: number): Promise<MonthlyExecutionLineItem[]>;
count(filters: Partial<MonthlyAnalyticsFilter>): Promise<number>;
getMonthlyTrend(filters: MonthlyAnalyticsFilter): Promise<{ month: string; value: number }[]>; // x = 'YYYY-MM'
```

SQL pattern for trend:

```sql
SELECT date_trunc('month', eli.period_month) AS month,
       SUM(CASE WHEN eli.account_category = 'vn' THEN eli.amount ELSE -eli.amount END) AS value
FROM MonthlyExecutionLineItems eli
-- joins built by shared filter builder
GROUP BY 1
ORDER BY 1;
```

Normalization (per-capita, euro) can reuse the same logic used in annual `getYearlyTrend`, swapping the temporal CTE of `years` for a months series (e.g., `generate_series(start_month, end_month, interval '1 month')`).

---

## GraphQL exposure

Two viable approaches:

1) Separate monthly API (clear separation; recommended):
   - Types:
     - `type MonthlyExecutionLineItem { ... period_month: String! /* YYYY-MM */ ... }`
     - `input MonthlyAnalyticsFilterInput` mirroring `AnalyticsFilterInput` but with `months`, `start_month`, `end_month` and without `years`.
   - Queries:
     - `monthlyExecutionLineItems(filter, sort, limit, offset): MonthlyExecutionLineItemConnection!`
     - `executionMonthlyAnalytics(inputs: [MonthlyAnalyticsInput!]!): [AnalyticsSeries!]!` where `xAxis.type = DATE` and `x` uses `YYYY-MM`.
   - Resolvers map 1:1 to `monthlyExecutionLineItemRepository`.

2) Unified API with an explicit granularity field:
   - Extend `AnalyticsInput`/`AnalyticsFilterInput` with `granularity: ANNUAL|MONTHLY` and optional `months` or `start_month/end_month`.
   - Overload existing resolvers to dispatch to annual vs monthly repos.
   - Not recommended here because you asked for clear separation and different analytics semantics.

For heatmaps/entity analytics: you can add monthly variants only if needed. Most heatmaps remain meaningful annually; if you need temporal heatmaps, use the same monthly repo and extend filters.

---

## ETL and data ingestion

- Use a staging table `MonthlyExecutionLineItems_staging` for bulk loads (COPY), validate, then `INSERT ... SELECT` into partitions.
- Idempotency & dedupe: create a unique constraint keyed on `(report_id, functional_code, economic_code, funding_source_id, account_category, budget_sector_id, program_code, expense_type, entity_cui, period_month)` if the source contains no line numbers; otherwise prefer `(report_id, source_line_no)`.
- Constraints: validate `economic_code IS NOT NULL` for expenses (`account_category = 'ch'`) as in annual.
- Partition management: schedule creation of next-year partitions ahead of time; optionally use `pg_partman` for automation.
- Refresh MVs: after ingest succeed, refresh monthly materialized views (consider `REFRESH MATERIALIZED VIEW CONCURRENTLY` if you add a unique index on MV rows).

---

## Performance considerations

- Partition pruning: queries filtered by `period_month` range will scan only relevant yearly partitions; ensure queries always constrain time.
- Index size: keep per-partition indexes smaller; avoid over-indexing. Prefer `(entity_cui, period_month)` leading columns.
- BRIN on `period_month` is effective if rows are naturally ordered by time on insert (append-only by month); combine with btree for point lookups.
- Planner settings: enable partition-wise aggregation/join for heavy analytics sessions.
- Caching: reuse existing in-memory caches with distinct namespaces; monthly trend queries are highly cacheable.

---

## Pros and cons comparison

- Option A (separate monthly table): strong isolation, simple mental model, tuned independently; modest duplication mitigated by shared query builders. Recommended.
- Option B (single table): fewer repos but complex trade-offs and risk of cross-granularity mistakes.
- Option C (monthly as source, annual derived): clean long term, larger migration.
- Option D (TimescaleDB): best performance for very large time-series at the cost of new dependency.

---

## Recommended path (Option A)

1) Schema
   - Create `MonthlyExecutionLineItems` partitioned by RANGE(`period_month`) with yearly partitions and essential indexes per partition.
   - Reuse `Reports`; if you later need different uniqueness for monthly, introduce `MonthlyReports`.

2) Repository
   - Extract shared `buildFilterQuery` and helpers into a query-builder module; implement `monthlyExecutionLineItemRepository` with `getAll`, `count`, `getMonthlyTrend`.
   - Mirror normalization logic from `getYearlyTrend` using a months series.

3) GraphQL
   - Add monthly types and inputs; expose `monthlyExecutionLineItems` and `executionMonthlyAnalytics` returning `AnalyticsSeries` with `xAxis.type = DATE` and `x = 'YYYY-MM'`.

4) ETL & Ops
   - Add a staging-and-validate pipeline; create yearly partitions ahead of time; refresh monthly MVs post-ingest.

5) Performance
   - Benchmark btree + optional BRIN; enable partition-wise features; cache by dataset + temporal range.

This approach keeps the current annual analytics untouched while enabling rich monthly analytics with predictable performance and maintainability.


