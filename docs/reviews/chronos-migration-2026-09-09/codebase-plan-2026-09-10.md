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

### WP2 — The corpus as a test asset (medium)

- `tests/integration/kernel-legacy-roots.test.ts`: `buildRedesignApp` with
  fakes, `app.inject` every live corpus document whose root is on the kernel
  (`executionAnalytics`, `entityAnalytics`, `aggregatedLineItems`, the four
  dimension roots, the INS roots); assert no `errors[]` and the documented
  `InvalidInput` envelopes (design 13 §7 rows 11–13). Closes T-05.
- Parity-allowlist coverage: a post-run assertion in the cutover harness's
  report stage (not a unit test, which has no live input): every kernel-mounted
  root in the corpus either passed or has an allowlist entry, else the run
  fails. This is what the review meant by "fails when a new root is mounted
  without a recorded parity decision" (item 7).
- Composition coverage for `build-redesign-app.ts` (T-09) lives here too: the
  enabled-module matrix boots with fakes and mounts exactly the declared roots.
- Verification: the new suites, plus an unchanged cutover set.

### WP3 — Test gaps that protect the later refactors (medium)

- Capturing-driver SQL tests for `ins-native/shell/repo/ins-repo.ts` (period
  narrowing, snapshot isolation, member-territory join), mirroring
  `legacy-analytics/repo-sql.test.ts`. These pin the generated SQL before WP5
  moves the code.
- Unit tests for the four shell population readers and
  `makeNativeBudgetFactors` over `fake-repo.ts` (T-13).
- Owner-fence unit test for `assertUserDataOwnerCanWrite` over a fake user
  database: tombstone → forbidden, none → ok, lock ordering scripted (T-06).
- Request-level auth test: a Clerk-dev-signed JWT yields an authenticated
  context on `/api/v1/graphql`, a wrong issuer yields anonymous.
- Testcontainers fallback in `normalization-factor-set.test.ts` and
  `map-owner-deletion.test.ts` (copy the `search-repo-entities` pattern) so
  they no longer need a loopback database; verify on zeus Docker.

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
