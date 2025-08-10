## Repository improvements TODO

- [ ] Standardize SQL builder helpers across repositories
  - Add `src/db/utils/sqlBuilder.ts` with param index manager, ensureJoin, and helpers: `addIn`, `addLikeAny`, `addRange`.
  - Justification: Eliminates duplicated ad-hoc code, prevents placeholder/casting mistakes, and makes filters easier to extend.

- [ ] Finish single builder reuse in all repos
  - Ensure each repo exports one `buildFilterParts(filter, initialIndex?)` reused by both list and count; add optional `buildHaving` where needed.
  - Justification: Guarantees consistency between result and count queries and avoids logic drift.

- [ ] Decouple search param indexing from $1
  - Remove the assumption that search must occupy `$1/$2`; support flexible offsets and expose `searchParamsOffset` to ORDER BY builders.
  - Justification: Future-proofs composition and nested builders without brittle constraints.

- [ ] Centralize safe ORDER BY construction
  - Introduce `buildOrderBy(allowedMap, requested)` utility used by all repos.
  - Justification: Prevents SQL injection and ensures consistent sorting semantics across APIs.

- [ ] Use explicit column selection and row mappers
  - Replace `SELECT *` with explicit column lists; add small mappers to coerce types (int/float/nullables) consistently.
  - Justification: Reduces payload size, clarifies contracts, and protects against schema drift.

- [ ] Prepared statements and per-query timeouts
  - Name frequent queries and set `SET LOCAL statement_timeout = '5s'` (or config) for long analytics.
  - Justification: Lowers parse overhead and avoids runaway queries under load.

- [ ] Query metrics and slow-query logging
  - Wrap `pool.query` with timing, row count, cache hit flag, and SQL hash; log when duration exceeds threshold.
  - Justification: Enables data-driven tuning and regression detection in CI/ops.

- [ ] Unify caching policy
  - Replace ad-hoc caches with a `QueryCache` supporting TTL, size limits, and tag-based invalidation (e.g., `invalidate('reports:*')`).
  - Justification: Predictable memory usage and safe invalidation when ETL refreshes data.

- [ ] Validate filter DTOs at repository boundary
  - Use a lightweight schema (e.g., zod) for arrays, domains (account_category), ranges (min<=max), and non-empty `years`.
  - Justification: Fail fast with actionable errors; fewer DB roundtrips.

- [ ] Repository test harness
  - Provide dockerized PG with seed SQL and golden tests for filters, HAVING thresholds, and ordering.
  - Justification: Prevents regressions in builders and result shaping.

- [ ] Read-only transactions for read APIs
  - Wrap read queries with `BEGIN READ ONLY;` (or set via connection) to enforce no writes.
  - Justification: Safety and better DB policy enforcement.

- [ ] Extract analytics normalization helpers
  - Share population expressions and per-capita formulas (UAT/județ/entity) as reusable CTE snippets.
  - Justification: Single source of truth, fewer subtle inconsistencies across analytics.

- [ ] Pagination defaults and guards
  - Enforce max `limit`, default `orderBy`, and deterministic tiebreakers.
  - Justification: Predictable latency and consistent UX.

- [ ] Large-set IN optimization
  - For long arrays, fall back to `UNNEST(...)` join or temp table pattern behind a size threshold.
  - Justification: Keeps planner efficient for large filter lists.

- [ ] Error taxonomy for repos
  - Use typed errors (ValidationError, NotFoundError, DbError) with operation context and sanitized details.
  - Justification: Cleaner handling in services/resolvers and improved observability.

- [ ] Connection and pool tuning
  - Review pool size, idle timeout, connection timeouts, and set `application_name` per service.
  - Justification: Stable throughput and better DB-side monitoring.

- [ ] SQL linting and EXPLAIN checks in CI
  - Add a smoke suite that runs `EXPLAIN (ANALYZE, BUFFERS)` for representative queries and asserts plan stability.
  - Justification: Early detection of performance regressions.

- [ ] Documentation
  - Short docs per repository: supported filters, sort fields, defaults, and example queries.
  - Justification: Faster onboarding and consistent usage by API consumers.


