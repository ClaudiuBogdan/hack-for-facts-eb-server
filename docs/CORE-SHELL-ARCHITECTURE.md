# Functional Core / Imperative Shell — Implementation Guide

## Reference Document v1.0

---

## 1. Overview

This document provides detailed implementation guidance for the **Functional Core / Imperative Shell** pattern as applied in Transparenta.eu. It complements `ARCHITECTURE.md` with concrete code patterns, testing strategies, and practical rules.

### 1.1 The Pattern Origin

The pattern combines:

- **Functional Core, Imperative Shell** (Gary Bernhardt) — Pure logic separated from I/O
- **Hexagonal Architecture** (Ports & Adapters) — Dependencies defined as interfaces

### 1.2 Why This Pattern?

| Benefit             | How It's Achieved                                        |
| :------------------ | :------------------------------------------------------- |
| **Testability**     | Core is 100% unit testable without mocks or I/O          |
| **Reliability**     | Financial calculations are deterministic and isolated    |
| **Maintainability** | Clear boundaries prevent accidental coupling             |
| **Multi-Protocol**  | Same logic serves REST, GraphQL, MCP without duplication |

---

## 2. The Mental Model

```text
┌─────────────────────────────────────────────────────────────┐
│                    IMPERATIVE SHELL                         │
│                                                             │
│   HTTP Handlers, GraphQL Resolvers, Queue Workers,          │
│   Database Queries, Cache Operations, External APIs         │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                 FUNCTIONAL CORE                     │   │
│   │                                                     │   │
│   │   Pure functions, domain types, business rules      │   │
│   │   No I/O, no side effects, fully testable           │   │
│   │                                                     │   │
│   │   Input → Output (deterministic)                    │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 Functional Core

- **Pure functions only** — takes data, returns data (or `Result<T, E>`)
- **No I/O**: no database, no HTTP, no file system, no `Date.now()`, no `crypto.randomUUID()`
- **Dependencies passed as arguments** (ports/interfaces)
- **100% unit testable** with simple inputs/outputs

### 2.2 Imperative Shell

- **Handles all I/O**: HTTP, GraphQL, database, cache, queues, external APIs
- **Calls Core functions** with fetched data
- **Maps** `request → DTO → domain input`, and `domain result → response`
- **Thin layer** — minimal logic, orchestration only

### 2.3 Dependency Flow

Core has **NO dependencies** on Shell or infrastructure. Shell depends on Core for types and business logic.

```text
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

## 3. Layer Responsibilities

| Layer             | Responsibility                             | Rules                                             |
| :---------------- | :----------------------------------------- | :------------------------------------------------ |
| **Core**          | Business logic, domain rules, calculations | No I/O. Pure functions. Returns `Result` types.   |
| **Shell/Repo**    | Database access                            | Converts DB types ↔ Domain types. SQL lives here. |
| **Shell/GraphQL** | GraphQL resolvers & loaders                | Unwrap Results, log errors, throw for GraphQL.    |

---

## 4. Module Structure

### 4.1 Anatomy of a Module

```text
src/modules/{feature}/
├── core/
│   ├── types.ts          # Domain types, constants, TypeBox schemas
│   ├── errors.ts         # Domain errors + constructor functions
│   ├── ports.ts          # Repository interfaces
│   └── usecases/
│       └── {action}.ts   # One file per use-case
│
├── shell/
│   ├── repo/
│   │   └── {entity}-repo.ts      # Kysely implementation
│   └── graphql/
│       ├── resolvers.ts          # Mercurius resolvers
│       ├── schema.ts             # GraphQL SDL
│       └── loaders.ts            # (optional) N+1 prevention
│
└── index.ts              # Public exports
```

### 4.2 What Goes Where

| File                 | Contains                                  | Does NOT Contain         |
| :------------------- | :---------------------------------------- | :----------------------- |
| `core/types.ts`      | Domain types, constants, re-exports       | Database types, API DTOs |
| `core/errors.ts`     | Error interfaces + constructor functions  | HTTP status codes        |
| `core/ports.ts`      | Repository interfaces (all return Result) | Implementations          |
| `core/usecases/*.ts` | Pure functions with deps as first arg     | Database calls, I/O      |
| `shell/repo/*.ts`    | Kysely queries, row→domain mappers        | Business logic           |
| `shell/graphql/*.ts` | Resolvers, schema, loaders                | Business logic           |

---

## 5. Implementation Patterns

### 5.1 Domain Types

Domain types are plain TypeScript interfaces with JSDoc comments. Constants and re-exports are co-located:

```typescript
// core/types.ts

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Default page size for entity listing */
export const DEFAULT_LIMIT = 20;

/** Maximum allowed page size */
export const MAX_LIMIT = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Entity Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entity domain type.
 * Represents a public institution or administrative unit.
 */
export interface Entity {
  /** Unique fiscal identification code (CUI) */
  cui: string;
  /** Entity name */
  name: string;
  /** Entity type classification */
  entity_type: string | null;
  /** Reference to UAT (Administrative Territorial Unit) */
  uat_id: number | null;
  /** Whether this entity is a UAT */
  is_uat: boolean;
  /** Physical address */
  address: string | null;
}

/**
 * Filter options for entity queries.
 */
export interface EntityFilter {
  cui?: string;
  cuis?: string[];
  name?: string;
  entity_type?: string;
  search?: string;
  is_uat?: boolean;
}

/**
 * Paginated connection of entities.
 */
export interface EntityConnection {
  nodes: Entity[];
  pageInfo: {
    totalCount: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}
```

### 5.2 Domain Errors

Errors use `readonly` interfaces with constructor functions for creation:

```typescript
// core/errors.ts

// ─────────────────────────────────────────────────────────────────────────────
// Error Interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface DatabaseError {
  readonly type: 'DatabaseError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export interface TimeoutError {
  readonly type: 'TimeoutError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export interface EntityNotFoundError {
  readonly type: 'EntityNotFoundError';
  readonly message: string;
  readonly cui: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Union
// ─────────────────────────────────────────────────────────────────────────────

export type EntityError = DatabaseError | TimeoutError | EntityNotFoundError;

// ─────────────────────────────────────────────────────────────────────────────
// Error Constructors
// ─────────────────────────────────────────────────────────────────────────────

export const createDatabaseError = (message: string, cause?: unknown): DatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable: true,
  cause,
});

export const createTimeoutError = (message: string, cause?: unknown): TimeoutError => ({
  type: 'TimeoutError',
  message,
  retryable: true,
  cause,
});

export const createEntityNotFoundError = (cui: string): EntityNotFoundError => ({
  type: 'EntityNotFoundError',
  message: `Entity with CUI '${cui}' not found`,
  cui,
});

// ─────────────────────────────────────────────────────────────────────────────
// Type Guards
// ─────────────────────────────────────────────────────────────────────────────

export const isTimeoutError = (cause: unknown): boolean => {
  if (cause instanceof Error) {
    const msg = cause.message.toLowerCase();
    return msg.includes('timeout') || msg.includes('canceling statement');
  }
  return false;
};
```

### 5.3 Ports (Interfaces)

Ports define repository contracts. **All methods return `Result<T, Error>`** for consistent error handling:

```typescript
// core/ports.ts

import type { EntityError } from './errors.js';
import type { Entity, EntityConnection, EntityFilter } from './types.js';
import type { Result } from 'neverthrow';

/**
 * Repository interface for entity data access.
 */
export interface EntityRepository {
  /**
   * Find a single entity by CUI.
   * @returns The entity if found, null if not found, or an error
   */
  getById(cui: string): Promise<Result<Entity | null, EntityError>>;

  /**
   * Batch load entities by CUIs.
   * Used by Mercurius loaders for N+1 prevention.
   */
  getByIds(cuis: string[]): Promise<Result<Map<string, Entity>, EntityError>>;

  /**
   * List entities with filtering and pagination.
   */
  getAll(
    filter: EntityFilter,
    limit: number,
    offset: number
  ): Promise<Result<EntityConnection, EntityError>>;

  /**
   * Get child entities (entities where this entity is a parent).
   */
  getChildren(cui: string): Promise<Result<Entity[], EntityError>>;
}
```

**Key pattern**: All repository methods wrap their return in `Result`, even for read operations. This allows the shell to convert database errors to domain errors.

### 5.4 Use Cases

Use cases are **thin wrappers** that delegate to repositories. Validation happens at the GraphQL/REST edge, not in use cases:

```typescript
// core/usecases/get-entity.ts

import type { EntityError } from '../errors.js';
import type { EntityRepository } from '../ports.js';
import type { Entity } from '../types.js';
import type { Result } from 'neverthrow';

/**
 * Dependencies for get entity use case.
 */
export interface GetEntityDeps {
  entityRepo: EntityRepository;
}

/**
 * Input for get entity use case.
 */
export interface GetEntityInput {
  cui: string;
}

/**
 * Retrieves a single entity by CUI.
 */
export async function getEntity(
  deps: GetEntityDeps,
  input: GetEntityInput
): Promise<Result<Entity | null, EntityError>> {
  return deps.entityRepo.getById(input.cui);
}
```

**Use case with pagination logic:**

```typescript
// core/usecases/list-entities.ts

import type { EntityError } from '../errors.js';
import type { EntityRepository } from '../ports.js';
import type { EntityConnection, EntityFilter } from '../types.js';
import type { Result } from 'neverthrow';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../types.js';

export interface ListEntitiesDeps {
  entityRepo: EntityRepository;
}

export interface ListEntitiesInput {
  filter: EntityFilter;
  limit?: number;
  offset?: number;
}

export async function listEntities(
  deps: ListEntitiesDeps,
  input: ListEntitiesInput
): Promise<Result<EntityConnection, EntityError>> {
  // Clamp pagination values (pure logic)
  const clampedLimit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const clampedOffset = Math.max(input.offset ?? 0, 0);

  return deps.entityRepo.getAll(input.filter, clampedLimit, clampedOffset);
}
```

**Key pattern**: Use cases contain only pure business logic (clamping, transformations). I/O is delegated to repositories via ports.

---

## 6. Shell Implementation

### 6.1 Repository Adapter (Kysely)

Repositories are class-based with a factory function. All methods return `Result`:

```typescript
// shell/repo/entity-repo.ts

import { sql } from 'kysely';
import { ok, err, type Result } from 'neverthrow';

import {
  createDatabaseError,
  createTimeoutError,
  isTimeoutError,
  type EntityError,
} from '../../core/errors.js';
import type { EntityRepository } from '../../core/ports.js';
import type { Entity, EntityConnection, EntityFilter } from '../../core/types.js';
import type { BudgetDbClient } from '@/infra/database/client.js';

class KyselyEntityRepo implements EntityRepository {
  constructor(private readonly db: BudgetDbClient) {}

  async getById(cui: string): Promise<Result<Entity | null, EntityError>> {
    try {
      const row = await this.db
        .selectFrom('entities')
        .select(['cui', 'name', 'entity_type', 'uat_id', 'is_uat', 'address'])
        .where('cui', '=', cui)
        .executeTakeFirst();

      if (row === undefined) {
        return ok(null);
      }

      return ok(this.mapRowToEntity(row));
    } catch (error) {
      return this.handleQueryError(error, 'getById');
    }
  }

  async getAll(
    filter: EntityFilter,
    limit: number,
    offset: number
  ): Promise<Result<EntityConnection, EntityError>> {
    try {
      let query = this.db
        .selectFrom('entities')
        .select([
          'cui',
          'name',
          'entity_type',
          'uat_id',
          'is_uat',
          'address',
          sql<string>`COUNT(*) OVER()`.as('total_count'),
        ]);

      // Apply filters
      if (filter.search !== undefined) {
        query = this.applySearchFilter(query, filter.search);
      }
      if (filter.is_uat !== undefined) {
        query = query.where('is_uat', '=', filter.is_uat);
      }

      const rows = await query.limit(limit).offset(offset).execute();

      const totalCount = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;

      return ok({
        nodes: rows.map((row) => this.mapRowToEntity(row)),
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      });
    } catch (error) {
      return this.handleQueryError(error, 'getAll');
    }
  }

  // ... other methods

  private mapRowToEntity(row: unknown): Entity {
    const r = row as Record<string, unknown>;
    return {
      cui: r.cui as string,
      name: r.name as string,
      entity_type: r.entity_type as string | null,
      uat_id: r.uat_id as number | null,
      is_uat: r.is_uat as boolean,
      address: r.address as string | null,
    };
  }

  private handleQueryError(error: unknown, operation: string): Result<never, EntityError> {
    if (isTimeoutError(error)) {
      return err(createTimeoutError(`Entity ${operation} query timed out`, error));
    }
    return err(createDatabaseError(`Entity ${operation} failed`, error));
  }
}

// Factory function
export const makeEntityRepo = (db: BudgetDbClient): EntityRepository => {
  return new KyselyEntityRepo(db);
};
```

**Key patterns:**

- Class-based implementation with private helpers
- Factory function (`makeEntityRepo`) for dependency injection
- All errors converted to domain errors via `handleQueryError`

### 6.2 GraphQL Resolvers

Resolvers call use cases, unwrap Results, and handle errors inline:

```typescript
// shell/graphql/resolvers.ts

import { getEntity } from '../../core/usecases/get-entity.js';
import { listEntities } from '../../core/usecases/list-entities.js';
import { DEFAULT_LIMIT, type Entity, type EntityFilter } from '../../core/types.js';
import type { EntityRepository } from '../../core/ports.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

export interface MakeEntityResolversDeps {
  entityRepo: EntityRepository;
}

export const makeEntityResolvers = (deps: MakeEntityResolversDeps): IResolvers => {
  const { entityRepo } = deps;

  return {
    Query: {
      entity: async (
        _parent: unknown,
        args: { cui: string },
        context: MercuriusContext
      ): Promise<Entity | null> => {
        const result = await getEntity({ entityRepo }, { cui: args.cui });

        if (result.isErr()) {
          // Log error with context
          context.reply.log.error(
            { err: result.error, cui: args.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          // Throw for GraphQL error response
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      entities: async (
        _parent: unknown,
        args: { filter?: EntityFilter; limit?: number; offset?: number },
        context: MercuriusContext
      ) => {
        const result = await listEntities(
          { entityRepo },
          {
            filter: args.filter ?? {},
            limit: args.limit ?? DEFAULT_LIMIT,
            offset: args.offset ?? 0,
          }
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, filter: args.filter },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },
    },

    Entity: {
      // Field resolvers for related data
      children: async (parent: Entity, _args: unknown, context: MercuriusContext) => {
        const result = await entityRepo.getChildren(parent.cui);
        if (result.isErr()) {
          context.reply.log.error({ err: result.error }, 'Failed to load children');
          return []; // Graceful degradation for nested fields
        }
        return result.value;
      },
    },
  };
};
```

**Key patterns:**

- Error logging includes structured context (`{ err, cui }`)
- Errors are thrown for GraphQL to handle
- Nested field resolvers may return empty arrays for graceful degradation

### 6.3 Mercurius Loaders (N+1 Prevention)

For batch loading related entities, use Mercurius loaders:

```typescript
// shell/graphql/loaders.ts

import type { EntityRepository } from '../../core/ports.js';
import type { Entity } from '../../core/types.js';
import type { MercuriusLoaders } from 'mercurius';

export interface CreateEntityLoadersDeps {
  entityRepo: EntityRepository;
}

export const createEntityLoaders = (deps: CreateEntityLoadersDeps): MercuriusLoaders => {
  const { entityRepo } = deps;

  return {
    Entity: {
      // Batch load UAT for multiple entities
      uat: async (queries: { obj: Entity }[], context) => {
        const uatIds = queries.map((q) => q.obj.uat_id).filter((id): id is number => id !== null);

        if (uatIds.length === 0) {
          return queries.map(() => null);
        }

        const result = await deps.uatRepo.getByIds(uatIds);
        if (result.isErr()) {
          context.reply.log.error({ err: result.error }, 'Failed to batch load UATs');
          return queries.map(() => null);
        }

        const uatMap = result.value;
        return queries.map((q) =>
          q.obj.uat_id !== null ? (uatMap.get(q.obj.uat_id) ?? null) : null
        );
      },
    },
  };
};
```

Loaders are registered in the app composition and automatically batch database queries.

---

## 7. Composition Root

The **only place** that creates database clients and wires module dependencies:

```typescript
// app/build-app.ts

import Fastify, { FastifyInstance } from 'fastify';
import mercurius from 'mercurius';

import {
  makeEntityRepo,
  makeEntityResolvers,
  createEntityLoaders,
} from '@/modules/entity/index.js';
import { makeUatRepo, makeUatResolvers } from '@/modules/uat/index.js';
import { createBudgetDbClient } from '@/infra/database/client.js';
import { mergeResolvers, mergeTypeDefs } from '@/infra/graphql/schema.js';

export interface AppConfig {
  databaseUrl: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });

  // Infrastructure
  const db = createBudgetDbClient(config.databaseUrl);

  // Create repositories
  const entityRepo = makeEntityRepo(db);
  const uatRepo = makeUatRepo(db);

  // Create resolvers with dependencies
  const entityResolvers = makeEntityResolvers({ entityRepo, uatRepo });
  const uatResolvers = makeUatResolvers({ uatRepo });

  // Create loaders for N+1 prevention
  const loaders = {
    ...createEntityLoaders({ entityRepo, uatRepo }),
  };

  // Register GraphQL
  await app.register(mercurius, {
    schema: mergeTypeDefs(),
    resolvers: mergeResolvers([entityResolvers, uatResolvers]),
    loaders,
  });

  // Graceful shutdown
  app.addHook('onClose', async () => {
    await db.destroy();
  });

  return app;
}
```

**Key patterns:**

- Repositories created from database client
- Resolvers receive repository dependencies
- Loaders registered for batch loading
- No REST routes (GraphQL-first architecture)

---

## 8. Testing Strategy

### 8.1 Testing Pyramid

```text
          /\
         /  \      E2E (5-10%)
        /----\     Real server, real DB
       /      \    Critical paths only
      /--------\   Integration (15-25%)
     /          \  Fastify.inject + in-memory fakes
    /------------\ Verify GraphQL mapping
   /              \
  /----------------\  Unit (70-80%)
 /                  \ Pure domain + use-cases
/                    \ In-memory fakes, no I/O
```

### 8.2 Unit Tests

Tests live in `tests/unit/{module}/` directory (not alongside source). Use in-memory fakes:

```typescript
// tests/unit/datasets/get-static-chart-analytics.test.ts

import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { getStaticChartAnalytics } from '@/modules/datasets/core/usecases/get-static-chart-analytics.js';
import type { DatasetRepo } from '@/modules/datasets/core/ports.js';
import type { Dataset } from '@/modules/datasets/core/types.js';

// Create test data inline
const createTestDataset = (id: string, title: string): Dataset => ({
  id,
  metadata: { id, source: 'Test', lastUpdated: '2024-01-01', units: 'unit', frequency: 'yearly' },
  i18n: { ro: { title, xAxisLabel: 'An', yAxisLabel: 'Valoare' } },
  axes: {
    x: { label: 'Year', type: 'date', frequency: 'yearly' },
    y: { label: 'Value', type: 'number', unit: 'unit' },
  },
  points: [
    { x: '2020', y: new Decimal('100') },
    { x: '2021', y: new Decimal('110') },
  ],
});

// Create fake repo inline
const makeFakeRepo = (datasets: Dataset[]): DatasetRepo => ({
  getById: async (id: string) => {
    const dataset = datasets.find((d) => d.id === id);
    if (dataset !== undefined) return ok(dataset);
    return Promise.reject(new Error(`Not found: ${id}`));
  },
  listAvailable: async () =>
    ok(datasets.map((d) => ({ id: d.id, absolutePath: '', relativePath: '' }))),
  getByIds: async (ids: string[]) => ok(datasets.filter((d) => ids.includes(d.id))),
  getAllWithMetadata: async () => ok(datasets),
});

describe('getStaticChartAnalytics', () => {
  it('returns chart data for valid IDs', async () => {
    const repo = makeFakeRepo([createTestDataset('gdp', 'PIB')]);
    const result = await getStaticChartAnalytics({ datasetRepo: repo }, { seriesIds: ['gdp'] });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });

  it('silently omits non-existent IDs', async () => {
    const repo = makeFakeRepo([createTestDataset('gdp', 'PIB')]);
    const result = await getStaticChartAnalytics(
      { datasetRepo: repo },
      { seriesIds: ['gdp', 'nonexistent'] }
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });
});
```

### 8.3 In-Memory Fakes

Fakes are defined in `tests/fixtures/fakes.ts`. Each fake implements the port interface:

```typescript
// tests/fixtures/fakes.ts

import { Decimal } from 'decimal.js';
import { ok, err, type Result } from 'neverthrow';

import type { DatasetRepo, Dataset, DatasetRepoError } from '@/modules/datasets/index.js';
import type {
  BudgetSectorRepository,
  BudgetSector,
  BudgetSectorConnection,
} from '@/modules/budget-sector/index.js';

/**
 * Creates minimal fake datasets for normalization testing.
 */
const createMinimalNormalizationDatasets = (): Record<string, Dataset> => {
  const years = [2020, 2021, 2022, 2023, 2024];

  const createYearlyDataset = (id: string, unit: string, values: number[]): Dataset => ({
    id,
    metadata: { id, source: 'test', lastUpdated: '2024-01-01', units: unit, frequency: 'yearly' },
    i18n: { ro: { title: `Test ${id}`, xAxisLabel: 'An', yAxisLabel: unit } },
    axes: {
      x: { label: 'Year', type: 'date', frequency: 'yearly' },
      y: { label: 'Value', type: 'number', unit },
    },
    points: years.map((year, i) => ({ x: String(year), y: new Decimal(values[i] ?? 100) })),
  });

  return {
    'ro.economics.cpi.yearly': createYearlyDataset(
      'ro.economics.cpi.yearly',
      'index',
      [100, 105, 118, 125, 130]
    ),
    'ro.economics.exchange.ron_eur.yearly': createYearlyDataset(
      'ro.economics.exchange.ron_eur.yearly',
      'RON/EUR',
      [4.87, 4.92, 4.93, 4.95, 4.97]
    ),
  };
};

/**
 * Creates a fake dataset repository for testing.
 */
export const makeFakeDatasetRepo = (
  options: { datasets?: Record<string, Dataset> } = {}
): DatasetRepo => {
  const datasets = { ...createMinimalNormalizationDatasets(), ...options.datasets };

  return {
    getById: async (id: string): Promise<Result<Dataset, DatasetRepoError>> => {
      const dataset = datasets[id];
      if (dataset != null) return ok(dataset);
      return err({ type: 'NotFound', message: `Dataset ${id} not found` });
    },
    listAvailable: async () =>
      ok(Object.keys(datasets).map((id) => ({ id, absolutePath: '', relativePath: '' }))),
    getByIds: async (ids: string[]) =>
      ok(Object.values(datasets).filter((d) => ids.includes(d.id))),
    getAllWithMetadata: async () => ok(Object.values(datasets)),
  };
};

/**
 * Creates a fake budget sector repository for testing.
 */
export const makeFakeBudgetSectorRepo = (sectors: BudgetSector[] = []): BudgetSectorRepository => ({
  findById: async (id: number) => ok(sectors.find((s) => s.sector_id === id) ?? null),
  list: async (filter, limit, offset) => {
    let filtered = [...sectors];
    if (filter?.search) {
      const searchLower = filter.search.toLowerCase();
      filtered = filtered.filter((s) => s.sector_description.toLowerCase().includes(searchLower));
    }
    const nodes = filtered.slice(offset, offset + limit);
    return ok({
      nodes,
      pageInfo: {
        totalCount: filtered.length,
        hasNextPage: offset + limit < filtered.length,
        hasPreviousPage: offset > 0,
      },
    });
  },
});
```

**Key patterns:**

- Fakes implement the full port interface
- Use simple in-memory data structures (arrays, Maps)
- Return `Result` types matching the port contract

### 8.4 Integration Tests (GraphQL)

Test GraphQL resolvers with `app.inject()` and fake repositories:

```typescript
// tests/integration/budget-sector-graphql.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import mercurius from 'mercurius';

import { makeBudgetSectorResolvers } from '@/modules/budget-sector/shell/graphql/resolvers.js';
import { BudgetSectorSchema } from '@/modules/budget-sector/shell/graphql/schema.js';
import { makeFakeBudgetSectorRepo } from '../fixtures/fakes.js';

describe('BudgetSector GraphQL', () => {
  let app: FastifyInstance;

  const sectors = [
    { sector_id: 1, sector_description: 'Buget local' },
    { sector_id: 2, sector_description: 'Buget de stat' },
  ];

  beforeAll(async () => {
    app = Fastify();

    const budgetSectorRepo = makeFakeBudgetSectorRepo(sectors);
    const resolvers = makeBudgetSectorResolvers({ budgetSectorRepo });

    await app.register(mercurius, {
      schema: BudgetSectorSchema,
      resolvers,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns budget sector by ID', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        query: `query { budgetSector(id: 1) { sector_id sector_description } }`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.budgetSector.sector_id).toBe(1);
    expect(body.data.budgetSector.sector_description).toBe('Buget local');
  });

  it('returns null for non-existent sector', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        query: `query { budgetSector(id: 999) { sector_id } }`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.budgetSector).toBeNull();
  });

  it('lists sectors with pagination', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'Content-Type': 'application/json' },
      payload: {
        query: `query { budgetSectors(limit: 10) { nodes { sector_id } pageInfo { totalCount } } }`,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.budgetSectors.nodes).toHaveLength(2);
    expect(body.data.budgetSectors.pageInfo.totalCount).toBe(2);
  });
});
```

### 8.5 E2E Tests (Real Database)

E2E tests use a real PostgreSQL database. Setup is in `tests/e2e/setup.ts`:

```typescript
// tests/e2e/setup.ts

import { beforeAll, afterAll } from 'vitest';
import { createBudgetDbClient, type BudgetDbClient } from '@/infra/database/client.js';

let db: BudgetDbClient;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for E2E tests');
  }
  db = createBudgetDbClient(databaseUrl);
});

afterAll(async () => {
  await db.destroy();
});

export const getTestDb = () => db;
```

```typescript
// tests/e2e/sql-builders.test.ts

import { describe, it, expect } from 'vitest';
import { getTestDb } from './setup.js';
import { makeEntityRepo } from '@/modules/entity/shell/repo/entity-repo.js';

describe('EntityRepo (Real DB)', () => {
  it('queries entities with search filter', async () => {
    const db = getTestDb();
    const repo = makeEntityRepo(db);

    const result = await repo.getAll({ search: 'Bucuresti' }, 10, 0);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.nodes.length).toBeGreaterThanOrEqual(0);
      expect(result.value.pageInfo.totalCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns null for non-existent CUI', async () => {
    const db = getTestDb();
    const repo = makeEntityRepo(db);

    const result = await repo.getById('00000000');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });
});
```

**Note:** E2E tests require a running database. Use `pnpm test:e2e` which sets up the test environment.

---

## 9. Practical Rules

### 9.1 Rules That Keep Architecture Clean

| Rule                                                                                          | Enforcement                                          |
| :-------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
| **No imports from `shell/` into `core/`**                                                     | ESLint boundary rules                                |
| **Edge validation only**                                                                      | TypeBox schemas in shell; core assumes typed inputs  |
| **Domain errors are domain concerns**                                                         | Mapped to HTTP/GraphQL codes in shell                |
| **Composition root is the only place** that reads env vars, constructs clients, wires modules | Single `build-app.ts`                                |
| **Feature modules over global layers**                                                        | Keep related code together                           |
| **Ports are interfaces, adapters are implementations**                                        | Core depends only on ports                           |
| **Pure functions where possible**                                                             | Validation, normalization, calculations have no deps |
| **Test doubles over mocks**                                                                   | In-memory repos and fixed clocks are simpler         |
| **No floats for money**                                                                       | Use `Decimal` everywhere, `NUMERIC` in Postgres      |
| **Result types for expected failures**                                                        | Thrown exceptions only for bugs                      |

### 9.2 Anti-Patterns to Avoid

| Anti-pattern                       | Why We Avoid It                          |
| :--------------------------------- | :--------------------------------------- |
| Business logic in handlers         | Untestable, duplicated across transports |
| Business logic in SQL              | Hard to test, hidden from view           |
| Thrown exceptions for control flow | Unclear error paths, easy to miss        |
| Deep abstraction layers            | Complexity without benefit               |
| Magic/implicit behavior            | Hard to debug and understand             |
| Floating point for money           | Precision errors in financial data       |
| Mocking libraries in tests         | Brittle tests, implementation coupling   |

### 9.3 When Starting a New Feature

1. Create module folder under `modules/`
2. Define domain types in `core/types.ts`
3. Define domain errors in `core/errors.ts`
4. Define ports (interfaces) in `core/ports.ts`
5. Implement use-cases as pure functions in `core/usecases/`
6. Write unit tests in `tests/unit/{module}/`
7. Implement repository adapter in `shell/repo/`
8. Add GraphQL schema in `shell/graphql/schema.ts`
9. Add GraphQL resolvers in `shell/graphql/resolvers.ts`
10. Add loaders if N+1 prevention is needed in `shell/graphql/loaders.ts`
11. Export public interface in `index.ts`

---

## 10. Quick Reference

### 10.1 Error Types

| Error Type            | Description                  | Retryable |
| :-------------------- | :--------------------------- | :-------- |
| `DatabaseError`       | Database query failed        | Yes       |
| `TimeoutError`        | Query exceeded timeout       | Yes       |
| `EntityNotFoundError` | Entity with CUI not found    | No        |
| `InvalidFilterError`  | Invalid filter parameter     | No        |
| `InvalidPeriodError`  | Invalid period specification | No        |

### 10.2 Test Type Guidelines

| Test Type       | Coverage | Location               | Dependencies           |
| :-------------- | :------- | :--------------------- | :--------------------- |
| **Unit**        | 70-80%   | `tests/unit/{module}/` | In-memory fakes        |
| **Integration** | 15-25%   | `tests/integration/`   | Fastify.inject + fakes |
| **E2E**         | 5-10%    | `tests/e2e/`           | Real PostgreSQL        |

### 10.3 Import Boundaries

| Layer     | Can Import                           | Cannot Import                |
| :-------- | :----------------------------------- | :--------------------------- |
| **Core**  | `common`, `decimal.js`, `neverthrow` | `fastify`, `kysely`, any I/O |
| **Shell** | `core`, `common`, `infra`            | Other modules' internals     |
| **Infra** | `common`                             | `core`, `shell`              |

### 10.4 Module Public API (index.ts)

```typescript
// Types (always as type)
export type { Entity, EntityFilter, EntityConnection } from './core/types.js';
export type { EntityError } from './core/errors.js';
export type { EntityRepository } from './core/ports.js';

// Constants
export { DEFAULT_LIMIT, MAX_LIMIT } from './core/types.js';

// Error constructors
export { createDatabaseError, createEntityNotFoundError } from './core/errors.js';

// Use cases
export { getEntity, type GetEntityDeps } from './core/usecases/get-entity.js';

// Repository factory
export { makeEntityRepo } from './shell/repo/entity-repo.js';

// GraphQL exports
export { EntitySchema } from './shell/graphql/schema.js';
export { makeEntityResolvers, type MakeEntityResolversDeps } from './shell/graphql/resolvers.js';
export { createEntityLoaders } from './shell/graphql/loaders.js';
```
