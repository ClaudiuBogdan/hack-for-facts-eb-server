<https://chatgpt.com/c/68ab5ab8-68ec-832e-b285-49f1b71654f1>

# Monthly Data Series — Unified Specification (v1.0)

**Owner:** Data Platform / Backend

**Status:** Proposed → Implement

**Scope:** Introduce monthly‑granularity execution line items using a **separate fact table** and expose them across ingestion, storage, repositories, analytics, and GraphQL. Annual data remains unchanged.

---

## 1) Goals & Non‑Goals

**Goals**

* Store and query monthly budget execution data without impacting current annual workloads.
* Optimize for time‑range scans (last 12/24/60 months) and entity‑scoped analyses.
* Keep ingestion fast and idempotent; support backfills and re‑imports.
* Provide clear API separation while reusing existing dimensions and conventions.

**Non‑Goals**

* Migrating annual facts into monthly or deriving annual from monthly (future option).
* Introducing external time‑series extensions (e.g., TimescaleDB) at this stage.

---

## 2) Canonical Data Model

### 2.1 Fact Table (new)

**`MonthlyExecutionLineItems`** — partitioned by time

* **Key columns:**

  * `line_item_id BIGSERIAL` (PK)
  * `report_id TEXT NOT NULL` → FK `Reports.report_id`
  * `entity_cui VARCHAR(20) NOT NULL` → FK `Entities.cui`
  * `main_creditor_cui VARCHAR(20)` → FK `Entities.cui`
  * `budget_sector_id INT NOT NULL` → FK `BudgetSectors.sector_id`
  * `funding_source_id INT NOT NULL` → FK `FundingSources.source_id`
  * `functional_code VARCHAR(20) NOT NULL` → FK `FunctionalClassifications.functional_code`
  * `economic_code VARCHAR(20)` → FK `EconomicClassifications.economic_code`
  * `account_category CHAR(2) NOT NULL CHECK (account_category IN ('vn','ch'))`
  * `amount DECIMAL(18,2) NOT NULL`
  * `program_code VARCHAR(50)`
  * `expense_type expense_type`
  * `period_month DATE NOT NULL CHECK (period_month = date_trunc('month', period_month))`
  * `year INT GENERATED ALWAYS AS (EXTRACT(YEAR FROM period_month)::INT) STORED`

**Data integrity:**

* `CHECK (account_category != 'ch' OR economic_code IS NOT NULL)`
* **Deduplication** (idempotent loads): unique composite on
  `(report_id, entity_cui, funding_source_id, functional_code, economic_code, account_category, budget_sector_id, program_code, expense_type, period_month)`.

### 2.2 Metadata Reuse

* Reuse existing **`Reports`** table: store monthly entries with

  * `report_date` set within the month,
  * `reporting_year = EXTRACT(YEAR FROM report_date)`,
  * `reporting_period` standardized as `YYYY-MM`.

> If later we need different uniqueness/metadata for monthly, we can introduce a `MonthlyReports` table without breaking consumers.

---

## 3) Physical Design & Partitioning

### 3.1 Partitioning

* Declarative `PARTITION BY RANGE (period_month)` with **one partition per year**:

  * `MonthlyExecutionLineItems_2023  FOR VALUES FROM ('2023-01-01') TO ('2024-01-01')`
  * `MonthlyExecutionLineItems_2024  FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')`
  * `MonthlyExecutionLineItems_2025  …` and so on
* Optional sub‑partitioning by `HASH(entity_cui)` under a yearly partition if a single year exceeds hundreds of millions of rows.
* Keep a `DEFAULT` partition for out‑of‑range safety; drain/move rows during maintenance.

### 3.2 Indexing (per partition)

* `btree(entity_cui, period_month) INCLUDE (amount, functional_code, economic_code)` — primary access path.
* `btree(account_category, period_month)` — fast split of income vs expense.
* `btree(funding_source_id)`; `btree(functional_code)`; `btree(economic_code) WHERE economic_code IS NOT NULL`.
* Optional `BRIN(period_month)` for very large yearly partitions (validate with benchmarks).

### 3.3 Storage & Maintenance

* Autovacuum tuned for large partitions (e.g., `autovacuum_vacuum_scale_factor = 0.01`).
* Pre‑create next‑year partitions via migration/automation; consider `pg_partman` later.
* Retention: archive/drop whole **year partitions** based on policy.

---

## 4) Ingestion & Data Quality

### 4.1 Staging + COPY

* **Staging table** `stg_monthly_eli` (text columns, minimal constraints) in a dedicated `staging` schema.
* Bulk load via `COPY` into staging.
* Validate and cast in `INSERT … SELECT` into the correct partition; enforce FKs and checks here.
* Use `ON CONFLICT DO NOTHING` targeting the composite unique key for idempotency.

### 4.2 Order of operations

1. COPY → staging
2. `BEGIN`
3. Insert/validate into fact partitions
4. Refresh **monthly** materialized views (see §6)
5. `COMMIT`

### 4.3 Governance

* Least‑privilege: app only inserts via stored function or service account scoped to staging + target table; no direct DML from outside ingestion path.
* Audit trigger to append to `ingestion_log` (report id, counts, duration, checksum).

---

## 5) Read Model & Encapsulation

### 5.1 Views (read‑only contracts)

* `vw_MonthlyBudgetSummary_ByEntityMonth` (entity, month) → totals by income/expense and balance using `date_trunc('month', period_month)`.
* `vw_MonthlyCategory_Aggregated_Metrics` (functional/economic, month) → aggregates for charts and drill‑downs.

These views isolate consumers from table changes and simplify GraphQL and BI.

### 5.2 Repository Layer

* New `monthlyExecutionLineItemRepository` that mirrors annual repository methods but targets the monthly table and views.
* Extract a **shared query builder** used by both repos:

  * Accepts `tableAlias`, `tableName`, `temporalColumn` (here `period_month`).
  * Adds monthly filters: `months[] (YYYY-MM)`, `start_month`, `end_month`.
* Separate cache namespaces: `annual:*` vs `monthly:*` to avoid collisions.

---

## 6) GraphQL & Analytics

### 6.1 Schema

* `type MonthlyExecutionLineItem { … period_month: String! /* YYYY-MM */ … }`
* `input MonthlyAnalyticsFilterInput` (mirrors annual but with month fields and **without** `years`).

### 6.2 Queries

* `monthlyExecutionLineItems(filter, sort, limit, offset): MonthlyExecutionLineItemConnection!`
* `executionMonthlyAnalytics(inputs: [MonthlyAnalyticsInput!]!): [AnalyticsSeries!]!` where `xAxis.type = DATE` and `x = 'YYYY-MM'`.

### 6.3 Analytics semantics

* Trend SQL pattern uses `date_trunc('month', period_month)` and a generated `generate_series(start_month, end_month, '1 month')` for dense x‑axes.
* Reuse normalization logic (per‑capita, currency) from annual analytics.

---

## 7) DDL (authoritative excerpt)

```sql
-- Parent table
CREATE TABLE IF NOT EXISTS MonthlyExecutionLineItems (
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
  FOREIGN KEY (main_creditor_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
  FOREIGN KEY (funding_source_id) REFERENCES FundingSources(source_id) ON DELETE RESTRICT,
  FOREIGN KEY (functional_code) REFERENCES FunctionalClassifications(functional_code) ON DELETE RESTRICT,
  FOREIGN KEY (economic_code) REFERENCES EconomicClassifications(economic_code) ON DELETE RESTRICT,
  FOREIGN KEY (budget_sector_id) REFERENCES BudgetSectors(sector_id) ON DELETE RESTRICT,
  CHECK (account_category != 'ch' OR economic_code IS NOT NULL)
) PARTITION BY RANGE (period_month);

-- Yearly partitions (sample)
CREATE TABLE IF NOT EXISTS MonthlyExecutionLineItems_2024
  PARTITION OF MonthlyExecutionLineItems
  FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');

CREATE TABLE IF NOT EXISTS MonthlyExecutionLineItems_2025
  PARTITION OF MonthlyExecutionLineItems
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

-- Indexes per partition
CREATE INDEX IF NOT EXISTS idx_meli_2024_entity_month
  ON MonthlyExecutionLineItems_2024 (entity_cui, period_month);
CREATE INDEX IF NOT EXISTS idx_meli_2024_category_month
  ON MonthlyExecutionLineItems_2024 (account_category, period_month);
CREATE INDEX IF NOT EXISTS idx_meli_2024_func
  ON MonthlyExecutionLineItems_2024 (functional_code);
CREATE INDEX IF NOT EXISTS idx_meli_2024_econ
  ON MonthlyExecutionLineItems_2024 (economic_code) WHERE economic_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meli_2024_fund
  ON MonthlyExecutionLineItems_2024 (funding_source_id);
-- Optional for very large partitions
-- CREATE INDEX idx_meli_2024_period_brin ON MonthlyExecutionLineItems_2024 USING brin (period_month);

-- Idempotent unique key (tune if source provides stable line numbers)
ALTER TABLE MonthlyExecutionLineItems_2024
  ADD CONSTRAINT uq_meli_2024 UNIQUE
  (report_id, entity_cui, funding_source_id, functional_code, economic_code, account_category, budget_sector_id, program_code, expense_type, period_month);
```

---

## 8) Backward Compatibility & Evolution

* No change to `ExecutionLineItems` (annual).
* Consumers migrate opt‑in to monthly views and queries.
* Future: derive annual aggregates from monthly and deprecate annual facts (requires ETL + acceptance tests).

---

## 9) Operational Runbook

* **Partition creation:** migration job runs yearly in Q4 to add next year partitions.
* **Ingest monitoring:** metrics per import (rows in/out, rejected rows, duration), unique‑violation counts, index scans on monthly partitions.
* **Housekeeping:** periodic `VACUUM ANALYZE` and `REINDEX` only if bloat observed; whole‑partition `DROP/ARCHIVE` for retention.

---

## 10) Acceptance Criteria (Go/No‑Go)

1. Insert 10M+ rows across 24 months in < N minutes on staging hardware (target to be set) with <5% rejected rows.
2. Typical trend query for a single entity, last 24 months, P95 < 300 ms.
3. `monthlyExecutionAnalytics` returns a dense series (`YYYY‑MM`) with no gaps between `start_month` and `end_month`.
4. Annual analytics P95 unaffected (±5%).
5. Re‑imports are idempotent (no duplicates) and safe.

---

## 11) Example Queries

**Entity trend (income − expense) by month**

```sql
SELECT date_trunc('month', period_month) AS month,
       SUM(CASE WHEN account_category='vn' THEN amount ELSE -amount END) AS value
FROM MonthlyExecutionLineItems
WHERE entity_cui = $1 AND period_month BETWEEN $2 AND $3
GROUP BY 1 ORDER BY 1;
```

**Monthly summary view**

```sql
SELECT reporting_year, to_char(period_month, 'YYYY-MM') AS month,
       entity_cui,
       SUM(CASE WHEN account_category='vn' THEN amount ELSE 0 END) AS total_income,
       SUM(CASE WHEN account_category='ch' THEN amount ELSE 0 END) AS total_expense
FROM MonthlyExecutionLineItems JOIN Reports USING (report_id)
GROUP BY reporting_year, month, entity_cui;
```

---

## 12) Rollout Plan

1. Ship DDL + partitions + indexes in a migration.
2. Implement staging → validate → insert pipeline; wire audit logging.
3. Build the monthly repository + shared query builder; add caches.
4. Add GraphQL types/resolvers and monthly analytics endpoints (behind feature flag), plus the two monthly MVs.
5. Load historical months for a pilot set of entities; benchmark and tune indexes.
6. Expand ingestion to all entities; add partitions for next year; finalize SLOs.

---

## 13) Risks & Mitigations

* **Index bloat / slow inserts** → Keep indexes minimal on hot partitions; consider BRIN; stage and batch inserts.
* **Cross‑granularity confusion** → Separate APIs and views; strong naming (`Monthly*`).
* **Storage growth** → Yearly retention/archive by dropping partitions; compress backups.
* **Backfill pressure** → Run backfills partition‑by‑partition; pause MV refreshes during bulk loads.

---

1) Make ExecutionLineItems a partitioned parent (by year)

Replace your current ExecutionLineItems definition with this:

-- ========= FACT TABLE (PARTITIONED BY YEAR) =========
CREATE TABLE ExecutionLineItems (
  year INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  line_item_id BIGINT GENERATED BY DEFAULT AS IDENTITY,
  report_id TEXT NOT NULL,
  report_type report_type NOT NULL,
  entity_cui VARCHAR(20) NOT NULL,
  main_creditor_cui VARCHAR(20),
  budget_sector_id INT NOT NULL,
  funding_source_id INT NOT NULL,
  functional_code VARCHAR(20) NOT NULL,
  economic_code VARCHAR(20),
  account_category CHAR(2) NOT NULL,
  amount DECIMAL(18,2) NOT NULL,
  program_code VARCHAR(50),
  expense_type expense_type,

  -- Important: PK must include the partition key on a partitioned table
  CONSTRAINT execution_line_items_pk PRIMARY KEY (year, line_item_id),

  FOREIGN KEY (report_id) REFERENCES Reports(report_id) ON DELETE CASCADE,
  FOREIGN KEY (entity_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,
  FOREIGN KEY (funding_source_id) REFERENCES FundingSources(source_id) ON DELETE RESTRICT,
  FOREIGN KEY (functional_code) REFERENCES FunctionalClassifications(functional_code) ON DELETE RESTRICT,
  FOREIGN KEY (economic_code) REFERENCES EconomicClassifications(economic_code) ON DELETE RESTRICT,
  FOREIGN KEY (budget_sector_id) REFERENCES BudgetSectors(sector_id) ON DELETE RESTRICT,
  FOREIGN KEY (main_creditor_cui) REFERENCES Entities(cui) ON DELETE RESTRICT,

  CHECK (account_category IN ('vn','ch')),
  CHECK (account_category != 'ch' OR economic_code IS NOT NULL)
) PARTITION BY RANGE (year);

COMMENT ON TABLE ExecutionLineItems IS 'Fact table containing individual budget execution line items (partitioned by year)';
COMMENT ON COLUMN ExecutionLineItems.account_category IS '\"vn\"=income, \"ch\"=expenses';
COMMENT ON COLUMN ExecutionLineItems.amount IS 'RON';
COMMENT ON COLUMN ExecutionLineItems.expense_type IS 'dezvoltare/functionare';

Adjust the only dependent table (ExecutionLineItemTags)

Change it to reference the composite PK:

DROP TABLE IF EXISTS ExecutionLineItemTags;
CREATE TABLE ExecutionLineItemTags (
  year INT NOT NULL,
  line_item_id BIGINT NOT NULL,
  tag_id INT NOT NULL,
  PRIMARY KEY (year, line_item_id, tag_id),
  FOREIGN KEY (year, line_item_id)
    REFERENCES ExecutionLineItems(year, line_item_id)
    ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES Tags(tag_id) ON DELETE CASCADE
);

-- Optional helper index for typical lookups
CREATE INDEX idx_execution_tags_item ON ExecutionLineItemTags(year, line_item_id);
CREATE INDEX idx_execution_tags_tag ON ExecutionLineItemTags(tag_id);

Your materialized views don’t need changes. Your existing CREATE INDEX ... ON ExecutionLineItems(...) lines can stay — when run on the partitioned parent, PostgreSQL creates partitioned indexes (one per child partition).

⸻

2) Create yearly partitions (+ a DEFAULT catch-all)

Add this block after the table definitions and before you load data:

-- ========= PARTITIONS =========
-- Create yearly partitions for your data window; tweak the bounds as needed.
DO $$
DECLARE y int;
BEGIN
  FOR y IN 2015..2035 LOOP
    EXECUTE format($f$
      CREATE TABLE IF NOT EXISTS ExecutionLineItems_y%s
      PARTITION OF ExecutionLineItems
      FOR VALUES FROM (%s) TO (%s);
    $f$, y, y, y+1);
  END LOOP;
END$$;

-- Optional: catch-all so new unseen years don't break inserts
CREATE TABLE IF NOT EXISTS ExecutionLineItems_default
PARTITION OF ExecutionLineItems DEFAULT;

⸻

3) How this affects your seed script

Good news: you can keep seeding “as usual” with a couple of small rules.

What stays the same
 • Insert into the parent: INSERT INTO ExecutionLineItems (...) VALUES (...)
Postgres routes each row to the right child partition automatically based on year.
 • COPY works the same way: COPY ExecutionLineItems (...) FROM STDIN will route rows automatically.

What you must do
 1. Make sure partitions exist before you insert.
 • Either pre-create them (as above), or rely on the DEFAULT partition temporarily.
 • If you don’t have a matching partition and don’t have a default, inserts will error with “no partition of relation found”.
 2. Include year in every seed row.
 • It’s now part of the PK and the partition key; seeding without it will fail.
 3. If you use upserts, include year in the conflict target.
 • Example:

INSERT INTO ExecutionLineItems (year, line_item_id, ...columns...)
VALUES (2024, DEFAULT, ... )
ON CONFLICT (year, line_item_id) DO UPDATE
  SET amount = EXCLUDED.amount;

 4. Best performance pattern for big seeds:
 • (Option A) Create partitions first, load data, then create the indexes on the parent (which builds per-partition indexes once). This is fastest.
 • (Option B) If you already need the indexes during seeding (e.g., for FK checks), keep your existing index block before the load; it’s fine, just a bit slower.
 5. Ordering helps locality
 • If using COPY/bulk inserts, feed rows roughly grouped by year. It improves cache locality and reduces random I/O during index builds.
 6. Sequences/IDs
 • line_item_id is an identity column; you can supply explicit values or let Postgres generate them.
 • If you do supply explicit IDs, you may want to SELECT setval(...) afterward to advance the identity sequence beyond the max.
 7. Seeding tags tied to items
 • When inserting into ExecutionLineItemTags, you must also supply year.
 • Typically you have it in the seed row already; if not, derive it from the source that produced the line item.

INSERT INTO ExecutionLineItemTags (year, line_item_id, tag_id)
VALUES (2024, 12345, 7);

Tiny sample seed (CSV via COPY)

-- Example CSV columns: year,report_id,report_type,entity_cui,main_creditor_cui,
-- budget_sector_id,funding_source_id,functional_code,economic_code,
-- account_category,amount,program_code,expense_type
COPY ExecutionLineItems (
  year, report_id, report_type, entity_cui, main_creditor_cui,
  budget_sector_id, funding_source_id, functional_code, economic_code,
  account_category, amount, program_code, expense_type
)
FROM PROGRAM 'cat /path/to/eli_2019_2025.csv' WITH (FORMAT csv, HEADER true);

⸻

FAQ (quick)
 • Are partitions created automatically by Postgres?
No. You create them (loop, migration) or add a DEFAULT partition to catch new years.
 • Do I need to change my queries?
Usually not. Just keep filtering by year where you can — that lets the planner prune partitions and scan less data.
 • Can I keep a single-column PK?
Not on a partitioned t
