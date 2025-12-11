# Module Dependency Strategy

This document defines the rules for imports and dependencies between layers and modules in the codebase.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                           src/app/                                  │
│                      (Composition Root)                             │
│            Wires all modules together, creates app                  │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ imports
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        src/modules/                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   health     │  │   datasets   │  │ normalization│              │
│  │  (isolated)  │  │  (provider)  │  │  (consumer)  │              │
│  └──────────────┘  └──────┬───────┘  └──────┬───────┘              │
│                           │                  │                      │
│                           │    ┌─────────────┘                      │
│                           ▼    ▼                                    │
│                    ┌──────────────────┐                             │
│                    │execution-analytics│                            │
│                    │   (consumer)      │                            │
│                    └──────────────────┘                             │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ imports
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         src/infra/                                  │
│      config/  database/  graphql/  logger/  plugins/                │
│              (Generic infrastructure, no business logic)            │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ imports
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         src/common/                                 │
│             types/  schemas/  (Pure utilities, no I/O)              │
└─────────────────────────────────────────────────────────────────────┘
```

## Layer Rules

### 1. `src/common/` (Leaf Layer)

**Purpose**: Pure types, schemas, and utilities shared across the codebase.

| Can Import                                                | Cannot Import   |
| --------------------------------------------------------- | --------------- |
| External: `neverthrow`, `decimal.js`, `@sinclair/typebox` | `src/infra/*`   |
| Nothing else                                              | `src/modules/*` |
|                                                           | `src/app/*`     |

**Contents**:

- `types/` - Domain-agnostic types (Result, errors, temporal primitives)
- `schemas/` - TypeBox validation schemas

### 2. `src/infra/` (Infrastructure Layer)

**Purpose**: Generic infrastructure adapters (database, config, logging).

| Can Import                                        | Cannot Import   |
| ------------------------------------------------- | --------------- |
| `src/common/*`                                    | `src/modules/*` |
| External: `kysely`, `pg`, `fastify`, `pino`, etc. | `src/app/*`     |

**Contents**:

- `config/` - Environment validation
- `database/` - Kysely clients, schema types, seeds
- `graphql/` - Mercurius plugin, common GraphQL types
- `logger/` - Pino logger factory
- `plugins/` - Fastify plugins (CORS, etc.)

### 3. `src/modules/*/core/` (Business Logic Layer)

**Purpose**: Pure business logic. No I/O, no side effects.

| Can Import                                                | Cannot Import                                          |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `src/common/*`                                            | `src/infra/*`                                          |
| Within same module: `./` siblings                         | Other module `shell/*`                                 |
| External: `neverthrow`, `decimal.js`, `@sinclair/typebox` | I/O libraries: `kysely`, `pg`, `fastify`, `fs`, `http` |

**Cross-Module Core Imports** (Allowed with restrictions):

- Core may import **types only** from other module's `index.ts`
- Core must NOT import implementations from other modules

**Contents**:

- `types.ts` - Domain types, branded types
- `errors.ts` - Domain error unions
- `ports.ts` - Interfaces for dependencies (repositories, services)
- `usecases/*.ts` - Pure business logic functions

### 4. `src/modules/*/shell/` (Adapter Layer)

**Purpose**: Implements ports, connects core to infrastructure.

| Can Import                                | Cannot Import          |
| ----------------------------------------- | ---------------------- |
| `src/common/*`                            | Other module internals |
| `src/infra/*`                             | Other module `shell/*` |
| Same module `core/*`                      |                        |
| Other module `index.ts` (public API only) |                        |

**Contents**:

- `repo/*.ts` - Database adapters (implement ports)
- `rest/*.ts` - Fastify route handlers
- `graphql/*.ts` - Resolvers and schema

### 5. `src/modules/*/index.ts` (Public API)

**Purpose**: Defines what the module exports to the outside world.

**Rules**:

- Export factories: `makeXxxRoutes`, `makeXxxResolvers`, `makeXxxRepo`
- Export types needed by consumers
- Export GraphQL schema strings
- Use explicit named exports (no `export *`)

### 6. `src/app/` (Composition Root)

**Purpose**: Wires all modules and infrastructure together.

| Can Import                | Cannot Import                                |
| ------------------------- | -------------------------------------------- |
| `src/infra/*`             | Module internals (only `index.ts`)           |
| `src/modules/*/index.ts`  | `src/common/*` directly (go through modules) |
| External: anything needed |                                              |

## Cross-Module Dependencies

### Allowed Patterns

```typescript
// ✅ Module shell imports from another module's public API
// src/modules/normalization/shell/service/normalization-service.ts
import type { DatasetRepo } from '@/modules/datasets/index.js';

// ✅ Module core imports TYPES from another module's public API
// src/modules/execution-analytics/core/types.ts
import type { Dataset } from '../../datasets/index.js';
```

### Forbidden Patterns

```typescript
// ❌ Module core imports from infra
// src/modules/xxx/core/types.ts
import type { BudgetDbClient } from '@/infra/database/client.js'; // WRONG

// ❌ Module imports another module's internals
// src/modules/xxx/shell/repo.ts
import { someHelper } from '@/modules/yyy/shell/repo/helper.js'; // WRONG

// ❌ Common imports from modules
// src/common/types/xxx.ts
import { SomeType } from '@/modules/yyy/index.js'; // WRONG
```

### Current Cross-Module Dependencies

| Consumer Module       | Provider Module | What's Imported                             |
| --------------------- | --------------- | ------------------------------------------- |
| `execution-analytics` | `datasets`      | `Dataset`, `DatasetRepo`, `DataPoint` types |
| `normalization`       | `datasets`      | `DatasetRepo` type                          |

These are **intentional** - both modules need dataset access for normalization factors.

## Circular Dependency Prevention

### Tools

1. **ESLint `import-x/no-cycle`** - Detects circular imports at lint time
2. **ESLint `boundaries/element-types`** - Enforces layer boundaries
3. **`madge`** - Visual circular dependency detection

### Scripts

```bash
# Check for circular dependencies
pnpm deps:check

# Generate visual dependency graph
pnpm deps:graph
```

### Rules to Prevent Cycles

1. **Layers flow downward only**: app → modules → infra → common
2. **Modules don't import each other's internals**: Use public API only
3. **Core never imports shell**: Dependencies flow shell → core
4. **Extract shared types to common**: If two modules need the same type, move it to `common/types/`

## Adding New Modules

1. Create structure:

   ```
   src/modules/my-module/
   ├── core/
   │   ├── types.ts      # Domain types
   │   ├── errors.ts     # Domain errors (optional)
   │   ├── ports.ts      # Dependency interfaces
   │   └── usecases/     # Business logic
   ├── shell/
   │   ├── repo/         # Database adapters
   │   ├── rest/         # HTTP routes (optional)
   │   └── graphql/      # GraphQL (optional)
   └── index.ts          # Public API
   ```

2. Define public API in `index.ts`:

   ```typescript
   // Factories
   export { makeMyModuleRepo } from './shell/repo/my-repo.js';
   export { makeMyModuleResolvers } from './shell/graphql/resolvers.js';

   // Types needed by consumers
   export type { MyPublicType } from './core/types.js';

   // GraphQL schema
   export { MyModuleSchema } from './shell/graphql/schema.js';
   ```

3. Wire in `app/build-app.ts`

## ESLint Boundary Rules

The following ESLint rules enforce this strategy:

```javascript
// eslint.config.mjs
'boundaries/element-types': ['error', {
  rules: [
    // Core cannot import shell or infra
    { from: 'core', disallow: ['shell', 'infra', 'app'] },
    // Shell can import core and infra
    { from: 'shell', allow: ['core', 'common', 'infra'] },
    // Infra cannot import modules
    { from: 'infra', disallow: ['core', 'shell'] },
  ]
}],

// Core external dependencies restricted
'boundaries/external': ['error', {
  rules: [{
    from: 'core',
    disallow: ['fastify', 'kysely', 'pg', 'redis', 'bullmq', 'fs', 'http'],
    message: 'Core modules must not import I/O libraries.'
  }]
}],

// Circular dependency detection
'import-x/no-cycle': 'error',
```
