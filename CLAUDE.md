# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Transparenta.eu server - analyzes and visualizes Romanian public budget data using a **strict architectural pattern** that enforces separation of concerns and financial precision.

**Tech Stack:** TypeScript, Fastify, GraphQL (Mercurius), Kysely, PostgreSQL, Redis/BullMQ, pnpm

## Development Commands

### Running the Application

```bash
pnpm dev              # Start development server with watch mode
pnpm build            # Compile TypeScript to dist/
pnpm start            # Run production build from dist/
pnpm clean            # Remove dist/ and coverage/
```

### Quality Checks

```bash
pnpm typecheck        # TypeScript type checking (no emit)
pnpm lint             # ESLint with zero warnings tolerance
pnpm lint:fix         # Auto-fix linting issues
pnpm format           # Format with Prettier
pnpm format:check     # Check formatting without changes
```

### Testing

```bash
pnpm test                  # Run all tests
pnpm test:unit             # Unit tests only (tests/unit)
pnpm test:integration      # Integration tests (tests/integration)
pnpm test:watch            # Watch mode for TDD
pnpm test:coverage         # Generate coverage report (80% threshold)
```

### Dataset Management

```bash
pnpm validate-datasets     # Validate dataset JSON files against schema
```

### CI Pipeline

```bash
pnpm ci                    # Full pipeline: typecheck → lint → test → build
```

## Architecture

### Core Principles

This codebase follows **Functional Core / Imperative Shell** (Hexagonal Architecture) with strict enforcement via ESLint:

1. **Core/** - Pure business logic, no I/O, must use Result<T,E> pattern (no throws)
2. **Shell/** - Adapters for Core (GraphQL/REST resolvers, repositories)
3. **Infra/** - Generic infrastructure (database clients, config, logger, GraphQL setup)
4. **Common/** - Shared types and utilities (pure, no business logic)

**Detailed architecture docs:** See `docs/ARCHITECTURE.md` and `docs/TECHNICAL-REFERENCE.md`

### Directory Structure

```
src/
├── api.ts                    # Server entry point
├── app/                      # COMPOSITION ROOT
│   └── build-app.ts          # Fastify app factory (wires all deps)
├── common/
│   ├── types/                # Result pattern, error types
│   └── period-labels/        # Shared utilities (pure)
├── infra/
│   ├── config/               # Environment validation (TypeBox)
│   ├── database/             # Kysely clients (budget/user DBs)
│   ├── graphql/              # Mercurius plugin setup
│   └── logger/               # Pino logger factory
└── modules/
    └── {feature}/            # e.g., health, datasets, execution-analytics
        ├── core/
        │   ├── types.ts      # Domain types + TypeBox schemas
        │   ├── errors.ts     # Domain error unions (optional)
        │   ├── ports.ts      # Interfaces for dependencies
        │   └── usecases/     # Pure business logic (one file per use-case)
        │       └── *.ts
        ├── shell/
        │   ├── repo/         # Database adapters (implement ports)
        │   ├── rest/         # Fastify route handlers
        │   └── graphql/      # Mercurius resolvers + schema
        └── index.ts          # Public API exports
```

### Module Anatomy

Each module follows a strict structure:

| File                 | Contains                                     | Does NOT Contain      |
| :------------------- | :------------------------------------------- | :-------------------- |
| `core/types.ts`      | Domain types, branded types, TypeBox schemas | DB types, API DTOs    |
| `core/errors.ts`     | Domain error unions (discriminated unions)   | Infrastructure errors |
| `core/ports.ts`      | Interfaces for external dependencies         | Implementations       |
| `core/usecases/*.ts` | Pure functions with deps as first argument   | DB calls, HTTP        |
| `shell/repo/*.ts`    | Kysely queries, type conversions             | Business logic        |
| `shell/rest/*.ts`    | Fastify routes, request validation           | Business logic        |
| `shell/graphql/*.ts` | Resolvers, schema                            | Business logic        |

### Ports Pattern

Core defines **ports** (interfaces) for external dependencies. Shell provides **adapters** (implementations).

```typescript
// core/ports.ts - Define what we need
export interface HealthChecker {
  checkDatabase(): Promise<boolean>;
  checkCache(): Promise<boolean>;
}

// shell/repo/health-checker.ts - Implement it
export function createHealthChecker(db: Kysely<DB>, redis: Redis): HealthChecker {
  return {
    async checkDatabase() {
      /* Kysely query */
    },
    async checkCache() {
      /* Redis ping */
    },
  };
}
```

### Use-Case Pattern

Use-cases are pure functions with dependencies passed as the first argument:

```typescript
// core/usecases/get-readiness.ts
export async function getReadiness(
  deps: { healthChecker: HealthChecker },
  input: { checkCache: boolean }
): Promise<Result<ReadinessStatus, HealthError>> {
  const dbOk = await deps.healthChecker.checkDatabase();
  if (!dbOk) return err({ type: 'DATABASE_UNAVAILABLE' });
  // ...
  return ok({ status: 'ready' });
}
```

### Module Exports

Each module exports from `index.ts`:

- Factory functions (`makeHealthRoutes`, `makeHealthResolvers`)
- Types needed by composition root
- GraphQL schema

**GraphQL and REST coexist:**

- `shell/graphql/` - Resolvers and schema
- `shell/rest/` - Fastify route handlers

### TypeScript Path Aliases

```typescript
@/*              → src/*
@/infra/*        → src/infra/*
@/common/*       → src/common/*
@/modules/*      → src/modules/*
@/tests/*        → tests/*  (test files only)
```

## Critical Rules

### 1. The "No Float" Rule

**Floats are forbidden.** Use `decimal.js` or integer math for all numeric calculations.

```typescript
// ❌ WRONG
const total = parseFloat('123.45');

// ✅ CORRECT
import { Decimal } from 'decimal.js';
const total = new Decimal('123.45');
```

ESLint will block `parseFloat` usage globally.

### 2. Result Pattern (No Throws in Core)

Core logic must return `Result<T, E>` from `neverthrow`. Throwing is forbidden.

```typescript
// ❌ WRONG (in core/)
export function divide(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero');
  return a / b;
}

// ✅ CORRECT
import { Result, ok, err } from 'neverthrow';

export function divide(a: Decimal, b: Decimal): Result<Decimal, string> {
  if (b.isZero()) return err('Division by zero');
  return ok(a.div(b));
}
```

### 3. Strict Boolean Expressions

Due to financial data, `0` is a valid value. You must explicitly check:

```typescript
// ❌ WRONG - ESLint will error
if (amount) { ... }

// ✅ CORRECT
if (amount !== 0) { ... }
if (amount.greaterThan(0)) { ... }  // For Decimal
```

### 4. Dependency Boundaries

| Layer     | Can Import                                    | Cannot Import                      |
| --------- | --------------------------------------------- | ---------------------------------- |
| **core**  | `common`, `decimal.js`, `neverthrow`, TypeBox | `fastify`, `kysely`, `pg`, any I/O |
| **shell** | `core`, `common`, `infra`                     | Other modules' internals           |
| **infra** | `common`                                      | `core`, `shell`                    |

ESLint will block violations. Core must remain **I/O-free and portable**.

### 5. Safe Parsing Only

Use TypeBox + `Value.Check()` for runtime validation. Direct `JSON.parse()` is blocked.

```typescript
// ❌ WRONG
const data = JSON.parse(input);

// ✅ CORRECT
import { Value } from '@sinclair/typebox/value';
if (Value.Check(DatasetFileSchema, data)) {
  // data is validated
}
```

## Database Setup

The app uses **two separate Kysely clients**:

- `budgetDb` - Budget/financial data (read from `BUDGET_DATABASE_URL` or `DATABASE_URL`)
- `userDb` - User/notification data (read from `USER_DATABASE_URL`)

**Schema files:**

- `src/infra/database/budget/schema.sql`
- `src/infra/database/user/schema.sql`

**Type generation:**

```bash
kysely-codegen --out-file src/infra/database/budget/types.ts
```

## Testing Strategy

### Testing Pyramid

| Test Type       | Coverage | What                             | How                                    |
| :-------------- | :------- | :------------------------------- | :------------------------------------- |
| **Unit**        | 70-80%   | Core use-cases, business rules   | Direct function calls, in-memory fakes |
| **Integration** | 15-25%   | API routes, HTTP/GraphQL mapping | Fastify inject with in-memory fakes    |
| **E2E**         | 5-10%    | Full stack, DB queries           | Testcontainers Postgres, real HTTP     |

### Unit Tests (No Mocking Libraries)

Test core functions by passing **in-memory fakes** — no `jest.mock` or `sinon`:

```typescript
// tests/unit/health/get-readiness.test.ts
const fakeChecker = {
  checkDatabase: async () => true,
  checkCache: async () => true,
};

const result = await getReadiness({ healthChecker: fakeChecker }, { checkCache: true });
expect(result.isOk()).toBe(true);
```

### Integration Tests (Fast, No Real I/O)

Test HTTP/GraphQL routes using `app.inject()` with in-memory fakes:

```typescript
// tests/integration/health.test.ts
const app = await createApp({
  deps: {
    budgetDb: makeFakeBudgetDb(),
    datasetRepo: makeFakeDatasetRepo(),
  },
});

const response = await app.inject({ method: 'GET', url: '/health/ready' });
expect(response.statusCode).toBe(200);
```

### E2E Tests (Testcontainers)

Test full stack with real database using Testcontainers:

```typescript
// tests/e2e/repos.e2e.test.ts
// Uses setupTestDatabase() from tests/infra/test-db.ts
```

### Test Files

- **Unit tests** (`tests/unit/`) - Test pure logic (core/) without I/O
- **Integration tests** (`tests/integration/`) - HTTP/GraphQL tests with in-memory fakes
- **E2E tests** (`tests/e2e/`) - Full stack tests with Testcontainers
- **Fixtures** (`tests/fixtures/`) - Builders and fakes for test data

**Test helpers:**

- `tests/infra/test-db.ts` - Testcontainers PostgreSQL setup (for E2E only)
- `tests/fixtures/builders.ts` - Factory functions for test objects
- `tests/fixtures/fakes.ts` - In-memory implementations of ports

**Running tests:**

```bash
pnpm test                  # Unit + Integration (fast)
pnpm test:unit             # Unit only
pnpm test:integration      # Integration only
pnpm test:e2e              # E2E only (slow, requires Docker)
```

## Git Workflow

**Husky hooks:**

- `pre-commit` - Runs `lint-staged` (ESLint + Prettier on staged files) + `pnpm typecheck`
- `commit-msg` - Enforces conventional commits via `commitlint`

**Commit format:**

```
type(scope): description

Examples:
feat(datasets): add validation for annual budgets
fix(health): return correct status codes
chore(deps): update fastify to 5.6.2
```

## Common Workflows

### Adding a New Module

1. Create module structure:

   ```
   src/modules/my-module/
   ├── core/
   │   ├── types.ts      # Domain types + TypeBox schemas
   │   ├── errors.ts     # Domain error unions (optional)
   │   ├── ports.ts      # Interfaces for dependencies
   │   └── usecases/     # Pure business logic (one file per use-case)
   │       └── *.ts
   ├── shell/
   │   ├── repo/         # Database adapters (implement ports)
   │   ├── graphql/
   │   │   ├── schema.ts
   │   │   └── resolvers.ts
   │   └── rest/
   │       └── routes.ts
   └── index.ts          # Public API exports
   ```

2. Export factories from `index.ts`:

   ```typescript
   export { makeMyModuleRoutes } from './shell/rest/routes.js';
   export { makeMyModuleResolvers } from './shell/graphql/resolvers.js';
   export { schema as myModuleSchema } from './shell/graphql/schema.js';
   export type { MyModuleDeps } from './core/types.js';
   ```

3. Wire in `app/build-app.ts`:

   ```typescript
   import { makeMyModuleRoutes, makeMyModuleResolvers, myModuleSchema } from './modules/my-module/index.js';

   // Register REST
   await app.register(makeMyModuleRoutes({ ...deps }));

   // Register GraphQL
   const resolvers = mergeResolvers([myModuleResolvers, ...]);
   const schema = [BaseSchema, myModuleSchema, ...];
   ```

### Working with Datasets

Datasets are JSON files in `src/infra/database/seeds/entities/` following this structure:

```json
{
  "metadata": { "id": "...", "source": "...", "lastUpdated": "2024-01-01", "units": "RON" },
  "i18n": { "ro": { "title": "...", "xAxisLabel": "...", "yAxisLabel": "..." } },
  "axes": { "x": { "label": "...", "type": "date" }, "y": { "label": "...", "type": "number" } },
  "data": [{ "x": "2023", "y": "123456789.50" }]
}
```

**Validate all datasets:**

```bash
pnpm validate-datasets
```

### GraphQL Development

**GraphQL endpoint:** `http://localhost:3000/graphql`

**Schema composition:**

- Base schema in `src/infra/graphql/schema.ts` (Query/Mutation roots)
- Module schemas in `src/modules/*/shell/graphql/schema.ts`
- Merge in `app/build-app.ts` using `mergeResolvers()`

**Resolver pattern:**

```typescript
export const makeMyResolvers = (deps: MyDeps) => ({
  Query: {
    myQuery: async () => {
      const result = await someLogic();
      if (result.isErr()) throw new Error(result.error);
      return result.value;
    },
  },
});
```

## Environment Variables

Create `.env` for local development (not committed):

```bash
# Server
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=debug

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/db
BUDGET_DATABASE_URL=postgresql://...  # Optional: separate budget DB
USER_DATABASE_URL=postgresql://...    # Optional: separate user DB

# Redis (for BullMQ)
REDIS_URL=redis://localhost:6379
```

All env vars are validated via TypeBox schema in `src/infra/config/env.ts`.

## Naming Conventions

- **Files:** kebab-case (`user-service.ts`, `health-check.ts`)
- **Types:** PascalCase (`DatasetFile`, `HealthChecker`)
- **Functions:** camelCase (`makeHealthRoutes`, `parseEnv`)
- **Constants:** UPPER_CASE (`MAX_POOL_SIZE`)
- **TypeBox Schemas:** PascalCase + `Schema` suffix (`DatasetFileSchema`)

## Key Dependencies

- **Fastify** - HTTP server framework
- **Mercurius** - GraphQL adapter for Fastify
- **Kysely** - Type-safe SQL query builder
- **TypeBox** - Runtime JSON schema validation
- **neverthrow** - Result type for error handling
- **decimal.js** - Arbitrary-precision decimal arithmetic
- **BullMQ** - Background job queue (Redis-backed)
- **Pino** - Structured logging
- **Vitest** - Test runner with coverage
- **Testcontainers** - Integration tests with real PostgreSQL

## Performance Notes

- Kysely connection pool size: 10 per database client
- Fastify runs in single-threaded mode (use cluster mode in production if needed)
- GraphQL uses Mercurius (fastest GraphQL server for Node.js)
