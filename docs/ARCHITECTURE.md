# Transparenta.eu — Technical Specification

## Architecture Reference Document v1.0

---

## 1. Introduction

### 1.1 Purpose

This document defines the architectural decisions, patterns, and standards for the Transparenta.eu platform. It serves as the authoritative reference for technical decisions, prioritizing simplicity, testability, and maintainability.

### 1.2 Design Principles

| Principle | What It Means |
|:----------|:--------------|
| **Simplicity** | Prefer straightforward solutions. Avoid abstractions until they're clearly needed. |
| **Testability** | Business logic must be testable without databases, networks, or external services. |
| **Explicitness** | Make errors, dependencies, and data flow visible. No hidden magic. |
| **Reliability** | Financial data requires precision and traceability. Every output must be reproducible. |

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

| Purpose | Technology | Why |
|:--------|:-----------|:----|
| Package Manager | pnpm | Fast, deterministic, secure package management |
| Runtime | Node.js LTS | Stable, excellent async I/O, large ecosystem |
| Language | TypeScript (strict mode) | Type safety across the entire stack |
| Framework | Fastify | Fast, low overhead, excellent plugin system |
| Database | PostgreSQL 16+ | Robust NUMERIC types, partitioning, mature tooling |
| Query Builder | Kysely | Type-safe SQL, no ORM overhead |
| Validation | TypeBox | JSON Schema with TypeScript inference |
| Queue | BullMQ + Redis | Reliable job processing |
| Cache | Redis | Query caching, pub/sub for invalidation |

### 2.2 Critical Libraries

| Purpose | Library | Why |
|:--------|:--------|:----|
| Decimal Math | decimal.js | **Mandatory** for financial calculations |
| Error Handling | neverthrow | Explicit Result types, no thrown exceptions in business logic |
| GraphQL | Mercurius | Native Fastify integration, performant |
| MCP | @modelcontextprotocol/sdk | Standard protocol for AI agent access |

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

| Layer | Responsibility | Rules |
|:------|:---------------|:------|
| **Core** | Business logic, domain rules, calculations | No I/O. Pure functions. Returns Result types. |
| **Shell/Repo** | Database access | Converts DB types ↔ Domain types. SQL lives here. |
| **Shell/API** | HTTP/GraphQL/MCP handlers | Request parsing, response formatting, error mapping. |
| **Shell/Workers** | Background job processing | Queue consumption, orchestration. |

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
│   ├── repo.ts        # Database operations
│   ├── api.graphql.ts # GraphQL resolvers (if applicable)
│   ├── api.rest.ts    # REST handlers (if applicable)
│   └── worker.ts      # Queue workers (if applicable)
└── index.ts           # Public exports
```

### 4.2 What Goes Where

| File | Contains | Does NOT Contain |
|:-----|:---------|:-----------------|
| `core/types.ts` | Domain types, TypeBox schemas, enums | Database types, API DTOs |
| `core/logic.ts` | Business rules, calculations, validations | Database calls, HTTP requests |
| `core/errors.ts` | Domain error types (discriminated unions) | Infrastructure errors |
| `shell/repo.ts` | Kysely queries, type conversions | Business logic |
| `shell/api.*.ts` | Request handling, response mapping | Business logic, raw SQL |

### 4.3 Dependency Rules

```
api.*.ts  ──→  core/logic.ts  ←──  repo.ts
    │              │                  │
    │              ▼                  │
    │         core/types.ts           │
    │              ▲                  │
    └──────────────┴──────────────────┘
```

- **Core has no dependencies** on Shell
- **Shell depends on Core** for types and logic
- **Repos return domain types**, not raw DB rows
- **APIs call Core functions**, not repos directly (for complex operations)

---

## 5. Error Handling

### 5.1 Result Pattern

Business logic uses `Result<T, E>` from neverthrow. No thrown exceptions in the Core.

**Domain errors are explicit:**

- Define error types as discriminated unions
- Functions declare what errors they can return
- Callers must handle all error cases

**When to use Result vs throw:**

| Situation | Approach |
|:----------|:---------|
| Business rule violation | Return `Result.err()` |
| Expected failure (not found, invalid input) | Return `Result.err()` |
| Programmer error (bug) | Throw |
| Infrastructure failure | Throw (caught at shell boundary) |

### 5.2 Error Mapping

Each transport maps domain errors to its format:

| Domain Error | REST | GraphQL | MCP |
|:-------------|:-----|:--------|:----|
| NotFound | 404 | NOT_FOUND extension | isError: true |
| ValidationError | 400 | BAD_USER_INPUT | isError: true |
| DataUnavailable | 422 | DATA_UNAVAILABLE | isError: true |

---

## 6. Data Model

### 6.1 Core Entities

// TODO: this needs to be updated based on the database schema

| Entity | Description | Key Field |
|:-------|:------------|:----------|
| **Entity** | Public institution | CUI (fiscal code) |
| **UAT** | Administrative territorial unit | SIRUTA code |
| **Classification** | Budget category (Functional/Economic) | Hierarchical code |
| **ExecutionLineItem** | Single budget line item | Composite (entity + period + codes) |
| **Dataset** | Macro indicator time series | Dataset key + period |

### 6.2 ExecutionLineItem Dimensions

Each ExecutionLineItem record has these dimensions:
// TODO: update this based on the database schema

- **Time:** Year, Quarter, Month
- **Entity:** CUI of reporting institution
- **Flow:** Income or Expense
- **Functional Code:** What purpose (COFOG hierarchy)
- **Economic Code:** What type of transaction
- **Funding Source:** State, Local, EU, etc.
- **Report Type:** Detailed, Secondary Aggregated, Principal Aggregated

---
// TODO: update this based on the database schema

## 7. Database Strategy

### 7.1 Schema Design Principles

- **Facts are partitioned by year** for query performance
- **Hierarchies use closure tables** for efficient ancestor/descendant queries
- **Lineage is preserved** (batch ID, source document, row hash)
- **Money uses NUMERIC(18,2)** never FLOAT

### 7.2 Key Tables

| Table | Purpose | Partitioning |
|:------|:--------|:-------------|
| `budget_facts` | Core fact table | By year |
| `entities` | Institution registry | None |
| `uats` | Geographic units | None |
| `classification_closure` | Hierarchy relationships | None |
| `import_batches` | Ingestion lineage | None |
| `rollups_*` | Pre-aggregated summaries | By scope |

### 7.3 Rollup Strategy

Pre-compute common aggregations to avoid full table scans:

- National totals by month/year
- Entity summaries by year
- UAT/County summaries

**Rollups are projections, not source of truth.** They can be rebuilt from facts.

---
// TODO: this is done in a different repo. Can be integrated at a later stage.

## 8. Ingestion Pipeline

### 8.1 Pipeline Stages

```
Acquire → Parse → Validate → Canonicalize → Persist → Refresh Rollups → Publish Event
```

| Stage | Responsibility |
|:------|:---------------|
| **Acquire** | Fetch source files, store metadata |
| **Parse** | Convert format to raw rows |
| **Validate** | Check structure, codes, required fields |
| **Canonicalize** | Normalize codes, attach lineage |
| **Persist** | Upsert to fact tables |
| **Refresh** | Update affected rollups |
| **Publish** | Emit event for cache invalidation, alerts |

### 8.2 Idempotency

Ingestion is idempotent: re-running the same source produces the same result.

- Each import batch has a unique ID
- Each row has a stable hash
- Upsert logic based on natural key + report type

### 8.3 Processing Model

Use BullMQ for reliable job processing:

- Jobs are persisted (survive restarts)
- Failed jobs are retried with backoff
- Concurrency is controlled per worker

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

| Transport | Optimized For | Caching |
|:----------|:--------------|:--------|
| **GraphQL** | Interactive exploration, dashboards | DataLoader batching |
| **REST** | Stable URLs, CDN caching | ETag, Cache-Control headers |
| **MCP** | AI agent access | Rate limited |

### 9.3 API Design Rules

- Handlers are thin: parse request → call service → format response
- Business logic is never in handlers
- Each handler maps errors to transport-appropriate format
- Validation happens at the boundary using TypeBox

---

## 10. Caching Strategy

### 10.1 Cache Layers

// TODO: update this. The caching is using some input params, like the filters to generate a key.

| Layer | Scope | TTL | Invalidation |
|:------|:------|:----|:-------------|
| **HTTP** | REST responses | 24h | ETag mismatch |
| **Redis** | Service results | 1h | Pub/sub on import |

### 10.2 Cache Keys

Keys include all parameters that affect the result:

- Entity/UAT identifiers
- Time range
- Normalization options (currency, per-capita)

### 10.3 Invalidation

// We need to create an endpoint in the app that is protected and is used to invalidate the cache. This can be triggered by a cron job or manually when new data is added.
We can have granular, based on the cache prefix.

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

| Test Type | What | How |
|:----------|:-----|:----|
| **Unit** | Core functions, business rules | Direct function calls, no mocks needed |
| **Integration** | Repositories, DB queries | Dockerized Postgres, real SQL |
| **E2E** | Full request/response | HTTP calls to running server |

### 11.3 Testing Rules

- **Core functions need no mocks** (they're pure)
- **Repositories test against real Postgres** (use testcontainers)
- **Don't mock what you don't own** (test the integration)
- **Golden file tests** for complex transformations

### 11.4 What Makes Code Testable

| Practice | Why It Helps |
|:---------|:-------------|
| Pure functions | Test with inputs/outputs, no setup |
| Explicit dependencies | Easy to substitute in tests |
| Result types | Error paths are explicit |
| Small functions | Fewer test cases per function |

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

| Thing | Convention | Example |
|:------|:-----------|:--------|
| Files | kebab-case | `budget-summary.ts` |
| Types/Interfaces | PascalCase | `BudgetEntry` |
| Functions | camelCase | `calculateTotal` |
| Constants | UPPER_SNAKE | `MAX_BATCH_SIZE` |
| Database tables | snake_case | `budget_facts` |

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

| Service | Scaling | Notes |
|:--------|:--------|:------|
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

| Decision | Choice | Rationale |
|:---------|:-------|:----------|
| Architecture pattern | Functional Core / Imperative Shell | Testability, simplicity |
| Code organization | Vertical slices | Feature cohesion |
| Error handling | Result types (neverthrow) | Explicit error flow |
| Financial math | decimal.js | Precision required |
| Database | PostgreSQL + Kysely | Type safety, mature tooling |
| API framework | Fastify | Performance, plugin system |
| Job processing | BullMQ | Reliability, Redis-based |
| Multi-protocol | Shared service layer | No logic duplication |

---

## 17. What This Architecture Avoids

| Anti-pattern | Why We Avoid It |
|:-------------|:----------------|
| Business logic in handlers | Untestable, duplicated |
| Business logic in SQL | Hard to test, hidden |
| Thrown exceptions for control flow | Unclear error paths |
| Deep abstraction layers | Complexity without benefit |
| Magic/implicit behavior | Hard to debug and understand |
| Floating point for money | Precision errors |

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
