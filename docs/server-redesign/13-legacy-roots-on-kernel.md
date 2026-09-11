# 13 — Legacy roots on the kernel endpoint (`/graphql` → `/api/v1/graphql`)

> **Status:** r3 (2026-09-11) — **the deployment matrix** the owner asked for
> (review B/F1 decision, `docs/reviews/chronos-migration-2026-09-09/README.md`
> §8; codebase plan WP7). §2 is the matrix; §0, §4 and §5 are the r2 plan
> reduced to what was executed or superseded; §1, §3 (rules 1–2), §6, §7 and §9
> keep their numbers because code and reviews cite them. Every cell of the
> matrix is a `path:line` at `dev` HEAD `f0d923fe`. The design origin is the
> user's fork decision C′: _"the goal is not to change the GraphQL interfaces
> for key data types, like the analytics filter, but the API endpoint can and
> should change to remove the legacy code and keep only the new codebase."_
> Program of record: scrapper `prod-db/BUDGET_SERVING_REDESIGN_PROGRAM_2026-09-01.md`
> §2, §4 S1, §7.1. Evidence: scrapper
> `prod-db/evidence/budget-chronos-serving-2026-09-01/client-operation-inventory.md`.
> Conforms to [`00-foundation-shared-kernel.md`](./00-foundation-shared-kernel.md).

## 0. Decision, in one paragraph

Executed for slice 1 (2026-09-09, amendment at the end of this document). The
legacy roots the client sends keep their **names, argument types and result
shapes** (§1) and are served from **`/api/v1/graphql`** by the kernel modules
over Chronos `transparenta_prod`. The legacy `/graphql` endpoint and its modules
are deleted; `api.js` survives only as a slim composer of the same kernel surface
plus the platform modules until slice 2 ports those and deletes `api.ts`. The
roots the kernel does not carry are **not** ported — the native roots replace
them (B/F1) and the **client migration is the gate**: the URL switch, the four
invalid documents, and the rewrite of the unported operations onto the native
names in §2.

## 1. What "unchanged" means, precisely

Client-visible surface (inventory §5), frozen:

- **Input types and enums by name and field:** `AnalyticsFilterInput`,
  `AnalyticsExcludeInput`, `AnalyticsInput`, `ReportPeriodInput`, `PeriodSelection`,
  `PeriodIntervalInput`, `PeriodType`, `PeriodDate` (scalar, by name),
  `Normalization`, `Currency`, `ReportType` (enum with the Romanian-literal value
  resolver), `AccountCategory`, `ExpenseType`, `SortOrder`, `EntityFilter`,
  `UATFilterInput`, `BudgetSectorFilterInput`, `FundingSourceFilterInput`, the two
  classification filters, every `Commitments*Input`, every `Ins*FilterInput`.
  **Only `@deprecated` markers may be added** (user constraint); additive fields
  are discussed one by one (program Appendix B). Two additive fields were
  accepted and recorded by the owner on 2026-09-09 (review B/F4):
  `AnalyticsFilterInput.is_territorial_executive: Boolean`
  (`budget/shell/graphql/legacy/typedefs.ts:187`) and
  `AnalyticsSeries.missingPeriods: [String!]` (`:115`). They are the only
  additions beyond `@deprecated` markers and the §3 collision renames.
- **Root names and signatures** as in inventory §4.
- **Result field names** (snake_case) and array order as the legacy resolvers emit
  them; `__typename` where the client reads it (`commitmentsSummary` union members).
- **Output type NAMES are not frozen** unless the client reads `__typename` or
  spreads a fragment on the name. Verified: only the `CommitmentsSummaryResult`
  union members are read by name. So a legacy output type may be renamed when it
  collides with a kernel type (§3), field names untouched.

Semantics frozen or deliberately changed — the **compatibility manifest** — is
program §2.2, decided as _"fix the bugs, document every difference"_: omitted
`report_type` sums all **supported** report types (kept; emitted as a
parameterized `IN` over the three execution literals so the planner prunes —
§7 delta 3); `[]` means "no filter" (kept — the
kernel's `in: []` → `false` must not apply on these roots); the five silently
ignored nested exclusions and `aggregate_min/max_amount` are **implemented** (a
documented delta); annual factor broadcast, composite normalizations, the
`percent_gdp` exclusivity and the growth rule keep the `legacy` normalization
policy (program D2); the 10,000-point cap stays and is logged.

## 2. Deployment matrix — what serves each root, on which build

### 2.1 The two entrypoints, one composition

| Build                 | Entrypoint                                           | Composition                                                                                                                                     | Deployed today                                                                                                                                       |
| --------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C** — kernel build  | `dist/redesign-api.js` (`src/redesign-api.ts`)       | `buildRedesignApp` → `registerRedesignSurface` with the default module set (`build-redesign-app.ts:222-235`, `:287`)                            | Chronos dev, image `f0d923fe` (`k8s/overlays/chronos-dev/workload-patch.yaml` `args: ["dist/redesign-api.js"]`, kustomization pin), manual Argo sync |
| **P** — Phoenix build | `dist/api.js` (`src/api.ts`, `Dockerfile:108` `CMD`) | `build-app.ts:857-896` embeds the SAME surface, no `modules` override, so the same default set; plus the platform modules over the legacy pools | Phoenix dev **frozen at `phoenix-last-full` (36b4e998, pre-X/F6 code)** as the cutover baseline; Phoenix prod on `main`. Neither runs this revision. |

The default set is `pnrr, reference, budget, companies, legal, parliament, judicial,
procurement, primarii-transparency, ins-native` (`build-redesign-app.ts:222-235`).
`ins-native` has been in it since X/F6 (commit `962f1c34`, 2026-09-09), and the
surface refuses to boot `budget` without it (`:479-483`). Consequently the budget
module is always built with `native` (`:492-499`) and the four native adapters
win in `makeBudgetModule` (`budget/index.ts:142-172`): native repo, native
execution series, native grouped entities and classifications, promoted factor
set 2, exact-year INS population. Everything else the module still constructs —
`legacyFactors` (set 1) and the `makeLegacyAnalyticsRepo` / `makeLegacyPopulationRepo` /
`makeLegacyDimensionRepo` repos (`budget/index.ts:174-176`) — is **constructed and
never reached** on either build at HEAD, and `makeBudgetRepo(db)` with its embedded
factor table (`:172`, `deps.repo ?? …`) is not even constructed. All of it goes
with `api.ts`.

The frozen Phoenix dev is different code: its default set had no `ins-native`, so
there `executionAnalytics` runs the legacy policy on set 1 (§7, §9) and the native
budget roots use the pre-WP6 float table. That is what the cutover replay's
baseline serves, by design.

### 2.2 GraphQL roots on `/api/v1/graphql` (identical on C and P)

| Root(s)                                                                                                                                                                                                              | Served by (HEAD)                                                                                                                                                                                                                        | Money factors                               | Population                                                                                      | Client status                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executionAnalytics` (carried, `budget/shell/graphql/legacy/typedefs.ts:529`)                                                                                                                                        | native strict series `makeNativeExecutionSeries` (`budget/index.ts:151`, `shell/native/execution-series.ts`) via `deps.executionSeries?.() ?? legacyExecutionSeries` (`legacy/resolvers.ts:179-180`; the fallback is unreachable)       | set 2, exact year, missing periods reported | annual POP107D + sector admission per scope, ancestor-suppressed                                | carried; contract §1; one corpus document passes; no corpus document exercises a normalized request (review §5.1)                                                                                   |
| `entityAnalytics`, `aggregatedLineItems` (carried, `legacy/grouped-typedefs.ts:132`, `:259`)                                                                                                                         | `makeNativeGroupedEntities` / `makeNativeGroupedClassifications` (`budget/index.ts:157`, `:163`) via `deps.X?.() ?? grouped*Analytics` (`legacy/grouped-resolvers.ts:39`, `:53`; fallbacks unreachable); fact path, not the summary MVs | set 2, strict                               | per-entity annual anchor cells / annual scope union                                             | carried; 3 + 2 cutover cases fail on declared native deltas ([`NATIVE_GROUPED_ANALYTICS_2026-09-05.md`](./NATIVE_GROUPED_ANALYTICS_2026-09-05.md)); DP-01 double count until the scrapper fix lands |
| `budgetSectors`, `fundingSources`, `functionalClassifications`, `economicClassifications` (carried, `legacy/typedefs.ts:534-590`)                                                                                    | legacy resolvers over `makeLegacyDimensionRepo` (`budget/index.ts:176`)                                                                                                                                                                 | —                                           | —                                                                                               | carried; pass or allowlisted (`tests/golden-master/parity-allowlist.json`: two pinned `totalCount` entries, ten classification drifts)                                                              |
| `budget*` native roots (24, `budget/shell/graphql/typedefs.ts:434-592`) incl. `budgetEntityRanking(Page)`, `budgetCountyHeatmap`, `budgetUatHeatmap`, `budgetCommitment*`, `budgetTimeseries`, `budgetSectorCatalog` | `makeNativeBudgetRepo` (`shell/native/budget-repo.ts:25-31`) = `makeBudgetRepo(db, { moneyFactors })` + population snapshot borrowing                                                                                                   | set 2 via `BudgetRepoOptions.moneyFactors`  | annual cells via the INS port, also for nominal ranking metadata (N/N3 blast radius, doc 14 §3) | native replacements for the unported roots (next table); `budgetSectorCatalog` is the renamed native `budgetSectors` (§3)                                                                           |
| `ins*` roots (8, `ins-native/shell/graphql/legacy/typedefs.ts:405-477`)                                                                                                                                              | `makeInsNativeModule` (`build-redesign-app.ts:456-468`)                                                                                                                                                                                 | none (decimal text)                         | POP107D reader                                                                                  | carried byte-for-byte minus `insUatIndicators` / `insCompare`; 3 cases fail on the dimension-slug contract, 14 on undeclared value-level deltas (allowlist decision pending, review §5.1)           |
| Kernel base roots `health`, `entity`, `organizationLabels`, `searchEntities` (`shared/shell/graphql/typedefs.ts:249-276`)                                                                                            | kernel                                                                                                                                                                                                                                  | —                                           | —                                                                                               | new surface; `entity` / `searchEntities` replace the legacy `entities` / `uats` pickers                                                                                                             |

### 2.3 Legacy roots NOT on the kernel (B/F1: client migrates, nothing is ported)

| Legacy root(s)                                                                                                         | Replacement on `/api/v1/graphql` or REST                                                                                                   | Cutover cases                |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| `entities`, `uats` (pickers)                                                                                           | `searchEntities`, `entity`, `organizationLabels`                                                                                           | 10                           |
| `datasets`, `staticChartAnalytics`                                                                                     | none on GraphQL; the datasets module stays a platform module on P only                                                                     | 5                            |
| `heatmapCountyData`, `heatmapUATData`                                                                                  | `budgetCountyHeatmap`, `budgetUatHeatmap`                                                                                                  | 2                            |
| `commitmentsSummary`, `commitmentsAggregated`, `commitmentsAnalytics`, `commitmentsLineItems`, `commitmentVsExecution` | `budgetCommitmentSummary`, `budgetCommitmentTimeseries`, `budgetCommitmentRanking`, `budgetCommitmentLineItems`; the REST commitments map  | 4 (+2 `dead` corpus entries) |
| `insUatIndicators`, `insCompare`                                                                                       | dropped (decision D5; no client document sends them)                                                                                       | —                            |
| `budgetSector(id)`, `fundingSource(id)`, `functionalClassification(code)`, `economicClassification(code)`              | not carried at all (`legacy/typedefs.ts:20-22`); never sent by the client                                                                  | —                            |
| `FundingSource.executionLineItems` (field)                                                                             | carried for SDL identity only; selecting it answers `NOT_PORTED` (`legacy/typedefs.ts:301`, `legacy/resolvers.ts:167-172`, decision S1-11) | —                            |

Corpus: `tests/golden-master/corpus/client-documents.json`, 68 entries — 59 `live`,
4 `invalid-today`, 5 `dead` (excluded from the replay: two commitments documents,
two INS documents the client no longer sends, one campaign directory). The current replay result
is the deploy record (`docs/reviews/chronos-migration-2026-09-09/deploy-2026-09-10.md`,
"Later syncs"): 46 failing, identical since WP1, of which 21 are this table and
25 are kernel-mounted roots awaiting a parity decision.

### 2.4 REST and MCP surfaces, per build

| Surface                                                                                            | C (kernel build)                                                                                                             | P (`api.js`)                                                                                     | Evidence                                                                           |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `/api/v1/mcp` (POST JSON-RPC incl. `tools/list`; GET/DELETE 405)                                   | yes; budget tools over the native repo                                                                                       | yes, same dispatcher and repo                                                                    | `build-redesign-app.ts:770-802`; `budget/index.ts:222`                             |
| Native advanced-map routes (`/api/v1/advanced-map-analytics/*`, `/api/v1/advanced-map-datasets/*`) | yes when `config.userData` is complete (Clerk auth + `USER_DATA_DATABASE_URL` + CA + webhook secret, else config load fails) | yes over `embeddedUserStore` (the legacy-owned user DB), `ownerRateLimiter: false`               | `build-redesign-app.ts:506-546`; `redesign-env.ts:391-417`; `build-app.ts:879-892` |
| `POST /api/ins/dataset-requests`                                                                   | **no** (embedder only until slice 2)                                                                                         | yes                                                                                              | `build-redesign-app.ts:150-161`, `:552-559`                                        |
| `/api/v1/pnrr`, `/api/v1/parliament`, `/api/v1/legal` REST                                         | yes                                                                                                                          | yes                                                                                              | `build-redesign-app.ts:748-764`                                                    |
| `/api/v1/agent`                                                                                    | no                                                                                                                           | yes when `AGENT_ENABLED` + user DB + Clerk (+ `REDIS_URL` in production, `build-app.ts:788-792`) | `build-redesign-app.ts:811-826`; `build-app.ts:872`                                |
| Clerk `user.deleted` receiver                                                                      | surface's `makeClerkUserDeletionRoutes` over the Chronos dev user store                                                      | legacy `makeClerkWebhookRoutes`; the surface registers none                                      | `build-redesign-app.ts:369-385`; `docs/USER-DATA-ANONYMIZATION.md`                 |
| Health                                                                                             | `/api/v1/live`, `/api/v1/health`, `/api/v1/ready` (probes use `/api/v1/live`)                                                | those plus legacy `/health/live`, `/health/ready` (`health/shell/rest/routes.ts`)                | `build-redesign-app.ts:840-865`; `build-app.ts:743-748`; `workload-patch.yaml`     |
| Platform modules (notifications, campaigns, share, user-data, report, …)                           | no — slice 2                                                                                                                 | yes, over `budgetDb` / `userDb`                                                                  | `build-app.ts`; README §8 slice-2 decision                                         |
| Mount failure                                                                                      | construction error closes the app and rethrows                                                                               | child scope logs and rethrows (fail-closed; INS-03 fixed)                                        | `build-redesign-app.ts:290-296`; `build-app.ts:900-907`                            |

Known inconsistency, not fixed here: `Dockerfile:79` declares a `HEALTHCHECK` on
`/health/live`, a path the kernel build does not serve. Kubernetes ignores Docker
health checks, so it is inert in-cluster; it only matters for `docker run`.

## 3. Mounting on the kernel: collisions and the three rules

The kernel merge gate (`src/modules/shared/shell/graphql/merge.ts:127-154`) rejects a
slice that re-declares a kernel base type or a type another slice defines, and a
field two slices add to the same type. Three legacy names collide:

| Collision                                                                                                                                                                                          | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Query.budgetSectors` — legacy `budgetSectors(filter, limit, offset): BudgetSectorConnection!` vs redesign `budgetSectors(search, ids): [BudgetSector!]!` (`budget/shell/graphql/typedefs.ts:552`) | **the legacy signature wins** (client-used). The redesign root is renamed `budgetSectorCatalog` — it is a new-API root, no client uses it (inventory §2), so this is not a compatibility change. Same treatment for any other redesign root that collides later.                                                                                                                                                                                                                                                                                                     |
| `Query.health`, `Query.entity` — kernel base roots (`shared/shell/graphql/typedefs.ts:251,253`)                                                                                                    | legacy roots **not ported** (never sent).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `type Entity`, `type PageInfo` — kernel base types                                                                                                                                                 | legacy `entities` returns `LegacyEntity` (fields `cui name entity_type is_uat uat{…}` unchanged; no client reads `__typename` here). `PageInfo`: the legacy connections need `totalCount` and `hasPreviousPage`; the kernel `PageInfo` (`shared/typedefs.ts:16-19`) lacks them → **`extend type PageInfo { totalCount: Int, hasPreviousPage: Boolean }`** in the legacy slice (nullable on the type; the legacy resolvers always populate them; kernel connections leave them null). Per-module `PageInfo` clones (`EntityAnalyticsPageInfo` etc.) keep their names. |

Rules for the legacy slices:

1. **Byte-identical SDL for the frozen types.** The legacy SDL strings moved from the
   legacy modules into the owning kernel module's `shell/graphql/legacy/typedefs.ts`
   unchanged, minus the roots not ported and plus the three collision resolutions
   above. The r2 byte-identity test against the deleted modules' SDL went with
   them in slice 1 (`d10d6e39`); what remains is the provenance map
   `BUDGET_LEGACY_SDL_PROVENANCE` (`legacy/typedefs.ts:619-666`) naming the source
   file of every carried definition, and the cutover replay's envelope comparison
   (§6), which is where a shape change would surface.
2. **Thin resolvers.** A legacy resolver only (a) maps legacy args → the module's
   typed query, (b) calls the same usecase the `budget*` roots call, (c) maps the
   view model → the legacy result shape. **No SQL in the slice.** Where a legacy
   root needs a query shape the module lacks, the module gains a **usecase**, not
   the slice.
3. **Fact path, not the summary MVs** (superseded r2 rule 3, which routed
   `executionAnalytics` to the MVs when the exclusion set matched and read the
   rankings and heatmaps from the MVs). Since the 2026-09-09 amendment point 3 the
   carried roots aggregate `budget.execution_line_items` per (year, entity) in SQL
   (`grouped-analytics-repo.ts`, the native execution series); the creditor
   collapse is that summation, which inherits DP-01 until the scrapper fix lands.

## 4. Per-root implementation notes (budget module)

Superseded by the §2 matrix and the 2026-09-09 amendment. The r2 rows for
`heatmapCountyData` / `heatmapUATData` and the `commitments*` roots were never
implemented on the kernel (review B/F1: native replacements instead); the row for
`executionAnalytics` described `legacyExecutionSeries` over the interim YAML
factor source, which at HEAD is the unreachable fallback behind the native series
(§2.2 row 1); the `entityAnalytics` row described an MV path that is no longer
used (§3 rule 3). What remains binding is the module boundary: the carried roots
live in `src/modules/budget/shell/graphql/legacy/` and `src/modules/ins-native/shell/graphql/legacy/`,
and resolve through the same usecases as the native roots (`budget/index.ts:142-200`).

## 5. Order and gates

Status of the r2 plan (kept for the citations):

1. **Harness** — done: `tests/golden-master/specs/client-documents.gm.test.ts`
   (baseline/target dual-endpoint replay, full-envelope capture, classifier) and the
   corpus of §2.3.
2. **Budget roots** — done for the carried roots (§2.2); the explained-per-root
   deltas are the allowlist and the native amendment documents.
3. **Reference roots** (`entities`, `uats`) — superseded: not ported, replaced by
   the kernel entity roots (§2.3).
4. **`datasets`** — superseded: not ported (§2.3).
5. **INS** — done 2026-09-07 as `ins-native` (before step 4, not after).
6. **Client** — **pending, the gate**: switch the transport base path to
   `/api/v1/graphql`, fix the four `invalid-today` documents (`UatNames`,
   `BudgetSectorNames`, `FundingSourceNames` — `[String!]` in an `[ID!]` position;
   `GetDatasets` selects a non-existent `data` field), migrate the §2.3 operations
   to the native names, delete the `VITE_API_MODE` gate.
7. **Retire** — executed for slice 1 (legacy endpoint, modules, pools and envs of the
   deleted modules; the `REDESIGN_SURFACE_ENABLED` bridge is gone). Slice 2 (the
   platform modules onto the kernel app, then `api.ts`, `build-app.ts`, `budgetDb`)
   waits on Redis/Resend on Chronos or the owner decision in the codebase plan.
   G0 (fix all known data defects) gates the prod release, not the code.

## 6. What the golden master must prove (acceptance)

The proof is the cutover replay (amendment point 4): baseline Phoenix dev pinned at
`phoenix-last-full`, target Chronos dev, `pnpm test:gm:cutover`.

- Every `status: "live"` document: identical `data` key set (aliases included),
  identical array order, identical `__typename` where selected, identical
  `pageInfo`, numbers equal at 2 dp with every exact difference listed; **no new
  `errors[]`** — except where the parity allowlist records a decision.
- Every `status: "invalid-today"` document: the same error envelope on both
  endpoints until the client fix ships, then valid on the new endpoint only.
- Every intentional delta from the compatibility manifest (§1) and the native
  amendments appears in `tests/golden-master/parity-allowlist.json` with a reason
  and before/after numbers; stale entries fail the run.
- The 14-case kernel snapshot suite (`legacy-execution-analytics-kernel.gm.test.ts`,
  `pnpm test:gm`) is a local diagnostic against the deployed target, not a gate.
- The replay runs against both the browser base URL and `INTERNAL_API_URL` (SSR).

## 7. `executionAnalytics` — the documented deltas of the legacy policy (r2, 2026-09-02)

**Which entrypoint this section describes (r3):** the `legacy` normalization
policy of `legacyExecutionSeries` — carry-forward, missing factor ⇒ unadjusted,
one filter-wide population — which is what the frozen Phoenix dev baseline
(`phoenix-last-full`) serves. At `dev` HEAD no server reaches it: both
entrypoints dispatch `executionAnalytics` to the native strict series (§2
matrix, `legacy/resolvers.ts:179-180`), whose own deltas are in
[`NATIVE_GROUPED_ANALYTICS_2026-09-05.md`](./NATIVE_GROUPED_ANALYTICS_2026-09-05.md)
and review rows B/F2, N/N4, N/N5. The table stays because it is the allowlist
basis for the cutover replay (baseline = this policy, target = the native
series) and because the code cites its delta numbers.

The slice: `src/modules/budget/core/legacy-analytics/*`,
`shell/factors/{dataset-factor-source,cpi-level}.ts`, `shell/graphql/legacy/*`,
`shell/repo/legacy-{analytics,population}-repo.ts`. Every difference from the
legacy `/graphql` implementation, with the legacy lines it deviates from. "Before /
after" numbers are Chronos measurements of 2026-09-02 unless stated. Items marked
**GM** move a golden-master snapshot and are the classifier's allowlist for this
root (the dual-endpoint cutover harness, worktree `gm-cutover-harness`, is the gate
that classifies them; the kernel spec `legacy-execution-analytics-kernel.gm.test.ts`
asserts the full envelope — no `errors[]` — and the data at 2 dp).

| #   | Delta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Legacy lines                                                                                                                                                         | Kernel                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Per-capita denominator on the `is_uat` / `entity_types` scopes (GM, fixed bug — program §1.17). Historical: this describes the pre-X/F6 legacy-population path; the native series divides each year by the scope's exact-year population with ancestor suppression (row 2, X/F6).** Legacy `SUM(DISTINCT u.population)` deduplicated by VALUE over a level-mixed hierarchy (county rows + Bucharest 179132 alongside the UATs/sectors they contain). Measured for `is_uat = true`: legacy **36,237,856** (3,228 territories, each person ≈1.9×); id-deduplicated **38,107,630** (still 2×); the kernel's UAT-level universe **19,053,815 over 3,186 rows** = the national county-row total. Rule (`UAT_LEVEL_UNIVERSE`, a pre-D1 proxy for `territories.level = 'uat'`): exclude county rows (`siruta_code = county_code`, 41 rows = 17,336,832) and exclude 179132 (1,716,983) when any of its six sectors is in the same set. Per-capita values on these scopes roughly **double**. Numerators unchanged. `entity_cuis` / `uat_ids` scopes stay as named by the caller (a county-council CUI = its county; a list mixing a container with its parts still double-counts — documented risk). County-council path unchanged. L2's `is_uat` redefinition will move these a second time (§1.17). | `normalization/shell/repo/population-repo.ts:173, :256, :267, :281` (`SUM(DISTINCT u.population)`), `:277-286` (`getPopulationOfAllUats`), `:252-271` (entity types) | `shell/repo/legacy-population-repo.ts` `uatLevelUniverse`, `byEntityTerritories(…, 'uat-level')`; e2e "per_capita with is_uat: true alone"                                                                                                                                           |
| 2   | **Country per-capita denominator (GM).** Legacy divided by the static county-row sum (19,053,815); the kernel divides each year by the exact-year national POP107D population (commit 4036d387, 2026-09-08, "Use annual scope populations"; review README B/F2, N/N4, N/N5; adapters consolidated by X/F6: 2016 = 22,273,309 … 2024 = 21,849,217), so `yearly-per-capita` / `quarterly-per-capita` move by ×0.855–0.872 (2016: 16001.43 → 13688.5). Re-baselined 2026-09-10 with the numbers in the kernel spec's header. Superseded: the pre-X/F6 plan served the reference dataset's latest year, 19,050,000 (×1.0002).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `population-repo.ts:63-83` (`getCountryPopulation`), `population.ts:37-43`                                                                                           | `budget/shell/native/execution-series.ts` → `annual-scope-population.ts` (`readNativeAnnualScopePopulation`) → `repo/grouped-population-anchors.ts` (country node `nuts:RO`) → the `ins-native` `AnnualPopulationPort`; `core/legacy-analytics/native-normalize.ts` divides per year |
| 3   | **Omitted `report_type` → `IN` over the three supported execution literals.** Legacy emitted no predicate and summed whatever the phoenix table held. Same rows today (the `_default` partitions are empty); the planner now prunes to the six `_rtN_ch` leaves for a two-year query and never scans a `_default` leaf (Chronos `EXPLAIN` 2026-09-02, e2e `EXPLAIN`); an unexpected report type can never be summed into a chart silently (e2e seeds one).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `infra/database/query-filters/dimension-filter.ts:38-39`                                                                                                             | `shell/repo/legacy-analytics-repo.ts` `ALL_EXECUTION_REPORT_TYPE_LITERALS`                                                                                                                                                                                                           |
| 4   | **CPI base year = the latest year in the series (GM label only).** Legacy hard-coded 2024; the unit label follows the base actually used (`RON (real 2024)` today — identical until the CPI series gains 2025).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `execution-analytics/core/usecases/get-analytics-series.ts:137` (`computeCpiAdjustmentFactorMap(cpiIndex, 2024)`), `:225`                                            | `core/legacy-analytics/normalize.ts` `computeCpiFactors`, `resultAxis`                                                                                                                                                                                                               |
| 5   | **CPI representation: the port carries the D2 chain-linked LEVEL; the core takes ratios.** Legacy chained the YoY index per request. Anchor-invariant: factors identical to 19 significant digits on the unit fixture; on the real 1971–2024 series a 1e12 RON total differs by < 1e-5 RON for 2016–2024 (12-dp level rounding, D2 `numeric(32,12)`). Non-positive or gapped YoY input is an `Upstream` error (D2 blocks the same), where legacy skipped the point.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `normalization/core/cpi-adjustment-factors.ts:46-60` (chaining), `:54-55` (skip)                                                                                     | `shell/factors/cpi-level.ts`, `dataset-factor-source.ts`; unit "PROOF" tests in `normalize.test.ts`                                                                                                                                                                                  |
| 6   | **Decimal end to end under a pinned policy (precision 40, ROUND_HALF_EVEN; user decision 2026-09-02) — a rounding-class delta.** Legacy converted every point and factor to a JS double and did the inflation, FX, %GDP, per-capita and growth arithmetic in floats (~15.95 significant digits); the kernel never does. Values are equal at 2 dp and differ only in trailing digits, ≤ 1e-9 relative (13 §6 acceptance); proven by a float replica of the legacy chain in `decimal-policy.test.ts` for 1e3 … 1e12 RON, per-capita, %GDP and growth. `number` only at the GraphQL `Float!` boundary.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `get-analytics-series.ts:87` (`toNumber()`), `:129`, `:148`, `:168`, `:183` (factor `.toNumber()`), `:132`, `:181` (double ops)                                      | `core/legacy-analytics/decimal.ts` `LegacyDecimal`; `decimal-policy.test.ts`                                                                                                                                                                                                         |
| 7   | **Dataset failures other than NotFound abort the batch (`Upstream`).** Legacy swallowed EVERY dataset error kind and served nominal values under the requested label. NotFound keeps the legacy policy (unadjusted) and is logged once per kind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `get-analytics-series.ts:301-316` (`if (res.isOk())`)                                                                                                                | `shell/factors/dataset-factor-source.ts`                                                                                                                                                                                                                                             |
| 8   | **Population-source failures abort the batch (`Database`).** Legacy silently disabled per-capita and served nominal values under `/capita`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `normalization/core/population.ts:37-51`, `get-analytics-series.ts:318-327`                                                                                          | `usecase.ts` `loadContext`                                                                                                                                                                                                                                                           |
| 9   | **Implemented, previously ignored inputs.** `aggregate_min/max_amount` (HAVING on the period sum) and the five exclusions `main_creditor_cui`, `funding_source_ids`, `budget_sector_ids`, `expense_types`, `program_codes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `infra/database/query-filters/exclusion-filter.ts:32-120` (the five absent), `amount-filter.ts` (aggregate bounds absent), `types.ts:129-146`                        | `core/legacy-analytics/clean.ts`, `legacy-analytics-repo.ts` `havingClause`, exclusions block                                                                                                                                                                                        |
| 10  | **NULL-safe exclusions on nullable columns.** Legacy `economic_code NOT IN (…)` dropped NULL-economic-code rows (0 such rows in y2025_rt1_ch, so no live delta on expense); `exclude.regions` alone raised a SQL error (uats joined without entities).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `exclusion-filter.ts:68-70` (economic), `:44-54` (report/entity/functional, non-null columns — unchanged)                                                            | `legacy-analytics-repo.ts` `notInNullSafe`, `noPrefixNullSafe`                                                                                                                                                                                                                       |
| 11  | **Non-integer `[ID!]` values are `InvalidInput`.** Legacy `toNumericIds` silently dropped them (an id list of `['abc']` became "no filter" and widened the result).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `infra/database/query-filters/composer.ts:171`, `entity-filter.ts:270`, `exclusion-filter.ts:91`                                                                     | `clean.ts` `ids()`                                                                                                                                                                                                                                                                   |
| 12  | **Unbounded period selections are `InvalidInput`.** Legacy emitted no period predicate for an empty / unparseable selection (a scan of every year); on the partitioned facts that is the forbidden unbounded scan (02 §0.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `infra/database/query-filters/period-filter.ts:166-230` (`buildPeriodConditions` returns `[]`)                                                                       | `core/legacy-analytics/period.ts` `planPeriod`                                                                                                                                                                                                                                       |
| 13  | **Error envelope.** Legacy threw `new Error(message)` (no `extensions.code`); the kernel returns `extensions.code` / `type` / `field` (kernel style). Same `message` for the tag-validation and COMMITMENT_* cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `execution-analytics/shell/graphql/resolvers.ts:38-41`, `:79-82`                                                                                                     | `shell/graphql/legacy/resolvers.ts` `toGraphqlError`                                                                                                                                                                                                                                 |
| 14  | **`PeriodDate` scalar: width-identical to legacy** (STRING / INT / FLOAT / ENUM literals → their text; BOOLEAN accepted; LIST / OBJECT / NULL rejected). Residual: legacy handed the raw boolean to `extractYear`, which threw a TypeError; here it is stringified, unparseable, and ends as delta 12.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `execution-analytics/shell/graphql/resolvers.ts:67-73` (`parseLiteral: (ast) => ast.value`), `period-filter.ts:77-85`                                                | `shell/graphql/legacy/resolvers.ts` `PeriodDateScalar`                                                                                                                                                                                                                               |
| 15  | **Statement timeout.** Legacy `QUERY_TIMEOUT_MS` 30 s via `SET statement_timeout` on the pooled connection; the kernel uses `SET LOCAL` inside a read transaction (released on error) — same 30 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `execution-analytics/shell/repo/analytics-repo.ts` `setStatementTimeout`                                                                                             | `legacy-analytics-repo.ts` `STATEMENT_TIMEOUT_SQL`                                                                                                                                                                                                                                   |
| 16  | **The 10,000-point cap is reported.** Legacy `MAX_DATA_POINTS` truncated silently; the kernel fetches one row over, trims, and logs `onCapped` (no silent caps).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `analytics-repo.ts` `MAX_DATA_POINTS`                                                                                                                                | `usecase.ts` `onCapped`, `budget/index.ts` logger hook                                                                                                                                                                                                                               |

Not deltas (kept verbatim, verified): `[]` / `null` = no filter; `seriesId ?? 'default'`;
one series per input in input order; the first error aborts the batch; sparse
`YYYY` / `YYYY-QN` / `YYYY-MM` labels, no zero-fill; `total_euro` / `per_capita_euro`
composites; `percent_gdp` exclusivity; annual factors broadcast to monthly /
quarterly points; carry-forward beyond the horizon; missing (NotFound) factor ⇒
unadjusted; growth after normalization with 0 for the first / missing / zero
predecessor; economic exclusions on the expense side only; faceted tags (OR within a
facet, AND across); `search` as name ILIKE; MONTH / QUARTER / YEAR amount columns via
the period flags (sum-equivalent on Chronos, measured).

## 9. Normalization Phase A — versioned factor reader (2026-09-04)

**Which entrypoint this section describes (r3):** the set-1 pin
(`LEGACY_FACTOR_SET_ID` / `LEGACY_FACTOR_SET_DIGEST`,
`budget/shell/factors/factor-set-source.ts:9-11`) is still constructed on both
entrypoints (`build-redesign-app.ts:487-491`) and handed to the legacy resolver
factories as `legacyFactors`, but at HEAD no root reads it: every money path is
the promoted set 2 through `NATIVE_FACTOR_SET_ID` / `NATIVE_FACTOR_SET_DIGEST`
(`budget/shell/native/factors.ts`, reader built with `requirePromotion: true` at
`build-redesign-app.ts:471-473`). Set 1 is what the
frozen Phoenix baseline serves for `executionAnalytics`. The text below is the
Phase A record as written.

The kernel composition now supplies `executionAnalytics` with factors from
`core.normalization_factors` through normalization's `FactorSetReader`. It pins
set `1` **and** manifest digest
`69cc0473af19ffb406fe9f2ed3f82c7785a3aa4ea6df74dfd360220c92e41078`, implementing
S1-5 and normalization design Phase A. A rebuilt database with another snapshot
at ID 1 fails explicitly. `current()` exists but remains unused by this path;
this is an internal compatibility pin, not public eligibility or promotion.

Reads are lazy. One SQL statement obtains the immutable set identity and rows;
successful frozen snapshots are cached per ID and concurrent loads share work.
Failures retry. The mutable current pointer is never cached. Numeric values
remain decimal text until the existing isolated 40-digit Decimal policy consumes
them; stored CPI levels are not chain-linked again.

The database adapter requires the configured snapshot and each requested yearly
series. Missing sets, wrong manifest identity, invalid values, duplicate keys,
missing kinds, or interior annual gaps return a typed error. Unlike the YAML
oracle's legacy missing-dataset behavior (§7), they never serve unadjusted values
under a normalized label. Subannual rows do not affect yearly factor selection.

No GraphQL shape, existing arithmetic, or client transport changes in this phase.
The legacy `/graphql` normalization and the datasets YAML remain unchanged.
Application SQL is SELECT-only; migrations and factor promotion are not part of
this release. **Deployment scope: server `dev` only (user decision 2026-09-04).**

Verification: all 120 consumed annual factors, including all 54 CPI price levels,
match the current server YAML exactly as Decimal values. The 228-row reference
fixture records the database snapshot and digest; tests also exercise actual
hash-pinned D2 and ETL prerequisite migration DDL on a dedicated empty PostgreSQL
database. Run the SQL regression with `E2E_FACTOR_PG_URL` naming a localhost
`budget_phase_a*` throwaway, `SCRAPPER_REPO_ROOT`, and `TEST_E2E_REQUIRED=1`.
The unit regression runs under the default test suite. Live API comparison is a
separate gate; the existing execution golden-master cases do not by themselves
cover CPI, GDP, or USD. Exact all-factor equivalence supplies that coverage.

The strict paired-kernel check is
`tests/golden-master/specs/factor-source-parity.gm.test.ts`, run with
`--config vitest.config.ts`, `PHASE_A_BASELINE_URL` and `PHASE_A_TARGET_URL`.
Those separate opt-in variables keep this exact-equality check out of the
legacy-to-kernel extended replay, whose documented numeric deltas remain valid.

## 2026-09-05 native grouped-root amendment

The approved user decisions supersede carried bugs for the new `entityAnalytics`
and `aggregatedLineItems` roots. The exact boundary is recorded in
[NATIVE_GROUPED_ANALYTICS_2026-09-05.md](./NATIVE_GROUPED_ANALYTICS_2026-09-05.md):
strict exact-year monetary factors; nullable auxiliary population metrics; known
executive eligibility; checked geographic unions; historical organization-spine
identity retention; unknown classification retention; primary-value thresholds
and sorting; honest empty-page counts. GDP percentage has no auxiliary per-capita
metric. The shared name/CUI search broadening also affects executionAnalytics;
its carried normalization fallback and old-field scope selection remain separate
migration debt. Annual population and release-consistent reads are not complete.

These semantic changes are covered by explicit SDL and actual-Postgres tests.
They are not blanket permissions to suppress golden-master errors. Re-measure
case-specific drift, including the now-loaded T103000 catalog, during full replay
before legacy deletion or final enforcement.

## 2026-09-09 slice-1 amendment — the legacy endpoint is gone; native roots replace the unported legacy roots

Owner decisions of the Chronos migration review (`docs/reviews/chronos-migration-2026-09-09/README.md` §8):

1. **§5 step 7 is executed for slice 1.** The legacy `/graphql` endpoint, the legacy
   GraphQL modules (nine whole modules plus the GraphQL shells of `datasets`,
   `aggregated-line-items` and `entity`, then `commitments` and `uat-analytics`), the
   legacy INS module and database, the legacy MCP/GPT surface, the
   `REDESIGN_SURFACE_ENABLED` bridge and the Phoenix INS port-forward are deleted
   (commits `f3d318b5`, `d10d6e39`, `58e1a576`, `f3072073`, `f5887fa4`). `api.js` remains
   only as a slim composer of the kernel surface plus the platform modules; slice 2 ports
   those onto `build-redesign-app.ts` and deletes `api.ts`, the Phoenix pools and envs.
2. **Unported roots are NOT ported; the native roots replace them.** The §2 rows for
   `entities`, `uats`, `datasets`, `staticChartAnalytics`, `heatmapCountyData` /
   `heatmapUATData` and the `commitments*` roots are superseded (review B/F1, T-09):
   the client migrates to the kernel's own roots and routes — `searchEntities` / `entity`,
   `budgetCountyHeatmap` / `budgetUatHeatmap`, `budgetCommitment*`, the native advanced-map
   REST routes over the kernel provider (which also serve `api.js` since commit 4). The
   carried roots (`executionAnalytics`, `entityAnalytics`, `aggregatedLineItems`, the
   dimension roots, the eight `ins*` roots) keep §1's contract.
3. **`entityAnalytics` reads the fact path**, not the summary MVs: `grouped-analytics-repo.ts`
   aggregates `budget.execution_line_items` summed per (year, entity) in SQL — which is
   the collapse, and which inherits the DP-01 creditor double count on the fact path
   (`docs/reviews/chronos-migration-2026-09-09/dp-01-creditor-handover.md`) until the
   scrapper fix lands (§3 rule 3 / §4 row 2 described an MV path that is no longer used).
4. **The golden-master proof (§6)** is the client-document cutover replay (baseline =
   Phoenix dev pinned at `phoenix-last-full`, target = Chronos dev); the 12 legacy
   snapshot specs were deleted (slice 1 commit 6a). The `executionAnalytics` kernel
   replay stays a local diagnostic until its per-capita snapshots are re-baselined for §7.
5. **Contract amendments the client must absorb** are collected in
   [`14-chronos-contract-amendments-2026-09-09.md`](./14-chronos-contract-amendments-2026-09-09.md)
   (`isUat` strictness, the entity-type vocabulary, the population admission pins).
