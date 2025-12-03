“Core–shell” (often described as **Functional Core, Imperative Shell**) means: keep _all business logic_ in a “core” made of **pure functions** and **dependency-free use-cases**, and put all I/O (HTTP, GraphQL, DB, queues, time, randomness, logging) in a thin “shell” that **wires dependencies** and **translates** between the outside world and the core.

## 1) The mental model (Fastify-friendly)

**Core**

- Domain types, invariants, calculations.
- Use-cases that orchestrate domain logic but take dependencies as **arguments** (ports/interfaces).
- No imports from Fastify, Mercurius, Postgres, env vars, Date.now(), random UUID, etc.

**Shell**

- Fastify routes + hooks, Mercurius resolvers, DB repositories, config, logger.
- Maps `request -> DTO -> domain input`, and `domain result/errors -> HTTP/GraphQL response`.

This is basically Hexagonal/Clean Architecture, but with an explicit emphasis on purity.

---

## 2) Recommended layering (ports/adapters)

Define **ports** in the core (interfaces). Implement them in adapters.

### Example ports

- `UserRepo` (DB access)
- `Hasher` (crypto)
- `Clock` (time)
- `IdGen` (uuid)
- `Tx` / `UnitOfWork` (transactions)

Core depends only on ports. Shell provides implementations.

---

## 3) A concrete TypeScript structure for a Fastify + GraphQL + DB app

### Option A (feature-first, scales well)

```txt
src/
  app/                    # composition root + Fastify bootstrap
    buildApp.ts
    plugins/
      db.ts
      graphql.ts
      auth.ts
      observability.ts
  modules/
    users/
      core/
        domain.ts
        errors.ts
        usecases/
          createUser.ts
          getUser.ts
        ports.ts
      adapters/
        http/
          routes.ts
          schemas.ts
        graphql/
          resolvers.ts
          schema.ts
        db/
          userRepo.pg.ts
  shared/
    core/
      result.ts           # Result/Either helpers (optional)
      validation.ts
    adapters/
      httpErrorMap.ts
      gqlErrorMap.ts
    infra/
      logger.ts
      config.ts
      idGen.ts
      clock.ts
test/
  unit/
  integration/
  contract/
```

### Option B (layer-first, OK for small apps)

Works, but tends to become “god folders” (`domain/`, `usecases/`, `adapters/` grow huge). I generally prefer feature-first.

---

## 4) How to implement “pure functions with external deps as args”

### Core domain: pure logic

```ts
// src/modules/users/core/domain.ts
export type Email = string & { __brand: 'Email' };

export function normalizeEmail(raw: string): Email {
  return raw.trim().toLowerCase() as Email;
}

export function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}
```

### Core ports (interfaces): no runtime deps

```ts
// src/modules/users/core/ports.ts
import type { Email } from './domain';

export interface UserRepo {
  findByEmail(email: Email): Promise<{ id: string; email: Email } | null>;
  insert(user: { id: string; email: Email; passwordHash: string; createdAt: Date }): Promise<void>;
}

export interface Hasher {
  hash(password: string): Promise<string>;
}

export interface Clock {
  now(): Date;
}

export interface IdGen {
  uuid(): string;
}
```

### Core use-case: orchestration, still deterministic given deps

```ts
// src/modules/users/core/usecases/createUser.ts
import { isValidEmail, normalizeEmail } from '../domain';
import type { Clock, Hasher, IdGen, UserRepo } from '../ports';

export class EmailInvalid extends Error {}
export class EmailAlreadyUsed extends Error {}

export async function createUser(
  deps: { repo: UserRepo; hasher: Hasher; clock: Clock; idGen: IdGen },
  input: { email: string; password: string }
): Promise<{ id: string; email: string }> {
  if (!isValidEmail(input.email)) throw new EmailInvalid();

  const email = normalizeEmail(input.email);
  const existing = await deps.repo.findByEmail(email);
  if (existing) throw new EmailAlreadyUsed();

  const id = deps.idGen.uuid();
  const createdAt = deps.clock.now();
  const passwordHash = await deps.hasher.hash(input.password);

  await deps.repo.insert({ id, email, passwordHash, createdAt });
  return { id, email };
}
```

No Fastify, no DB client import. Every side effect is behind a port.

---

## 5) Shell wiring in Fastify (composition + DI)

Fastify already nudges you toward “shell”: use plugins + `decorate` to expose dependencies.

### DB plugin

```ts
// src/app/plugins/db.ts
import fp from "fastify-plugin";

export default fp(async (app) => {
  // create client/pool here
  const db = /* pg pool or kysely instance */;
  app.decorate("db", db);
});
```

### Users module registration (wires ports to implementations)

```ts
// src/modules/users/adapters/http/routes.ts
import type { FastifyPluginAsync } from 'fastify';
import { createUser, EmailAlreadyUsed, EmailInvalid } from '../../core/usecases/createUser';

export const usersRoutes: FastifyPluginAsync = async (app) => {
  // Adapter implementations (DB repo, hasher, clock, idGen)
  const repo = {
    findByEmail: async (email) => app.db.user.findByEmail(email), // your db adapter
    insert: async (u) => app.db.user.insert(u),
  };

  const deps = {
    repo,
    hasher: app.hasher,
    clock: app.clock,
    idGen: app.idGen,
  };

  app.post('/users', async (req, reply) => {
    const body = req.body as { email: string; password: string }; // validate at edge
    try {
      const out = await createUser(deps, body);
      return reply.code(201).send(out);
    } catch (e) {
      if (e instanceof EmailInvalid) return reply.code(400).send({ message: 'Invalid email' });
      if (e instanceof EmailAlreadyUsed)
        return reply.code(409).send({ message: 'Email already used' });
      throw e;
    }
  });
};
```

Key rule: **validate + parse at the edge**, then call the core with a clean input shape.

---

## 6) GraphQL layer (Mercurius) without polluting the core

GraphQL resolvers are just another adapter calling the same use-cases.

```ts
// src/modules/users/adapters/graphql/resolvers.ts
import { createUser } from '../../core/usecases/createUser';

export function makeUserResolvers(deps: Parameters<typeof createUser>[0]) {
  return {
    Mutation: {
      createUser: async (_: unknown, args: { input: { email: string; password: string } }) => {
        return createUser(deps, args.input);
      },
    },
  };
}
```

The resolver factory takes `deps`, so tests can pass stubs.

---

## 7) DB access: keep SQL/ORM in the adapter

Implement `UserRepo` in `adapters/db/`. This is the only place that knows about columns, joins, SQL, Prisma, Kysely, etc.

```ts
// src/modules/users/adapters/db/userRepo.pg.ts
import type { UserRepo } from '../../core/ports';

export function makeUserRepo(db: any): UserRepo {
  return {
    async findByEmail(email) {
      return db.queryUserByEmail(email); // implement however you want
    },
    async insert(u) {
      await db.insertUser(u);
    },
  };
}
```

If you need transactions, prefer a port like:

- `withTransaction<T>(fn: (repo: UserRepo) => Promise<T>): Promise<T>`
  or a `UnitOfWork` that exposes transactional repos.

---

## 8) Testing strategy (simple and robust)

### Unit tests (fast, most coverage)

- Test **domain** + **use-cases** with stubbed deps (in-memory repo, fake clock/idGen).
- No Fastify instance needed.

Example: in-memory repo + deterministic clock/id

```ts
const repoMem = (() => {
  const byEmail = new Map<string, any>();
  return {
    findByEmail: async (e: any) => byEmail.get(e) ?? null,
    insert: async (u: any) => byEmail.set(u.email, u),
  };
})();

await createUser(
  {
    repo: repoMem,
    hasher: { hash: async () => 'h' },
    clock: { now: () => new Date(0) },
    idGen: { uuid: () => 'id1' },
  },
  { email: 'A@B.com', password: 'pw' }
);
```

### Integration tests (Fastify + adapters)

- Use `fastify.inject()` for HTTP routes (no real network).
- For GraphQL, hit `/graphql` with inject.
- Use a real Postgres via Testcontainers (or a disposable Docker compose) for DB tests.

### Contract tests (adapters)

- Verify repo implementations satisfy `UserRepo` semantics:
  - unique constraints -> mapped to `EmailAlreadyUsed`
  - correct normalization rules
  - transaction behavior (if applicable)

### Suggested pyramid

- 70–80% unit (core)
- 15–25% integration (Fastify/Mercurius + real DB)
- small set of end-to-end (optional)

---

## 9) Practical rules that keep the architecture clean

1. **No imports from `adapters/` into `core/`.** Only the other way around.
2. **Edge validation only** (HTTP/GraphQL): TypeBox/Zod schemas live in adapters; core assumes typed inputs.
3. **Errors in core are domain errors**, mapped in the shell to HTTP codes / GraphQL error extensions.
4. **Composition root is the only place** allowed to read env vars, construct real clients, and wire modules.
5. Prefer **feature modules** (users, auth, budgets, etc.) over global layers.

---

## 10) Fastify-specific wiring pattern that stays clean

- `app/plugins/*`: infra (db, config, auth, logger, observability)
- `modules/*/adapters/http/routes.ts`: register routes, map errors
- `modules/*/adapters/graphql/*`: resolvers/schema
- `modules/*/core/*`: pure domain + use-cases + ports

`buildApp.ts` becomes the composition root:

- register infra plugins
- register each module plugin (routes + graphql), passing wired deps

---

If you want, I can provide:

- a complete minimal “starter” repository skeleton (Fastify + Mercurius + Postgres) following this layout,
- or a single end-to-end “users” module with HTTP + GraphQL + Postgres + tests (unit + integration).
