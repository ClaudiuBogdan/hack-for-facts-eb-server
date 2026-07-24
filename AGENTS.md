# Transparenta.eu Server

The API over the Romanian public-data platform: **REST + GraphQL + MCP**, read-only
over the production database. `AGENTS.md` is the canonical instruction file;
`CLAUDE.md`, `GEMINI.md`, and `.opencode/AGENTS.md` are symlinks to it.

Sibling repos — keep the data shape consistent across all three:

- **scrapper** — extraction, raw DBs, the production DB design, migrations, loaders.
  `~/projects/devostack/hack-for-facts-eb-scrapper` (its `AGENTS.md` is the platform
  context; `prod-db/TRACKER.md` is the live topology + per-source status board).
- **client** — React 19 + TanStack web app. `~/projects/devostack/hack-for-facts-eb-client`

## The binding contract

[`docs/server-redesign/00-foundation-shared-kernel.md`](docs/server-redesign/00-foundation-shared-kernel.md)
**is binding** — read it before designing or changing a data-source module. It fixes:

- **Module-per-source over a `shared/` kernel.** No monolithic explorer module.
- **Full REST + GraphQL + MCP** for every source module.
- **The server is read-only over the serving DB.** No writes, no migrations, ever —
  loaders and migrations live in the scrapper. This is the easiest rule to violate
  by accident and the most expensive to undo.
- A source module **never imports another source module**; cross-source needs go
  through the kernel. The kernel never imports a source module.

Per-source plans are `docs/server-redesign/01..12-*.md`.

## Critical rules

- **No floats.** `decimal.js` or integer math for every numeric calculation; ESLint
  blocks `parseFloat`. Money bugs here are user-visible and hard to detect.
- **No throws in `core/`.** Return `Result<T, E>` from `neverthrow`; only `shell/`
  may throw.
- **Strict booleans.** `0` is a valid financial value — always `amount !== 0`, never
  `if (amount)`.
- **No raw `JSON.parse`.** TypeBox schema + `Value.Check()`.
- **Layer flow is one-way:** `app/` → `modules/` → `infra/` → `common/`.
  `core/` imports only `common/*`, `neverthrow`, `decimal.js`, TypeBox — no I/O.
  `shell/` may import its own `core/`, `common/*`, `infra/*`, and other modules'
  `index.ts` (public API only, never internals). ESLint `import-x/no-cycle` +
  `boundaries/element-types` enforce this; `pnpm deps:check` catches cycles.
- **Never read `.env` files** (`.env`, `.claude/*.env`) or print secret values. Use
  `.env.example` for names. Live DB reads go through the `db-read` skill, never an
  ad-hoc `psql` with a connection string.
- **Privacy is enforced here.** The platform deliberately keeps ALL data — including
  personal data — in the raw and serving DBs and **gates access at this API layer**
  on `privacy_class`. A restricted class must never reach a response, a search
  document, or an MCP tool result. Public figures' public acts are public; personal
  fields are not. Never "fix" a privacy issue by having the scrapper drop data.
- **User-data deletion coverage.** Any new table or JSON document holding
  user-generated data, user-owned state, copied account/contact data, or user-linked
  operational records needs a Clerk `user.deleted` delete/anonymize path, documented
  in [`docs/USER-DATA-ANONYMIZATION.md`](docs/USER-DATA-ANONYMIZATION.md). The
  anonymizer is deliberately not public API — don't bypass the ESLint
  restricted-import rule; route calls through the verified `user.deleted` handler.

## Repo map

- `src/modules/` — ~50 modules. Three generations coexist, and knowing which one
  you're in matters more than any other orientation fact:
  - **Kernel:** `shared/` — the filter DSL, pagination, identity/territory/flows/
    search repos, Meili + OpenSearch + synthetic clients, MCP bootstrap, and
    cache/rate-limit middleware. Extend the kernel rather than forking its logic
    into a source module.
  - **Source modules** (the redesign): `budget`, `companies`, `parliament`, `legal`,
    `judicial`, `pnrr`, `procurement`, `primarii-transparency`, `ins`, `entity`,
    `reference`, `uat`, … — each `core/{ports,types,usecases}` +
    `shell/{repo,rest,graphql,mcp}`, exporting `makeXModule(deps)` from `index.ts`.
  - **Product/platform:** `auth`, `mcp`, `agent` (LLM), `notifications`,
    `notification-platform`, `notification-delivery`, `campaign-*`,
    `clerk-webhooks`, `resend-webhooks`, `email-templates`, `user-data`, `share`,
    `report`, `health`.
  - **Legacy budget-viz** (pre-redesign, still served): `datasets`,
    `execution-analytics`, `execution-line-items`, `aggregated-line-items`,
    `advanced-map-*`, `county-analytics`, `uat-analytics`, `normalization`.
- `src/api.ts` — **what ships** (`Dockerfile` → `dist/api.js`), composed by
  `app/build-app.ts`. `src/redesign-api.ts` — kernel-only dev entrypoint composed by
  `app/build-redesign-app.ts`; it loads no legacy modules and requires no legacy envs.
- `src/infra/` — TypeBox-validated config, Kysely database clients, GraphQL setup,
  logger.
- `docs/` — 148 files. `docs/server-redesign/` is the current contract; most of the
  rest is per-feature specs. `docs/ARCHITECTURE.md` and `docs/TECHNICAL-REFERENCE.md`
  are the deep architecture references.
- Skills (`.claude/skills/`): `dev-bring-up` (run it locally), `verify-and-ship`
  (gates, CI, commits), `db-read` (read-only live SQL), `send-monthly-digest`.

## Conventions

Files `kebab-case.ts` · types `PascalCase` · functions `camelCase` · constants
`UPPER_CASE` · TypeBox schemas `PascalCase` + `Schema` suffix. Path aliases
`@/modules/*`, `@/common/*`, `@/infra/*`, `@/tests/*`; prefer relative imports
within a module. Prettier formats — don't hand-align.

Tests mirror the source structure under `tests/{unit,integration,e2e}/`. **No mocking
libraries** (`jest.mock`/`sinon` are out) — unit tests pass in-memory fakes,
integration tests use `app.inject()` with fakes, e2e uses Testcontainers Postgres.
Builders and fakes live in `tests/fixtures/`.

Work happens on the **`dev` branch** (not `main`), with feature branches per slice.
Conventional commits are enforced by commitlint; the pre-commit hook runs a staged
secret scan, lint-staged, and `pnpm typecheck`. Details: `verify-and-ship` skill.
