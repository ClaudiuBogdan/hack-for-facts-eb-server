# AGENTS.md

## Commands

- **Build/Check:** `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm ci` (full pipeline)
- **Test all:** `pnpm test` | **Single test:** `pnpm vitest run tests/unit/health/get-readiness.test.ts`
- **Test suites:** `pnpm test:unit`, `pnpm test:integration`, `pnpm test:e2e`
- **Dependency check:** `pnpm deps:check` (circular deps) | `pnpm deps:graph` (visual graph, requires Graphviz)

## Code Style

- **Formatting:** Prettier auto-formats on save; run `pnpm format` manually
- **Imports:** Use path aliases (`@/modules/*`, `@/common/*`, `@/infra/*`); prefer relative within same module
- **Naming:** Files: `kebab-case.ts` | Types: `PascalCase` | Functions: `camelCase` | Constants: `UPPER_CASE`
- **Types:** Use TypeBox schemas with `Schema` suffix (e.g., `DatasetFileSchema`); validate with `Value.Check()`

## Critical Rules

- **No floats:** Use `decimal.js` for all numeric calculations (ESLint blocks `parseFloat`)
- **No throws in core/:** Return `Result<T, E>` from `neverthrow`; only shell/ may throw
- **Strict booleans:** Always use explicit checks (`amount !== 0`), never truthy (`if (amount)`)
- **No raw JSON.parse:** Use TypeBox validation instead
- **Architecture:** `core/` = pure logic (no I/O) | `shell/` = adapters | `infra/` = infrastructure

## Security

- **NEVER read `.env` files** — Environment files contain secrets (API keys, database credentials). Do not read, display, or reference their contents. Use `.env.example` as a template reference instead.

## Module Dependencies

- **Layer flow:** `app/` → `modules/` → `infra/` → `common/` (never upward)
- **Core imports:** Only `common/*`, `neverthrow`, `decimal.js`, `@sinclair/typebox`; NO I/O libs
- **Shell imports:** Own `core/`, `common/*`, `infra/*`, other module's `index.ts` (public API only)
- **Cross-module:** Import types from `index.ts` only; never import other module's internals
- **Circular prevention:** ESLint `import-x/no-cycle` + `boundaries/element-types` enforce rules

## Testing

- Unit tests use in-memory fakes, no mocking libraries (no `jest.mock`/`sinon`)
- Test files mirror source structure in `tests/unit/`, `tests/integration/`, `tests/e2e/`
- Test fixtures in `tests/fixtures/` (builders, fakes, in-memory-db)
