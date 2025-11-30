# Transparenta.eu — Technical Specification

## Architecture Reference Document v1.0

---

## 1. Introduction

### 1.1 Purpose

This document defines the architectural decisions, patterns, and standards for the Transparenta.eu platform. It serves as the authoritative reference for technical decisions, prioritizing simplicity, testability, and maintainability.

### 1.2 Design Principles

| Principle        | What It Means                                                                          |
| :--------------- | :------------------------------------------------------------------------------------- |
| **Simplicity**   | Prefer straightforward solutions. Avoid abstractions until they're clearly needed.     |
| **Testability**  | Business logic must be testable without databases, networks, or external services.     |
| **Explicitness** | Make errors, dependencies, and data flow visible. No hidden magic.                     |
| **Reliability**  | Financial data requires precision and traceability. Every output must be reproducible. |

### 1.3 Scope

The platform ingests Romanian public budget data from 13,000+ institutions, normalizes it, and serves analytics through multiple interfaces. Core capabilities:

- Data ingestion and validation pipeline
- Budget execution analytics and aggregation
- Multi-protocol API (GraphQL, REST, MCP)
- Search across entities and classifications
- Alerting on budget thresholds

---

## 2. Technology Stack

### 2.1 Core Technologies

| Purpose         | Technology               | Why                                                |
| :-------------- | :----------------------- | :------------------------------------------------- |
| Package Manager | pnpm                     | Fast, deterministic, secure package management     |
| Runtime         | Node.js LTS              | Stable, excellent async I/O, large ecosystem       |
| Language        | TypeScript (strict mode) | Type safety across the entire stack                |
| Framework       | Fastify                  | Fast, low overhead, excellent plugin system        |
| Database        | PostgreSQL 16+           | Robust NUMERIC types, partitioning, mature tooling |
| Query Builder   | Kysely                   | Type-safe SQL, no ORM overhead                     |
| Validation      | TypeBox                  | JSON Schema with TypeScript inference              |
| Queue           | BullMQ + Redis           | Reliable job processing                            |
| Cache           | Redis                    | Query caching, pub/sub for invalidation            |

### 2.2 Critical Libraries

| Purpose        | Library                   | Why                                                           |
| :------------- | :------------------------ | :------------------------------------------------------------ |
| Decimal Math   | decimal.js                | **Mandatory** for financial calculations                      |
| Error Handling | neverthrow                | Explicit Result types, no thrown exceptions in business logic |
| GraphQL        | Mercurius                 | Native Fastify integration, performant                        |
| MCP            | @modelcontextprotocol/sdk | Standard protocol for AI agent access                         |

### 2.3 The "No Float" Rule

JavaScript `number` (IEEE 754 float) is **forbidden** for monetary values. Use:

- PostgreSQL `DECIMAL` in the database
- `decimal.js` in application code
- String serialization in JSON APIs

---

## 3. Architecture Overview

### 3.1 Functional Core / Imperative Shell

This is the foundational pattern. All business logic lives in pure functions. All I/O lives in the shell.

```
┌────────────────────────────────────────────────────────────┐
│                    IMPERATIVE SHELL                        │
│                                                            │
│   HTTP Handlers, GraphQL Resolvers, Queue Workers,         │
│   Database Queries, Cache Operations, External APIs        │
│                                                            │
│   ┌────────────────────────────────────────────────────┐   │
│   │                 FUNCTIONAL CORE                    │   │
│   │                                                    │   │
│   │   Pure functions, domain types, business rules     │   │
│   │   No I/O, no side effects, fully testable          │   │
│   │                                                    │   │
│   │   Input → Output (deterministic)                   │   │
│   └────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

**Functional Core:**

- Pure functions only
- Takes data, returns data (or Result types)
- No database, no HTTP, no file system
- 100% unit testable with simple inputs/outputs

**Imperative Shell:**

- Handles all I/O operations
- Calls Core functions with fetched data
- Maps results to transport formats (HTTP, GraphQL, etc.)
- Thin layer—minimal logic

### 3.2 Vertical Slices

Code is organized by business capability, not technical layer. Each feature owns its entire stack.

```
modules/
├── catalog/       # Entities, UATs, classifications
├── analytics/     # Query and aggregation
├── search/        # Unified search
└── alerts/        # Threshold monitoring
```

**Why vertical slices:**

- Related code lives together
- Features can be developed independently
- Easier to understand a complete feature
- Simpler dependency management

### 3.3 Layer Responsibilities

| Layer             | Responsibility                             | Rules                                                |
| :---------------- | :----------------------------------------- | :--------------------------------------------------- |
| **Core**          | Business logic, domain rules, calculations | No I/O. Pure functions. Returns Result types.        |
| **Shell/Repo**    | Database access                            | Converts DB types ↔ Domain types. SQL lives here.    |
| **Shell/API**     | HTTP/GraphQL/MCP handlers                  | Request parsing, response formatting, error mapping. |
| **Shell/Workers** | Background job processing                  | Queue consumption, orchestration.                    |

---

## 4. Module Structure

### 4.1 Standard Module Layout

Every module follows the same structure:

```
modules/{feature}/
├── core/
│   ├── types.ts       # Domain types and schemas
│   ├── logic.ts       # Pure business functions
│   └── errors.ts      # Domain-specific errors
├── shell/
│   ├── graphql/       # GraphQL resolvers
│   ├── rest/          # REST handlers
│   └── repo/        # Database operations
└── index.ts           # Public exports
```

### 4.2 What Goes Where

| File             | Contains                                  | Does NOT Contain                                  |
| :--------------- | :---------------------------------------- | :------------------------------------------------ |
| `core/types.ts`  | Domain types, TypeBox schemas, enums      | Database types, API DTOs                          |
| `core/logic.ts`  | Business rules, calculations, validations | Database calls, HTTP requests                     |
| `core/errors.ts` | Domain error types (discriminated unions) | Infrastructure errors                             |
| `shell/repo/`    | Kysely queries, type conversions          | Business logic                                    |
| `shell/graphql/` | GraphQL resolvers                         | Business logic                                    |
| `shell/rest/`    | REST handlers                             | Business logic                                    |
| `index.ts`       | Public exports                            | Business logic, database operations, API handlers |

### 4.3 Dependency Rules

```
    ┌──────────────────┐
    │      SHELL       │
    │  (API, Repo)     │
    └────────┬─────────┘
             │ Calls / Uses Types
             ▼
    ┌──────────────────┐
    │       CORE       │
    │  (Logic, Types)  │
    └──────────────────┘
```

- **Core has NO dependencies** on Shell or infrastructure.
- **Shell depends on Core** for types and business logic functions.
- **API (Shell)** orchestrates: fetches data from Repo (Shell), passes it to Logic (Core), maps result to response.
- **Repo (Shell)** returns domain types defined in Core, but does not call business logic.

---

## 5. Error Handling

### 5.1 Result Pattern

Business logic uses `Result<T, E>` from neverthrow. No thrown exceptions in the Core.

**Domain errors are explicit:**

- Define error types as discriminated unions
- Functions declare what errors they can return
- Callers must handle all error cases

**When to use Result vs throw:**

| Situation                                   | Approach                         |
| :------------------------------------------ | :------------------------------- |
| Business rule violation                     | Return `Result.err()`            |
| Expected failure (not found, invalid input) | Return `Result.err()`            |
| Programmer error (bug)                      | Throw                            |
| Infrastructure failure                      | Throw (caught at shell boundary) |

### 5.2 Error Mapping

Each transport maps domain errors to its format:

| Domain Error    | REST | GraphQL             | MCP           |
| :-------------- | :--- | :------------------ | :------------ |
| NotFound        | 404  | NOT_FOUND extension | isError: true |
| ValidationError | 400  | BAD_USER_INPUT      | isError: true |
| DataUnavailable | 422  | DATA_UNAVAILABLE    | isError: true |

---

## 6. Data Model

### 6.1 Core Entities

| Entity                       | Description                                 | Key Field                          |
| :--------------------------- | :------------------------------------------ | :--------------------------------- |
| **Entity**                   | Public institution                          | CUI (fiscal code)                  |
| **UAT**                      | Administrative territorial unit             | UAT Code (SIRUTA / CIF)            |
| **Report**                   | Metadata for imported budget files          | Report ID                          |
| **FunctionalClassification** | COFOG functional code                       | Functional Code                    |
| **EconomicClassification**   | Economic nature code                        | Economic Code                      |
| **ExecutionLineItem**        | Single budget line item                     | Composite (Year + ReportType + ID) |
| **Tag**                      | Arbitrary label for grouping entities/codes | Tag ID                             |

### 6.2 ExecutionLineItem Dimensions

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

## 7. Database Strategy

### 7.1 Schema Design Principles

- **Partitioning:** `ExecutionLineItems` is partitioned by **Year** (Range) and sub-partitioned by **Report Type** (List) for query performance.
- **Materialized Views:** Pre-aggregated views (`mv_summary_monthly`, `mv_summary_quarterly`, `mv_summary_annual`) are used to speed up high-level dashboard queries.
- **Text Search:** `pg_trgm` (trigram) indexes are used for fuzzy search on names (Entities, UATs) and descriptions.
- **Money:** Uses `NUMERIC(18,2)` to ensure precision (no floats).

### 7.2 Key Tables

| Table                | Purpose                                       | Partitioning |
| :------------------- | :-------------------------------------------- | :----------- |
| `ExecutionLineItems` | Core fact table (budget lines)                | Year / Type  |
| `Entities`           | Institution registry                          | None         |
| `UATs`               | Geographic units (counties, cities, communes) | None         |
| `Reports`            | Metadata for imported files                   | None         |
| `Tags`               | Dynamic labeling system                       | None         |
| `mv_summary_*`       | Materialized views for fast aggregation       | N/A          |

### 7.3 Rollup Strategy

Materialized views (`mv_*`) are the primary source for dashboard totals to avoid scanning the massive `ExecutionLineItems` table for every request.

- **Refresh:** Materialized views are refreshed after significant data ingestion events.
- **Indices:** Views have unique indexes to support fast lookups by Entity/Year.

---

## 8. Ingestion Pipeline (External)

_Note: The ingestion pipeline is managed in a separate repository/system but is integral to the data flow._

### 8.1 Pipeline Stages

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

### 8.2 Idempotency

Ingestion is designed to be idempotent. Re-importing the same report updates the existing records (based on report metadata and line item uniqueness) rather than duplicating them.

### 8.3 Processing Model

Relies on reliable job queues (BullMQ) to handle large file processing, with persistence and retries.

---

## 9. API Strategy

### 9.1 Three Transports, One Service Layer

All transports call the same application services:

```
GraphQL  ─┐
          ├──→  Application Services  ──→  Core Logic
REST     ─┤                           ──→  Repositories
          │
MCP      ─┘
```

### 9.2 Transport Purposes

| Transport   | Optimized For                       | Caching                     |
| :---------- | :---------------------------------- | :-------------------------- |
| **GraphQL** | Interactive exploration, dashboards | DataLoader batching         |
| **REST**    | Stable URLs, CDN caching            | ETag, Cache-Control headers |
| **MCP**     | AI agent access                     | Rate limited                |

### 9.3 API Design Rules

- Handlers are thin: parse request → call service → format response
- Business logic is never in handlers
- Each handler maps errors to transport-appropriate format
- Validation happens at the boundary using TypeBox

---

## 10. Caching Strategy

### 10.1 Cache Layers

| Layer     | Scope           | TTL    | Invalidation      |
| :-------- | :-------------- | :----- | :---------------- |
| **HTTP**  | REST responses  | 24h    | ETag mismatch     |
| **Redis** | Service results | 1h-24h | Pub/sub on import |

### 10.2 Cache Keys

Cache keys must uniquely identify the data slice. Common parameters used in keys:

- `year`, `quarter`, `month`
- `entity_cui`, `main_creditor_cui`
- `report_type`
- `account_category` (income/expense)
- Filters: `functional_code`, `economic_code`, `funding_source`

Example Key: `summary:year:2024:entity:123456:type:detailed`

### 10.3 Invalidation

- **Triggers:** Ingestion events (new reports loaded), manual administrative actions.
- **Mechanism:**
  - An authenticated internal endpoint (e.g., `/admin/cache/invalidate`) can trigger invalidation patterns.
  - Invalidation can be broad (flush all) or targeted (by entity or year) depending on the ingestion scope.

---

## 11. Testing Strategy

### 11.1 Test Pyramid

```
        ┌─────────┐
        │   E2E   │   Few: Critical user journeys
       ┌┴─────────┴┐
       │Integration│   Moderate: Repos + real DB
      ┌┴───────────┴┐
      │    Unit     │   Many: Core logic, pure functions
      └─────────────┘
```

### 11.2 What to Test Where

| Test Type       | What                           | How                                    |
| :-------------- | :----------------------------- | :------------------------------------- |
| **Unit**        | Core functions, business rules | Direct function calls, no mocks needed |
| **Integration** | Repositories, DB queries       | Dockerized Postgres, real SQL          |
| **E2E**         | Full request/response          | HTTP calls to running server           |

### 11.3 Testing Rules

- **Core functions need no mocks** (they're pure)
- **Repositories test against real Postgres** (use testcontainers)
- **Don't mock what you don't own** (test the integration)
- **Golden file tests** for complex transformations

### 11.4 What Makes Code Testable

| Practice              | Why It Helps                       |
| :-------------------- | :--------------------------------- |
| Pure functions        | Test with inputs/outputs, no setup |
| Explicit dependencies | Easy to substitute in tests        |
| Result types          | Error paths are explicit           |
| Small functions       | Fewer test cases per function      |

---

## 12. Coding Standards

### 12.1 TypeScript Configuration

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "exactOptionalPropertyTypes": true
  }
}
```

### 12.2 Naming Conventions

| Thing            | Convention  | Example             |
| :--------------- | :---------- | :------------------ |
| Files            | kebab-case  | `budget-summary.ts` |
| Types/Interfaces | PascalCase  | `BudgetEntry`       |
| Functions        | camelCase   | `calculateTotal`    |
| Constants        | UPPER_SNAKE | `MAX_BATCH_SIZE`    |
| Database tables  | snake_case  | `budget_facts`      |

### 12.3 Code Organization Rules

- One concept per file (avoid god files)
- Export only what's needed (explicit public API)
- Group imports: external → internal → relative
- No circular dependencies between modules

### 12.4 Function Design

- Functions do one thing
- Prefer returning values over mutating
- Use descriptive names (verb + noun)
- Keep functions small (< 30 lines as guideline)

---

## 13. Directory Structure

```
/src
├── infra/                    # Shared infrastructure
│   ├── database/
│   │   ├── client.ts        # Kysely instance
│   │   ├── types.ts         # Generated DB types
│   │   └── migrations/      # SQL migrations
│   ├── redis/
│   │   └── client.ts
│   ├── queue/
│   │   └── client.ts
│   └── logging/
│       └── logger.ts
│
├── common/                   # Shared utilities
│   ├── money.ts             # Decimal wrapper
│   ├── result.ts            # Result helpers
│   └── time.ts              # Date utilities
│
├── modules/                  # Feature modules
│   ├── catalog/
│   │   ├── core/
│   │   ├── shell/
│   │   └── index.ts
│   ├── ingestion/
│   ├── analytics/
│   ├── search/
│   └── alerts/
│
├── app.ts                    # Fastify composition
├── api.ts                    # API entry point
```

---

## 14. Observability

### 14.1 Logging

- Use structured logging (Pino)
- Include correlation IDs across requests
- Log at boundaries (request in, response out, job start/end)
- Don't log sensitive data

### 14.2 Metrics

Essential metrics:

- Request latency by endpoint
- Error rate by type
- Queue depth and processing time
- Cache hit ratio

### 14.3 Health Checks

- `/health/live` — basic liveness (is the process running?)
- `/health/ready` — readiness (can accept traffic? DB connected?)

---

## 15. Deployment

### 15.1 Workloads

| Service | Scaling                  | Notes     |
| :------ | :----------------------- | :-------- |
| **API** | Horizontal by CPU/memory | Stateless |

### 15.2 Configuration

- All config via environment variables
- Validate config at startup (fail fast)
- No secrets in code or config files

### 15.3 Database Migrations

- Run migrations as a separate step before deployment
- Migrations are forward-only (no rollbacks in production)
- Test migrations against production-like data

---

## 16. Key Decisions Summary

| Decision             | Choice                             | Rationale                   |
| :------------------- | :--------------------------------- | :-------------------------- |
| Architecture pattern | Functional Core / Imperative Shell | Testability, simplicity     |
| Code organization    | Vertical slices                    | Feature cohesion            |
| Error handling       | Result types (neverthrow)          | Explicit error flow         |
| Financial math       | decimal.js                         | Precision required          |
| Database             | PostgreSQL + Kysely                | Type safety, mature tooling |
| API framework        | Fastify                            | Performance, plugin system  |
| Job processing       | BullMQ                             | Reliability, Redis-based    |
| Multi-protocol       | Shared service layer               | No logic duplication        |

---

## 17. What This Architecture Avoids

| Anti-pattern                       | Why We Avoid It              |
| :--------------------------------- | :--------------------------- |
| Business logic in handlers         | Untestable, duplicated       |
| Business logic in SQL              | Hard to test, hidden         |
| Thrown exceptions for control flow | Unclear error paths          |
| Deep abstraction layers            | Complexity without benefit   |
| Magic/implicit behavior            | Hard to debug and understand |
| Floating point for money           | Precision errors             |

---

## Appendix: Quick Reference

### When Starting a New Feature

1. Create module folder under `modules/`
2. Define types in `core/types.ts`
3. Define errors in `core/errors.ts`
4. Implement logic in `core/logic.ts` (pure functions)
5. Add database operations in `shell/repo.ts`
6. Add API handlers in `shell/api.*.ts`
7. Export public interface in `index.ts`

### When Adding a Business Rule

1. Write it as a pure function in Core
2. Function takes data, returns Result
3. Write unit tests with various inputs
4. Call from Shell with real data

### When Debugging

1. Check structured logs for correlation ID
2. Trace request through handlers → services → repos
3. Core functions are deterministic—same input = same output
4. Check cache if seeing stale data
