# Transparenta.eu — Architecture Specification

## Functional Core / Imperative Shell Reference Document v1.0

---

## 1. Introduction

This specification defines the complete architecture for Transparenta.eu, a platform that ingests Romanian public budget data from 13,000+ institutions, normalizes it, and serves analytics through multiple interfaces.

### 1.1 Design Principles

| Principle        | What It Means                                                                          |
| :--------------- | :------------------------------------------------------------------------------------- |
| **Simplicity**   | Prefer straightforward solutions. Avoid abstractions until clearly needed.             |
| **Testability**  | Business logic must be testable without databases, networks, or external services.     |
| **Explicitness** | Make errors, dependencies, and data flow visible. No hidden magic.                     |
| **Reliability**  | Financial data requires precision and traceability. Every output must be reproducible. |

### 1.2 Technology Stack

| Purpose        | Technology          | Why                                         |
| :------------- | :------------------ | :------------------------------------------ |
| Runtime        | Node.js LTS         | Stable, excellent async I/O                 |
| Language       | TypeScript (strict) | Type safety across entire stack             |
| Framework      | Fastify             | Fast, low overhead, excellent plugin system |
| Database       | PostgreSQL 16+      | NUMERIC types, partitioning, mature tooling |
| Query Builder  | Kysely              | Type-safe SQL, no ORM overhead              |
| Validation     | TypeBox             | JSON Schema with TypeScript inference       |
| Decimal Math   | decimal.js          | Mandatory for financial calculations        |
| Error Handling | neverthrow          | Explicit Result types, no thrown exceptions |
| GraphQL        | Mercurius           | Native Fastify integration                  |

---

## 2. Architecture Pattern: Functional Core / Imperative Shell

### 2.1 The Mental Model

All business logic lives in pure functions (the Core). All I/O operations live in the Shell. Dependencies are passed as arguments to Core functions, making them deterministic and trivially testable.

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

#### Functional Core

- Pure functions only — takes data, returns data (or Result types)
- No I/O: no database, no HTTP, no file system, no `Date.now()`, no `crypto.randomUUID()`
- Dependencies passed as arguments (ports/interfaces)
- 100% unit testable with simple inputs/outputs

#### Imperative Shell

- Handles all I/O: HTTP, GraphQL, database, cache, queues, external APIs
- Calls Core functions with fetched data
- Maps `request → DTO → domain input`, and `domain result → response`
- Thin layer — minimal logic, orchestration only

### 2.2 Layer Responsibilities

| Layer             | Responsibility                             | Rules                                                |
| :---------------- | :----------------------------------------- | :--------------------------------------------------- |
| **Core**          | Business logic, domain rules, calculations | No I/O. Pure functions. Returns Result types.        |
| **Shell/Repo**    | Database access                            | Converts DB types ↔ Domain types. SQL lives here.    |
| **Shell/API**     | HTTP/GraphQL/MCP handlers                  | Request parsing, response formatting, error mapping. |
| **Shell/Workers** | Background job processing                  | Queue consumption, orchestration.                    |

### 2.3 Dependency Flow

Core has NO dependencies on Shell or infrastructure. Shell depends on Core for types and business logic.

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

---

## 3. Folder Structure

### 3.1 Complete Project Layout

```
src/
├── app/                          # Composition root + bootstrap
│   ├── buildApp.ts               # Fastify app composition
│   └── plugins/                  # Fastify plugins
│       ├── database.ts           # Kysely instance
│       ├── graphql.ts            # Mercurius setup
│       ├── redis.ts              # Cache client
│       └── observability.ts      # Logging, metrics
│
├── infra/                        # Shared infrastructure
│   ├── database/
│   │   ├── client.ts             # Kysely instance factory
│   │   ├── types.ts              # Generated DB types (kysely-codegen)
│   │   └── migrations/           # SQL migrations
│   ├── redis/
│   │   └── client.ts
│   └── logging/
│       └── logger.ts             # Pino logger
│
├── common/                       # Shared utilities (pure)
│   ├── money.ts                  # Decimal wrapper
│   ├── result.ts                 # Result helpers
│   ├── time.ts                   # Date utilities
│   └── validation.ts             # Shared validators
│
├── modules/                      # Feature modules (vertical slices)
│   ├── catalog/                  # Entities, UATs, classifications
│   │   ├── core/
│   │   │   ├── types.ts          # Domain types + TypeBox schemas
│   │   │   ├── errors.ts         # Domain errors
│   │   │   ├── ports.ts          # Interfaces (what we need)
│   │   │   └── usecases/
│   │   │       ├── getEntity.ts
│   │   │       ├── getEntity.test.ts
│   │   │       ├── listUATs.ts
│   │   │       └── listUATs.test.ts
│   │   ├── shell/
│   │   │   ├── repo/
│   │   │   │   ├── entity.repo.ts
│   │   │   │   └── uat.repo.ts
│   │   │   ├── rest/
│   │   │   │   ├── routes.ts
│   │   │   │   └── schemas.ts
│   │   │   └── graphql/
│   │   │       ├── resolvers.ts
│   │   │       └── schema.ts
│   │   └── index.ts              # Public exports
│   │
│   ├── analytics/                # Query and aggregation
│   │   ├── core/
│   │   │   ├── types.ts
│   │   │   ├── errors.ts
│   │   │   ├── ports.ts
│   │   │   └── usecases/
│   │   │       ├── getBudgetSummary.ts
│   │   │       ├── getBudgetSummary.test.ts
│   │   │       ├── compareEntities.ts
│   │   │       └── aggregateByClassification.ts
│   │   ├── shell/
│   │   │   ├── repo/
│   │   │   ├── rest/
│   │   │   └── graphql/
│   │   └── index.ts
│   │
│   ├── search/                   # Unified search
│   │   ├── core/
│   │   ├── shell/
│   │   └── index.ts
│   │
│   └── alerts/                   # Threshold monitoring
│       ├── core/
│       ├── shell/
│       └── index.ts
│
├── test/
│   ├── helpers/
│   │   ├── inMemoryRepos.ts      # In-memory repo implementations
│   │   ├── fixtures.ts           # Test data factories
│   │   └── testDeps.ts           # Test dependency bundles
│   ├── integration/              # DB + API tests
│   └── e2e/                      # Full stack tests
│
├── api.ts                        # API entry point
└── server.ts                     # Server startup
```

### 3.2 What Goes Where

| File                 | Contains                                  | Does NOT Contain         |
| :------------------- | :---------------------------------------- | :----------------------- |
| `core/types.ts`      | Domain types, TypeBox schemas, enums      | Database types, API DTOs |
| `core/errors.ts`     | Domain error types (discriminated unions) | Infrastructure errors    |
| `core/ports.ts`      | Interfaces for external dependencies      | Implementations          |
| `core/usecases/*.ts` | Business rules, calculations, validations | Database calls, HTTP     |
| `shell/repo/*.ts`    | Kysely queries, type conversions          | Business logic           |
| `shell/rest/*.ts`    | Fastify routes, request validation        | Business logic           |
| `shell/graphql/*.ts` | Mercurius resolvers, schema               | Business logic           |

---

## 4. Domain Types

All domain types live in `core/types.ts`. They use branded types for compile-time safety and TypeBox for runtime validation.

### 4.1 Entity (Public Institution)

```typescript
// modules/catalog/core/types.ts

import { Type, Static } from '@sinclair/typebox';
import Decimal from 'decimal.js';

// Branded types for compile-time safety
export type CUI = string & { readonly __brand: 'CUI' };
export type UATCode = string & { readonly __brand: 'UATCode' };
export type FunctionalCode = string & { readonly __brand: 'FunctionalCode' };
export type EconomicCode = string & { readonly __brand: 'EconomicCode' };

// Smart constructors
export function createCUI(value: string): CUI {
  return value as CUI;
}

// Domain entity
export interface Entity {
  cui: CUI;
  name: string;
  uatCode: UATCode | null;
  parentCui: CUI | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// TypeBox schema for API validation
export const EntitySchema = Type.Object({
  cui: Type.String({ minLength: 1, maxLength: 20 }),
  name: Type.String({ minLength: 1, maxLength: 500 }),
  uatCode: Type.Union([Type.String(), Type.Null()]),
  parentCui: Type.Union([Type.String(), Type.Null()]),
  isActive: Type.Boolean(),
});

export type EntityInput = Static<typeof EntitySchema>;
```

### 4.2 Execution Line Item (Budget Fact)

```typescript
// modules/analytics/core/types.ts

import Decimal from 'decimal.js';
import { Type, Static } from '@sinclair/typebox';
import { CUI, FunctionalCode, EconomicCode } from '../../catalog/core/types';

export type AccountCategory = 'income' | 'expense';
export type ReportType = 'detailed' | 'secondary' | 'principal';
export type ExpenseType = 'development' | 'operational';

export interface ExecutionLineItem {
  id: string;
  year: number;
  quarter: 1 | 2 | 3 | 4;
  month: number;
  reportingEntityCui: CUI;
  mainCreditorCui: CUI | null;
  accountCategory: AccountCategory;
  functionalCode: FunctionalCode;
  economicCode: EconomicCode;
  fundingSourceId: string;
  budgetSectorId: string;
  reportType: ReportType;
  expenseType: ExpenseType | null;
  // Amounts as Decimal (never float!)
  amountYtd: Decimal;
  amountMonthly: Decimal;
  amountQuarterly: Decimal;
}

// Money type wrapper
export interface Money {
  value: Decimal;
  currency: 'RON';
}

export function createMoney(value: string | number): Money {
  return {
    value: new Decimal(value),
    currency: 'RON',
  };
}

export function addMoney(a: Money, b: Money): Money {
  return {
    value: a.value.plus(b.value),
    currency: 'RON',
  };
}
```

### 4.3 Budget Summary (Aggregated View)

```typescript
export interface BudgetSummary {
  entityCui: CUI;
  entityName: string;
  year: number;
  quarter?: 1 | 2 | 3 | 4;
  month?: number;
  totalIncome: Money;
  totalExpense: Money;
  balance: Money;
  byFunctionalCode: Map<FunctionalCode, Money>;
  byEconomicCode: Map<EconomicCode, Money>;
}
```

---

## 5. Ports (Interfaces)

Ports define what the Core needs without specifying how. They live in `core/ports.ts` and have NO implementation details.

### 5.1 Repository Ports

```typescript
// modules/catalog/core/ports.ts

import { Entity, CUI, UATCode } from './types';
import { Result } from 'neverthrow';

export interface EntityRepo {
  findByCui(cui: CUI): Promise<Entity | null>;
  findByUatCode(uatCode: UATCode): Promise<Entity[]>;
  search(query: string, limit: number): Promise<Entity[]>;
  insert(entity: Entity): Promise<Result<Entity, RepoError>>;
  update(cui: CUI, data: Partial<Entity>): Promise<Result<Entity, RepoError>>;
}

export interface UATRepo {
  findByCode(code: UATCode): Promise<UAT | null>;
  findByCounty(countyCode: string): Promise<UAT[]>;
  listAll(): Promise<UAT[]>;
}

export type RepoError =
  | { type: 'NOT_FOUND'; id: string }
  | { type: 'DUPLICATE'; field: string; value: string }
  | { type: 'CONSTRAINT_VIOLATION'; message: string };
```

### 5.2 Analytics Repository Port

```typescript
// modules/analytics/core/ports.ts

import { CUI, FunctionalCode, EconomicCode } from '../../catalog/core/types';
import { ExecutionLineItem, BudgetSummary, Money, ReportType } from './types';

export interface SummaryFilters {
  year: number;
  quarter?: 1 | 2 | 3 | 4;
  month?: number;
  entityCui?: CUI;
  mainCreditorCui?: CUI;
  reportType?: ReportType;
  functionalCode?: FunctionalCode;
  economicCode?: EconomicCode;
}

export interface AnalyticsRepo {
  getSummary(filters: SummaryFilters): Promise<BudgetSummary | null>;
  getSummaryByEntity(year: number, entityCui: CUI): Promise<BudgetSummary | null>;
  getLineItems(filters: SummaryFilters, pagination: Pagination): Promise<ExecutionLineItem[]>;
  aggregateByFunctionalCode(filters: SummaryFilters): Promise<Map<FunctionalCode, Money>>;
  aggregateByEconomicCode(filters: SummaryFilters): Promise<Map<EconomicCode, Money>>;
  compareEntities(year: number, cuis: CUI[]): Promise<BudgetSummary[]>;
}

export interface Pagination {
  offset: number;
  limit: number;
}
```

### 5.3 Infrastructure Ports

```typescript
// common/ports.ts

// Time port - makes testing deterministic
export interface Clock {
  now(): Date;
  today(): Date; // Date at midnight
}

// ID generation port
export interface IdGen {
  uuid(): string;
}

// Cache port
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  invalidate(pattern: string): Promise<void>;
}

// Logger port (for core, if needed)
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
```

---

## 6. Domain Errors

Domain errors are defined as discriminated unions in `core/errors.ts`. They are explicit, typed, and can be pattern-matched.

### 6.1 Error Types

```typescript
// modules/catalog/core/errors.ts

export type CatalogError =
  | { type: 'ENTITY_NOT_FOUND'; cui: string }
  | { type: 'UAT_NOT_FOUND'; code: string }
  | { type: 'INVALID_CUI'; cui: string; reason: string }
  | { type: 'DUPLICATE_ENTITY'; cui: string };

// Type guard helpers
export function isEntityNotFound(
  err: CatalogError
): err is { type: 'ENTITY_NOT_FOUND'; cui: string } {
  return err.type === 'ENTITY_NOT_FOUND';
}
```

```typescript
// modules/analytics/core/errors.ts

export type AnalyticsError =
  | { type: 'NO_DATA_FOR_PERIOD'; year: number; quarter?: number; month?: number }
  | { type: 'INVALID_DATE_RANGE'; message: string }
  | { type: 'ENTITY_NOT_FOUND'; cui: string }
  | { type: 'CLASSIFICATION_NOT_FOUND'; code: string; codeType: 'functional' | 'economic' };
```

### 6.2 Error Mapping in Shell

Each transport layer maps domain errors to its appropriate format:

| Domain Error         | REST | GraphQL          | MCP           |
| :------------------- | :--- | :--------------- | :------------ |
| `ENTITY_NOT_FOUND`   | 404  | NOT_FOUND        | isError: true |
| `INVALID_CUI`        | 400  | BAD_USER_INPUT   | isError: true |
| `NO_DATA_FOR_PERIOD` | 422  | DATA_UNAVAILABLE | isError: true |
| `DUPLICATE_ENTITY`   | 409  | CONFLICT         | isError: true |

---

## 7. Use-Cases (Pure Business Logic)

Use-cases orchestrate domain logic. All side effects go through ports. They return Result types from neverthrow.

### 7.1 Use-Case Structure

```typescript
// modules/analytics/core/usecases/getBudgetSummary.ts

import { Result, ok, err } from 'neverthrow';
import Decimal from 'decimal.js';
import { BudgetSummary, Money, createMoney, addMoney } from '../types';
import { AnalyticsError } from '../errors';
import { AnalyticsRepo, SummaryFilters } from '../ports';
import { EntityRepo } from '../../../catalog/core/ports';
import { CUI } from '../../../catalog/core/types';

// Define dependencies as an interface
export interface GetBudgetSummaryDeps {
  analyticsRepo: AnalyticsRepo;
  entityRepo: EntityRepo;
}

// Input type
export interface GetBudgetSummaryInput {
  entityCui: string;
  year: number;
  quarter?: 1 | 2 | 3 | 4;
  month?: number;
}

// Pure function with deps as first argument
export async function getBudgetSummary(
  deps: GetBudgetSummaryDeps,
  input: GetBudgetSummaryInput
): Promise<Result<BudgetSummary, AnalyticsError>> {
  // Validate CUI format (pure)
  if (!isValidCUI(input.entityCui)) {
    return err({ type: 'ENTITY_NOT_FOUND', cui: input.entityCui });
  }

  const cui = input.entityCui as CUI;

  // Check entity exists (via port)
  const entity = await deps.entityRepo.findByCui(cui);
  if (!entity) {
    return err({ type: 'ENTITY_NOT_FOUND', cui: input.entityCui });
  }

  // Build filters
  const filters: SummaryFilters = {
    year: input.year,
    quarter: input.quarter,
    month: input.month,
    entityCui: cui,
  };

  // Fetch summary (via port)
  const summary = await deps.analyticsRepo.getSummary(filters);
  if (!summary) {
    return err({
      type: 'NO_DATA_FOR_PERIOD',
      year: input.year,
      quarter: input.quarter,
      month: input.month,
    });
  }

  // Calculate derived values (pure)
  const balance = calculateBalance(summary.totalIncome, summary.totalExpense);

  return ok({
    ...summary,
    entityName: entity.name,
    balance,
  });
}

// Pure helper functions
function isValidCUI(cui: string): boolean {
  return /^\d{1,10}$/.test(cui);
}

function calculateBalance(income: Money, expense: Money): Money {
  return {
    value: income.value.minus(expense.value),
    currency: 'RON',
  };
}
```

### 7.2 Compare Entities Use-Case

```typescript
// modules/analytics/core/usecases/compareEntities.ts

import { Result, ok, err } from 'neverthrow';
import { BudgetSummary } from '../types';
import { AnalyticsError } from '../errors';
import { AnalyticsRepo } from '../ports';
import { EntityRepo } from '../../../catalog/core/ports';
import { CUI } from '../../../catalog/core/types';

export interface CompareEntitiesDeps {
  analyticsRepo: AnalyticsRepo;
  entityRepo: EntityRepo;
}

export interface CompareEntitiesInput {
  cuis: string[];
  year: number;
}

export interface ComparisonResult {
  summaries: BudgetSummary[];
  rankings: {
    byIncome: CUI[];
    byExpense: CUI[];
    byBalance: CUI[];
  };
}

export async function compareEntities(
  deps: CompareEntitiesDeps,
  input: CompareEntitiesInput
): Promise<Result<ComparisonResult, AnalyticsError>> {
  // Validate all CUIs exist
  const validCuis: CUI[] = [];
  for (const cui of input.cuis) {
    const entity = await deps.entityRepo.findByCui(cui as CUI);
    if (!entity) {
      return err({ type: 'ENTITY_NOT_FOUND', cui });
    }
    validCuis.push(cui as CUI);
  }

  // Fetch all summaries
  const summaries = await deps.analyticsRepo.compareEntities(input.year, validCuis);

  if (summaries.length === 0) {
    return err({ type: 'NO_DATA_FOR_PERIOD', year: input.year });
  }

  // Calculate rankings (pure computation)
  const rankings = calculateRankings(summaries);

  return ok({ summaries, rankings });
}

// Pure function - no dependencies
function calculateRankings(summaries: BudgetSummary[]): ComparisonResult['rankings'] {
  const byIncome = [...summaries]
    .sort((a, b) => b.totalIncome.value.minus(a.totalIncome.value).toNumber())
    .map((s) => s.entityCui);

  const byExpense = [...summaries]
    .sort((a, b) => b.totalExpense.value.minus(a.totalExpense.value).toNumber())
    .map((s) => s.entityCui);

  const byBalance = [...summaries]
    .sort((a, b) => b.balance.value.minus(a.balance.value).toNumber())
    .map((s) => s.entityCui);

  return { byIncome, byExpense, byBalance };
}
```

---

## 8. Shell Implementation

### 8.1 Repository Implementation (Kysely)

```typescript
// modules/analytics/shell/repo/analytics.repo.ts

import { Kysely } from 'kysely';
import Decimal from 'decimal.js';
import { Database } from '../../../../infra/database/types';
import { AnalyticsRepo, SummaryFilters, Pagination } from '../../core/ports';
import { ExecutionLineItem, BudgetSummary, Money, createMoney } from '../../core/types';
import { CUI, FunctionalCode, EconomicCode } from '../../../catalog/core/types';

export function createAnalyticsRepo(db: Kysely<Database>): AnalyticsRepo {
  return {
    async getSummary(filters: SummaryFilters): Promise<BudgetSummary | null> {
      let query = db.selectFrom('mv_summary_annual').where('year', '=', filters.year);

      if (filters.entityCui) {
        query = query.where('entity_cui', '=', filters.entityCui);
      }
      if (filters.reportType) {
        query = query.where('report_type', '=', filters.reportType);
      }

      const row = await query
        .select(['entity_cui', 'entity_name', 'year', 'total_income', 'total_expense'])
        .executeTakeFirst();

      if (!row) return null;

      return mapRowToSummary(row);
    },

    async getLineItems(
      filters: SummaryFilters,
      pagination: Pagination
    ): Promise<ExecutionLineItem[]> {
      let query = db.selectFrom('execution_line_items').where('year', '=', filters.year);

      // Apply filters
      if (filters.entityCui) {
        query = query.where('reporting_entity_cui', '=', filters.entityCui);
      }
      if (filters.quarter) {
        query = query.where('quarter', '=', filters.quarter);
      }
      if (filters.functionalCode) {
        query = query.where('functional_code', '=', filters.functionalCode);
      }

      const rows = await query
        .selectAll()
        .offset(pagination.offset)
        .limit(pagination.limit)
        .execute();

      return rows.map(mapRowToLineItem);
    },

    async aggregateByFunctionalCode(filters: SummaryFilters): Promise<Map<FunctionalCode, Money>> {
      const rows = await db
        .selectFrom('execution_line_items')
        .where('year', '=', filters.year)
        .where('account_category', '=', 'expense')
        .groupBy('functional_code')
        .select(['functional_code', db.fn.sum<string>('amount_ytd').as('total')])
        .execute();

      const result = new Map<FunctionalCode, Money>();
      for (const row of rows) {
        result.set(row.functional_code as FunctionalCode, createMoney(row.total));
      }
      return result;
    },

    async aggregateByEconomicCode(filters: SummaryFilters): Promise<Map<EconomicCode, Money>> {
      // Similar implementation
      return new Map();
    },

    async compareEntities(year: number, cuis: CUI[]): Promise<BudgetSummary[]> {
      const rows = await db
        .selectFrom('mv_summary_annual')
        .where('year', '=', year)
        .where('entity_cui', 'in', cuis)
        .selectAll()
        .execute();

      return rows.map(mapRowToSummary);
    },
  };
}

// Mapper functions (convert DB types to domain types)
function mapRowToSummary(row: any): BudgetSummary {
  return {
    entityCui: row.entity_cui as CUI,
    entityName: row.entity_name,
    year: row.year,
    totalIncome: createMoney(row.total_income),
    totalExpense: createMoney(row.total_expense),
    balance: createMoney(new Decimal(row.total_income).minus(row.total_expense).toString()),
    byFunctionalCode: new Map(),
    byEconomicCode: new Map(),
  };
}

function mapRowToLineItem(row: any): ExecutionLineItem {
  return {
    id: row.id,
    year: row.year,
    quarter: row.quarter,
    month: row.month,
    reportingEntityCui: row.reporting_entity_cui as CUI,
    mainCreditorCui: row.main_creditor_cui as CUI | null,
    accountCategory: row.account_category,
    functionalCode: row.functional_code as FunctionalCode,
    economicCode: row.economic_code as EconomicCode,
    fundingSourceId: row.funding_source_id,
    budgetSectorId: row.budget_sector_id,
    reportType: row.report_type,
    expenseType: row.expense_type,
    amountYtd: new Decimal(row.amount_ytd),
    amountMonthly: new Decimal(row.amount_monthly),
    amountQuarterly: new Decimal(row.amount_quarterly),
  };
}
```

### 8.2 REST Routes

```typescript
// modules/analytics/shell/rest/routes.ts

import { FastifyPluginAsync } from 'fastify';
import { getBudgetSummary } from '../../core/usecases/getBudgetSummary';
import { compareEntities } from '../../core/usecases/compareEntities';
import { GetSummaryParamsSchema, GetSummaryQuerySchema, CompareBodySchema } from './schemas';
import { mapErrorToResponse } from './errorMapper';

export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  // Dependencies from app context
  const deps = {
    analyticsRepo: app.repos.analytics,
    entityRepo: app.repos.entity,
  };

  // GET /api/v1/entities/:cui/summary
  app.get<{
    Params: { cui: string };
    Querystring: { year: number; quarter?: number; month?: number };
  }>(
    '/entities/:cui/summary',
    {
      schema: {
        params: GetSummaryParamsSchema,
        querystring: GetSummaryQuerySchema,
      },
    },
    async (request, reply) => {
      const result = await getBudgetSummary(deps, {
        entityCui: request.params.cui,
        year: request.query.year,
        quarter: request.query.quarter as 1 | 2 | 3 | 4 | undefined,
        month: request.query.month,
      });

      if (result.isErr()) {
        const { status, body } = mapErrorToResponse(result.error);
        return reply.status(status).send(body);
      }

      // Map domain to DTO (serialize Decimal to string)
      return reply.send(serializeSummary(result.value));
    }
  );

  // POST /api/v1/compare
  app.post<{
    Body: { cuis: string[]; year: number };
  }>(
    '/compare',
    {
      schema: { body: CompareBodySchema },
    },
    async (request, reply) => {
      const result = await compareEntities(deps, request.body);

      if (result.isErr()) {
        const { status, body } = mapErrorToResponse(result.error);
        return reply.status(status).send(body);
      }

      return reply.send(serializeComparison(result.value));
    }
  );
};

// Serializers (Decimal → string for JSON)
function serializeSummary(summary: BudgetSummary) {
  return {
    entityCui: summary.entityCui,
    entityName: summary.entityName,
    year: summary.year,
    quarter: summary.quarter,
    month: summary.month,
    totalIncome: summary.totalIncome.value.toString(),
    totalExpense: summary.totalExpense.value.toString(),
    balance: summary.balance.value.toString(),
    currency: 'RON',
  };
}
```

### 8.3 Error Mapper

```typescript
// modules/analytics/shell/rest/errorMapper.ts

import { AnalyticsError } from '../../core/errors';

interface ErrorResponse {
  status: number;
  body: { error: string; code: string; details?: unknown };
}

export function mapErrorToResponse(error: AnalyticsError): ErrorResponse {
  switch (error.type) {
    case 'ENTITY_NOT_FOUND':
      return {
        status: 404,
        body: {
          error: `Entity not found: ${error.cui}`,
          code: 'ENTITY_NOT_FOUND',
        },
      };

    case 'NO_DATA_FOR_PERIOD':
      return {
        status: 422,
        body: {
          error: 'No data available for the specified period',
          code: 'NO_DATA_FOR_PERIOD',
          details: {
            year: error.year,
            quarter: error.quarter,
            month: error.month,
          },
        },
      };

    case 'INVALID_DATE_RANGE':
      return {
        status: 400,
        body: {
          error: error.message,
          code: 'INVALID_DATE_RANGE',
        },
      };

    case 'CLASSIFICATION_NOT_FOUND':
      return {
        status: 404,
        body: {
          error: `Classification not found: ${error.code}`,
          code: 'CLASSIFICATION_NOT_FOUND',
          details: { codeType: error.codeType },
        },
      };

    default:
      const _exhaustive: never = error;
      return {
        status: 500,
        body: { error: 'Internal server error', code: 'INTERNAL_ERROR' },
      };
  }
}
```

### 8.4 GraphQL Resolvers

```typescript
// modules/analytics/shell/graphql/resolvers.ts

import { getBudgetSummary, GetBudgetSummaryDeps } from '../../core/usecases/getBudgetSummary';
import { compareEntities, CompareEntitiesDeps } from '../../core/usecases/compareEntities';
import { GraphQLContext } from '../../../../app/plugins/graphql';

// Factory pattern - deps injected at composition time
export function makeAnalyticsResolvers(deps: GetBudgetSummaryDeps & CompareEntitiesDeps) {
  return {
    Query: {
      budgetSummary: async (
        _: unknown,
        args: { cui: string; year: number; quarter?: number; month?: number }
      ) => {
        const result = await getBudgetSummary(deps, {
          entityCui: args.cui,
          year: args.year,
          quarter: args.quarter as 1 | 2 | 3 | 4 | undefined,
          month: args.month,
        });

        if (result.isErr()) {
          throw mapToGraphQLError(result.error);
        }

        return serializeSummary(result.value);
      },

      compareEntities: async (_: unknown, args: { cuis: string[]; year: number }) => {
        const result = await compareEntities(deps, args);

        if (result.isErr()) {
          throw mapToGraphQLError(result.error);
        }

        return serializeComparison(result.value);
      },
    },
  };
}
```

---

## 9. Composition Root

The composition root is the only place that reads config, creates real clients, and wires modules together.

```typescript
// app/buildApp.ts

import Fastify, { FastifyInstance } from 'fastify';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import Redis from 'ioredis';

import { Database } from '../infra/database/types';
import { createEntityRepo } from '../modules/catalog/shell/repo/entity.repo';
import { createUATRepo } from '../modules/catalog/shell/repo/uat.repo';
import { createAnalyticsRepo } from '../modules/analytics/shell/repo/analytics.repo';
import { catalogRoutes } from '../modules/catalog/shell/rest/routes';
import { analyticsRoutes } from '../modules/analytics/shell/rest/routes';
import { searchRoutes } from '../modules/search/shell/rest/routes';
import { makeCatalogResolvers } from '../modules/catalog/shell/graphql/resolvers';
import { makeAnalyticsResolvers } from '../modules/analytics/shell/graphql/resolvers';
import { createClock, createIdGen } from '../common/infra';

// Type augmentation for Fastify
declare module 'fastify' {
  interface FastifyInstance {
    repos: {
      entity: EntityRepo;
      uat: UATRepo;
      analytics: AnalyticsRepo;
    };
    cache: Cache;
    clock: Clock;
    idGen: IdGen;
  }
}

export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
  });

  // Infrastructure
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
  const redis = new Redis(config.redisUrl);

  // Create repositories (adapters)
  const entityRepo = createEntityRepo(db);
  const uatRepo = createUATRepo(db);
  const analyticsRepo = createAnalyticsRepo(db);

  // Create infrastructure adapters
  const cache = createRedisCache(redis);
  const clock = createClock();
  const idGen = createIdGen();

  // Decorate Fastify with dependencies
  app.decorate('repos', { entity: entityRepo, uat: uatRepo, analytics: analyticsRepo });
  app.decorate('cache', cache);
  app.decorate('clock', clock);
  app.decorate('idGen', idGen);

  // Register REST routes
  app.register(catalogRoutes, { prefix: '/api/v1' });
  app.register(analyticsRoutes, { prefix: '/api/v1' });
  app.register(searchRoutes, { prefix: '/api/v1' });

  // Register GraphQL (Mercurius)
  await app.register(import('mercurius'), {
    schema: mergedSchema,
    resolvers: {
      ...makeCatalogResolvers({ entityRepo, uatRepo }),
      ...makeAnalyticsResolvers({ analyticsRepo, entityRepo }),
    },
  });

  // Health checks
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await pool.query('SELECT 1');
    await redis.ping();
    return { status: 'ready' };
  });

  // Graceful shutdown
  app.addHook('onClose', async () => {
    await db.destroy();
    await redis.quit();
  });

  return app;
}
```

---

## 10. Testing Strategy

### 10.1 Testing Pyramid

Unit tests (Core) form the base—they're fast and cover business logic. Integration tests verify database operations. E2E tests cover critical user journeys only.

| Test Type                | What                                         | How                                     |
| :----------------------- | :------------------------------------------- | :-------------------------------------- |
| **Unit (70-80%)**        | Core functions, business rules, calculations | Direct function calls, no mocks needed  |
| **Integration (15-25%)** | Repositories, DB queries, API routes         | Testcontainers Postgres, Fastify inject |
| **E2E (5-10%)**          | Critical user journeys                       | HTTP calls to running server            |

### 10.2 In-Memory Repository for Testing

```typescript
// test/helpers/inMemoryRepos.ts

import Decimal from 'decimal.js';
import { AnalyticsRepo, SummaryFilters, Pagination } from '../../modules/analytics/core/ports';
import { BudgetSummary, ExecutionLineItem, createMoney } from '../../modules/analytics/core/types';
import { CUI, FunctionalCode, EconomicCode } from '../../modules/catalog/core/types';

export function createInMemoryAnalyticsRepo(
  initialData: { summaries?: BudgetSummary[]; lineItems?: ExecutionLineItem[] } = {}
): AnalyticsRepo & {
  _summaries: BudgetSummary[];
  _lineItems: ExecutionLineItem[];
  _addSummary(s: BudgetSummary): void;
  _clear(): void;
} {
  const summaries = [...(initialData.summaries ?? [])];
  const lineItems = [...(initialData.lineItems ?? [])];

  return {
    _summaries: summaries,
    _lineItems: lineItems,
    _addSummary: (s) => summaries.push(s),
    _clear: () => {
      summaries.length = 0;
      lineItems.length = 0;
    },

    async getSummary(filters: SummaryFilters): Promise<BudgetSummary | null> {
      return (
        summaries.find(
          (s) =>
            s.year === filters.year &&
            (!filters.entityCui || s.entityCui === filters.entityCui) &&
            (!filters.quarter || s.quarter === filters.quarter) &&
            (!filters.month || s.month === filters.month)
        ) ?? null
      );
    },

    async getSummaryByEntity(year: number, entityCui: CUI): Promise<BudgetSummary | null> {
      return summaries.find((s) => s.year === year && s.entityCui === entityCui) ?? null;
    },

    async getLineItems(
      filters: SummaryFilters,
      pagination: Pagination
    ): Promise<ExecutionLineItem[]> {
      return lineItems
        .filter(
          (item) =>
            item.year === filters.year &&
            (!filters.entityCui || item.reportingEntityCui === filters.entityCui)
        )
        .slice(pagination.offset, pagination.offset + pagination.limit);
    },

    async aggregateByFunctionalCode(filters: SummaryFilters): Promise<Map<FunctionalCode, Money>> {
      const result = new Map<FunctionalCode, Money>();
      for (const item of lineItems) {
        if (item.year !== filters.year) continue;
        if (item.accountCategory !== 'expense') continue;

        const existing = result.get(item.functionalCode);
        if (existing) {
          result.set(item.functionalCode, {
            value: existing.value.plus(item.amountYtd),
            currency: 'RON',
          });
        } else {
          result.set(item.functionalCode, createMoney(item.amountYtd.toString()));
        }
      }
      return result;
    },

    async aggregateByEconomicCode(filters: SummaryFilters): Promise<Map<EconomicCode, Money>> {
      return new Map();
    },

    async compareEntities(year: number, cuis: CUI[]): Promise<BudgetSummary[]> {
      return summaries.filter((s) => s.year === year && cuis.includes(s.entityCui));
    },
  };
}
```

### 10.3 Unit Test Example

```typescript
// modules/analytics/core/usecases/getBudgetSummary.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { getBudgetSummary } from './getBudgetSummary';
import { createInMemoryAnalyticsRepo } from '../../../../test/helpers/inMemoryRepos';
import { createInMemoryEntityRepo } from '../../../../test/helpers/inMemoryRepos';
import { createMoney } from '../types';
import { CUI } from '../../../catalog/core/types';

describe('getBudgetSummary', () => {
  const makeDeps = () => {
    const entityRepo = createInMemoryEntityRepo([
      { cui: '12345678' as CUI, name: 'Primăria Sibiu', isActive: true },
    ]);

    const analyticsRepo = createInMemoryAnalyticsRepo({
      summaries: [
        {
          entityCui: '12345678' as CUI,
          entityName: 'Primăria Sibiu',
          year: 2024,
          totalIncome: createMoney('1000000'),
          totalExpense: createMoney('800000'),
          balance: createMoney('200000'),
          byFunctionalCode: new Map(),
          byEconomicCode: new Map(),
        },
      ],
    });

    return { entityRepo, analyticsRepo };
  };

  it('returns budget summary for valid entity and year', async () => {
    const deps = makeDeps();

    const result = await getBudgetSummary(deps, {
      entityCui: '12345678',
      year: 2024,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.entityCui).toBe('12345678');
      expect(result.value.entityName).toBe('Primăria Sibiu');
      expect(result.value.totalIncome.value.toString()).toBe('1000000');
      expect(result.value.balance.value.toString()).toBe('200000');
    }
  });

  it('returns ENTITY_NOT_FOUND for unknown CUI', async () => {
    const deps = makeDeps();

    const result = await getBudgetSummary(deps, {
      entityCui: '99999999',
      year: 2024,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('ENTITY_NOT_FOUND');
      expect(result.error.cui).toBe('99999999');
    }
  });

  it('returns NO_DATA_FOR_PERIOD when no data exists', async () => {
    const deps = makeDeps();

    const result = await getBudgetSummary(deps, {
      entityCui: '12345678',
      year: 2020, // No data for this year
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('NO_DATA_FOR_PERIOD');
      expect(result.error.year).toBe(2020);
    }
  });

  it('calculates balance correctly', async () => {
    const deps = makeDeps();

    const result = await getBudgetSummary(deps, {
      entityCui: '12345678',
      year: 2024,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Balance = Income - Expense = 1000000 - 800000 = 200000
      expect(result.value.balance.value.toString()).toBe('200000');
    }
  });
});
```

### 10.4 Integration Test Example

```typescript
// modules/analytics/shell/rest/routes.test.ts

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import { analyticsRoutes } from './routes';
import {
  createInMemoryAnalyticsRepo,
  createInMemoryEntityRepo,
} from '../../../../test/helpers/inMemoryRepos';
import { createMoney } from '../../core/types';
import { CUI } from '../../../catalog/core/types';

describe('GET /api/v1/entities/:cui/summary', () => {
  const buildTestApp = async () => {
    const app = Fastify();

    const entityRepo = createInMemoryEntityRepo([
      { cui: '12345678' as CUI, name: 'Test Entity', isActive: true },
    ]);

    const analyticsRepo = createInMemoryAnalyticsRepo({
      summaries: [
        {
          entityCui: '12345678' as CUI,
          entityName: 'Test Entity',
          year: 2024,
          totalIncome: createMoney('500000'),
          totalExpense: createMoney('300000'),
          balance: createMoney('200000'),
          byFunctionalCode: new Map(),
          byEconomicCode: new Map(),
        },
      ],
    });

    app.decorate('repos', { entity: entityRepo, analytics: analyticsRepo });
    await app.register(analyticsRoutes, { prefix: '/api/v1' });

    return app;
  };

  it('returns 200 with summary data', async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/entities/12345678/summary?year=2024',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.entityCui).toBe('12345678');
    expect(body.totalIncome).toBe('500000');
    expect(body.balance).toBe('200000');
    expect(body.currency).toBe('RON');
  });

  it('returns 404 for unknown entity', async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/entities/99999999/summary?year=2024',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('ENTITY_NOT_FOUND');
  });

  it('returns 422 when no data for period', async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/entities/12345678/summary?year=2020',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('NO_DATA_FOR_PERIOD');
  });
});
```

### 10.5 Test Fixtures

```typescript
// test/helpers/fixtures.ts

import Decimal from 'decimal.js';
import { Entity, CUI, UATCode } from '../../modules/catalog/core/types';
import { BudgetSummary, ExecutionLineItem, createMoney } from '../../modules/analytics/core/types';

// Factory functions for test data
export function createTestEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    cui: '12345678' as CUI,
    name: 'Test Entity',
    uatCode: null,
    parentCui: null,
    isActive: true,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

export function createTestSummary(overrides: Partial<BudgetSummary> = {}): BudgetSummary {
  return {
    entityCui: '12345678' as CUI,
    entityName: 'Test Entity',
    year: 2024,
    totalIncome: createMoney('1000000'),
    totalExpense: createMoney('800000'),
    balance: createMoney('200000'),
    byFunctionalCode: new Map(),
    byEconomicCode: new Map(),
    ...overrides,
  };
}

export function createTestLineItem(overrides: Partial<ExecutionLineItem> = {}): ExecutionLineItem {
  return {
    id: 'line-1',
    year: 2024,
    quarter: 1,
    month: 3,
    reportingEntityCui: '12345678' as CUI,
    mainCreditorCui: null,
    accountCategory: 'expense',
    functionalCode: '51.02' as FunctionalCode,
    economicCode: '20.01.01' as EconomicCode,
    fundingSourceId: 'A',
    budgetSectorId: '01',
    reportType: 'detailed',
    expenseType: 'operational',
    amountYtd: new Decimal('100000'),
    amountMonthly: new Decimal('30000'),
    amountQuarterly: new Decimal('100000'),
    ...overrides,
  };
}
```

---

## 11. Practical Rules

### 11.1 Rules That Keep Architecture Clean

1. **No imports from `adapters/` into `core/`** — Only the reverse is allowed.
2. **Edge validation only** — TypeBox schemas live in shell; core assumes typed inputs.
3. **Domain errors are domain concerns** — Mapped to HTTP/GraphQL codes in shell.
4. **Composition root is the only place** that reads env vars, constructs clients, wires modules.
5. **Feature modules over global layers** — Keep related code together.
6. **Ports are interfaces, adapters are implementations** — Core depends only on ports.
7. **Pure functions where possible** — Validation, normalization, calculations have no deps.
8. **Test doubles over mocks** — In-memory repos and fixed clocks are simpler.
9. **No floats for money** — Use Decimal everywhere, NUMERIC in Postgres.
10. **Result types for expected failures** — Thrown exceptions only for bugs.

### 11.2 When Starting a New Feature

1. Create module folder under `modules/`
2. Define domain types in `core/types.ts`
3. Define domain errors in `core/errors.ts`
4. Define ports (interfaces) in `core/ports.ts`
5. Implement use-cases as pure functions in `core/usecases/`
6. Write unit tests alongside use-cases
7. Implement repository adapter in `shell/repo/`
8. Add REST routes in `shell/rest/`
9. Add GraphQL resolvers in `shell/graphql/`
10. Export public interface in `index.ts`

### 11.3 What This Architecture Avoids

| Anti-pattern                       | Why We Avoid It                          |
| :--------------------------------- | :--------------------------------------- |
| Business logic in handlers         | Untestable, duplicated across transports |
| Business logic in SQL              | Hard to test, hidden from view           |
| Thrown exceptions for control flow | Unclear error paths, easy to miss        |
| Deep abstraction layers            | Complexity without benefit               |
| Magic/implicit behavior            | Hard to debug and understand             |
| Floating point for money           | Precision errors in financial data       |
| Mocking libraries in tests         | Brittle tests, implementation coupling   |

---

## 12. Key Decisions Summary

| Decision             | Choice                             | Rationale                  |
| :------------------- | :--------------------------------- | :------------------------- |
| Architecture pattern | Functional Core / Imperative Shell | Testability, simplicity    |
| Code organization    | Vertical slices (feature modules)  | Feature cohesion           |
| Error handling       | Result types (neverthrow)          | Explicit error flow        |
| Financial math       | decimal.js + NUMERIC               | Precision required         |
| Database access      | Kysely (type-safe SQL)             | No ORM overhead            |
| API framework        | Fastify                            | Performance, plugin system |
| GraphQL              | Mercurius                          | Native Fastify integration |
| Multi-protocol API   | Shared use-cases layer             | No logic duplication       |
| Testing strategy     | Test doubles (in-memory repos)     | Fast, reliable tests       |
