# Functional Core, Imperative Shell in Fastify

The pattern combines **Functional Core, Imperative Shell** (Gary Bernhardt) with **Hexagonal Architecture** (Ports & Adapters). The core contains all business logic as pure functions with dependencies passed as arguments. The shell handles all I/O and wires everything together.

## The Mental Model

```
┌─────────────────────────────────────────────────────┐
│              IMPERATIVE SHELL                       │
│  Fastify routes, Mercurius resolvers, DB clients,  │
│  config, logger, env vars, Date.now(), crypto      │
│                                                     │
│    ┌───────────────────────────────────────────┐   │
│    │           FUNCTIONAL CORE                 │   │
│    │   Domain types, invariants, calculations  │   │
│    │   Use-cases with deps as arguments        │   │
│    │   No imports from shell/adapters          │   │
│    └───────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Core**: Domain types, validation, business rules, use-cases. Takes dependencies as arguments (ports/interfaces). No imports from Fastify, Mercurius, Postgres, env vars, `Date.now()`, `crypto.randomUUID()`, etc.

**Shell**: HTTP routes, GraphQL resolvers, DB repositories, config, logger. Maps `request → DTO → domain input` and `domain result/errors → HTTP/GraphQL response`.

---

## Folder Structure: Feature-First vs Layer-First

### Feature-First (Recommended - Scales Well)

```
src/
├── app/                          # Composition root + bootstrap
│   ├── buildApp.ts
│   └── plugins/
│       ├── db.ts
│       ├── graphql.ts
│       ├── auth.ts
│       └── observability.ts
│
├── modules/
│   ├── users/
│   │   ├── core/
│   │   │   ├── domain.ts         # Types, invariants, calculations
│   │   │   ├── errors.ts         # Domain errors
│   │   │   ├── ports.ts          # Interfaces (what we need)
│   │   │   └── usecases/
│   │   │       ├── createUser.ts
│   │   │       ├── createUser.test.ts
│   │   │       └── getUser.ts
│   │   └── adapters/
│   │       ├── http/
│   │       │   ├── routes.ts
│   │       │   └── schemas.ts    # Validation (TypeBox/Zod)
│   │       ├── graphql/
│   │       │   ├── resolvers.ts
│   │       │   └── schema.ts
│   │       └── db/
│   │           └── userRepo.pg.ts
│   │
│   └── orders/
│       ├── core/
│       └── adapters/
│
├── shared/
│   ├── core/
│   │   ├── result.ts             # Result/Either helpers
│   │   └── validation.ts
│   ├── adapters/
│   │   ├── httpErrorMap.ts
│   │   └── gqlErrorMap.ts
│   └── infra/
│       ├── logger.ts
│       ├── config.ts
│       ├── clock.ts
│       └── idGen.ts
│
└── test/
    ├── unit/
    ├── integration/
    └── helpers/
        └── inMemoryRepos.ts
```

### Layer-First (Simpler, but doesn't scale)

```
src/
├── domain/          # Becomes a "god folder"
├── usecases/        # Hard to find related code
├── adapters/
└── ...
```

Feature-first keeps related code together. When you work on "users," everything is in `modules/users/`.

---

## Implementation

### 1. Domain Types with Branded Types (core/domain.ts)

Branded types provide compile-time safety for primitive values:

```typescript
// src/modules/users/core/domain.ts

// Branded types - prevent mixing up strings
export type UserId = string & { readonly __brand: unique symbol };
export type Email = string & { readonly __brand: unique symbol };

// Smart constructors
export function createUserId(id: string): UserId {
  return id as UserId;
}

export function normalizeEmail(raw: string): Email {
  return raw.trim().toLowerCase() as Email;
}

// Pure validation
export function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}

export function isValidPassword(password: string): boolean {
  return password.length >= 8;
}

// Domain entity
export interface User {
  id: UserId;
  email: Email;
  passwordHash: string;
  createdAt: Date;
}
```

### 2. Domain Errors (core/errors.ts)

Domain errors are thrown by use-cases, mapped to HTTP/GraphQL codes in the shell:

```typescript
// src/modules/users/core/errors.ts

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailInvalidError extends DomainError {
  constructor(public readonly email: string) {
    super(`Invalid email format: ${email}`);
  }
}

export class EmailAlreadyUsedError extends DomainError {
  constructor(public readonly email: string) {
    super(`Email already registered: ${email}`);
  }
}

export class PasswordTooWeakError extends DomainError {
  constructor() {
    super('Password must be at least 8 characters');
  }
}

export class UserNotFoundError extends DomainError {
  constructor(public readonly userId: string) {
    super(`User not found: ${userId}`);
  }
}
```

### 3. Ports - Interfaces (core/ports.ts)

Ports define what the core needs without specifying how:

```typescript
// src/modules/users/core/ports.ts
import type { User, UserId, Email } from './domain';

// Repository port
export interface UserRepo {
  findById(id: UserId): Promise<User | null>;
  findByEmail(email: Email): Promise<User | null>;
  insert(user: User): Promise<void>;
  update(id: UserId, data: Partial<Omit<User, 'id'>>): Promise<void>;
}

// Crypto port
export interface Hasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

// Time port - makes testing deterministic
export interface Clock {
  now(): Date;
}

// ID generation port
export interface IdGen {
  uuid(): string;
}

// Transaction port (for complex operations)
export interface UnitOfWork {
  transaction<T>(fn: (repos: { userRepo: UserRepo }) => Promise<T>): Promise<T>;
}

// Bundle for convenience
export interface UserUseCaseDeps {
  userRepo: UserRepo;
  hasher: Hasher;
  clock: Clock;
  idGen: IdGen;
}
```

### 4. Use-Cases - Pure Business Logic (core/usecases/)

Use-cases orchestrate domain logic. All side effects go through ports:

```typescript
// src/modules/users/core/usecases/createUser.ts
import { isValidEmail, isValidPassword, normalizeEmail, createUserId, User } from '../domain';
import { EmailInvalidError, EmailAlreadyUsedError, PasswordTooWeakError } from '../errors';
import type { UserUseCaseDeps } from '../ports';

export interface CreateUserInput {
  email: string;
  password: string;
}

export interface CreateUserOutput {
  id: string;
  email: string;
}

export async function createUser(
  deps: UserUseCaseDeps,
  input: CreateUserInput
): Promise<CreateUserOutput> {
  // Validate (pure)
  if (!isValidEmail(input.email)) {
    throw new EmailInvalidError(input.email);
  }
  if (!isValidPassword(input.password)) {
    throw new PasswordTooWeakError();
  }

  // Normalize
  const email = normalizeEmail(input.email);

  // Check uniqueness (via port)
  const existing = await deps.userRepo.findByEmail(email);
  if (existing) {
    throw new EmailAlreadyUsedError(input.email);
  }

  // Create user
  const user: User = {
    id: createUserId(deps.idGen.uuid()),
    email,
    passwordHash: await deps.hasher.hash(input.password),
    createdAt: deps.clock.now(),
  };

  await deps.userRepo.insert(user);

  return { id: user.id, email: user.email };
}
```

```typescript
// src/modules/users/core/usecases/getUser.ts
import type { UserRepo } from '../ports';
import type { UserId } from '../domain';
import { UserNotFoundError } from '../errors';

export interface GetUserDeps {
  userRepo: UserRepo;
}

export async function getUser(
  deps: GetUserDeps,
  userId: string
): Promise<{ id: string; email: string; createdAt: Date }> {
  const user = await deps.userRepo.findById(userId as UserId);

  if (!user) {
    throw new UserNotFoundError(userId);
  }

  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
  };
}
```

### 5. Shared Infrastructure (shared/infra/)

```typescript
// src/shared/infra/clock.ts
import type { Clock } from '../../modules/users/core/ports';

export function createClock(): Clock {
  return {
    now: () => new Date(),
  };
}

// For testing
export function createFixedClock(date: Date): Clock {
  return {
    now: () => date,
  };
}
```

```typescript
// src/shared/infra/idGen.ts
import { randomUUID } from 'crypto';
import type { IdGen } from '../../modules/users/core/ports';

export function createIdGen(): IdGen {
  return {
    uuid: () => randomUUID(),
  };
}

// For testing
export function createSequentialIdGen(prefix = 'id'): IdGen {
  let counter = 0;
  return {
    uuid: () => `${prefix}-${++counter}`,
  };
}
```

### 6. DB Adapter (adapters/db/)

The only place that knows about SQL/ORM:

```typescript
// src/modules/users/adapters/db/userRepo.pg.ts
import type { Pool } from 'pg';
import type { UserRepo } from '../../core/ports';
import type { User, UserId, Email } from '../../core/domain';
import { createUserId } from '../../core/domain';

export function createPostgresUserRepo(pool: Pool): UserRepo {
  return {
    async findById(id: UserId): Promise<User | null> {
      const result = await pool.query(
        'SELECT id, email, password_hash, created_at FROM users WHERE id = $1',
        [id]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async findByEmail(email: Email): Promise<User | null> {
      const result = await pool.query(
        'SELECT id, email, password_hash, created_at FROM users WHERE email = $1',
        [email]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async insert(user: User): Promise<void> {
      await pool.query(
        `INSERT INTO users (id, email, password_hash, created_at)
         VALUES ($1, $2, $3, $4)`,
        [user.id, user.email, user.passwordHash, user.createdAt]
      );
    },

    async update(id: UserId, data: Partial<Omit<User, 'id'>>): Promise<void> {
      const fields: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (data.email !== undefined) {
        fields.push(`email = $${paramIndex++}`);
        values.push(data.email);
      }
      if (data.passwordHash !== undefined) {
        fields.push(`password_hash = $${paramIndex++}`);
        values.push(data.passwordHash);
      }

      if (fields.length === 0) return;

      values.push(id);
      await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex}`, values);
    },
  };
}

function mapRow(row: any): User {
  return {
    id: createUserId(row.id),
    email: row.email as Email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}
```

### 7. In-Memory Adapter for Testing

```typescript
// src/test/helpers/inMemoryUserRepo.ts
import type { UserRepo } from '../../modules/users/core/ports';
import type { User, UserId, Email } from '../../modules/users/core/domain';

export function createInMemoryUserRepo(initial: User[] = []): UserRepo & {
  _data: Map<string, User>;
  _clear(): void;
} {
  const data = new Map<string, User>(initial.map((u) => [u.id, u]));

  return {
    _data: data,
    _clear: () => data.clear(),

    async findById(id: UserId) {
      return data.get(id) ?? null;
    },

    async findByEmail(email: Email) {
      for (const user of data.values()) {
        if (user.email === email) return user;
      }
      return null;
    },

    async insert(user: User) {
      data.set(user.id, { ...user });
    },

    async update(id: UserId, updates: Partial<Omit<User, 'id'>>) {
      const user = data.get(id);
      if (user) {
        data.set(id, { ...user, ...updates });
      }
    },
  };
}
```

### 8. HTTP Routes - The Shell (adapters/http/)

Validate at the edge, map errors to HTTP codes:

```typescript
// src/modules/users/adapters/http/schemas.ts
import { Type, Static } from '@sinclair/typebox';

export const CreateUserBodySchema = Type.Object({
  email: Type.String({ format: 'email' }),
  password: Type.String({ minLength: 8 }),
});

export type CreateUserBody = Static<typeof CreateUserBodySchema>;

export const UserParamsSchema = Type.Object({
  id: Type.String(),
});

export type UserParams = Static<typeof UserParamsSchema>;
```

```typescript
// src/modules/users/adapters/http/routes.ts
import type { FastifyPluginAsync } from 'fastify';
import { createUser } from '../../core/usecases/createUser';
import { getUser } from '../../core/usecases/getUser';
import {
  EmailInvalidError,
  EmailAlreadyUsedError,
  PasswordTooWeakError,
  UserNotFoundError,
} from '../../core/errors';
import { CreateUserBodySchema, UserParamsSchema } from './schemas';

export const usersRoutes: FastifyPluginAsync = async (app) => {
  // Dependencies wired from app context
  const deps = {
    userRepo: app.repos.user,
    hasher: app.hasher,
    clock: app.clock,
    idGen: app.idGen,
  };

  // POST /users
  app.post(
    '/users',
    {
      schema: {
        body: CreateUserBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const result = await createUser(deps, request.body);
        return reply.status(201).send(result);
      } catch (error) {
        // Map domain errors to HTTP responses
        if (error instanceof EmailInvalidError) {
          return reply.status(400).send({
            error: 'INVALID_EMAIL',
            message: error.message,
          });
        }
        if (error instanceof EmailAlreadyUsedError) {
          return reply.status(409).send({
            error: 'EMAIL_ALREADY_USED',
            message: error.message,
          });
        }
        if (error instanceof PasswordTooWeakError) {
          return reply.status(400).send({
            error: 'PASSWORD_TOO_WEAK',
            message: error.message,
          });
        }
        throw error; // Let Fastify handle unexpected errors
      }
    }
  );

  // GET /users/:id
  app.get<{ Params: { id: string } }>(
    '/users/:id',
    {
      schema: {
        params: UserParamsSchema,
      },
    },
    async (request, reply) => {
      try {
        const user = await getUser({ userRepo: deps.userRepo }, request.params.id);
        return user;
      } catch (error) {
        if (error instanceof UserNotFoundError) {
          return reply.status(404).send({
            error: 'USER_NOT_FOUND',
            message: error.message,
          });
        }
        throw error;
      }
    }
  );
};
```

### 9. GraphQL Resolvers - Same Core, Different Shell

```typescript
// src/modules/users/adapters/graphql/resolvers.ts
import { createUser } from '../../core/usecases/createUser';
import { getUser } from '../../core/usecases/getUser';
import { EmailInvalidError, EmailAlreadyUsedError, UserNotFoundError } from '../../core/errors';
import type { UserUseCaseDeps, GetUserDeps } from '../../core/ports';

// Factory pattern - deps injected at composition time
export function makeUserResolvers(deps: UserUseCaseDeps) {
  return {
    Query: {
      user: async (_: unknown, args: { id: string }) => {
        try {
          return await getUser({ userRepo: deps.userRepo }, args.id);
        } catch (error) {
          if (error instanceof UserNotFoundError) {
            return null; // GraphQL convention: return null for not found
          }
          throw error;
        }
      },
    },

    Mutation: {
      createUser: async (_: unknown, args: { input: { email: string; password: string } }) => {
        try {
          return await createUser(deps, args.input);
        } catch (error) {
          // Map to GraphQL errors with extensions
          if (error instanceof EmailInvalidError) {
            throw new Error('Invalid email format');
          }
          if (error instanceof EmailAlreadyUsedError) {
            throw new Error('Email already registered');
          }
          throw error;
        }
      },
    },
  };
}
```

### 10. Composition Root (app/buildApp.ts)

The only place that reads config, creates real clients, and wires modules:

```typescript
// src/app/buildApp.ts
import Fastify from 'fastify';
import { Pool } from 'pg';
import bcrypt from 'bcrypt';

import { createPostgresUserRepo } from '../modules/users/adapters/db/userRepo.pg';
import { usersRoutes } from '../modules/users/adapters/http/routes';
import { makeUserResolvers } from '../modules/users/adapters/graphql/resolvers';
import { createClock } from '../shared/infra/clock';
import { createIdGen } from '../shared/infra/idGen';

// Type augmentation
declare module 'fastify' {
  interface FastifyInstance {
    repos: { user: UserRepo };
    hasher: Hasher;
    clock: Clock;
    idGen: IdGen;
  }
}

export async function buildApp(config: AppConfig) {
  const app = Fastify({ logger: true });

  // Infrastructure
  const pool = new Pool({ connectionString: config.databaseUrl });

  // Create adapters
  const userRepo = createPostgresUserRepo(pool);
  const hasher = {
    hash: (plain: string) => bcrypt.hash(plain, 10),
    verify: (plain: string, hash: string) => bcrypt.compare(plain, hash),
  };
  const clock = createClock();
  const idGen = createIdGen();

  // Decorate Fastify with dependencies
  app.decorate('repos', { user: userRepo });
  app.decorate('hasher', hasher);
  app.decorate('clock', clock);
  app.decorate('idGen', idGen);

  // Register HTTP routes
  app.register(usersRoutes, { prefix: '/api' });

  // Register GraphQL (Mercurius)
  const resolvers = makeUserResolvers({ userRepo, hasher, clock, idGen });
  await app.register(import('@mercuriusjs/gateway'), {
    schema: userSchema,
    resolvers,
  });

  // Graceful shutdown
  app.addHook('onClose', async () => {
    await pool.end();
  });

  return app;
}
```

---

## Testing Strategy

### Testing Pyramid

```
          /\
         /  \      E2E (5-10%)
        /----\     Real server, real DB
       /      \    Smoke tests only
      /--------\   Integration (15-25%)
     /          \  Fastify.inject + real/test DB
    /------------\ Contract tests for adapters
   /              \
  /----------------\  Unit (70-80%)
 /                  \ Pure domain + use-cases
/                    \ Stubbed deps, no I/O
```

### Unit Tests - Core Logic (Most Coverage)

No mocking libraries needed - just pass test doubles:

```typescript
// src/modules/users/core/usecases/createUser.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createUser } from './createUser';
import { EmailInvalidError, EmailAlreadyUsedError } from '../errors';
import { createInMemoryUserRepo } from '../../../../test/helpers/inMemoryUserRepo';

describe('createUser', () => {
  const fixedDate = new Date('2024-01-01T00:00:00Z');

  // Test doubles - no mocking library needed
  const makeDeps = (repoOverrides = {}) => ({
    userRepo: createInMemoryUserRepo(),
    hasher: {
      hash: async (p: string) => `hashed:${p}`,
      verify: async () => true,
    },
    clock: { now: () => fixedDate },
    idGen: { uuid: () => 'test-uuid-1' },
    ...repoOverrides,
  });

  it('creates user with valid input', async () => {
    const deps = makeDeps();

    const result = await createUser(deps, {
      email: 'Test@Example.com',
      password: 'securepass123',
    });

    expect(result).toEqual({
      id: 'test-uuid-1',
      email: 'test@example.com', // Normalized
    });

    // Verify side effect
    const stored = await deps.userRepo.findById('test-uuid-1' as any);
    expect(stored).not.toBeNull();
    expect(stored?.passwordHash).toBe('hashed:securepass123');
  });

  it('throws EmailInvalidError for invalid email', async () => {
    const deps = makeDeps();

    await expect(
      createUser(deps, { email: 'not-an-email', password: 'securepass123' })
    ).rejects.toThrow(EmailInvalidError);
  });

  it('throws EmailAlreadyUsedError for duplicate email', async () => {
    const deps = makeDeps();

    // First creation succeeds
    await createUser(deps, { email: 'taken@example.com', password: 'pass1234' });

    // Second creation fails
    await expect(
      createUser(deps, { email: 'TAKEN@example.com', password: 'pass5678' })
    ).rejects.toThrow(EmailAlreadyUsedError);
  });
});
```

### Integration Tests - HTTP Routes

```typescript
// src/modules/users/adapters/http/routes.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { usersRoutes } from './routes';
import { createInMemoryUserRepo } from '../../../../test/helpers/inMemoryUserRepo';

describe('POST /users', () => {
  const buildTestApp = async () => {
    const app = Fastify();

    // Wire test dependencies
    app.decorate('repos', { user: createInMemoryUserRepo() });
    app.decorate('hasher', { hash: async (p: string) => `h:${p}`, verify: async () => true });
    app.decorate('clock', { now: () => new Date('2024-01-01') });
    app.decorate('idGen', { uuid: () => 'test-id' });

    await app.register(usersRoutes);
    return app;
  };

  it('returns 201 with created user', async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { email: 'test@example.com', password: 'securepass123' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: 'test-id',
      email: 'test@example.com',
    });
  });

  it('returns 400 for invalid email', async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { email: 'invalid', password: 'securepass123' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('INVALID_EMAIL');
  });

  it('returns 409 for duplicate email', async () => {
    const app = await buildTestApp();

    // First request
    await app.inject({
      method: 'POST',
      url: '/users',
      payload: { email: 'taken@example.com', password: 'pass1234' },
    });

    // Duplicate
    const response = await app.inject({
      method: 'POST',
      url: '/users',
      payload: { email: 'taken@example.com', password: 'pass5678' },
    });

    expect(response.statusCode).toBe(409);
  });
});
```

### Contract Tests - Adapter Verification

Verify that adapter implementations satisfy port semantics:

```typescript
// src/modules/users/adapters/db/userRepo.contract.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createPostgresUserRepo } from './userRepo.pg';
import type { UserRepo } from '../../core/ports';

// Run same tests against any UserRepo implementation
function runUserRepoContract(
  name: string,
  createRepo: () => Promise<{ repo: UserRepo; cleanup: () => Promise<void> }>
) {
  describe(`UserRepo contract: ${name}`, () => {
    let repo: UserRepo;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
      const result = await createRepo();
      repo = result.repo;
      cleanup = result.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    it('returns null for non-existent user', async () => {
      const user = await repo.findById('non-existent' as any);
      expect(user).toBeNull();
    });

    it('inserts and retrieves user by id', async () => {
      const user = {
        id: 'contract-test-1' as any,
        email: 'contract@test.com' as any,
        passwordHash: 'hash',
        createdAt: new Date(),
      };

      await repo.insert(user);
      const found = await repo.findById(user.id);

      expect(found).toMatchObject({
        id: user.id,
        email: user.email,
      });
    });

    it('finds user by email (case-insensitive after normalization)', async () => {
      const found = await repo.findByEmail('contract@test.com' as any);
      expect(found).not.toBeNull();
    });
  });
}

// Run against Postgres
runUserRepoContract('Postgres', async () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await pool.query('DELETE FROM users WHERE email LIKE $1', ['contract@%']);

  return {
    repo: createPostgresUserRepo(pool),
    cleanup: async () => {
      await pool.query('DELETE FROM users WHERE email LIKE $1', ['contract@%']);
      await pool.end();
    },
  };
});
```

---

## Practical Rules (Keep the Architecture Clean)

1. **No imports from `adapters/` into `core/`** - Only the reverse is allowed.

2. **Edge validation only** - TypeBox/Zod schemas live in adapters; core assumes typed inputs.

3. **Domain errors are domain concerns** - Mapped to HTTP codes or GraphQL extensions in the shell.

4. **Composition root is the only place** that reads env vars, constructs real clients, and wires modules.

5. **Feature modules over global layers** - Keep users, orders, auth together, not split across domain/, usecases/, adapters/.

6. **Ports are interfaces, adapters are implementations** - Core depends only on ports.

7. **Pure functions where possible** - Validation, normalization, calculations should have no deps.

8. **Test doubles over mocks** - In-memory repos and fixed clocks are simpler and more reliable than mocking libraries.

---

This structure gives you testable code with clear boundaries, where the core business logic is completely isolated from infrastructure concerns. Want me to create a working starter repository you can clone?
