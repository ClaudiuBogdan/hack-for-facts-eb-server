# Codebase migration plan after the slice-1 deploy (2026-09-10)

Scope: the review's open items that are code, tests or docs in this repository
and need no Chronos service change, no data change and no client change. CI
work (the e2e job, validate additions) is deliberately out: everything below is
developed and verified locally, against the port-forwarded serving database,
and pushed to `dev` in reviewed batches. Chronos dev stays on manual sync; it is
synced once per work package, not per commit.

## Local verification loop

Every work package is verified the same way before it is pushed:

1. `pnpm typecheck`, `pnpm lint`, `pnpm deps:check`, `pnpm test:unit`,
   `pnpm test:integration` (the CI gates, run locally).
2. The kernel server against Chronos: `pnpm dev:redesign` (port 3010, reads
   `transparenta_prod` read-only over Tailscale via `.claude/redesign-prod.env`).
3. Golden master against the local server:
   `TEST_GM_API_URL=http://localhost:3010/api/v1/graphql pnpm test:gm`
   (snapshot suite; green after WP1) and
   `TEST_GM_BASELINE_URL=https://api-dev.transparenta.eu/graphql TEST_GM_API_URL=http://localhost:3010/api/v1/graphql pnpm test:gm:cutover`
   (the gate is the failing-case ID SET: it must equal the reference set, 48
   ids on deploy day, 46 since WP1 re-pinned the two picker cases; the difference counts depend on Chronos data and are a signal to
   explain, not a gate. The reference set holds only while Chronos data is
   static; if the scrapper loads anything, re-record the reference run before
   trusting a diff).
4. The e2e suites that touch the changed code, on the zeus Docker host
   (Testcontainers over the SSH socket tunnel; a skipped e2e is not a pass).
5. Codex plus Fable-high review of the working tree, findings applied, then
   the commit (conventional scope from the commitlint enum, no trailers).

## Work packages, in order

### WP0 — Prove the local loop (small, first) — done 2026-09-10

Result: no port-forward is needed. `.claude/redesign-prod.env` points the
kernel at the private Chronos Tailscale endpoints (postgres, Meili,
OpenSearch, ClickHouse; `scripts/local/redesign/gen-prod-env.sh` regenerates
it without printing secrets; `scripts/local/dev-db-forward.sh` forwards only
the Phoenix legacy services). `/api/v1/health` reported postgres, meilisearch
and opensearch ok; the cutover replay against :3010 produced the same 48
failing ids as the deploy-day run (counts 3,972 / 70,764, 2 stale allowlist
entries) and the snapshot suite the same five failures. The loop is a gate.

Original task: the 48-case reference set was measured against the Chronos dev pods, which
reach Meili, OpenSearch and the user database in-cluster. The local kernel
reads those from `.claude/redesign-prod.env`, hand-maintained since Griffin's
retirement. Before any code change: bring the Chronos forwards up (postgres,
Meili, OpenSearch through `~/.kube/chronos.yaml`), start `pnpm dev:redesign`,
confirm `/api/v1/health` reports every dependency ok, run the cutover replay
and `pnpm test:gm` against :3010 unchanged, and diff the failing-id set against
the deploy-day reference. Only a matching set makes the loop a gate. Record the
working forward commands in the dev-topology notes, which still describe the
Griffin forwards.

### WP1 — Golden-master housekeeping (small)

- Re-pin the two `parity-allowlist.json` entries strict mode reports as stale:
  they pinned the pre-publication catalog (757 economic / 1,117 functional);
  the catalog published 2026-09-05 has 760 / 1,121 (verified read-only
  2026-09-10, the seven 2026 codes present, the synthetic '0' / '00.00.00'
  absent), so the pins move to 761 → 760 and 1,122 → 1,121 and the drift
  explanations that cite the old counts are corrected. The two picker cases
  then leave the failing set (48 → 46), a recorded parity change.
- Re-baseline the five failing `execution-analytics` snapshots
  (`yearly-per-capita`, `quarterly-per-capita`, `monthly-totals`,
  `filtered-by-entity-type`, `monthly-income-vs-expenses`): delete the five
  `.snap.json`, record them against the local kernel over Chronos, and write
  the before/after numbers and their verified cause into the spec header.
  Found 2026-09-10 (each verified with one read-only query on Chronos): the
  per-capita denominator is the exact-year national POP107D population
  (22,273,309 in 2016, 21,849,217 in 2024; commit 4036d387 of 2026-09-08,
  review README B/F2, N/N4, N/N5),
  not the ×1.0002 latest-year figure doc 13 §7 row 2 described, so the
  per-capita points move by ×0.855–0.872 and row 2 is corrected; the 2023-02/03
  monthly expenses are the waived Phoenix parser defect (scrapper BUDGET_NOTES
  "Anomaly 2"), Chronos facts equal the kernel to the cent; `entity_types:
['uat']` selects 3,228 rows on Chronos (3,187 `is_uat` + 41 county councils),
  `[]` on Phoenix. `pnpm test:gm:update` rewrites every existing snapshot (key
  order), so only the five files are kept; the header records the recipe.
- Outcome: `pnpm test:gm` green locally, so the loop above has a green baseline.

### WP2 — The corpus as a test asset (medium) — done 2026-09-11

- `tests/integration/kernel-legacy-roots.test.ts`: the budget module runs its
  real core usecases and resolvers over fake ports (aggregate, grouped,
  factor, population and dimension repos; one optional `legacyDimensions`
  injection added to the module deps for it), the INS module over the shared
  fake repository, both mounted on `buildRedesignApp` with `modules: []`.
  Every non-dead kernel-rooted corpus document is injected as the client
  sends it: 40 live answer 200 without errors, the two `invalid-today` fail
  validation on `$ids`, the capturing driver sees no SQL, and design 13 §7
  rows 11–13 come back kernel-style (`INVALID_INPUT` / `InvalidInput` /
  `field`, no stack). Closes T-05. The INS fake repository and the corpus
  world mapping were promoted into `tests/fixtures/ins-native/` first.
- `tests/integration/redesign-composition.test.ts` (T-09): each composition
  unit boots over the bare kernel; units only add roots, no root has two
  owners, the standalone defaults equal the union of the units, the budget +
  INS unit carries every legacy root, and the three lone boots fail with
  their documented reasons (`budget` needs `ins-native`; `ins-native` alone
  lacks `PeriodDate`; `judicial` alone lacks `LegalAct`). The two SDL
  dependencies were found by this test, not known before.
- Parity-allowlist coverage (item 7): `tests/golden-master/kernel-roots.ts`
  holds the literal kernel root list (pinned to the modules' constants by
  `tests/unit/golden-master/kernel-roots.test.ts`); the cutover teardown
  partitions the failing cases and lists every failing kernel-rooted case that
  no allowlist entry fully covers under "Failing cases on kernel-mounted roots
  without a recorded parity decision" in `summary.md` / `summary.json`. A
  classification, not a second gate (Codex review: such a case already fails
  the run, so a strict flag could never change the outcome). The replay
  against the local kernel names 25 of the 46 failing cases this way
  (entityAnalytics / aggregatedLineItems and the INS statistics documents,
  the §5.1 decisions still parked); the other 21 fail on unported roots.

### WP3 — Test gaps that protect the later refactors (medium) — done 2026-09-11

- `tests/unit/ins-native/repo-sql.test.ts`: the native INS repo pinned over
  the capturing driver before WP5 moves it: the repeatable-read snapshot
  policy (`read only`, the 30 s statement timeout, `jit = off`, the 35 s
  transaction timeout of a composed snapshot; one transaction per
  `withSnapshot`, one per plain read), the per-read runner's driver-error
  mapping (SQLSTATE 57014 or the timeout message → Timeout, a missing
  relation → ServiceUnavailable, the publication signal → its message,
  anything else → Database with the cause), the full `listObservations`
  statement with every period selector and `limit + 1`, hydration's
  member-territory join and its statement order, the default-series
  candidate and winner statements (NO_DATA without a candidate,
  AMBIGUOUS_GEOGRAPHY with two, a candidate without a winner row is a
  publication failure), and the shared page/count predicate of
  `listDatasets`. The capturing fixture records transaction settings, since
  the isolation level is a driver argument and was invisible before; an
  unrouted statement fails the test instead of answering no rows.
- T-13: `tests/unit/shared/territory-population-sql.test.ts`,
  `tests/unit/budget/native-population.test.ts`,
  `tests/unit/ins-native/population-cells.test.ts`,
  `tests/unit/budget/native-factors.test.ts`: the admitted-source read with
  its canonical-sector proof in SQL, the map anchor sets over the union
  kernel, the annual scope population (anchors from the transaction, cells
  from the port, a year with any missing cell absent, never partial), the
  snapshot-bound cells and the Bucharest sector supplement over the fake INS
  repo (cell values encode the resolved node, so the tests prove which node
  was read), and the native factors (set 2 under its recorded digest, a port
  whose `current` throws).
- T-06: `tests/unit/infra/database/user/owner-write-guard.test.ts` — the
  owner fence over a `UserDatabase` transaction: refusal of an empty or
  untrimmed id before any statement, the advisory lock before the audit
  marker read, the marker looked up by the sha256 the anonymizer writes, a
  marker refuses, none admits, a driver failure on either statement
  propagates.
- `tests/integration/redesign-auth-context.test.ts`: the real jose-signed
  path through `makeConfiguredJWTProvider` on `buildRedesignApp`; a verified
  token reaches resolvers as the session with its exact expiry, a missing or
  malformed header and the provider's refusals reach them as anonymous with
  HTTP 200, an app without a provider carries no session. The other redesign
  suites use a fake provider.
- `tests/e2e/disposable-postgres.ts` (Docker probe, container start,
  exception-safe teardown with the container stopped in a `finally`) shared
  by `search-repo-entities`, `map-owner-deletion` and
  `normalization-factor-set`; the last two no longer need a hand-prepared
  loopback database (an external URL stays guarded; the factor proof finds
  the scrapper checkout beside the repo when its dependencies are installed,
  digests still matching). Verified on the zeus Docker host: 14/14, no skip,
  no container left behind. The e2e suites remain outside the dev-branch CI.
- Reviews: Codex working-tree per commit plus branch scope, Fable (high)
  per commit with delta re-checks; findings applied before each commit
  (node-discriminating cell values, fail-loud statement routing, the
  calendar-dependent expiry pin, the teardown leak window).

### WP4 — Kernel typing and constants (medium)

- Kysely types for `core.territory_population`, `core.territory_identifiers`
  and the remaining untyped `privacy_class` columns (N/K1, DP-07 remainder).
  Types only: the raw SQL that reads those tables is NOT rewritten here, so the
  generated SQL text WP5 relies on stays identical; query rewrites, if wanted,
  get their own commit with updated capturing-driver expectations.
- The hard-coded Bucharest county `'B'`, SIRUTA `179132` and sector-kind rules
  move to one named kernel reference with a unit test.
- Verification: typecheck, the ins-native and search e2e suites on zeus, live
  queries through the local kernel for the affected roots, cutover set unchanged.

### WP5 — Split the oversized repos (large, pure moves, one commit per concern)

- `src/modules/budget/shell/repo/budget-repo.ts` (2,436 lines) into
  per-concern files behind the unchanged `makeBudgetRepo` (execution
  analytics, entity analytics, aggregated line items, rankings, dimensions),
  one reviewed commit per extracted concern so the Codex/Fable loop can read
  the diff; `makeBudgetRepo` unchanged throughout.
- `src/modules/ins-native/shell/repo/ins-repo.ts` (958) into publication,
  series and geography files behind the unchanged factory.
- No behaviour change is the contract: the capturing-driver SQL tests
  (WP3 and the existing budget ones) must produce identical generated text;
  the budget legacy-analytics e2e suite (92 cases) and the ins-native suite
  (146) pass on zeus; `pnpm test:gm` and the cutover set are unchanged.
- `src/app/build-app.ts` (2,246) is not split: it goes with slice 2.

### WP6 — Dead code that does not wait for the legacy entrypoint (small)

- The embedded float factor table becomes decimal strings aligned to factor
  set 2 (DP-15), with a pin test against the promoted set. The YAML
  `FactorSource`, the CPI chain-linker and the Phoenix `SUM(DISTINCT
population)` denominators stay `@deprecated` until `api.ts` is deleted.

### WP7 — Documentation still stale after the slice-1 sweep (small)

- Doc 13 rewritten as the deployment matrix the owner asked for (B/F1
  decision), with the DRAFT header and the superseded MV path removed.
- `AGENTS.md` module map (`ins-native` present, `ins` removed);
  `docs/DEPLOYMENT-SPEC.md` CMD; the `verify-and-ship` skill describing the CI
  as it is; the N/N3 population-admission republish procedure and its
  nominal-ranking blast radius; the two 2026-09-06 sections of
  `docs/USER-DATA-ANONYMIZATION.md` moved above "References" and the Chronos
  dev store named.

## What stays parked, and the decision that unparks it

- Slice 2 (the ~20 platform modules onto the kernel app, then delete
  `api.ts`): Redis and Resend on Chronos, or an owner decision to let the
  user-database-only modules (share/short links, learning progress, user
  events, report) mount on the restricted dev user database first.
- The 46 cutover cases: client migration for the unported roots (B/F1), the
  INS allowlist decisions (§5.1), data vintage.
- The CI items (e2e job, `format:check`, boundaries lint in CI, the
  golden-master workflow copy on `main`), X/F7 Clerk egress, the dangling
  `gitops-canary` app: cluster or CI changes, later.

## Order

WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → WP6 → WP7; WP7's rows may interleave.

## Cadence

One work package per `dev` push, one Chronos sync per package, the deploy
record extended with a dated line per sync (image, cutover set unchanged or
the recorded change).
