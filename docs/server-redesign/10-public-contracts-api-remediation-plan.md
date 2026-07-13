# Public Contracts API — Remediation Plan (Final)

> **Status:** Approved and committed locally; production publication, push, and deployment remain permission-gated
> **Date:** 2026-07-13
> **Inputs:** [`10-public-contracts-api-remediation-review.md`](./10-public-contracts-api-remediation-review.md) (all findings verified or accepted), companion design [`10-public-contracts.md`](./10-public-contracts.md)
> **Repos:** `hack-for-facts-eb-server` (dev branch) and `hack-for-facts-eb-scrapper` (main), both in isolated worktrees

## 0. Decisions this plan encodes

| Decision            | Choice                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy coexistence  | **Remove** the legacy aggregate surface (review option 1) rather than route or version it. The removal lands in code now; production keeps serving legacy names until the server deploy, which stays permission-gated and coordinated with the client migration. |
| Distinct-series gap | **Matrix contract v2** in the scraper: measure-specific series rows so distinct-series exclusions are hash-pinned in the cross-repo artifact, not server-only exceptions.                                                                                        |
| `topN`              | Reject explicit out-of-range values on both surfaces; default only when absent.                                                                                                                                                                                  |
| Abstention          | Machine-readable answerability state + reason code in every analysis envelope.                                                                                                                                                                                   |
| `link` field        | Renamed to `canonicalScope`; it is scope serialization, not a navigable URL. Deep links belong to the client wave.                                                                                                                                               |
| Performance gates   | Review targets cold p95 ≤ 5 s, warm p95 ≤ 300 ms; **hard deployment gate: no advertised case reaches 12 s** (headroom under the 15 s statement timeout).                                                                                                         |
| Wave 2              | Unknown-bucket selectors, canonical procedure-type keys, and reintroduced analyst features stay deferred (§7).                                                                                                                                                   |
| CronJob             | Remains suspended; activation is a separate operator decision.                                                                                                                                                                                                   |

Findings resolved by construction: P1-4 and P2-7 disappear with the legacy removal; P1-2 becomes a matrix rejection today plus an optional precomputed distinct rollup in a later wave.

## 1. Artifact and input integrity (P0-1, P0-2, P1-1, P1-6)

**Scraper — matrix contract v2** (lane/artifact change only; no DDL migration):

- Extend the generator so series rows carry the measure dimension; emit explicit rejections (named capability) for unbounded direct-acquisition distinct series and ungrained platform distinct requests. Explicit contract-grain platform series and entity-bounded DA series remain accepted.
- Regenerate deterministically; the artifact SHA becomes the v2 pin. The generator-equals-artifact byte test stays.

**Server:**

- Vendor the exact v2 bytes. Add the artifact path to a new `.prettierignore` (root cause of P0-2: this repo had none, so lint-staged's prettier rewrote the staged JSON during commit).
- Copy the artifact byte-for-byte into `dist` at build time.
- Boot: hash the local artifact file and compare to the pinned constant — mismatch is **boot-fatal** (broken image, fail fast). If the **active generation's** `matrix_hash` differs from the pin, analysis requests return `SERVICE_UNAVAILABLE` with the two hashes named; record search/detail APIs stay up.
- MCP strictness: add opt-in strict-input support to the shared kernel MCP contract and enforce it in both the external MCP registration and the in-process agent adapter. Enable it for every retained procurement tool; make the nested analysis `scope` object strict (`.strict()` — zod's default silently strips unknown keys, which is the P0-1 widening). Rejections name every unknown field.
- Month validation: parse `YYYY-MM` into components; month `01..12`, year `2000..2100` (same range as `year`); `from <= to` only after semantic validation; `InvalidInput` names the offending field.
- `topN`: centralize in core — absent means the documented per-shape default; explicit integers `1..50` accepted; everything else is `InvalidInput` before any generation or repository read. (The `?? 50` case in the current code is in the legacy CPV-spend resolver, which §3 deletes; only the new analysis surface carries the contract.)

**Cross-repo coupling risk (explicit):** once the server pins the v2 hash, its analysis surface refuses production build 2 (stamped v1) until a new generation publishes with v2. That 503 window is intentional fail-closed behavior, but it means the scraper deploy + generation publish (§5 step 8) must precede any server deploy, and a denied/delayed publish blocks the server rollout. Local/live testing against the new generation happens before any server commit is pushed or deployed.

## 2. Routing and answerability (P1-5, P2-3, P2-4, P2-6)

- **Measured-key-free rule** in matrix routing and core validation (not per-transport):
  - Reject supplier concentration when `supplierCui` is fixed by scope.
  - Reject `distinctSuppliers` when `supplierCui` is fixed; reject `distinctAuthorities` when `authorityCui` is fixed.
  - Rejections are named-capability errors that suggest the record-count series or the opposite counterparty measure; the repository is never invoked.
- **Answerability protocol** — every analysis envelope carries:
  - `answerability: served | degraded | abstained`
  - `reason` is absent when `served` and names the fired gate, not a fixed state mapping. `SPEND_COVERAGE_BELOW_GATE` yields `degraded` for mixed stats blocks whose counts survive, but `abstained` for a spend-primary series/concentration/share. `TIME_COVERAGE_BELOW_FLOOR`, `GEO_COVERAGE_BELOW_FLOOR`, `MISSING_QUALITY_VERDICT`, and defensive `GENERATION_LACKS_CAPABILITY` yield `abstained`; `TIME_COVERAGE_DEGRADED` and `GEO_COVERAGE_DEGRADED` yield `degraded`.
  - Same representation whether grain is explicit or inferred, and for both explicitly and implicitly blocked series.
- Quality-gate outcomes are **successful abstained results**, never `INVALID_INPUT`; `InvalidInput` is reserved for malformed or structurally unsupported requests.
- Stats with usable counts but gated money: `degraded` with money fields null. Blocked primary measures: `abstained`.
- Concentration defaults to count basis. An explicit value basis **never silently falls back** — it returns an abstained block. MCP `aggregate_procurement` gains an explicit `basis` input; GraphQL's free-form basis string becomes an enum.
- Share returns `share: null` with abstained answerability when spend is gated; invalid subset/window relationships remain errors.
- Rename envelope `link` → `canonicalScope`, keeping the existing stable serialization; update MCP summaries and GraphQL descriptions to stop implying it is openable.

## 3. Legacy aggregate surface removal (P1-4, P2-7)

Verified against the current tool registry and resolver map.

**Retain:** GraphQL search, detail, supplier-record, and CPV discovery; the six build-2 analysis operations; MCP `resolve_procurement_filter`, `search_procurement_contracts`, `search_procurement_direct_acquisitions`, `aggregate_procurement`.

**Remove:** MCP `rank_procurement_suppliers`, `rank_procurement_authorities`, `get_procurement_concentration`, `get_procurement_authority_cpv_spend`, `find_same_day_da_candidates`, `get_procurement_grain_quality`; GraphQL `procurementGrainQuality`, the old analyst fields, detail `gate` fields, and the `Entity.procurement` contributor; `ProcurementAggregateRepo` with its old-MV gate, usecases, types, mappers, contributor wiring, and legacy-specific tests.

**Pre-removal audit step:** confirm the retained search/detail/supplier-record paths have no dependency on `ProcurementAggregateRepo` internals (current consumers: `core/usecases.ts`, `shell/contributor.ts`, `resolvers.ts`, `index.ts`, `tools.ts` — all believed legacy-only); anything genuinely shared moves before deletion. Confirm with the owner that no production agent depends on the removed MCP names before the eventual deploy.

Audit result (2026-07-13): retained record paths use `ProcurementRepo`, not the
deleted aggregate repositories. The separate legacy `/mcp` surface is enabled in
production, but repository/agent searches found no external
`query_procurement_filters` consumer and the available 27-day server logs contain
no `/mcp` or tool-name event. The owner selected the stricter review disposition:
remove this procurement-only legacy path while retaining all budget `/mcp` tools.

Repeated-pair, same-day, regional ranking, and Entity-360 procurement features return only through a future generation-stamped package (§7). Removing the legacy stack also eliminates the floating-point money defect (P2-7) — its fix ships as deletion, with a lint check that no remaining money path passes through JS `number`.

## 4. Timeouts, golden behavior, documentation (P1-3, P1-7, P2-5, P3-1)

- Map PostgreSQL `57014` (query_canceled / statement timeout) at the shell boundary to the project timeout error → GraphQL `GATEWAY_TIMEOUT` extension code and the MCP timeout category. Other database failures stay `Database`.
- Timeout logs carry: operation/shape, grain, rollup, build ID, elapsed ms, PostgreSQL code. Never SQL text, connection details, or unbounded scope values.
- Live golden suite:
  - New `PROCUREMENT_LIVE_GOLDEN_REQUIRED=1`: with it, missing database/schema/active generation **fails setup**; without it and without live configuration, tests are **visibly skipped** (vitest skip, not silent pass).
  - Emit the active build ID once at suite start.
- Documentation refresh (last, after behavior is final): design doc, implementation record, client migration notes, scraper `PUBLIC_CONTRACTS_NOTES`, and matrix row/version references (the "106-row curated" comments become the v2 count). Replace duplicated numeric claims with links to the implementation record.

## 5. Review, commit, and rollout gates

1. Implement scraper matrix v2 and all server changes in dedicated worktrees (both repos had live checkouts with pre-existing changes).
2. Run local characterization, unit, parity, build, and artifact tests (see §6).
3. Two independent read-only reviews of both diffs plus evidence: Claude Opus 4.8 with its maximum supported extended-thinking configuration, and Codex GPT-5.6 Sol-Hi with high reasoning in a read-only sandbox. Stream both outputs and capture model metadata.
4. Consensus requires both independent reviews and the primary implementation review to agree on: public removals, matrix closure, fail-closed behavior, generation coupling, rollout safety, and every P0/P1 disposition. Any material disagreement stops work and returns to the owner.
5. After consensus, commit the **scraper matrix change only** (completed locally as `b2fb1d36`; no push or deployment).
6. Owner decision, 2026-07-13: local server commits may land before live matrix-v2 evidence. This changes only commit ordering; the exhaustive live golden, performance corpus, and post-evidence dual review remain mandatory deployment gates.
7. Land the reviewed server remediation in narrow local commits, rehashing the vendored artifact from `HEAD` after each commit. Do not push or deploy.
8. Obtain explicit permission before pushing/deploying the scraper image or publishing the next production generation. Publication stays atomic: a failed run must leave the current generation active.
9. Against the new generation, run the strict live golden and performance suites from the committed local server branch.
10. Re-run the same independent review on the complete server commits plus live evidence; disagreement again returns to the owner. Address any blocking findings locally and rerun both reviews.
11. **After every commit**, recompute the artifact hash from `HEAD` (not the working tree) and re-run the pin tests — this is the guard against commit-hook rewriting, the exact failure mode of P0-2.
12. Coordinate the pending client migration before requesting permission to deploy the server. CronJob activation remains a separate operator decision.

## 6. Test plan

**Characterization first:** reproduce every review failure as a red test before fixing it.

**Layer A — unit and transport parity:**

- Reject top-level and nested MCP typos (`authorityCUI`, `topn`, `buyer_region`, `unexpected`) without invoking handlers or repositories; keep a positive test that a genuinely absent scope means platform scope.
- Table-test months `00`, `13`, unpadded, malformed years, range boundaries; `topN` absent/1/50/0/51/negative/fractional/huge — identical error categories on GraphQL and MCP.
- Reject fixed measured-key and unbounded DA distinct cases; keep valid controls (authority-, CPV-, platform-scoped concentration; bounded distinct series).
- Assert identical answerability state, reason code, build ID, and `canonicalScope` across GraphQL/MCP for a shared case table (the standing conformance matrix against transport drift).
- Prove an explicit value basis never becomes count silently (concentration and share).
- Decision table: shape × grain-explicitness × gate-verdict, every cell asserting the answerability protocol.

**Layer B — artifact/runtime:**

- Scraper generator output equals the committed artifact byte-for-byte; SHA and exhaustive closure pass in both repos; matrix-v2 accept/reject rows match server routing bidirectionally.
- Simulated lint-staged run (stage the artifact, run the pre-commit pipeline) leaves the SHA unchanged.
- Built `dist` contains the exact bytes; local corruption prevents boot; generation-hash mismatch blocks analysis requests but not record APIs.

**Layer C — timeout/logging:**

- Synthetic `57014` maps to timeout semantics on both surfaces; ordinary database errors do not.
- Captured logs contain the safe diagnostic fields and no SQL or connection strings.

**Layer D — strict live golden (against the new generation):**

- GraphQL = MCP = raw SQL for every retained shape across platform, authority, supplier, pair, CPV, region, status, and procedure-type scopes and every grain.
- The corpus is generated from every `serving.kind = rollup` row in the pinned artifact (388 rows): all three buckets for every advertised series row and both bases for every concentration row, for 846 live executions. The suite asserts that the executed-key set equals this derived closure, so a newly advertised row cannot be skipped silently.
- Share operands stay on one build ID; breakdown reconciliation stays exact.
- Removed GraphQL fields and MCP names are absent from introspection and the tool listing.

**Layer E — performance (fresh server process, prod-volume data, recorded build ID):**

- Cold corpus then immediate warm replay for: all advertised distinct measure × grain × bucket combinations, all platform breakdown dimensions at default `topN`, representative bounded requests, and enough concurrency to reveal pool contention; report median/p95 over ≥3 samples with worst-case plans (`EXPLAIN (ANALYZE, BUFFERS)`).
- Each performance case runs in three independently spawned server processes. Each child records its first request as the cold sample and three immediate warm replays; the orchestrator reports and gates median/p95 per case, runs an eight-request contention probe, and explains the actually slowest accepted distinct case.
- Review targets: cold p95 ≤ 5 s, warm p95 ≤ 300 ms. **Hard gate: nothing reaches 12 s.** Rejected combinations return before repository access, under 300 ms.

**Layer F — release gate:** focused procurement suites after every batch, then `pnpm typecheck && pnpm lint && pnpm deps:check && pnpm test && pnpm build`, plus `pnpm test:e2e` once per batch (requires the Docker Desktop socket per the e2e setup notes). Release fails on: matrix hash divergence anywhere, a requested live suite skipping assertions, any malformed predicate widening scope, or any advertised query near the timeout.

## 7. Deferred wave 2

- Explicit unknown-dimension selectors distinguishing SQL `NULL` from the literal source value `"unknown"`, round-tripping every unknown breakdown bucket, with `other` explicitly non-drillable (P2-1).
- Scraper-owned stable procedure-type keys with separate display labels; facets return the key, filters accept it unchanged, round-trip invariant for every facet dimension (P2-2).
- Precomputed distinct-series projections if the product wants the platform/DA combinations back inside SLO.
- Repeated-pair, same-day, regional ranking, and Entity-360 procurement views, rebuilt only on generation-stamped projections.

## 8. Open items requiring owner confirmation

1. Permission checkpoints at §5.8 (scraper deploy + generation publish) and §5.12 (server deploy) — both remain explicit gates, not assumptions.

The owner confirmed the redesigned procurement surface is not deployed, so the six
deprecated MCP names have no production consumer migration gate. Client migration
still precedes the eventual server deployment.
