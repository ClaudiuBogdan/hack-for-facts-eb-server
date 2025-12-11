# Transparenta.eu — Technical Reference

## Domain & Infrastructure Guide

This document covers domain-specific technical details, data model, database strategy, API design, and operational concerns. For code architecture patterns, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## 1. Platform Scope

The platform ingests Romanian public budget data from 13,000+ institutions, normalizes it, and serves analytics through multiple interfaces.

**Core Capabilities:**

- Data ingestion and validation pipeline
- Budget execution analytics and aggregation
- Multi-protocol API (GraphQL, REST, MCP)
- Search across entities and classifications
- Alerting on budget thresholds

---

## 2. Extended Technology Stack

Beyond the core stack in ARCHITECTURE.md:

| Purpose         | Technology                | Why                                            |
| :-------------- | :------------------------ | :--------------------------------------------- |
| Package Manager | pnpm                      | Fast, deterministic, secure package management |
| Queue           | BullMQ + Redis            | Reliable job processing                        |
| Cache           | Redis                     | Query caching, pub/sub for invalidation        |
| MCP             | @modelcontextprotocol/sdk | Standard protocol for AI agent access          |

---

## 3. Data Model

### 3.1 Core Entities

| Entity                       | Description                                 | Key Field                          |
| :--------------------------- | :------------------------------------------ | :--------------------------------- |
| **Entity**                   | Public institution                          | CUI (fiscal code)                  |
| **UAT**                      | Administrative territorial unit             | UAT Code (SIRUTA / CIF)            |
| **Report**                   | Metadata for imported budget files          | Report ID                          |
| **FunctionalClassification** | COFOG functional code                       | Functional Code                    |
| **EconomicClassification**   | Economic nature code                        | Economic Code                      |
| **ExecutionLineItem**        | Single budget line item                     | Composite (Year + ReportType + ID) |
| **Tag**                      | Arbitrary label for grouping entities/codes | Tag ID                             |

### 3.2 ExecutionLineItem Dimensions

Each `ExecutionLineItem` record is a fact in the main partitioned table, with these dimensions:

- **Time:** Year, Quarter, Month
- **Reporting Entity:** CUI of the institution submitting the report
- **Main Creditor:** CUI of the supervising entity (if applicable)
- **Account Category:** Income (`vn`) or Expense (`ch`)
- **Classifications:** Functional Code (COFOG) and Economic Code
- **Sources:** Funding Source ID (State, Local, EU) and Budget Sector ID
- **Report Type:** Detailed, Secondary Aggregated, or Principal Aggregated
- **Expense Type:** Development vs. Operational
- **Amounts:** YTD, Monthly, and Quarterly values

---

## 4. Database Strategy

### 4.1 Schema Design Principles

- **Partitioning:** `ExecutionLineItems` is partitioned by **Year** (Range) and sub-partitioned by **Report Type** (List) for query performance.
- **Materialized Views:** Pre-aggregated views (`mv_summary_monthly`, `mv_summary_quarterly`, `mv_summary_annual`) are used to speed up high-level dashboard queries.
- **Text Search:** `pg_trgm` (trigram) indexes are used for fuzzy search on names (Entities, UATs) and descriptions.
- **Money:** Uses `NUMERIC(18,2)` to ensure precision (no floats).

### 4.2 Key Tables

| Table                | Purpose                                       | Partitioning |
| :------------------- | :-------------------------------------------- | :----------- |
| `ExecutionLineItems` | Core fact table (budget lines)                | Year / Type  |
| `Entities`           | Institution registry                          | None         |
| `UATs`               | Geographic units (counties, cities, communes) | None         |
| `Reports`            | Metadata for imported files                   | None         |
| `Tags`               | Dynamic labeling system                       | None         |
| `mv_summary_*`       | Materialized views for fast aggregation       | N/A          |

### 4.3 Rollup Strategy

Materialized views (`mv_*`) are the primary source for dashboard totals to avoid scanning the massive `ExecutionLineItems` table for every request.

- **Refresh:** Materialized views are refreshed after significant data ingestion events.
- **Indices:** Views have unique indexes to support fast lookups by Entity/Year.

---

## 5. Ingestion Pipeline

_Note: The ingestion pipeline is managed in a separate repository/system but is integral to the data flow._

### 5.1 Pipeline Stages

```
Acquire → Parse → Validate → Canonicalize → Persist → Refresh Views → Publish Event
```

| Stage            | Responsibility                            |
| :--------------- | :---------------------------------------- |
| **Acquire**      | Fetch source files, store metadata        |
| **Parse**        | Convert format to raw rows                |
| **Validate**     | Check structure, codes, required fields   |
| **Canonicalize** | Normalize codes, attach lineage           |
| **Persist**      | Upsert to fact tables                     |
| **Refresh**      | Refresh Materialized Views                |
| **Publish**      | Emit event for cache invalidation, alerts |

### 5.2 Idempotency

Ingestion is designed to be idempotent. Re-importing the same report updates the existing records (based on report metadata and line item uniqueness) rather than duplicating them.

### 5.3 Processing Model

Relies on reliable job queues (BullMQ) to handle large file processing, with persistence and retries.

---

## 6. API Strategy

### 6.1 Three Transports, One Service Layer

All transports call the same application services:

```
GraphQL  ─┐
          ├──→  Application Services  ──→  Core Logic
REST     ─┤                           ──→  Repositories
          │
MCP      ─┘
```

### 6.2 Transport Purposes

| Transport   | Optimized For                       | Caching                     |
| :---------- | :---------------------------------- | :-------------------------- |
| **GraphQL** | Interactive exploration, dashboards | DataLoader batching         |
| **REST**    | Stable URLs, CDN caching            | ETag, Cache-Control headers |
| **MCP**     | AI agent access                     | Rate limited                |

### 6.3 API Design Rules

- Handlers are thin: parse request → call service → format response
- Business logic is never in handlers
- Each handler maps errors to transport-appropriate format
- Validation happens at the boundary using TypeBox

### 6.4 Extended Error Mapping

| Domain Error    | REST | GraphQL             | MCP           |
| :-------------- | :--- | :------------------ | :------------ |
| NotFound        | 404  | NOT_FOUND extension | isError: true |
| ValidationError | 400  | BAD_USER_INPUT      | isError: true |
| DataUnavailable | 422  | DATA_UNAVAILABLE    | isError: true |

---

## 7. Caching Strategy

### 7.1 Cache Layers

| Layer     | Scope           | TTL    | Invalidation      |
| :-------- | :-------------- | :----- | :---------------- |
| **HTTP**  | REST responses  | 24h    | ETag mismatch     |
| **Redis** | Service results | 1h-24h | Pub/sub on import |

### 7.2 Cache Keys

Cache keys must uniquely identify the data slice. Common parameters used in keys:

- `year`, `quarter`, `month`
- `entity_cui`, `main_creditor_cui`
- `report_type`
- `account_category` (income/expense)
- Filters: `functional_code`, `economic_code`, `funding_source`

Example Key: `summary:year:2024:entity:123456:type:detailed`

### 7.3 Invalidation

- **Triggers:** Ingestion events (new reports loaded), manual administrative actions.
- **Mechanism:**
  - An authenticated internal endpoint (e.g., `/admin/cache/invalidate`) can trigger invalidation patterns.
  - Invalidation can be broad (flush all) or targeted (by entity or year) depending on the ingestion scope.

---

## 8. Observability

### 8.1 Logging

- Use structured logging (Pino)
- Include correlation IDs across requests
- Log at boundaries (request in, response out, job start/end)
- Don't log sensitive data

### 8.2 Metrics

Essential metrics:

- Request latency by endpoint
- Error rate by type
- Queue depth and processing time
- Cache hit ratio

### 8.3 Health Checks

- `/health/live` — basic liveness (is the process running?)
- `/health/ready` — readiness (can accept traffic? DB connected?)

---

## 9. Deployment

### 9.1 Workloads

| Service | Scaling                  | Notes     |
| :------ | :----------------------- | :-------- |
| **API** | Horizontal by CPU/memory | Stateless |

### 9.2 Configuration

- All config via environment variables
- Validate config at startup (fail fast)
- No secrets in code or config files

### 9.3 Database Migrations

- Run migrations as a separate step before deployment
- Migrations are forward-only (no rollbacks in production)
- Test migrations against production-like data

---

## 10. Key Decisions Summary

| Decision             | Choice                             | Rationale                   |
| :------------------- | :--------------------------------- | :-------------------------- |
| Architecture pattern | Functional Core / Imperative Shell | Testability, simplicity     |
| Code organization    | Vertical slices                    | Feature cohesion            |
| Error handling       | Result types (neverthrow)          | Explicit error flow         |
| Financial math       | decimal.js                         | Precision required          |
| Database             | PostgreSQL + Kysely                | Type safety, no ORM bloat   |
| Partitioning         | Year + Report Type                 | Query performance           |
| API                  | GraphQL + REST + MCP               | Different access patterns   |
| Caching              | Redis + HTTP headers               | Multi-layer for performance |
| Queue                | BullMQ                             | Reliable job processing     |
