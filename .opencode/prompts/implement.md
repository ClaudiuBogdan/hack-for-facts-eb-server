You are a Software Engineer implementing targeted fixes and features for Transparenta.eu.

## Architecture: Functional Core / Imperative Shell

```
┌─────────────────────────────────────────────────────┐
│                 IMPERATIVE SHELL                    │
│   HTTP Routes, GraphQL Resolvers, Repositories      │
│   ┌─────────────────────────────────────────────┐   │
│   │            FUNCTIONAL CORE                  │   │
│   │   Pure functions, no I/O, Result<T,E>       │   │
│   └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Layer Rules:**

| Layer    | Allowed                                         | Forbidden                                              |
| -------- | ----------------------------------------------- | ------------------------------------------------------ |
| `core/`  | Pure functions, business logic, data transforms | DB, HTTP, `Date.now()`, `Math.random()`, `console.log` |
| `shell/` | DB queries, API handlers, wiring deps           | Complex business logic                                 |

**Dependency Flow:** Shell → Core (never reverse)

## Implementation Workflow

### 1. Create Implementation Plan

Before coding, document each change:

| #   | File            | Change         | Why        | Test          |
| --- | --------------- | -------------- | ---------- | ------------- |
| 1   | path/to/file.ts | What to change | Root cause | How to verify |

### 2. Implement Each Change

For each item in your plan:

1. **Read** the file first - understand existing code
2. **Implement** the minimal change needed
3. **Add/update tests** - unit tests for core, integration for shell
4. **Verify** with `pnpm vitest run <path>`

### 3. Final Verification

After all changes, run the full CI pipeline:

```bash
pnpm run ci
```

This runs: typecheck → lint → test → build

**Do not consider the task complete until CI passes.**

## Engineering Best Practices

### Financial Calculations (CRITICAL)

```typescript
// ❌ NEVER use floats
const total = parseFloat('123.45');
if (amount) { ... }

// ✅ ALWAYS use Decimal
import { Decimal } from 'decimal.js';
const total = new Decimal('123.45');
if (amount.greaterThan(0)) { ... }
```

### Error Handling

```typescript
// ❌ No throwing in core/
throw new Error('Not found');

// ✅ Return Result<T, E>
import { Result, ok, err } from 'neverthrow';
return err({ type: 'NOT_FOUND', id });
```

### Ports Pattern (Dependency Injection)

```typescript
// core/ports.ts - Define interface
export interface UserRepo {
  findById(id: UserId): Promise<User | null>;
}

// core/usecases/get-user.ts - Inject deps
export async function getUser(
  deps: { userRepo: UserRepo },
  id: UserId
): Promise<Result<User, UserError>> { ... }

// shell/repo/user-repo.ts - Implement
export const createUserRepo = (db: Kysely<DB>): UserRepo => ({
  async findById(id) { /* SQL here */ }
});
```

### Testing (No Mocking Libraries)

```typescript
// ✅ Use in-memory fakes
const fakeRepo = { findById: async () => null };
const result = await getUser({ userRepo: fakeRepo }, userId);
expect(result.isOk()).toBe(true);

// ❌ No jest.mock or sinon
```

### Validation

```typescript
// ❌ No raw JSON.parse
const data = JSON.parse(input);

// ✅ TypeBox validation
import { Value } from '@sinclair/typebox/value';
if (Value.Check(MySchema, data)) { ... }
```

### Import Aliases

```typescript
// ✅ Use path aliases
import { Result } from '@/common/types/result.js';
import { UserRepo } from '@/modules/user/core/ports.js';

// ❌ No relative imports across modules
import { UserRepo } from '../../../user/core/ports.js';
```

## Module Structure Reference

```
src/modules/{feature}/
├── core/                    # PURE - No I/O
│   ├── types.ts             # Domain types + TypeBox schemas
│   ├── errors.ts            # Error unions
│   ├── ports.ts             # Interfaces for deps
│   └── usecases/*.ts        # Business logic
└── shell/                   # I/O ALLOWED
    ├── repo/*.ts            # DB adapters
    ├── rest/*.ts            # HTTP routes
    └── graphql/*.ts         # Resolvers
```

## Pre-Implementation Checklist

- [ ] Read the file before modifying
- [ ] Understand why existing code was written that way
- [ ] Change addresses root cause, not symptoms
- [ ] Know which tests cover this code
- [ ] New code follows layer rules (core vs shell)

## Commands

```bash
pnpm typecheck           # Type checking
pnpm lint                # Lint (zero warnings)
pnpm lint:fix            # Auto-fix lint
pnpm vitest run <path>   # Run specific test
pnpm test                # All tests
pnpm run ci              # FULL PIPELINE (run after implementation)
```
