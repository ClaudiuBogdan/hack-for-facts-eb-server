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

### WP4 — Kernel typing and constants (medium) — done 2026-09-11

- Types only; no query was rewritten, and the 21 SQL pin suites compile the
  same text before and after (the WP3 pins are what makes this checkable).
- DP-07: the last four of its six tables carry `privacy_class` on their
  Kysely interface (`core.organization_identifiers`, `ins.territory_nodes`,
  `ins.contexts`, `ins.dataset_coverage`; `core.territories` and
  `search.documents` were typed in `401f51a9`, the INS geo tables through
  `InsGeographyStamp`); `core.organizations`' column is non-null like the live
  column. `core.territory_population` and `core.territory_identifiers` were
  already typed by the hygiene commit. Nine other typed tables carry the
  column live and stay untyped (parliament `vote_capture_coverage`,
  `vote_capture_gaps`, `committee_meetings`; pnrr `announcements`,
  `acquisitions`, `lots`, `contractors`, `payments`; procurement
  `procedure_ted_links`): their gates are raw SQL, a follow-up if wanted.
- N/K1: `shared/core/territory-constants.ts` names Bucharest once (county
  code, municipality SIRUTA, the sector row shape `locality`/`sector`, the
  six sector SIRUTAs). The budget module re-exports the county code and the
  municipality SIRUTA, the INS module re-exports the sector list and reads
  the sector shape in its territory bridge; the kernel predicates, the
  admitted-source read, the budget population union and the map repo emit
  the values through `sql.lit`. The legacy budget-viz modules
  (`normalization`, `advanced-map-analytics`) keep their copies until slice
  2 deletes them; `entity-repo.ts` compares a CUI to `179132`, a different
  semantic, left as is. `tests/unit/shared/territory-constants.test.ts` pins
  the values, the re-exports and that the kernel predicates compile the
  values as literals with no parameters.
- Verification: full unit and integration green; `ins-native-repo` 174/174
  and `search-repo-entities` 8/8 on the zeus Docker host (the INS suite's
  loopback guard now applies to an external URL only, its teardown goes
  through the WP3 helper); local snapshot suite 14/14; cutover replay
  through the local kernel at the same 46 cases, 25 kernel-rooted, 0 stale.
- Surfaced to the owner, not changed: `AGENTS.md` says `core/` imports only
  `common/*`, while the linter and 74 core files allow and use other modules'
  `index.ts` (types and constants); the sentence should say so.

### WP5 — Split the oversized repos (large, pure moves, one commit per concern) — done 2026-09-11

- `budget-repo.ts` 2,436 → 168 lines in five commits, one read family each,
  behind the unchanged `makeBudgetRepo(db, options)` and its unchanged
  25-member return object: `line-items.ts` (execution and commitment line
  items, FACT path) with `fact-predicates.ts` (the pruning gates, period
  tuple, amount range, transfer exclusion, core-join decision) and
  `budget-repo-shared.ts` (limits, MV name resolution, the commitment metric
  maps, `BudgetRepoOptions`, the `BudgetRepoContext` every family receives:
  `db`, `options`, the funding map, `asOf`); `entity-analytics.ts` (MV
  summaries and the three timeseries); `rankings.ts`; `aggregates.ts`
  (classification aggregate and the heatmaps); `catalog.ts` (reports,
  dimensions, official budget, contributor support). What remains is the
  composition root: the two invariants, the funding map, the freshness read,
  one context and the five family calls.
- `ins-repo.ts` 958 → 62 lines in three commits behind the unchanged
  `makeInsRepo` / `makeInsSnapshotRepo` / `withInsReadSnapshot`:
  `ins-publication.ts` (the catalog reads and the row → view mappers),
  `ins-territory.ts`, `ins-series.ts` (observations, default series,
  hydration). The repository literal spreads the three families before its
  one literal member, `withSnapshot`; the key sets are pairwise disjoint and
  sum to the port's 23 members (the one thing typecheck could not catch, a
  literal key overriding a spread key, was ruled out by hand).
- The contract held on every commit: the reviewers' multiset comparison of
  the old file against the new ones left zero body-line residue (only import
  lines, `export` prefixes, Prettier reflows and the factory glue); every SQL
  pin suite compiled the same text; the budget and INS unit and integration
  suites, typecheck, lint, prettier and the cycle check were green; the local
  snapshot suite stayed 14/14 and the cutover replay through the local kernel
  at the same 46 cases (one replay that overlapped a `tsx watch` reload was
  discarded and re-run). Full unit (456 files) and integration (40 files)
  green on the final tree; on the zeus Docker host the budget legacy
  execution-analytics suite (92) and the INS suite (174) ran together,
  266/266, after the budget suite's loopback guard was scoped to an external
  URL like the INS one.
- Reviews: Codex working-tree per commit plus branch scope before the push;
  Fable (high) per commit with the multiset method. Findings applied along
  the way: two stale header claims, a Prettier drift (the process is now
  eslint --fix → prettier --write → prettier --check on the final tree), a
  misnamed population comment, orphaned banners. One incident: a
  `prettier --write` that ran with no arguments after an extractor crash
  reformatted 19 unrelated tracked files; confirmed formatting-only and
  restored before any review or commit.
- `src/app/build-app.ts` is not split; it goes with slice 2 as planned.

### WP6 — Dead code that does not wait for the legacy entrypoint (small) — done 2026-09-11

- The embedded float factor table becomes decimal strings aligned to factor
  set 2 (DP-15), with a pin test against the promoted set. The YAML
  `FactorSource`, the CPI chain-linker and the Phoenix `SUM(DISTINCT
population)` denominators stay `@deprecated` until `api.ts` is deleted.

Done (commit `f0d923fe`, pin `5c219350`, synced 11:57 UTC; row in
`deploy-2026-09-10.md`):

- `shell/repo/analytics.ts`: `FX_RON_PER_EUR` and `GDP_RON` are decimal
  strings copied from set 2 (`ron_per_eur` 2005–2025, `gdp_ron` 1995–2025;
  the 2026 estimates are gone, so a year past the set carries 2025 forward as
  any year past the table always did). `yearMultiplier` returns decimal text
  under the slice's decimal policy — the same `1.div(fx)` / `100.div(gdp)` the
  native `exactYearMoneyMultipliers` runs — and `factorCaseExpr` binds it;
  `money-factor.ts` drops its `String()`. Deprecation stays in prose, as in
  `cpi-level.ts`: `@typescript-eslint/no-deprecated` is on and
  `money-factor.ts` is a live caller (tags produced 36 lint errors).
- Pin: `tests/unit/normalization/fixtures/factor-set-2.json` (set 2 read from
  Chronos 2026-09-11, 261 rows, digest `5f2948ec…`, promoted 2026-09-08 run
  23230, the set-1 fixture's shape) and
  `tests/unit/budget/embedded-factor-table.test.ts`: fixture tied to
  `NATIVE_FACTOR_SET_ID`/`_DIGEST` and a row hash; every table value and year
  equals the fixture; the compatibility multiplier equals the native
  derivation for every year and money normalization; bound parameter shapes.
  Fixture README extended; doc 13 §4's "interim source until D2 lands" line
  corrected.
- Served numbers: unchanged on every server built from this revision. The WP6
  commit message and the first version of this section said the table was
  live on the Phoenix `api.js` embedding; that was the `phoenix-last-full`
  code (no `ins-native` in the default composition). At HEAD `ins-native` is
  in the default composition (X/F6) and both entrypoints pass `native` to
  `makeBudgetModule`, so `makeBudgetRepo(db)` without `moneyFactors` is
  composed by no server — only by `tests/integration/kernel-legacy-roots.test.ts`.
  Corrected in WP7. For whichever build ever composes budget without `native`,
  EUR and %GDP move to the set-2 values: 2025 EUR +0.17 % (5.05 → 5.0415),
  2025 %GDP −1.90 % (1.88 T → 1.9164 T), 2026 +1.16 % EUR / +4.36 % %GDP
  against the former estimates, pre-2016 years get real values instead of the
  2016 carry-back; the multiplier text is 40 significant digits instead of a
  ~17-digit float. The frozen Phoenix dev keeps serving its own pre-X/F6 float
  table until it is unpinned.
- Reviews: Codex working-tree and branch (no findings; independently checked
  all 52 values, multipliers and SQL bindings), Fable high (no P1/P2; verified
  the fixture against the live set 52/52 and the native-equality oracle; two
  P3 wording items and the optional row-hash pin applied). Deployed
  verification identical to WP5: cutover 46 / 25 kernel-rooted / 0 stale /
  92,814 leaves, snapshot 14/14.

### WP7 — Documentation still stale after the slice-1 sweep (small) — done 2026-09-11

- Doc 13 rewritten as the deployment matrix the owner asked for (B/F1
  decision), with the DRAFT header and the superseded MV path removed.
- `AGENTS.md` module map (`ins-native` present, `ins` removed);
  `docs/DEPLOYMENT-SPEC.md` CMD; the `verify-and-ship` skill describing the CI
  as it is; the N/N3 population-admission republish procedure and its
  nominal-ranking blast radius; the two 2026-09-06 sections of
  `docs/USER-DATA-ANONYMIZATION.md` moved above "References" and the Chronos
  dev store named.

Done (commit `cf7f0e2f`, pin `b243937f`, synced 12:34 UTC; row in
`deploy-2026-09-10.md`):

- Doc 13 is r3, the deployment matrix: §2.1 the two entrypoints and their one
  shared composition, §2.2 every root on `/api/v1/graphql` with serving path,
  factor source, population source and client status, §2.3 the legacy roots
  not on the kernel with their native replacements and the cutover counts,
  §2.4 REST/MCP per build; §0/§4/§5 reduced to executed-or-superseded notes;
  §1 records the two accepted additive fields (B/F4); §3 rule 3 is the fact
  path; §7/§9 keep their cited numbers with a lead naming the entrypoint they
  describe. The "DRAFT" header had already gone in the slice-1 sweep.
- Found while building the matrix and corrected in the same commit: since
  X/F6 (`962f1c34`) `ins-native` is in the default composition and the
  `api.js` embedding passes no module override, so BOTH entrypoints compose
  budget with `native`. WP6's "live on the Phoenix `api.js` embedding" was the
  `phoenix-last-full` code, not HEAD; the compatibility table, the set-1 pin
  and the legacy usecases are reached by no server at this revision. Corrected
  in `analytics.ts`'s header, the WP6 records, the fixture README and the
  stale comment above `SHARED_DEFAULT_MODULES` (comment-only source changes).
- The other rows were already satisfied by the slice-1 docs sweep
  (`ad90376c`): `AGENTS.md` lists `ins-native` and no `ins`;
  `docs/DEPLOYMENT-SPEC.md:547` carries the Dockerfile `CMD` with the Chronos
  override note; the N/N3 republish procedure and blast radius are doc 14 §3
  (paths re-verified); the two 2026-09-06 anonymization sections sit above
  "References" and name `transparenta-eu-dev-user-db`. The `verify-and-ship`
  skill's CI section was rewritten to the workflows as they are (six jobs, the
  pin commit on every push, manual Argo sync, golden master on `workflow_run`
  and nightly) — but `.claude/` is gitignored, so that edit is local to the
  owner's machine and cannot land; `AGENTS.md` documents skills the repo does
  not track (owner item).
- Left as owner items: the `AGENTS.md` sentence "`core/` imports only
  `common/*`" versus the linter and 74 core files that import other modules'
  `index.ts`; `Dockerfile:79`'s `HEALTHCHECK` on `/health/live`, a path the
  kernel build does not serve (inert in-cluster).
- Reviews: Codex working-tree (no findings; non-comment tokens identical),
  Fable high cell-by-cell against HEAD (no P1; two P2 and P3 wording items,
  all applied; root, corpus and allowlist counts reproduced).

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
