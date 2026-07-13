# Public Contracts API — Remediation Review

> **Status:** Historical pre-remediation review — implementation decisions and current gates are recorded in `10-public-contracts-api-remediation-plan.md`
> **Date:** 2026-07-13
> **Scope:** The current server branch, run locally against the production procurement analysis package through read-only tunnels
> **Surfaces tested:** GraphQL `/api/v1/graphql` and MCP `aggregate_procurement`, plus the legacy procurement aggregate/MCP surfaces where coexistence affects correctness
> **Companion design:** [`10-public-contracts.md`](./10-public-contracts.md)

## 1. Purpose and decision boundary

This document records only findings that are sufficiently evidenced to treat as
real defects, contract inconsistencies, or release risks. It proposes the shape
of each fix and the tests that should prove the fix, but it does not authorize or
contain implementation work.

The audit exercised roughly 75 API cases across every analysis shape, grain,
scope family, breakdown dimension, invalid-input family, and GraphQL/MCP parity
path. Successful new-analysis responses consistently used active generation
`buildId = "2"`.

The current implementation also demonstrated important correct behavior:

- Per-grain separation held.
- The build-2 quality gate correctly withheld money answers.
- Tested breakdowns reconciled exactly to stats: top buckets + other + unknown.
- Ordinary valid GraphQL and MCP requests agreed.
- Named unsupported combinations were generally rejected correctly.
- Bounded stats queries were normally tens to low hundreds of milliseconds.

## 2. Summary and proposed order

| ID   | Priority        | Finding                                                                       | Recommended disposition                                   |
| ---- | --------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| P0-1 | Release blocker | MCP silently removes unknown fields and can widen a request to platform scope | Fix before deployment                                     |
| P0-2 | Release blocker | The byte-pinned semantic matrix tests are red                                 | Restore byte-exact artifact before deployment             |
| P1-1 | High            | Impossible months pass validation and fail inside PostgreSQL                  | Fix input validation                                      |
| P1-2 | High            | Direct-acquisition/platform distinct series exceed the server timeout         | Optimize or precompute before exposing these combinations |
| P1-3 | High            | Database timeouts are returned as generic internal database errors            | Preserve and map timeout errors explicitly                |
| P1-4 | High            | Legacy and build-2 surfaces give contradictory spend answers                  | Retire, route, or clearly version the legacy surfaces     |
| P1-5 | High            | Supplier-scoped concentration is a tautology reported as meaningful HHI       | Reject the degenerate shape                               |
| P1-6 | High            | GraphQL silently clamps `topN` while MCP rejects the same values              | Adopt one validation contract                             |
| P1-7 | High            | Live golden tests can report green while asserting nothing                    | Fail closed or explicitly skip with visible status        |
| P2-1 | Medium          | Unknown breakdown buckets cannot be filtered or drilled into                  | Add an explicit unknown-bucket filter contract            |
| P2-2 | Medium          | Procedure-type filters require undocumented raw labels                        | Publish/normalize a canonical vocabulary                  |
| P2-3 | Medium          | Fixed-key distinct series return tautological `1` values                      | Reject or explicitly classify as degenerate               |
| P2-4 | Medium          | Quality-gated abstention has incompatible representations across shapes       | Define one answerability protocol                         |
| P2-5 | Medium          | Cold platform breakdown latency is far above the documented range             | Establish a cold-query SLO and optimize/warm accordingly  |
| P2-6 | Medium          | Envelope `link` is not an actionable client deep link                         | Return a complete URL/route or rename/remove the field    |
| P2-7 | Medium          | Legacy MCP money output exposes binary floating-point artifacts               | Serialize legacy money with Decimal/fixed precision       |
| P3-1 | Low             | Procurement implementation and matrix documentation is stale                  | Refresh after behavior decisions are approved             |

Recommended implementation order:

1. P0-1, P0-2, P1-1, and P1-7: restore fail-closed contracts and trustworthy tests.
2. P1-2 and P1-3: make advertised queries finish within the serving budget and expose actionable failures.
3. P1-4: make an explicit product decision about legacy coexistence before deployment.
4. P1-5, P1-6, and P2-1 through P2-4: normalize the analysis contract.
5. P2-5 through P3-1: performance hardening, navigation, legacy precision, and documentation.

## 3. Confirmed findings, fixes, and proof tests

### P0-1 — MCP silently widens typo-containing requests

**Evidence**

- `scope: { authorityCUI: "29170968" }` was accepted, normalized to `{}`, and returned platform totals rather than authority totals.
- `scope: { unexpected: "x" }` behaved the same way.
- A top-level `topn` typo was ignored, defaulted to `topN = 10`, and triggered a platform supplier breakdown.
- GraphQL rejects the equivalent unknown field and suggests `authorityCui`.
- `scope` currently uses `z.object(ANALYSIS_SCOPE_ZOD_SHAPE)` without strict unknown-key rejection in `shell/mcp/tools.ts`.

**Fix summary**

- Make the MCP top-level input object and nested scope object strict.
- Return a structured `InvalidInput` response naming every unknown field.
- Ensure parsing never receives an object whose predicates were silently removed.
- Keep GraphQL and MCP field names generated from or checked against one shared contract.

**Verification**

- Unit-test unknown fields at both the top level and inside `scope`.
- Cover plausible casing/typo variants such as `authorityCUI`, `topn`, and `buyer_region`.
- Assert the analysis repository is not called for rejected input.
- Add a GraphQL/MCP parity table asserting that both surfaces reject the same malformed requests.
- Retain a positive test proving a genuinely absent scope still means platform scope.

### P0-2 — Semantic matrix byte pin is broken

**Evidence**

The focused suite currently reports 299 passing and 2 failing tests:

```text
Expected: 1ce871d54e28c75f39d6084a82a005237417a2d4f048270dbf3629e91fd7f412
Received: e71bb8dc396178ca0c9b5216eff87f07876cd6f94ca68a0c102e72e812c2e931
```

The parsed JSON semantics appear equivalent, but the contract and tests promise a
byte-exact vendored scraper artifact.

**Fix summary**

- Replace the server copy with the exact generated scraper artifact; do not manually reformat it.
- Keep the pinned hash sourced from the same generator output.
- If byte identity is no longer required, change the contract deliberately to a canonical semantic hash in both repos rather than simply updating one constant.

**Verification**

- Run both byte-pin tests and require the same digest in server, scraper artifact, and active generation metadata.
- Add a cross-repository publication check that copies the artifact without a formatter touching it.
- Keep the exhaustive matrix closure assertions in addition to the hash check.

### P1-1 — Invalid calendar months reach the database

**Evidence**

`from: "2024-13"` passes the `^\d{4}-\d{2}$` check, reaches SQL as
`2024-13-01`, and becomes `INTERNAL_SERVER_ERROR` / `Database` instead of an
input error.

**Fix summary**

- Parse `YYYY-MM` into validated year and month components.
- Enforce month `01..12` and the same supported year range used by `year`.
- Perform `from <= to` comparison only after semantic validation.
- Return `InvalidInput` with the exact offending field.

**Verification**

- Table-test months `00`, `13`, missing zero padding, malformed years, and supported boundaries.
- Test valid leap/non-leap February months; day validation is intentionally irrelevant because the input is month-grained.
- Assert GraphQL and MCP return the same input-error category.
- Assert no repository call occurs for invalid dates.

### P1-2 — Platform/direct-acquisition distinct series time out

**Evidence**

- Contract `distinctSuppliers`, quarter: approximately 1.67 seconds.
- Direct-acquisition `distinctSuppliers`: failure at approximately 15.04 seconds.
- Platform `distinctSuppliers`: fails through the DA leg.
- Platform `distinctAuthorities`: fails after approximately 16.46 seconds.
- Authority-bounded equivalents complete in approximately 70–197 milliseconds.
- The pool sets `statement_timeout = 15000`; the query performs per-bucket `COUNT(DISTINCT ...)` over the selected rollup.

**Fix summary**

- Inspect `EXPLAIN (ANALYZE, BUFFERS)` for the exact platform DA queries.
- Prefer a serving-data fix: generation-stamped pre-aggregated distinct-series projections or an index/layout designed for these dimensions and buckets.
- If the platform combination cannot meet the agreed SLO, remove it from the supported matrix and return a named capability rejection rather than timing out.
- Do not solve this only by increasing the global statement timeout; that expands resource risk without making the query predictable.

**Verification**

- Add a read-only live performance suite for every advertised distinct measure × grain × bucket combination.
- Restart the local server between cold runs so the in-process cache cannot hide the query cost.
- Record at least three cold samples and the query plan for the worst case.
- Minimum acceptance: every advertised query finishes with material headroom below 15 seconds. Suggested review target: cold p95 at or below 5 seconds, subject to an explicit product SLO decision.
- Re-run the raw-SQL/GraphQL/MCP equality check for each optimized path.

### P1-3 — Query timeouts are misclassified and under-logged

**Evidence**

The distinct-series failures arrive as generic `Database` / GraphQL
`INTERNAL_SERVER_ERROR` messages such as `analysis distinctSeriesFor failed`.
They do not identify a timeout to the caller, and the observed server log did not
retain the actionable PostgreSQL cause.

**Fix summary**

- Recognize PostgreSQL statement-timeout/cancellation codes at the shell boundary.
- Map them to the project timeout error and the intended GraphQL/HTTP/MCP error category.
- Log safe operational context: shape, rollup, grain, build ID, elapsed time, and database error code. Do not log credentials or unbounded user data.

**Verification**

- Unit-test PostgreSQL timeout-code translation separately from ordinary database errors.
- Integration-test a deliberately low per-test timeout against a harmless slow statement.
- Assert GraphQL and MCP expose a timeout category, not `InvalidInput` or generic database failure.
- Capture logs in the integration test and assert presence of safe diagnostic fields and absence of connection strings.

### P1-4 — Legacy and build-2 spend surfaces contradict each other

**Evidence**

- The legacy DA gate reports value coverage `0.993937` and allows spend rankings.
- Build 2 reports insufficient value coverage and withholds money.
- New concentration requested on value falls back to count with a caveat.
- Legacy MCP concentration for the same tested authority returns value-based totals and no build-2 quality disclosure.
- Legacy and build-2 supplier counts also differ for the tested scope.

The behavior is explainable—the two surfaces use different projections and quality
gates—but is not safe as one public API contract.

**Fix summary**

Choose one of these explicitly before implementation:

1. Retire the legacy aggregate queries/tools when build 2 is deployed; or
2. Route legacy names through the build-2 executor and envelope; or
3. Version the legacy surface, label its data generation and gate prominently, and prevent agents from treating it as equivalent to build 2.

The recommended outcome is one authoritative answerability decision per scope and
measure, even if compatibility aliases remain temporarily.

**Verification**

- Build a cross-surface conformance table for stats, top suppliers, and concentration on the same scope.
- Assert identical build identity, gate decision, value/null behavior, counts, and caveats for compatibility aliases.
- Add a negative regression proving no legacy path can emit money when the active generation rejects spend.
- Inventory the GraphQL schema and MCP tool registry so no unversioned stale route remains.

### P1-5 — Supplier-scoped supplier concentration is degenerate

**Evidence**

Fixing `supplierCui` before grouping by supplier necessarily yields one known
supplier. The tested request returned supplier count 1 and top-1, top-5, and HHI
all `1.0000`, with only the ordinary concentration caveat.

**Fix summary**

- Define concentration as concentration of the supplier dimension.
- Reject any concentration scope that already fixes `supplierCui`.
- Adjust matrix routing to require the supplier key—not merely any counterparty key—to remain free.
- If authority concentration is wanted later, expose it as a separately named measure with its own grouping semantics.

**Verification**

- Unit-test the complete concentration scope matrix, including supplier-only and authority+supplier scopes.
- Assert rejected requests do not call the repository.
- Keep positive authority-, CPV-, and platform-scoped concentration tests.
- Add a semantic invariant: an accepted concentration query must be capable of observing more than one value of its grouped dimension.

### P1-6 — `topN` validation differs between GraphQL and MCP

**Evidence**

- GraphQL silently maps `topN = 0` to 1 and `topN = 1000` to 50.
- MCP rejects values outside `1..50`.
- The GraphQL response does not disclose that caller input was changed.

**Fix summary**

- Prefer rejecting explicit out-of-range values on both surfaces.
- Apply defaults only when the argument is absent.
- Centralize the range/default in core validation so resolvers and MCP do not diverge.

**Verification**

- Boundary-test absent, 1, 50, 0, 51, negative, fractional, and very large values.
- Assert GraphQL/MCP parity for both success and error cases.
- Assert accepted `topN` is preserved exactly in repository arguments and response metadata where applicable.

### P1-7 — Live golden tests can pass without assertions

**Evidence**

The live analysis suite sets `active = false` when the generation probe fails or
finds no active row, then each test executes `if (!active) return`. The runner
reports those tests as passed rather than skipped or failed.

**Fix summary**

- Separate ordinary CI skip behavior from explicitly requested live-golden behavior.
- When live-golden mode is requested, fail setup if the database, schema, or active generation is absent.
- Otherwise use an explicit skip mechanism that the test report displays as skipped, not passed.
- Emit the active build ID once at suite start.

**Verification**

- Run the suite in three modes: no live configuration, unreachable database, and active generation.
- Assert the first is visibly skipped, the second fails when live mode was requested, and the third executes a known assertion counter.
- Add a deliberate mismatch canary in a test fixture to prove the suite actually fails on bad data.

### P2-1 — Unknown buckets cannot be used as scopes

**Evidence**

Breakdowns expose material unknown populations, including:

- Unknown procedure type: 45,981 procedures and 211,774 contracts.
- Unknown buyer region: 185,871 procedures, 389,872 contracts, and 9,273,759 direct acquisitions.

Filtering `procedureType: "unknown"` or `buyerRegion: "unknown"` returns zero
because those rows are SQL `NULL`, not the literal label. CPV and CUI validation
also makes their unknown buckets impossible to select. Status can expose both a
literal source value `"unknown"` and the synthetic null bucket under the same
display label.

**Fix summary**

- Add an explicit null/unknown selector rather than overloading a real string value.
- Keep literal source value `"unknown"` distinct from missing data in response keys and labels.
- Ensure unknown scopes route only to rollups that retain the relevant null state.
- Make `other` explicitly non-drillable unless its member keys are returned.

**Verification**

- For every breakdown dimension, assert that selecting its unknown bucket reproduces the bucket count exactly.
- Add a fixture containing both SQL `NULL` and literal `"unknown"` and assert they remain distinct.
- Re-run breakdown reconciliation after applying the unknown scope.
- Check GraphQL/MCP parity and generated client types for the new selector.

### P2-2 — Procedure-type filters depend on undocumented raw labels

**Evidence**

`procedureType: "licitatie-deschisa"`, a value used in unit routing tests,
returns zero live rows. The stored label `"Licitatie deschisa"` returns 163,159
procedures and 983,546 contracts. Routing tests only prove field presence and do
not validate the live vocabulary contract.

**Fix summary**

- Choose a canonical API representation: stable code/slug is preferable to a mutable display label.
- Normalize accepted aliases at the boundary or require clients to use a facet-provided opaque key.
- Return key and display label separately in facets/breakdowns.
- Document case, whitespace, diacritic, and alias behavior.

**Verification**

- Add contract fixtures for canonical code, display label, casing, diacritics, and invalid aliases.
- Assert facet keys can be passed back into stats and reproduce non-zero matching totals.
- Add a round-trip invariant for every facet dimension: returned filter key must be accepted unchanged.

### P2-3 — Fixed-key distinct series are tautologies

**Evidence**

- Supplier-scoped `distinctSuppliers` returns 1 for each populated period.
- Authority-scoped `distinctAuthorities` returns 1 for each populated period.

These answers are mathematically correct but do not answer a useful distinct-series
question and can be misinterpreted by an agent.

**Fix summary**

- Reject a distinct measure when its measured key is fixed by scope.
- Direct callers toward record-count series or the opposite counterparty distinct measure.
- Encode the rule in routing/core validation, not separately in each transport.

**Verification**

- Matrix-test both fixed-key rejection cases and their valid opposite-key equivalents.
- Assert repository non-invocation for degenerate requests.
- Add GraphQL/MCP parity tests for the named rejection and suggested alternative.

### P2-4 — Quality-gated abstention lacks one transport contract

**Evidence**

Depending on shape and whether grain is explicit, unavailable data currently
appears as one of the following:

- Successful block with null money and caveats.
- Blocked/empty block.
- `INVALID_INPUT`.
- Silent value-to-count concentration substitution, disclosed only in caveats.

This makes `quality says this answer is unavailable` indistinguishable from
unsupported input or a legitimate count answer without shape-specific client logic.

**Fix summary**

- Define an explicit answerability state in every analysis envelope, for example `served`, `degraded`, or `abstained` plus a stable reason code.
- Reserve `InvalidInput` for malformed or unsupported requests, not quality-gate outcomes.
- Do not silently change the requested measure/basis; return the fallback as a separate labeled result only if the contract explicitly permits it.
- Apply the same rule whether grain is explicit or inferred.

**Verification**

- Create a shape × grain-explicitness × gate-verdict decision table and unit-test every cell.
- Assert requested and returned basis/measure are never different without a machine-readable fallback marker.
- Add client-contract tests that handle all abstentions through one shared code path.

### P2-5 — Cold platform breakdown latency needs an explicit SLO

**Evidence**

Observed first requests through the local-to-production read-only tunnel:

| Dimension    | Cold elapsed |
| ------------ | -----------: |
| Authority    |      10.35 s |
| Supplier     |       8.83 s |
| Status       |       4.40 s |
| CPV division |       3.64 s |
| CPV code     |       1.04 s |

Cached repeats were much faster, including approximately 3 milliseconds for the
repeated supplier query. Cache keys include dimension and parameters, so the first
request for each variant still pays the cold cost. The tunnel adds some latency,
but not enough to explain the multi-second cold/cached delta.

**Fix summary**

- Agree separate cold and warm SLOs before optimizing.
- Inspect query plans for authority/supplier ranking and verify index order against filter, grouping, and ranking order.
- Consider bounded precomputed top lists and deployment warm-up for the small set of platform defaults.
- Keep cache as an optimization, not the only mechanism preventing timeout.

**Verification**

- Build a repeatable benchmark with a fresh server process and recorded build ID.
- Measure cold and warm latency separately for every dimension and supported `topN` default.
- Run multiple samples and report median/p95 rather than one best result.
- Suggested review target: cold p95 below 5 seconds and warm p95 below 300 milliseconds for platform defaults, subject to product approval.
- Retain exact breakdown reconciliation checks in the performance run.

### P2-6 — Envelope `link` is not an actionable deep link

**Evidence**

- Platform scope returns `link: ""`.
- Authority scope returns `link: "authorityCui=29170968"` without a path or URL.
- The legacy MCP surface returns a complete `https://transparenta.eu/...` link.
- Unknown/other buckets cannot be represented by the current scope echo.

**Fix summary**

- Decide whether the field means canonical scope serialization or a navigable client link.
- If navigable, build it from configured client base URL + route + encoded query and support every drillable bucket.
- If it is only scope serialization, rename it and stop describing it as something callers can open.

**Verification**

- Unit-test platform, single-filter, multi-filter, Unicode, and unknown-bucket encoding.
- Parse every returned link in a client route test and assert it reconstructs the original scope.
- Never hard-code a production hostname in core logic; test configured base URLs.

### P2-7 — Legacy MCP money contains floating-point artifacts

**Evidence**

Legacy concentration returned total RON as `"2696910.5700000003"` rather than
`"2696910.57"`. This violates the server's decimal-string money convention even
though the path predates the new analysis executor.

**Fix summary**

- Keep money as database numeric text or convert with `Decimal` and the agreed fixed scale.
- Avoid converting money through JavaScript `number` at any point.
- Apply the same rule to shares if they remain numeric on the legacy surface.

**Verification**

- Add precision fixtures such as `0.1 + 0.2`, large values, zero, and values with more than two stored decimals.
- Assert exact strings across repository, core view model, GraphQL, and MCP serialization.
- Run the project lint rule that blocks float-based money handling.

### P3-1 — Procurement documentation no longer describes the shipped state

**Evidence**

- Parts of the design still describe implementation as unapproved/unstarted.
- Committed build/query/shadow evidence slots remain `TBD` despite live proof existing elsewhere.
- Matrix test comments still describe a curated 106-row artifact while the current closure has 275 rows.

**Fix summary**

- Update documentation only after the behavior decisions above are approved.
- Separate shipped server code, deployed production data, undeployed server surface, suspended CronJob, and pending client migration.
- Replace duplicated numeric claims with links to one implementation record where practical.

**Verification**

- Search for stale `TBD`, unimplemented-state language, and obsolete row counts.
- Check every operational claim against the current commit, active build, and deployment state.
- Have the final implementation PR checklist require documentation status to match deployment status.

## 4. Testing strategy for the remediation as a whole

### Layer A — Pure unit and contract tests

Use table-driven tests for validation, routing, gate decisions, canonical filter
keys, degenerate-shape rejection, and error translation. These tests should not
mock libraries; use the existing in-memory fakes and assert repository call
counts as well as returned values.

Primary targets:

- `tests/unit/procurement/arg-translation.test.ts`
- `tests/unit/procurement/combinations.test.ts`
- `tests/unit/procurement/matrix-artifact.test.ts`
- `tests/unit/procurement/analysis-shapes.test.ts`
- `tests/unit/procurement/aggregate-procurement-tool.test.ts`
- New focused tests for strict MCP schema validation and timeout translation

### Layer B — GraphQL/MCP conformance matrix

Create one shared set of cases and run each through GraphQL and MCP. Compare:

- Accepted/rejected status and stable error reason
- Normalized scope
- Requested versus returned measure/basis
- Build ID and answerability state
- Counts, decimal strings, caveats, and links
- Repository non-invocation for invalid or degenerate requests

This layer is the main protection against future transport drift.

### Layer C — Live read-only golden correctness

Continue comparing GraphQL, MCP, and raw SQL against the active generation, but
make the suite fail closed when live-golden mode is explicitly requested. Cover:

- At least one platform, authority, supplier, pair, CPV, region, status, and procedure-type scope
- Every grain and analysis shape
- Breakdown reconciliation
- Facet-key round trips, including unknown buckets
- Legacy aliases, if any remain, against the same build-2 answerability decision

The scraper continues to own DDL. This server suite is a consumer-contract proof
against the published schema, not a second migration suite.

### Layer D — Performance and timeout tests

Run through a fresh local server connected read-only to the production-like data
volume. Record cold and warm timings separately, active build ID, and worst-query
plans. At minimum cover:

- All platform distinct measure × grain × bucket combinations
- All platform breakdown dimensions at supported default `topN`
- Representative bounded authority/supplier/CPV requests
- Concurrent requests sufficient to reveal pool contention

Performance acceptance thresholds must be approved before implementation. A
reasonable starting proposal is cold p95 ≤ 5 seconds, warm p95 ≤ 300 milliseconds,
and no advertised request approaching the 15-second hard timeout.

### Layer E — Release gate

Before deployment, require:

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm build
```

Then run the explicit live-golden and performance suites with the active build ID
captured in the report. The release should fail if:

- The matrix hash differs.
- A requested live suite skips its assertions.
- Any malformed predicate widens scope.
- Legacy/new surfaces disagree on answerability.
- Any advertised query hits or nearly reaches the database timeout.

## 5. Explicit non-findings

The following observations from the audit are not proposed as bugs:

- Four-decimal rounded bucket shares may sum visually to slightly under or over 1; exact row reconciliation held.
- A future year with no dated rows may still report `undatedInScope`; this is an intentional disclosure rule.
- Money abstention itself is correct under build 2. The issue is inconsistent representation and coexistence with legacy money-serving paths.
- The suspended CronJob and pending client migration are known rollout decisions, not server defects discovered by this audit.

## 6. Review decisions requested

Before implementation, approve or amend:

1. Whether the confirmed issue list is complete and correctly prioritized.
2. Whether legacy procurement surfaces should be retired, routed through build 2, or explicitly versioned.
3. Whether invalid `topN` values should be rejected rather than clamped.
4. Whether quality-gate abstention should use a machine-readable envelope state.
5. The cold/warm performance SLOs used as acceptance gates.
6. Whether `link` should be a client deep link or a renamed canonical scope serialization.
