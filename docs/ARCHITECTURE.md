# Transparenta.eu — Architecture Specification

## Architecture Reference Document v2.0

---

## 1. Introduction

This document defines the authoritative architectural standards for the Transparenta.eu platform. It serves as the single source of truth for code structure, patterns, and testing strategies.

### 1.1 Design Principles

| Principle            | What It Means                                                                 |
| :------------------- | :---------------------------------------------------------------------------- |
| **Functional Core**  | Business logic is pure, deterministic, and free of I/O.                       |
| **Imperative Shell** | I/O is isolated in a thin shell that orchestrates the core.                   |
| **Vertical Slices**  | Code is organized by feature (module), not by technical layer.                |
| **Explicit Deps**    | Dependencies are passed as arguments (Dependency Injection). No global state. |
| **Zero Magic**       | Avoid hidden abstractions. Prefer explicitness over "clever" code.            |

### 1.2 Technology Stack

| Purpose           | Technology     | Usage                                                        |
| :---------------- | :------------- | :----------------------------------------------------------- |
| **Runtime**       | Node.js LTS    | Async I/O, stable ecosystem.                                 |
| **Language**      | TypeScript     | Strict mode. Type safety everywhere.                         |
| **Framework**     | Fastify        | HTTP server, plugin system.                                  |
| **Database**      | PostgreSQL 16+ | Primary data store. NUMERIC types for money.                 |
| **Query Builder** | Kysely         | Type-safe SQL construction. No ORM.                          |
| **Validation**    | TypeBox        | JSON Schema validation with TS inference.                    |
| **Math**          | decimal.js     | **MANDATORY** for financial calculations. No floats.         |
| **Errors**        | neverthrow     | Result types (`Result<T, E>`). No thrown exceptions in Core. |
| **GraphQL**       | Mercurius      | GraphQL adapter for Fastify.                                 |

---

## 2. The Pattern: Functional Core / Imperative Shell

We strictly separate **Policy** (Logic) from **Mechanism** (I/O).

### 2.1 The Mental Model

```text
┌────────────────────────────────────────────────────────────┐
│                    IMPERATIVE SHELL                        │
│                                                            │
│   HTTP Handlers, GraphQL Resolvers, DB Repositories,       │
│   External APIs, System Time, Randomness                   │
│                                                            │
│   ┌────────────────────────────────────────────────────┐   │
│   │                 FUNCTIONAL CORE                    │   │
│   │                                                    │   │
│   │   Pure functions only.                             │   │
│   │   Input → Output (deterministic).                  │   │
│   │   Dependencies defined as Interfaces (Ports).      │   │
│   │                                                    │   │
│   └────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

### 2.2 Layer Rules

| Layer     | Allowed                                              | Forbidden                                                                  |
| :-------- | :--------------------------------------------------- | :------------------------------------------------------------------------- |
| **CORE**  | Pure functions, data manipulation, business rules.   | Database access, HTTP calls, `Date.now()`, `Math.random()`, `console.log`. |
| **SHELL** | Database queries, API handlers, wiring dependencies. | Complex business logic (should be delegated to Core).                      |

### 2.3 Dependency Flow

**Shell → Core** (Shell imports Core).
**Core → ∅** (Core imports NOTHING from Shell).

---

## 3. Directory Structure

We use a **Feature-First** (Vertical Slice) structure, with a distinct **Composition Root**.

```text
src/
├── app/                          # COMPOSITION ROOT
│   ├── buildApp.ts               # The ONLY place that wires real deps
│   └── plugins/                  # Fastify plugins (CORS, etc.)
│
├── common/                       # SHARED UTILITIES (Pure & Generic)
│   ├── money.ts                  # Decimal wrapper
│   ├── result.ts                 # Error handling helpers
│   └── types/                    # Truly global types (Result, etc.)
│
├── infra/                        # GENERIC INFRASTRUCTURE
│   ├── config/                   # Environment variables
│   ├── database/                 # Kysely client setup
│   ├── logger/                   # Pino logger setup
│   └── graphql/                  # Mercurius setup
│
└── modules/                      # VERTICAL SLICES (Features)
    └── {feature}/                # e.g. "budget-analysis"
        ├── core/                 # FUNCTIONAL CORE (Pure)
        │   ├── types.ts          # Domain types & TypeBox schemas
        │   ├── errors.ts         # Domain error unions
        │   ├── ports.ts          # Interfaces for dependencies
        │   └── usecases/         # Business Actions (one file per case)
        │       ├── calculate-total.ts
        │       └── validate-report.ts
        │
        └── shell/                # IMPERATIVE SHELL (I/O)
            ├── repo/             # Database Adapters (implement Ports)
            ├── rest/             # HTTP Routes (Fastify)
            └── graphql/          # GraphQL Resolvers
```

### 3.1 The "Common" Trap

**`src/common` is NOT for business logic.**

- ✅ OK: `Money` class, `Result` helpers, `Date` formatters.
- ❌ WRONG: `User` types, `Authentication` logic, `Budget` constants.
- _If it's business logic, it belongs in a Module._

---

## 4. Module anatomy

### 4.1 Core

**`core/types.ts`**
Domain entities using **Branded Types** for safety.

```typescript
export type UserId = string & { readonly __brand: unique symbol };
export interface User {
  id: UserId;
  email: string;
}
```

**`core/ports.ts`**
Interfaces defining _what_ the core needs, not _how_ it gets it.

```typescript
export interface UserRepo {
  findById(id: UserId): Promise<User | null>;
}
```

**`core/usecases/*.ts`**
Pure functions implementing a single business action. Dependencies are injected.

```typescript
export async function registerUser(
  deps: { userRepo: UserRepo; hasher: Hasher },
  input: RegisterInput
): Promise<Result<User, DomainError>> { ... }
```

### 4.2 Shell

**`shell/repo/*.ts`**
Implementations of Ports using real infrastructure (Kysely).

```typescript
export const createPostgresUserRepo = (db: Kysely<DB>): UserRepo => ({
  async findById(id) { ... } // SQL queries here
});
```

**`shell/rest/*.ts`**
Fastify routes that:

1. Validate input (Shell concern).
2. Call Core Use-Case.
3. Map Result to HTTP Response.

---

## 5. Application Composition (`src/app`)

The **Composition Root** (`src/app/buildApp.ts`) is the entry point where the application is assembled.

**Responsibilities:**

1. Load Configuration.
2. Initialize Infrastructure (DB connection, Redis).
3. Instantiate Adapters (Repos).
4. Register Plugins (Routes, GraphQL).
5. **Inject Adapters into Use-Cases.**

```typescript
// src/app/buildApp.ts
export async function buildApp() {
  const db = createKyselyClient();
  const userRepo = createPostgresUserRepo(db); // Create Adapter

  app.register(userRoutes, {
    // Inject Dependency
    container: { userRepo },
  });
}
```

---

## 6. Error Handling

### 6.1 The Result Pattern

We use `neverthrow` to treat errors as values. **Do not throw exceptions in the Core.**

- **Expected Errors** (Validation, Not Found, Business Rule): Return `Result.err(DomainError)`.
- **Unexpected Errors** (DB Connection died, Bug): Throw exception (caught by Fastify's global error handler).

### 6.2 Error Mapping

The Shell must map Domain Errors to Transport Errors.

| Domain Error     | HTTP Status | GraphQL Code      |
| :--------------- | :---------- | :---------------- |
| `EntityNotFound` | 404         | `NOT_FOUND`       |
| `InvalidInput`   | 400         | `BAD_USER_INPUT`  |
| `Unauthorized`   | 401         | `UNAUTHENTICATED` |

---

## 7. Data Model & Money

### 7.1 The "No Float" Rule

JavaScript `number` (IEEE 754 float) is **forbidden** for monetary values.

- **DB**: Use `NUMERIC(18, 2)` (or 4).
- **JS**: Use `decimal.js`.
- **API**: Serialize as `string`.

### 7.2 Database Access

- **Kysely** is the only allowed way to query the DB.
- SQL queries belong **ONLY** in `shell/repo/`.
- Repos must return Domain Types, not raw DB rows.

---

## 8. Testing Strategy

We follow the **Testing Pyramid**.

### 8.1 Unit Tests (Target: Core)

- **Scope**: `core/usecases/`
- **Speed**: Extremely Fast (<1ms).
- **Technique**: **In-Memory Fakes**. Pass fake implementations of Ports into the Use-Case.
- **No Mocks**: Do not use `jest.mock` or `sinon`. Just pass an object.

```typescript
// Real test example
const fakeRepo = { findById: async () => null }; // Fake
const result = await registerUser({ userRepo: fakeRepo }, input);
expect(result.isOk()).toBe(true);
```

### 8.2 Integration Tests (Target: Shell Routes)

- **Scope**: `shell/rest/` and `shell/graphql/`
- **Speed**: Fast (in-memory, no I/O).
- **Technique**: Use `app.inject()` with **in-memory fakes**. Verify HTTP/GraphQL mapping, validation, and error handling.
- **No Real I/O**: All dependencies (DB, cache) are faked.

```typescript
// Integration test example
const app = await createApp({
  deps: {
    budgetDb: makeFakeBudgetDb(),
    datasetRepo: makeFakeDatasetRepo(),
  },
});
const response = await app.inject({ method: 'GET', url: '/health/ready' });
expect(response.statusCode).toBe(200);
```

### 8.3 E2E Tests (Target: Full System)

- **Scope**: Full stack including database.
- **Speed**: Slow (container startup ~5-10s).
- **Technique**: **Testcontainers** (Real PostgreSQL). Verify SQL queries, data integrity, and system behavior.
- **Usage**: Repository implementations, critical user paths. Keep these minimal.

```typescript
// E2E test with Testcontainers
beforeAll(async () => {
  await setupTestDatabase(); // Starts PostgreSQL container
}, 60_000);
```

### 8.4 When to Use Each

| Test Type       | Use For                                    | Don't Use For             |
| :-------------- | :----------------------------------------- | :------------------------ |
| **Unit**        | Business logic, calculations, validations  | HTTP mapping, SQL queries |
| **Integration** | Route handlers, resolvers, error mapping   | Database queries          |
| **E2E**         | Repository implementations, critical flows | Everything else           |

---

## 9. Coding Standards

- **Naming**: `kebab-case` for files. `camelCase` for functions/vars. `PascalCase` for types/classes.
- **Exports**: Prefer named exports. Avoid `export default`.
- **Comments**: Explain _WHY_, not _WHAT_.
- **Formatting**: Prettier + ESLint (Standard).

---
