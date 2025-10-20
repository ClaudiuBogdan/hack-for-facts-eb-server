# PostgreSQL Analytics Configuration Guide – Optimized Edition

This guide explains every configuration option applied to the production `postgres-db` CloudNativePG cluster (see `k8s/overlays/prod/kustomization.yaml`) and its PgBouncer pooler. The goal is to expose the theory behind each tuning knob so you can reason about trade‑offs and adapt the profile for future workloads. The configuration targets analytics scenarios with >100 M row partitioned tables, long‑running aggregations, and NVMe storage.

---

## 1. Core Infrastructure

### 1.1 Storage Layout

```yaml
spec.storage.size: 200Gi
spec.storage.storageClass: microk8s-hostpath
spec.walStorage.size: 20Gi
spec.walStorage.storageClass: microk8s-hostpath
```

- **Primary storage (200 Gi on NVMe)** – PostgreSQL stores tables and indexes as 8 KiB heap and index pages. Provisioning 200 Gi ensures that the buffer manager has time to absorb growth, and autovacuum can run without constant disk pressure. Because `microk8s-hostpath` maps to NVMe, random and sequential IO have comparable latency, enabling the planner to treat them similarly (see `random_page_cost`).
- **Dedicated WAL volume (20 Gi)** – WAL records reflect every change before data files are modified. Placing WAL on its own NVMe PVC separates sequential log writes from random heap access. This reduces fsync latency and avoids head‑of‑line blocking when data pages are being vacuumed or rebuilt. The 20 Gi size gives breathing room above `max_wal_size = 16GB`, ensuring checkpoints do not stall for lack of free WAL segments.

### 1.2 Resource Guarantees

```yaml
spec.resources.requests = spec.resources.limits = { cpu: "4", memory: "10Gi" }
```

PostgreSQL’s planner, autovacuum, and parallel executor assume they can run without cgroup throttling. By keeping requests equal to limits, the pod receives Kubernetes’ “Guaranteed” QoS class, which eliminates CPU throttling and lowers eviction probability. All memory calculations below (e.g., `work_mem`) assume 10 Gi of available RSS.

---

## 2. Connection Management

```yaml
max_connections: "50"
```

Each active backend can allocate memory for `work_mem`, temporary structures, and shared cache metadata. Analytics queries tend to execute fewer sessions, but each session is heavy: one complex plan may use several `work_mem` allocations per worker. By limiting `max_connections` to 50, we bound total memory exposure:

```
Potential work memory ≈ connections × operators × work_mem
≈ 50 × 4 × 256 MB ≈ 51 GiB
```

PgBouncer session pooling absorbs higher client concurrency while forcing queries to queue when resources are constrained.

---

## 3. Memory Hierarchy

```yaml
shared_buffers: "4096MB"
effective_cache_size: "8GB"
work_mem: "256MB"
hash_mem_multiplier: "2.0"
maintenance_work_mem: "2GB"
temp_file_limit: "20GB"
```

- **`shared_buffers` (4 GiB)** – PostgreSQL’s buffer manager caches table and index pages before they reach the operating system. The buffer pool uses an LRU/clock‑sweep algorithm, so larger pools reduce “buffer churn” when multiple partitions are scanned repeatedly. At 40 % of total RAM we balance caching against memory reserved for `work_mem` and background processes.

- **`effective_cache_size` (8 GiB)** – A planner hint estimating pages likely cached by the OS. PostgreSQL compares `bitmap heap scan` vs `sequential scan` cost using this value. Setting it close to RAM (minus headroom for other processes) tells the planner that even large datasets can stay resident, encouraging index usage and parallel plans.

- **`work_mem` (256 MiB)** – Memory assigned per sort or hash node *per backend* (and per parallel worker). Sort nodes use quicksort with fallbacks to external merge sort when space is exhausted; hash nodes use dynamic hash tables that spill to disk if they cannot grow. At 256 MiB most OLAP joins, aggregations, and window functions remain in RAM, avoiding `base/pgsql_tmp` writes that can be orders of magnitude slower.

- **`hash_mem_multiplier` (2.0)** – PostgreSQL 13+ allows hashes to exceed `work_mem` by this factor because spilling a hash table is costlier than spilling a sort. With this multiplier, hash joins/aggregates can consume 512 MiB before spilling, increasing the probability of staying in memory while still keeping sorts under 256 MiB.

- **`maintenance_work_mem` (2 GiB)** – Used by VACUUM, CREATE INDEX, and ALTER INDEX operations. Large maintenance memory allows these routines to sort tuples and build indexes in memory, reducing passes over the data. For example, CREATE INDEX uses this space for the initial tuplesort before writing to disk.

- **`temp_file_limit` (20 GiB)** – Soft limit that aborts queries generating more than 20 GiB of on-disk temp files, preventing runaway jobs from filling the PVC. Because analytics queries are allowed to spill moderate amounts, the limit is high but finite. Every spill is logged thanks to `log_temp_files = 0`.

---

## 4. WAL and Checkpoints

```yaml
min_wal_size: "2GB"
max_wal_size: "16GB"
checkpoint_timeout: "15min"
checkpoint_completion_target: "0.9"
wal_buffers: "-1"
wal_compression: "lz4"
```

- **Checkpoint cadence** – PostgreSQL writes dirty pages to disk during checkpoints. Extending `checkpoint_timeout` to 15 min and allowing WAL to grow to 16 GiB lowers the number of checkpoints, thus reducing write amplification during heavy ETL bursts. The `checkpoint_completion_target` of 0.9 makes the background writer spread the workload evenly instead of flushing everything at the end of the interval.

- **`wal_buffers = -1`** – Auto-sizing WAL buffers (typically 3 % of `shared_buffers`) ensures WAL write batching stays optimal as `shared_buffers` changes. WAL buffers hold log records before they reach the WAL segment files.

- **`wal_compression = lz4`** – When full-page images are emitted (e.g., after a checkpoint), compression shrinks WAL volume with very low CPU overhead, especially beneficial for network replication or when WAL resides on separate storage.

---

## 5. NVMe-Oriented Planner & IO Settings

```yaml
random_page_cost: "1.0"
effective_io_concurrency: "256"
maintenance_io_concurrency: "256"
```

- **`random_page_cost = 1.0`** – The planner’s cost model compares sequential and random IO by multiplying page fetches by these costs. HDDs typically justify the default 4.0 because head seeks dominate latency. On NVMe, random reads are near sequential speeds, so setting the cost to 1.0 tells the planner that index probes are cheap, unlocking index-driven plans on large tables.

- **`effective_io_concurrency = 256`** – Governs how many asynchronous prefetch requests may be queued for bitmap heap scans. Bitmap scans first identify heap page addresses via the index, then prefetch them. High values allow the IO scheduler to exploit NVMe’s deep queues, keeping workers busy instead of waiting.

- **`maintenance_io_concurrency = 256`** – Applies similar queuing to maintenance tasks (VACUUM, `CREATE INDEX`). PostgreSQL 15 added this setting to reduce replication lag and speed up vacuum on fast storage.

---

## 6. Parallel Execution

```yaml
max_worker_processes: "8"
max_parallel_workers: "4"
max_parallel_workers_per_gather: "4"
max_parallel_maintenance_workers: "4"
parallel_setup_cost: "100"
parallel_tuple_cost: "0.01"
min_parallel_table_scan_size: "8MB"
min_parallel_index_scan_size: "512kB"
```

- **Worker limits** – `max_worker_processes` is the global cap for all background workers (parallel queries, logical replication, autovacuum). `max_parallel_workers` reserves four of them for parallel query execution, matching the number of vCPUs. `max_parallel_workers_per_gather` allows a single Gather node to enlist all four workers, letting one heavy query utilize the entire CPU budget. `max_parallel_maintenance_workers` lets maintenance commands (VACUUM, CREATE INDEX) also leverage parallelism.

- **Planner cost adjustments** – The planner weighs the cost of starting workers (`parallel_setup_cost`) and processing tuples (`parallel_tuple_cost`). Lower values express confidence that work can be split efficiently across cores, making it easier for the planner to choose parallel execution. Likewise, reducing `min_parallel_*_size` lowers the data-size threshold required before parallel plans are considered.

Combined, these settings help the executor break up large sequential scans and aggregations across multiple workers, reducing wall-clock time without oversubscribing CPU cores.

---

## 7. Partition-Aware Planning

```yaml
default_statistics_target: "500"
constraint_exclusion: "partition"
enable_partition_pruning: "on"
enable_partitionwise_join: "on"
enable_partitionwise_aggregate: "on"
```

- **Statistics depth** – PostgreSQL’s ANALYZE samples tables to build histograms and most-common-value lists. Increasing `default_statistics_target` to 500 increases sample size and histogram bins. This improves cardinality estimates for skewed data, which in turn guides join order, parallelism, and partition pruning decisions.

- **Partition elimination** – `constraint_exclusion=partition` allows the planner to discard partitions when the WHERE clause contradicts partition bounds at plan time. `enable_partition_pruning=on` adds runtime pruning, useful for prepared statements where parameter values are only known during execution.

- **Partitionwise operations** – Enabling partitionwise joins and aggregates lets the planner process each pair of matching partitions independently, then combine the results. This reduces memory per worker and enables more parallel work, especially when fact and dimension tables share partition keys (e.g., monthly partitions).

---

## 8. Autovacuum for Large Tables

```yaml
autovacuum_max_workers: "8"
autovacuum_naptime: "30s"
autovacuum_vacuum_scale_factor: "0.02"
autovacuum_vacuum_insert_scale_factor: "0.02"
autovacuum_analyze_scale_factor: "0.01"
autovacuum_vacuum_cost_delay: "0ms"
autovacuum_vacuum_cost_limit: "10000"
```

- **Worker concurrency** – Eight workers mean autovacuum can address several large partitions in parallel. With a 30 s nap time, the launcher checks for work frequently, reducing the risk of backlog after heavy ingestion.

- **Trigger thresholds** – Scale factors define how much a table may change before vacuum/analyze runs: `0.02` triggers vacuum after 2 % dead tuples, and `0.01` triggers analyze after 1 % modifications. For a 100 M row partition, that means interventions at 2 M and 1 M rows respectively—much sooner than defaults—keeping visibility maps current and statistics fresh.

- **Cost-based throttling** – Setting `autovacuum_vacuum_cost_delay` to zero and raising `autovacuum_vacuum_cost_limit` to 10 000 removes most throttling. On NVMe, the system can absorb aggressive vacuum IO, allowing workers to complete faster and release resources promptly.

---

## 9. JIT Compilation

```yaml
jit: "on"
jit_above_cost: "500000"
jit_inline_above_cost: "500000"
jit_optimize_above_cost: "500000"
```

LLVM-based JIT compilation transforms expression evaluation and tuple deforming into machine code for expensive plans. The cost thresholds (500 000) correspond to queries that the planner estimates will process millions of rows or perform complex aggregates. JIT adds compilation overhead (~hundreds of milliseconds), so enabling it only for high-cost plans ensures the speedup outweighs the cost. Lower-cost OLTP-style queries bypass JIT altogether.

---

## 10. Monitoring & Instrumentation

```yaml
pg_stat_statements.max: "10000"
pg_stat_statements.track: "all"
auto_explain.log_min_duration: "1000ms"
auto_explain.log_analyze: "on"
auto_explain.log_buffers: "on"
auto_explain.log_timing: "on"
track_io_timing: "on"
track_functions: "all"
log_min_duration_statement: "1000ms"
log_temp_files: "0"
log_lock_waits: "on"
statement_timeout: "3600000"
idle_in_transaction_session_timeout: "600000"
```

- **`pg_stat_statements`** – Tracks execution counts, time, and IO metrics for normalized queries. Setting `track=all` includes nested statements (e.g., from functions). Raising `max` ensures the catalog retains analytics queries that may execute less frequently but consume significant resources.

- **`auto_explain` attributes** – Logging plans for queries longer than 1 s, with `ANALYZE`, buffer usage, and timing, helps diagnose whether slow queries are CPU-bound, IO-bound, or blocked on locks. Plans appear in server logs, aiding forensic analysis.

- **`track_io_timing`** – Enables block device timing, adding visibility into read/write latency for each query. Without it, `pg_stat_statements` cannot separate CPU time from IO wait.

- **`track_functions=all`** – Records function-level statistics, useful when analytical workloads rely on PL/pgSQL or SQL functions.

- **Logging slow statements and temp files** – `log_min_duration_statement=1000ms` captures slow SQL text; `log_temp_files=0` records every temp file with its size, highlighting queries still spilling despite higher `work_mem`.

- **Lock diagnostics** – `log_lock_waits=on` logs when sessions wait longer than one second on locks, important for spotting blockers during large maintenance tasks.

- **Timeouts** – `statement_timeout=1h` prevents runaway analytics jobs from occupying resources indefinitely. `idle_in_transaction_session_timeout=10m` terminates sessions that hold open transactions without activity, avoiding long-lived locks that could block autovacuum.

---

## 11. PgBouncer Session Pooler

```yaml
poolMode: session
parameters:
  max_client_conn: "200"
  default_pool_size: "25"
  min_pool_size: "5"
  query_wait_timeout: "120"
  server_idle_timeout: "600"
```

- **Session pooling** – Keeps each client bound to a backend for the life of the session. Analytics clients often rely on prepared statements, temp tables, and `SET` commands such as `SET work_mem`. Transaction pooling would break these assumptions, so session mode is required.

- **Connection limits** – `max_client_conn` controls how many client connections each PgBouncer deployment accepts. With two replicas, the theoretical maximum is 400; however, `default_pool_size=25` per user/database combination matches the Postgres `max_connections` budget (≈50 active backends). `min_pool_size=5` keeps a warm pool ready, reducing latency spikes when traffic resumes.

- **Timeouts** – `query_wait_timeout=120` returns errors to clients if they wait longer than two minutes for a server connection, making resource saturation explicit. `server_idle_timeout=600` closes idle server connections after ten minutes, letting PgBouncer rebalance slots under fluctuating demand.

---

## 12. Instrumentation Queries

These SQL snippets (referenced in the guide) help interpret the effects of the configuration:

### 12.1 Parallel Worker Usage
```sql
SELECT
  substring(query, 1, 80) AS query_preview,
  calls,
  mean_exec_time::numeric(10,2) AS avg_ms,
  workers_planned,
  workers_launched
FROM pg_stat_plans
JOIN pg_stat_statements USING (queryid)
ORDER BY mean_exec_time DESC
LIMIT 10;
```

### 12.2 Detecting Memory Spills
```sql
SELECT
  substring(query, 1, 80) AS query_preview,
  calls,
  temp_blks_written,
  pg_size_pretty(temp_blks_written * 8192) AS temp_size
FROM pg_stat_statements
WHERE temp_blks_written > 0
ORDER BY temp_blks_written DESC
LIMIT 10;
```

### 12.3 Measuring JIT Benefit
```sql
SELECT
  substring(query, 1, 80) AS query_preview,
  calls,
  mean_exec_time::numeric(10,2) AS avg_exec_ms,
  (jit_generation_time + jit_inlining_time + jit_optimization_time)::numeric(10,2) AS jit_overhead_ms,
  round(((jit_generation_time + jit_inlining_time + jit_optimization_time) / NULLIF(mean_exec_time,0) * 100)::numeric, 2) AS jit_overhead_pct
FROM pg_stat_statements
WHERE jit_functions > 0
ORDER BY mean_exec_time DESC
LIMIT 10;
```

---

## References

1. [pganalyze – work_mem tuning](https://pganalyze.com/blog/5mins-postgres-work-mem-tuning)  
2. [pganalyze – deterministic planner & SSD tuning](https://pganalyze.com/blog/5mins-postgres-tuning-deterministic-query-planner-extended-statistics-join-collapse-limits)  
3. [pganalyze – PostgreSQL 15 maintenance IO concurrency](https://pganalyze.com/blog/5mins-postgres-15-maintenance-io-concurrency-reduce-replication-lag)  
4. [PostGIS performance tuning workshop](https://postgis.net/workshops/it/postgis-intro/tuning.html)  
5. [Rizqi Mulki – hidden PostgreSQL setting doubled query speed](https://rizqimulki.com/the-hidden-postgresql-setting-that-doubled-query-speed-overnight-72803da1a13e)  
6. [StackOverflow – random_page_cost on NVMe](https://stackoverflow.com/questions/73196927/postgresql-random-page-cost-1-1-and-nvme-disk-slower-query)  
7. [Frehi – tuning PostgreSQL for SSD](https://blog.frehi.be/2025/07/28/tuning-postgresql-performance-for-ssd/)  
8. [PostgreSQL documentation – maintenance_io_concurrency](https://postgresqlco.nf/doc/en/param/maintenance_io_concurrency/)  
9. [Citus Data – configuring work_mem](https://www.citusdata.com/blog/2018/06/12/configuring-work-mem-on-postgres/)  
10. [PostgreSQL runtime config reference](https://www.postgresql.org/docs/current/runtime-config-resource.html)  
11. [PostgreSQLCO.NF – hash_mem_multiplier](https://postgresqlco.nf/doc/en/param/hash_mem_multiplier/)  
12. [PostgreSQL WAL configuration docs](https://www.postgresql.org/docs/current/wal-configuration.html)  
13. [MinervaDB – PostgreSQL 16 performance parameters](https://minervadb.xyz/postgresql-16-configuration-parameters-for-performance/)  
14. [credativ – ANALYZE vs maintenance_io_concurrency](https://www.credativ.de/en/blog/postgresql-en/quick-benchmark-analyze-vs-maintenance_io_concurrency-reduce-replication-lag/)  
15. [AWS Aurora PostgreSQL parameter guidance](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Reference.ParameterGroups.html)

Understanding the theoretical rationale for each setting allows you to tailor the profile as workloads evolve, while maintaining predictable performance on NVMe-backed analytics infrastructure.
