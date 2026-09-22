# Procurement data audit — Chronos serving DB, scrapper producer, server consumer

**Date:** 2026-09-09 · **Mode:** read-only review, no code changed, no commits ·
**Snapshot window:** 08:11–09:37 UTC. The nightly `public-contracts` daily-load
(`etl.load_runs` 23532, `procurement.contracts` stage) was running for the whole
window, so `contracts` counts drift by a few hundred rows between sections.

**Cluster / DB convention used throughout.** Every number is tagged with its
source. "Chronos" = kubeconfig `~/.kube/chronos.yaml`, namespace
`transparenta-eu-etl-prod`, pod `transparenta-prod-postgres-1`, database
`transparenta_prod` (PostgreSQL 18.4, postmaster started 2026-09-03 20:14 UTC).
"Griffin raw" = `~/.kube/griffin.yaml`, same namespace, pod
`transparenta-eu-etl-raw-postgres-1`, database `transparenta_eu_public_contracts_raw`.
"Phoenix dev" = `~/.kube/phoenix.yaml`, namespace `hack-for-facts-dev`, pod
`postgres-db-1`, database `hack-for-facts-dev`. "CH" = Chronos ClickHouse pod
`chi-transparenta-analytics-analytics-0-0-0`, database `proto`. "OS" = Chronos
pod `transparenta-eu-etl-opensearch-0`. "Deployed" = the Chronos dev API
`https://dev-chronos-api.transparenta.eu` (namespace `transparenta-eu-dev`,
image `08a7fb6b` = server `dev` HEAD). "Local" = `pnpm dev:redesign` on this Mac.
Rates are tagged **exact**, **planner** (`pg_stats` from the last ANALYZE) or
**sampled** (`TABLESAMPLE SYSTEM`). All SQL was read-only with
`set statement_timeout='90s'`; no `.env` file was read and no secret printed.

Authority resolution: `prod-db/TRACKER.md:340` (topology board) says
`transparenta_prod` is authoritative on Chronos since 2026-07-22 and the Griffin
former primary was retired 2026-08-23 (verified: no `transparenta-prod-postgres`
pod on Griffin today). The raw-mainline board (`TRACKER.md` "Raw-database mainline
board", row `public-contracts | not_started`) means the raw DB is still the Griffin
combined predecessor, which is what was queried.

Method: seven parallel subagents (DB inventory, DB analysis, scrapper extraction,
scrapper load path, scrapper docs, server interfaces, server runtime) plus lead
verifications. Their raw SQL, outputs and logs are in `/tmp/procurement-audit/`
on the reviewing machine (ephemeral; the load-bearing queries are reproduced
inline below).

---

## (a) Executive verdict

Procurement data on Chronos is **not correct and complete enough to serve as a
whole**. The record surface is internally consistent but stale and partly
mislabelled; the analysis surface is a 46-day-old prototype snapshot that the
deployed dev API cannot reach at all; the legacy filter-capability surface
describes a population that no longer exists.

| Surface                                                                            | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Evidence                  |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Record lists / details (Postgres `procurement.*`)                                  | **Served, internally consistent, but with no new rows since the 2026-08-19/20 backfill and split by source**: the SEAP side got a 2007–2015 backfill on 08-19/20; the e-licitatie side has had no new raw data since 2026-07-03. ~245k e-licitatie framework ceilings are labelled `contract_award`. The DA detail surface (11.1M bodies) is unreachable: every e-licitatie DA answers `NOT_CAPTURED`. Buyer-geography list filters silently drop everything loaded after 2026-07-25. | §1, §3, issues 3, 5, 7, 9 |
| Analysis on the **deployed** dev API                                               | **Not serviceable.** `PROD_CLICKHOUSE_URL` is empty in the chronos-dev overlay; every `procurementStats/Series/Breakdown/…` field and the MCP `aggregate_procurement` tool return a Database error. Confirmed live.                                                                                                                                                                                                                                                                   | issue 2                   |
| Analysis when wired (ClickHouse `proto`, and the Postgres facts/rollups behind it) | **Stale and incomplete**: build 8 (published 2026-07-25) misses 789,922 canonical contracts (34.3%), 388,498 procedures (38.4%) and 7,347,323 DAs. CH drifts from the PG facts of the same build on 587 contracts. No production loader exists for CH.                                                                                                                                                                                                                                | issues 4, 10              |
| Legacy MVs / `public_contracts_filter_capabilities_v1`                             | **Frozen 2026-06-29 (72 days)**; a refresh today flips every DA capability row to blocked (authority CUI coverage 0.85 vs 0.98 gate). Nothing in the server reads them any more.                                                                                                                                                                                                                                                                                                      | issue 8                   |
| Flows / search documents                                                           | `flows.money_flows` is rebuilt nightly, but 506,021 of 1,092,760 money-bearing contracts (46.3%) have no `award_attribution` row, so consortium awards from the backfill are not suppressed. `search.documents` last built 2026-08-10 (procedures 622,936 docs vs 1,011,431 rows).                                                                                                                                                                                                    | issue 6                   |

The record APIs, the gate semantics and the money handling in the server are
sound where they are exercised: decimal strings end to end, filters bound to the
resolved comparable measure, gate verdicts reproduce exactly from the facts, GraphQL
and MCP agree to the cent with raw ClickHouse SQL (on Local). The failures are in
deployment wiring, pipeline activation, and freshness, not in arithmetic.

### Premises in the brief that turned out to be wrong

- _\*"Five analysis_rollup_* tables"_* — there are six; `analysis_rollup_value_states_monthly` was added by migration `20260718T091000` (Chronos inventory, exact).
- **"framework_agreements / framework_members if present"** — absent. The reserved range `20260806T09*` (`TRACKER.md:1148-1156`) was used only for `20260806T090000__procurement_contract_framework_role` (adds one column). Framework facts live in `contracts.framework_role`, `subsequent_contracts` (63,246 rows, 2016–2018 only), `subsequent_contract_residuals` (424) and `award_attribution` (617,015).
- **"ServiceUnavailable on matrix_hash mismatch"** — removed in server commit `831ccecc` (2026-07-23). `core/analysis-usecases.ts:224-226` now says "matrixHash is informational passthrough"; 503 fires only when no active generation row exists (`:221`).
- **"gate-v2 reads analysis_generations.quality"** — still true (`shell/repo/generation-repo.ts:124-135`) and confirmed live on Local.
- **"OpenSearch retired 2026-08-23" (`TRACKER.md:340`)** — wrong for Chronos: pod `transparenta-eu-etl-opensearch-0` runs (49 d) and the deployed server points `PROD_OPENSEARCH_URL` at it. What was retired was Griffin's instance.
- **"ClickHouse non-serving, exporter/loader unimplemented" (`TRACKER.md:341`)** — true for the scrapper (no loader code; `proto` was filled by hand from `prod-db/ch-prototype/`), yet ClickHouse is the server's **only** analytics backend since `831ccecc`. `clickhouse-analysis-repo.ts` is live code with real data behind it, unwired on dev.
- **"56 raw migrations"** — 55 files in `src/sources/public-contracts/migrations`, 55 rows in Griffin `contract_control.kysely_migration`, identical.
- **"Records reach 2026-09-03"** (a reading two subagents made) — those are future-dated rows inserted on 2026-06-14/16, not fresh loads (lead verification V1 below).

---

## (b) Ranked issues

Severity: **Critical** = serves wrong/absent answers to users now; **High** = data
materially incomplete or a latent privacy/integrity failure; **Medium** = correctness
drift or operational risk; **Low** = hygiene/docs.

### 1. [Critical · server deployment] The deployed dev API serves no procurement analysis at all

- `k8s/overlays/chronos-dev/configmap-patch.yaml:18` sets `PROD_CLICKHOUSE_URL: ''` (commit `b4e0ec38`, 2026-08-24); live configmap `hack-for-facts-eb-server-config` confirms `PROD_CLICKHOUSE_URL` empty, `PROD_CLICKHOUSE_DATABASE=proto`. Base `k8s/base/configmap.yaml:32` has `http://chronos-prod-clickhouse:8123` — but no Service of that name exists in any Chronos namespace (`kubectl get svc -A | grep -i clickhouse`: `clickhouse-transparenta-analytics` 8443/9440, `transparenta-eu-etl-clickhouse` 8443/9440/9363, `tailscale-transparenta-eu-etl-clickhouse` 8123, all in `transparenta-eu-etl-prod`), so simply restoring the base value would not wire it either.
- `src/app/build-redesign-app.ts:589-599` passes `clickhouse` only when the URL is non-empty → `src/modules/procurement/index.ts:102-109` installs `makeUnconfiguredAnalysisRepo()` (`shell/repo/clickhouse-analysis-repo.ts:1161-1173`), whose every method (including `activeGeneration`) returns `databaseError('procurement analytics backend (ClickHouse) is not configured')`.
- Live (Deployed, 08:15:42Z): `{ procurementStats {} }` → `{"errors":[{"message":"Internal server error","extensions":{"code":"INTERNAL_SERVER_ERROR","type":"Database"}}]}`. MCP `aggregate_procurement {shape:stats}` (08:16:40Z) → `"procurement analytics backend (ClickHouse) is not configured"`. Pod logs show the same GraphQLError from `dist/modules/procurement/shell/graphql/resolvers.js:9`.
- Two comments still promise a Postgres-rollup fallback that was deleted in `831ccecc`: `clickhouse-analysis-repo.ts:7-8` and `build-redesign-app.ts:542` ("Unset = rollups"). No server code reads any `analysis_rollup_*` table (grep: only `shell/db/schema.ts` declares them). One subagent initially concluded "the PG rollups are the live analysis path" from those comments; that inference is wrong and is corrected here.
- Record APIs are unaffected (`index.ts:92-97` builds the record repo without the analysis dependency; confirmed live §3.2).

### 2. [High · scrapper loader + deployment] The analysis substrate is frozen at build 8 (2026-07-25) and misses the whole 2026-08-19 backfill

- Chronos exact: `select build_id,status,published_at,load_run_id from procurement.analysis_generations` → `7 | retired | 2026-07-24 16:24:52Z | 13340`, `8 | active | 2026-07-25 13:32:31Z | 13357`. No `etl.load_runs` row with target `procurement.analysis_facts` after 13357.
- Gap, exact: contracts not in `analysis_facts_contracts` = **803,245** (789,922 canonical; all `created_at` 2026-08-19 11:21–11:43Z, contract_date 2007–2019); procedures = **388,498** (all `seap_notice/initiation`, created 2026-08-19); DAs with `da_id` above the facts' max = **7,347,323** (= load run 19108's backfill; a 0.5% sample corroborates ≈21.8% of DAs absent). Arithmetic check: facts 3,274,708 + 803,245 = 4,077,953 = exact `count(*)` of `contracts` during the window, so the backfill is the only growth since build 8.
- CH `proto.facts_*_v2` carry only `build_id='8'` (facts_contracts_v2 3,274,708; facts_da_v2 26,563,361; facts_procedures_v2 622,933; `dim_build_pin`=8; `meta_value_coverage_v2` computed 2026-07-25 17:10). Last write anywhere in `proto`: 2026-08-04 02:37 (`dim_titles_contracts`). No exporter/loader code in the scrapper (`grep -ril clickhouse src`), `PROCUREMENT_CLICKHOUSE_ANALYTICS_SPEC.md:3` "DRAFT r3 … Not implemented".
- Cause: CronJob `transparenta-eu-etl-public-contracts-analysis-facts` `suspend=True`, `lastSchedule None` (48 d); `etl.sync_policy(analysis-facts).suspended = t` (updated 2026-07-25 12:34). Activation checklist (`PUBLIC_CONTRACTS_NOTES.md:1444-1450`), item by item: (1) image ≥ `8dad70f7` + pin — **done** (`git merge-base --is-ancestor 8dad70f7 1f3caaef` yes); (2) Argo sync — **N/A** (Chronos writers are manually applied, `k8s/environments/chronos/writers/public-contracts/README.md`); (3) smoke one-off — **done** (Jobs `public-contracts-v4-analysis-facts-20260723`, `-v5-facts-20260724` succeeded); (4) unsuspend + flip sync_policy — **not done**.
- Consequences: rollups stop at month 2026-07-01 and contain no 2007–2015 seap_da history although the record APIs serve it; `analysis_facts_contracts.framework_role` exists (migration) but is NULL on every row by construction; `record_change_log` last event 2026-07-23.

### 3. [High · scrapper extraction] e-licitatie raw extraction stopped on 2026-07-03; the nightly replays a fixed watermark and reports success

- Griffin raw (planner upper bounds / exact): `elicitatie_source.contracts.last_seen_at` 2026-07-03 09:19; `list_items.last_seen_at` 2026-07-03 09:11; `ca_notice_contracts` max first/last_seen **2026-06-30 18:36Z** (exact); `ca_notice_detail_projection` max captured_at **2026-07-03 00:35Z** (exact); `direct_acquisition_details.last_seen_at` max 2026-08-14 03:07 (exact); TED 2026-07-11; SEAP `updated_at` up to 2026-08-18 20:41 (the legacy backfill).
- Chronos `etl.load_runs` notes: procedures run 23531 (2026-09-09) `{"mode":"full","routeClass":"elicitatie_ca_notice_list","sourceWatermark":"2026-07-03 00:36:09"}` 24 rows; DA run 23122 `sourceWatermark 2026-07-03 15:08:09`, 101,706 rows — identical every night for 68 days.
- Lead verification V1 (Chronos, 09:34Z): planner histogram upper bounds `contracts.created_at/updated_at` **2026-08-19 11:43:26**, `direct_acquisitions` **2026-08-20 00:52:02**, `procedures` **2026-08-19 11:18:34** (tables analyzed 09-03 / 08-21 / 08-21). Exact: `max(created_at)/max(updated_at)` on `procedures` = 2026-08-19 11:18 / 11:21; DA 1% sample max created/updated 2026-08-20 00:52; contracts planner bound 2026-08-19 (analyzed 09-03). No new row has entered any base table since the backfill, and no row's `updated_at` moved after 2026-08-20; the nightly upserts do physically rewrite tuples without changing content (`pg_stat_user_tables.n_mod_since_analyze`: DAs 2,864,452 since 08-21, contracts 192,269 since 09-03, procedures 828). The "max contract_date 2026-09-03" seen by two subagents is **future-dated rows**: `select count(*) filter (where contract_date > created_at::date), count(*) from procurement.contracts where contract_date >= '2026-06-14'` → `3049 | 3175`; procedures `566 | 566`; DAs with `finalization_date >= '2026-07-04'` (past the raw watermark) = 24,262, all created 2026-06-14 03:04 (exact via `das_finalization_date_idx`); e.g. contract 2814028 has contract_date 2026-09-03 and created_at 2026-06-14 02:16.
- `PROCUREMENT_SERVING_PARITY_RUNBOOK.md:106-115` Step 0 (redeploy the extraction fleet) and Step 0.5 (assert the raw watermark advanced) were never executed; `TRACKER.md` "PC DA browser fleet" row records 5 of 10 DA slots fenced.

### 4. [High · scrapper deployment] The nightly runs a 2026-07-25 image; the August v6 rollout was silently reverted across 39M rows

- Live CronJob digest `sha256:db3ab998…` = `kustomization.yaml:14,36,67-68` image-sha `1f3caaef` (2026-07-25) for all four public-contracts CronJobs; `ops/releases/current.json:10-14` agrees. `git show 1f3caaef:…/value-resolution.ts | grep VALUE_RULES_VERSION` → **5**; HEAD `prod/lanes/value-resolution.ts:100` → **6** (`e06e4783`, 2026-08-05, not an ancestor of the pin). 20 later prod-path commits are absent from the image (incl. `491f9d8e` DA-detail lane, `691b8a64` P0A search-doc scrub, `a5c2ffb6` legacy corpus).
- `etl.load_runs` `procurement.value_resolution`: run 19117 (2026-08-19 20:03Z, **38,961,354** rows, the attended v6 one-off) → run 19572 (2026-08-21 15:21Z, **39,000,068** rows, the first nightly on the v5 image) → every nightly since writes 0. The distinct-guard tuple includes `value_rules_version` (`value-resolution.ts:719-728`), so a lower code version rewrites a higher stamp.
- Today (Chronos): `value_rules_version` = 5 on 100% of rows (procedures exact 1,011,431/1,011,431; contracts 2% sample 80,843; DAs 0.3% sample 101,559; planner mcv `{5}` freq 1.0 on all three); `value_resolved_at` = 2026-08-21 on every sampled row. `attrs ? 'contract_type'` is false on 100% of sampled e-licitatie contracts (3% sample, 34,466 rows) — the v5 loader rewrote `attrs` without the marker; `framework_role` (0% NULL: ceiling .564 / standalone .292 / call_off .144, planner) survives only because the v5 SET clause never touches it — a frozen 08-19 snapshot.
- Render ≠ live: `public-contracts-daily-load.yaml:86-105` appends a `load-da-detail` step that the live CronJob args do not have; `public-contracts-da-detail-full.yaml` is in `kustomization.yaml:29` but no such CronJob exists on the cluster.
- Reliability: 3 of the last 7 nightlies failed (08-25 and 09-01 "ca-detail projection failure (class=other)", 09-08 unhandled pg `read ETIMEDOUT` in the cpv stage, `BackoffLimitExceeded`, no retry). The ledger shows 0 `failed` rows in 30 days; the R-S5 guard (`load-run-abort.ts`, installed `prod-cli.ts:253`) only handles SIGTERM/SIGINT, so 15066, 17729 and 23234 are stranded `running`.
- `PUBLIC_CONTRACTS_NOTES.md:8594-8600` ("rollout landed exactly as forecast") and `PROCUREMENT_SERVING_PARITY_RUNBOOK.md:71-79` describe a state that no longer exists; nothing records the revert.

### 5. [High · scrapper loader + server] The whole DA detail surface is unreachable, which also masks a latent PII exposure

- `procurement.da_details.da_id` is NULL on 100% of 11.1M rows (exact: `select count(*) from procurement.da_details where da_id is not null` → **0**, via the partial index; planner `null_frac = 1`; unique partial index `da_details_da_id_uq … where da_id is not null`). The scrapper's `lanes/da-detail.ts:658-671 resolveDaFks()` would set it from `a.da_key = 'elicitatie_da:' || d.source_ref`, but all six `da_details` load runs (13358–13370, last 2026-07-26 07:31) are `failed`; the weekly `da-detail-full` CronJob was never applied.
- The server looks up bodies by `dd.da_id = daId` (`shell/repo/procurement-repo.ts:565-589`) and maps a missing row to `not_captured` (`shell/repo/da-detail-bundle.ts:102-108`). Lead verification V2, Deployed 09:36:43Z, for three e-licitatie DAs whose `da_details` rows exist (da_ids 2354482, 2354489, 2535469 ↔ da_detail_ids 42982, 42989, 253156): `{"detailAvailability":"NOT_CAPTURED","detail":null}` on all three. So every one of the 11.1M captured detail bodies and 16.7M items is served as "not captured".
- Latent privacy defect behind it: `procurement-repo.ts:598-619` selects `da_items` without `privacy_class` and `mappers.ts:454` maps item text verbatim; only the parent `da_details` prose is redacted (`mappers.ts:472`). `da_items.privacy_class = 'contact_pii'` on 2.17% (planner, ≈363k rows); a 0.5% sample of `da_details` found 674 of 53,279 **public** parents (1.27%) with at least one `contact_pii` item; the three DAs above each have exactly one. The scrapper flags these deliberately (`prod/lanes/da-detail-pii.ts:94-105`). The moment `resolveDaFks` runs, ≈135k public DA detail pages would serve detector-flagged text through GraphQL `ProcurementDaDetail.items` (client renders `catalogItemName/Description`, `procurement-queries.ts:537-541`). MCP does not expose the detail bundle, but `mcp/tools.ts:5` claims the module is "PII-free".

### 6. [High · scrapper lane] `award_attribution` was last computed 2026-07-24; 46% of money-bearing contracts are unattributed and the gate only warns

- Chronos: `award_attribution` 617,015 rows, all `build_id 7`, computed 2026-07-24 22:28 (exact). Nightly gate run 23128 (2026-09-07): `award_attribution_coverage` **warning**, observed 0.4631 vs threshold 0.005, `{"moneyPopulation":1092760,"attributionTotal":617015,"missingContracts":506021}`, message "new association contracts may be serving unsuppressed; rerun the attribution lane" — on every nightly since 2026-08-19. `validate.ts:1505-1545` makes this warn-tier, so it never blocks.
- Mechanism (not a measured amount): the flows upsert nulls money only for rows classified `member_suppressed`/`quarantined` (`load-prod.ts:2357,5513`); unclassified consortium awards from the backfill are therefore carried at full value per member into `flows.money_flows` (entity-360). The analysis lane never reads `award_attribution` at all (grep on `lanes/analysis-facts*.ts` → none); the PG rollups sum replicated consortium values (e.g. notice CAN1122054 counted twice at 810,110,943.00 in the 2024-03 authority total), but nothing reads those rollups. The ClickHouse path does apply attribution (`core/analysis-usecases.ts:114-182,408-443`; CH `value_awarded_attributed_bani`).

### 7. [High · server + DB] Record lists with buyer-geography filters silently exclude everything loaded after 2026-07-25

- `shell/repo/offset-search-repo.ts:203-236` implements `buyerRegion/County/Siruta` on the SQL path by joining `procurement.analysis_facts_*` (build 8 population). With 803,245 contracts, 388,498 procedures and 7,347,323 DAs absent from the facts (issue 2), those records vanish from any geography-filtered list while appearing in unfiltered lists. Deployed lists are SQL (`provenance.engine = "postgres"`, §3.3), so this is the live path. Code-derived: Deployed `buyerRegion:{eq:"Nord-Vest"}` was confirmed to return rows, but the exclusion of a 2007–2015 backfill record was not probed live.

### 8. [Medium · DB / scrapper] F1 is still latent: the legacy matviews are frozen at 2026-06-29 and a refresh would block the DA surface

- `aggregate_quality_by_grain` / `public_contracts_filter_capabilities_v1` `refreshed_at 2026-06-29T07:26:59Z` (exact): DA rows 15,722,185, date .958, amount .994, authority_cui .987; contract rows 970,182, amount .810 (`spend_ranked_top_n = false`). Relation file mtimes for all six legacy MVs: 2026-06-29 07:35–07:59.
- Live `flows.money_flows` (reltuples 30,985,902; run 23130 scopeTotal 31,022,949), two independent samples (2% and 1%): DA `date 0.979 / amount 0.993 / payer_cui 0.849–0.850 / payee_cui 0.994 / cpv 0.995`; contract `date 0.95 / amount 0.44–0.45`. The July F1 axis (DA date/amount ≈0.65/0.68) is repaired, but `payer_cui 0.85 < min_authority_cui_coverage 0.98` (`aggregate_filter_thresholds`) still flips `filter_answers_allowed=false` for every DA row on refresh. Cause (sampled): the 2007–2015 seap_da backfill has `authority_cui` NULL on 56.7% of rows (names present, legacy files carry no CUI) vs 0.3–0.6% for 2016+. Contract amount coverage fell 0.81→0.44 because framework canonicals carry no comparable value.
- No refresh ledger exists; nothing in the server reads these MVs (grep: 0 references to `org_edge_monthly_rollups`, `aggregate_quality_by_grain`, `procurement_flow_facts_v1`), so the risk is to whatever still consumes `public_contracts_filter_capabilities_v1`.

### 9. [Medium · scrapper canonicalisation → server list filter → client facet] `record_kind` is minted SEAP-blind; ~245k e-licitatie framework ceilings are labelled `contract_award`

- `prod/lanes/value-resolution.ts:522-523` sets `record_kind = has_framework ? 'framework_agreement' : 'contract_award'` from the SEAP-only framework marker (admitted at `:93-96`). `framework-role.ts:60-78` derives `framework_role` from the e-licitatie `contract_type` attr.
- Chronos 3% sample: `elicitatie_ca_award | contract_award | framework_ceiling | 7,878` (≈22.7% of e-licitatie contracts); planner gap `record_kind framework .502` vs `framework_role ceiling .564` ≈ 245k rows. Contract 2814028 is `record_kind = framework_agreement` with `framework_role = framework_ceiling` (SEAP, consistent), but e-licitatie ceilings carry `contract_award`.
- Consumers: the server list filter and the client "purchases/frameworks" facet key on `recordKind` (`mappers.ts:337`, client `procurement-mappers.ts`); the server hard-disables `frameworkRole` (`core/constants.ts:131-133`) because CH build 8 has no such column, so contract analytics serve legacy totals with the caveat at `core/analysis-usecases.ts:254-259` — labelled, not silently excluded — while SDL (`typedefs.ts:674-676`) and MCP (`tools.ts:96-100`) still advertise the field.

### 10. [Medium · scrapper `prod-db/ch-prototype`] ClickHouse build 8 drifts from the Postgres facts of the same build

- CH `facts_contracts_v2`: 587 canonical rows with `date_basis IS NULL` although `contract_date IS NOT NULL`; PG `analysis_facts_contracts`: 0 such rows. Canonical undated contracts CH 97,688 vs PG 97,194. Example contract 51687882: PG `date_basis 2020-09-10, date_source own`; CH `date_basis NULL, date_source own, contract_date 2020-09-10`, identical `updated_at 2026-07-25 12:38:20`. Procedures/DA undated counts match (369,326 / 624,393). This is what breaks two golden series months (185→184, 161→160). The server never checks CH `dim_build_pin` against PG's active row (`clickhouse-analysis-repo.ts:781/831/870/921/1037` ignore `_buildId`).

### 11. [Medium · scrapper extraction/loader] Procedures have no usable dates for 59% of facts and no canonicality

- Chronos exact over 1,011,431 procedures: `state_date` NULL on **100%** of rows (every source); `publication_date` 0/312,159 on e-licitatie (attrs hold only ids — nothing to backfill from serving), 604,334/662,182 (91.3%) on seap_notice initiation. Facts: 369,326/622,933 (59.3%) undated; quality `date 0.4071 → time abstain`. Local stats: 994,892,110,663.14 of 1,039,213,898,064.18 RON (95.7%) of procedure money is undated; rollups have **zero** procedure records for 2019 (2018: 16,739 → 2020: 28,626). No `is_canonical`/`dup_group_id` on procedures (`LEGACY_ISSUES` 2.1 open); 15,376 e-licitatie procedures with awarded = 0 ∧ estimated = 0 are `official_exact`.

### 12. [Medium · infra + server config + client] OpenSearch holds only prototype indices the serving role cannot read; the client sends engine-only filters to a SQL backend

- OS admin `_cat/indices` (in-pod, 08:29Z): `proto_procurement_{contracts,procedures,da}_v{0,1}`; v1 created 2026-07-24T21:31Z — contracts 1,555,900 (all canonical incl. cancelled), procedures 622,933, DA 10,688,687 (years 2016–2020 only, max `date_basis` 2020-06-29); no aliases; no `unified_*`. The serving-access job (`opensearch-serving-access.yaml:49`) grants `transparenta_serving_read` on `unified_*` only → the Deployed reader gets 403 on `proto_*`.
- `PROCUREMENT_SEARCH_OPENSEARCH_INDEXES` is deliberately unset on Chronos dev (`k8s/base/configmap.yaml:34-35`); `build-redesign-app.ts:552-577` enables the engine only when the map is non-empty. Deployed lists: `engine:"postgres"`; `sort=relevance` → `BAD_GATEWAY`; supplier geography / `qMode` / facets / highlights → `upstreamError` (`offset-search-repo.ts:562-575`). The client sends all of these (`src/features/procurement/api/graphql/procurement-filters.ts:72-74,97-99`; queries request `facets`/`highlights`). Local (index map set) serves contracts/procedures from the v1 index with `asOf 2026-07-24T22:44Z`.
- `PROCUREMENT_OPENSEARCH_SEARCH_SPEC.md` is "DRAFT r2 … Not implemented"; `search.documents` (Meili palette source) procurement doc types last updated 2026-08-10 21:33Z: DA 3,892,745, contract 1,567,335, procedure 622,936.

### 13. [Medium · DB index (scrapper migration) + server] MCP DA search by `uniqueCode` times out on the deployed API

- `pg_indexes` on `procurement.direct_acquisitions`: no index on `unique_code` (indexes: pkey `da_id`, `da_key`, `authority_cui`, `cpv_code`, `supplier_cui`, `finalization_date`, two partials). `EXPLAIN` = Parallel Seq Scan (cost 6.3M) over the 58 GB table → pool `statement_timeout 15_000` (`modules/shared/shell/db/pool.ts:120`). Yet `core/filters.ts:492` lists `uniqueCode` as selective and `mcp/tools.ts:218` advertises it. Deployed (08:23:12Z): `search_procurement_direct_acquisitions {uniqueCode:"DAN2398851"}` → "listDirectAcquisitions failed"; nothing logged at warn/error.

### 14. [Medium · server tests] The golden suite asserts against a substrate the server no longer reads and skips the deployed configuration

- Local run (`tests/integration/procurement/procurement-golden.test.ts`, 08:24:42Z, 15.8 s): **5 failed / 20 passed**, each reconciled: (1) `:152-168` expects `total` null on wide scopes — engine exact count on Local (`core/search.ts:396-415`), null on Deployed (SQL); (2) `:529-565` procedure count 2806 vs rollup 2811 — 5 cancelled procedures excluded by `CORE_BASE` (`clickhouse-analysis-repo.ts:111`), rollup includes them; (3) `:708-726` months 185→184, 161→160 — issue 10; (4) `:778-797` MCP items carry `valueSum`/`valueWithheldAssociationSum` absent from the GraphQL selection; (5) `:817-880` share 0.8767 (attributed) vs 0.8592 (raw rollup). `detail-availability-graphql.test.ts`: 5/5 pass (in-memory fakes). The golden's three detail-bundle cases pass while every e-licitatie DA detail is `NOT_CAPTURED` on Chronos: the file never mentions `detailAvailability` (grep → no match), so a dead detail surface is invisible to it. Not covered: gate-flip/degrade paths (unit-tested only), undated-vs-period exclusivity, `value_states` rollup, `framework_role`/`recordKind` scope, `da_date_floor_2007`, `record_kind` remap, privacy_class filtering (only `mappers.test.ts`), OpenSearch-vs-SQL parity, CH-vs-PG parity, the deployed config.

### 15. [Medium · interface/doc drift bundle · server] See §(d) for file:line. Highlights

- `src/modules/procurement/CATALOG_RECONCILIATION.md:25-31` "five stamped rollups" (nothing reads any), `:38-39` "ServiceUnavailable on matrix_hash mismatch" (passthrough), `:70` "supplier geography deferred" (served).
- `shell/db/schema.ts` comments: `:3-4` "5 MVs", `:42-47,81-86,126-131` "VALUE_RULES_VERSION 2" (live 5; code 6; `core/constants.ts:57` says 4), `:177-178` cpv `parent_code/cpv_level` "100% NULL" (live 9,409/9,454 of 13,828 populated, exact), `:254-255` TED links "57 965" (live 69,582), `:274-276` "serving never reads analysis_facts_*" (it does).
- DA GraphQL filter `publicationDate` binds to `finalization_date` (`offset-search-repo.ts:111-113`, `procurement-repo.ts:697`, `core/filters.ts:361-368`) while the returned `publicationDate` is the real column: Deployed filter `publicationDate:{gte:"2025-06-01",lte:"2025-06-03"}` returned DA 76771943 with `publicationDate 2025-12-03`, `finalizationDate 2025-06-03`.
- Money inputs typed as floats: `ProcurementAnalysisScopeInput.valueMin/valueMax: Float` (`typedefs.ts:684,686`), MCP `z.number()` (`tools.ts:111-120`) → `Math.round(x*100)` (`clickhouse-analysis-repo.ts:440,443`); `minDeltaPct: Float` interpolated into SQL (`procurement-repo.ts:786`, `offset-search-repo.ts:310`); `mappers.ts:265-271` computes `deltaPct` with `Number()` (internal, not on the wire).
- Two accepted-value sets: `core/constants.ts:62-67` (4 states) vs `clickhouse-analysis-repo.ts:65` (2) — no numeric effect today (the other two states never occur live).
- `docs/server-redesign/_prod-schema/procurement.tsv` (2026-06-16) misses 33 of 45 live relations and 40+ columns on the four core tables.

### 16. [Low · docs] Scrapper docs vs reality (51 claims checked, 22 pending items traced — top items)

- `TRACKER.md:340` vs `:2215`: the status board still says "daily-load suspended, activation pending"; live: scheduled since 2026-07-24, `lastSchedule 2026-09-09T01:10Z`.
- `PUBLIC_CONTRACTS_NOTES.md:351-355` documents build 6 as active; live build 8. `:361-363` says the disclosed floor is NULL/pending; `aggregate_filter_thresholds` has 0.75 "activated 2026-07-24" and builds 7/8 serve `spend: allow_disclosed`. Builds 7 and 8 exist only in `kustomization.yaml:15-16`.
- `PROCUREMENT_FINISH_WAVE.md` "contracts are SEAP-only"; `PROCUREMENT_CONTRACT.md:78-80` lists `elicitatie`/`elicitatie_contracts` source systems; live domain `{seap_contracts .716, elicitatie_ca_award .284}` (planner).
- `PROCUREMENT_DOMAIN_GOAL.md:195-199` "fully served" vs analysis 46 d stale, MVs 72 d, search docs 30 d.
- `TRACKER.md:1148-1156` reserves `20260806T09*` for `framework_agreements/framework_members` — never built.
- `CHRONOS_MIGRATION_REMAINING_WORK_2026-09-07.md` and `CHRONOS_DEV_FULL_MIGRATION_APPROVAL_2026-09-05.md` contain zero mentions of procurement while the dev server serves it.
- Silently undone (promised → never done): Track B stale-delete (CronJob `lastSuccessful None`, now hard-gated on an image ≥ `691b8a64` nobody pinned, `kustomization.yaml:38-47`); MV/`aggregate-filters` refresh (`NOTES:1460-1462`); `sync_policy` stale suspend reasons (`updated_at 2026-07-07`, `subsequent-contracts` still says "table empty" with 63,246 rows); cpv full-scan optimisation (`NOTES:457-535`: now 5h34m/night for 0 rows); CronJob pin bumps (`DOMAIN_GOAL` #58); award-attribution rerun (`LEGACY_ISSUES` 2.12); DA-detail weekly convergence; the ~1.49M swallowed 2022–2024 SEAP DA lines (`NOTES:219-220`); dedup v3 (#45); framework spine Release 1; post-promotion base backup + analytics alias switch (unverifiable here).

### 17. [Low · DB data nits] (all Chronos, exact unless tagged)

- 7,269 canonical seap contracts have a date-like `notice_no` (`09/16/2019` ×4,068) — a column-shift signature on `seap_contracts`.
- 21,040 canonical contract_award groups (73,183 rows) share `(source_system, notice_no, contract_no, supplier_cui)`; 395 keys are canonical in both sources.
- 61,500 canonical awards are `conflicting_sources/cross_disagrees` and withheld from spend although 61,095 carry an own `value_ron`.
- 178,572 canonical contracts unlinked to a procedure (linkage 92.2%, FK-enforced); 176,621 carry a `notice_no` matching no procedure; 167,225 arrived 2026-08-19 (2007–2011).
- `contract_modifications` 52,295: 99.9% linked (`link_method notice_no`, conf 0.995), 52.1% dated, 38.6% with before/after values, `supplier_cui` 100% NULL, 1,046 attached to non-canonical contracts, 0 orphans.
- TED: 69,582 links 100% integral (all on e-licitatie procedures); 348,834 notices (reltuples 267k stale), max publication 2026-06-23; `buyer_cui` 0.06% on legacy R2.0.8 notices.
- `currency` NULL on 100% of e-licitatie contracts (0/1,154,461) and on all `elicitatie_da`/`seap_dan` DAs (sampled) while resolved `official` (RON assumed by source); procedures in EUR/USD (3,752) get no derived comparable; `fx_rates` (237,466 rows) ends 2026-07-18.
- seap_da column-shift remnants are quarantined (2% sample of 315,970 canonical rows: 931 date-shaped `value_ron`, 0 served exact) except 56 rows with date-shaped `supplier_name` still `official_exact` and 667 rows with `value_ron < 1` served exact.
- DA `status = 'unknown'` on 55.6% of all DAs (96.4% of canonical seap_da, sampled) — passes every `status <> 'cancelled'` filter; seap_da canonical `authority_cui` 73.7% (sampled).
- DA 76771943 (`seap_dan`): publication 2025-12-03 after finalization 2025-06-03.
- 3,049 contracts and 566 procedures carry business dates after their own insert date (V1).
- `cpv_codes` grew 10,542 → 13,828 (unexplained in docs; 9,454 official unchanged); `record_classifications` = one failed canary release (50,000 rows, "never promotable"); `subsequent_contracts` frozen at 2018-03-30; `da_anchor_conflicts` 0; `contracts.value_observations` jsonb `[]` on 100% (rescue lives in `contract_value_observations`, 10,954,424 rows, 74% `ok`).

### 18. [Low · scrapper load hygiene]

- `cpv_codes` stage full-scans raw for **5h34m** nightly to write 0 rows (`load-prod.ts:902-930`); chain 14.5–17.9 h vs the 18 h `activeDeadlineSeconds` (09-06: 17h52m).
- Projection lanes (`ca-detail` 311,787, `ted` 348,834, `subsequent` 63,246) rewrite their full row counts nightly.
- Ledger written by more than one path: `system_control.kysely_migration` rows `20260616T220000` (epoch-ms `1781625999692`) and `20260616T221000` (`+03:00` offset) vs ISO-Z elsewhere; `allowUnorderedMigrations: true` (`src/db/migrator.ts:61,76,91,106`) explains the out-of-name-order applies.

---

## (c) Chronos vs Phoenix, and layer-by-layer drift on Chronos

**Phoenix dev has no procurement data.** `hack-for-facts-dev` schemas: `public`, `prod_sync`, `prod_sync_m2026_07_20260816t193211z_50906` (budget tables: `commitment_line_items`, `execution_line_items`, `funding_sources`, `may_doc_links`, `may_report_doc`, `public_entities`, `reports`, `reports_backup`); no table matching `%procur%|%contract%|%acquisition%`; no `system_control.kysely_migration`. Phoenix `hack-for-facts-prod` was not probed for procurement (its pods are `postgres-db-1`, `postgres-db-stagging-1`, `postgres-ins-1`, `postgres-userdata-1`; the legacy server has no procurement module). The Griffin former `transparenta_prod` primary was retired 2026-08-23 and its pod is gone, so no second copy of the procurement schema exists anywhere to diff against. The deployed dev server reads Chronos `transparenta_prod` (`pg_stat_activity`: `client_addr 10.42.0.224 / 10.42.1.142` = the two `transparenta-eu-dev` server pods, role `transparenta_prod_phoenix_dev_readonly`). A migration diff Phoenix↔Chronos is therefore not applicable; the repo↔Chronos diff is empty (228 files = 228 ledger rows, both directions).

The comparison the data supports is the same population across the layers that exist on Chronos:

| Layer                                                          | Contracts                                                   | Procedures                                                                 | Direct acquisitions                                      | As of                                                                                                                                             | Source / tag              |
| -------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Griffin raw (`seap_source`, `elicitatie_source`, `ted_source`) | seap 3,734,837; e-lic `ca_notice_contracts` 1,154,861       | `procurement_notices` 730,965; e-lic `ca_notice_detail_projection` 312,240 | seap 19,442,120; DAN 1,529,332; e-lic details 13,428,477 | SEAP 2026-08-18; e-lic lists 2026-07-03; e-lic DA details 2026-08-14; TED 2026-07-11                                                              | planner reltuples         |
| Chronos `procurement.*` records                                | 4,077,953 exact (canonical 2,303,572; reltuples 3,964,270)  | 1,011,431 exact                                                            | 35,476,656 reltuples (canonical .875 planner)            | last insert 2026-08-19/20, last `updated_at` change 2026-08-20 (V1: procedures exact, DAs sampled, contracts planner); e-lic watermark 2026-07-03 | exact / planner / sampled |
| Chronos `analysis_facts_*` (build 8)                           | 3,274,708 (canonical 1,555,900)                             | 622,933                                                                    | 26,563,361 (canonical 22,590,243)                        | 2026-07-25 12:38                                                                                                                                  | exact (`facts_counts`)    |
| Chronos `analysis_rollup_*` (6 tables, builds 7+8 retained)    | reconciles to facts to the cent                             | same                                                                       | same                                                     | 2026-07-25 13:43                                                                                                                                  | exact reconcile           |
| CH `proto.facts_*_v2`                                          | 3,274,708 (canonical 1,555,900) — 587 `date_basis` drift    | 622,933                                                                    | 26,563,361                                               | 2026-07-25 17:09 (last `proto` write 2026-08-04)                                                                                                  | exact                     |
| OS `proto_*_v1`                                                | 1,555,900                                                   | 622,933                                                                    | 10,688,687 (2016–2020 only)                              | 2026-07-24 21:31                                                                                                                                  | exact `_cat/indices`      |
| `search.documents` (procurement doc types)                     | 1,567,335                                                   | 622,936                                                                    | 3,892,745                                                | 2026-08-10 21:33                                                                                                                                  | exact                     |
| Legacy MVs / capabilities (`aggregate_quality_by_grain`)       | 970,182 rows, amount .810                                   | —                                                                          | 15,722,185 rows, date .958                               | 2026-06-29 07:26                                                                                                                                  | exact (MV rows)           |
| `flows.money_flows`                                            | contract amount coverage 0.44 (sampled)                     | —                                                                          | DA payer_cui 0.85 (sampled)                              | rebuilt nightly, run 23130 2026-09-07, scopeTotal 31,022,949                                                                                      | reltuples 30,985,902      |
| `award_attribution`                                            | 617,015 rows (build 7) vs 1,092,760 money-bearing contracts | —                                                                          | —                                                        | 2026-07-24 22:28                                                                                                                                  | exact                     |

What moved: SEAP records (backfill 08-19/20: +803,245 contracts, +388,498 procedures, +7,347,323 DAs) and `flows`. What drifted: CH vs PG facts (587 rows); `record_kind` vs `framework_role`; `value_rules_version` 6→5. What is missing: the backfill in every analytics/search layer; e-licitatie data after 2026-07-03 everywhere; `da_details.da_id`; framework spine tables. Unexplained: `cpv_codes` +3,286 observed codes; the two odd ledger timestamps.

---

## (d) Interface mismatches (file:line) across scrapper, DB, server, client

| #   | Layer boundary                  | Mismatch                                                                                                                                                                                    | Where                                                                                                                                                                                    |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | DB ↔ server                     | `da_details.da_id` 100% NULL; server joins on it                                                                                                                                            | scrapper `prod/lanes/da-detail.ts:658-671` (never ran); server `shell/repo/procurement-repo.ts:565-589`, `shell/repo/da-detail-bundle.ts:102-108`                                        |
| 2   | DB ↔ server                     | `da_items.privacy_class` never selected; item text mapped verbatim                                                                                                                          | `procurement-repo.ts:598-619`, `shell/repo/mappers.ts:454` vs `:472`; scrapper `prod/lanes/da-detail-pii.ts:91-105`                                                                      |
| 3   | scrapper ↔ DB ↔ client          | `record_kind` SEAP-blind vs `framework_role`                                                                                                                                                | `prod/lanes/value-resolution.ts:522-523` (`:93-96`), `prod/framework-role.ts:60-78`; server `mappers.ts:337`; client `procurement-mappers.ts` purchases/frameworks facet                 |
| 4   | scrapper image ↔ code ↔ DB      | `VALUE_RULES_VERSION` code 6 / image 5 / rows 5 / server comment 4                                                                                                                          | `value-resolution.ts:100`, `:719-728`; `kustomization.yaml:14,67-68`; server `core/constants.ts:57`                                                                                      |
| 5   | scrapper ↔ DB                   | `attrs.contract_type` written by the loader, wiped by the v5 nightly                                                                                                                        | `load-prod.ts:4700-4703`; live 0/34,466 sampled e-lic rows                                                                                                                               |
| 6   | server config ↔ server code     | `PROD_CLICKHOUSE_URL=''` → unconfigured analysis repo; comments promise a rollup fallback                                                                                                   | `k8s/overlays/chronos-dev/configmap-patch.yaml:18`; `src/app/build-redesign-app.ts:542,589-599`; `src/modules/procurement/index.ts:102-109`; `clickhouse-analysis-repo.ts:7-8,1161-1173` |
| 7   | server ↔ CH                     | `frameworkRole` advertised in SDL/MCP, refused by the backend (CH build 8 has no column)                                                                                                    | `shell/graphql/typedefs.ts:674-676`, `shell/mcp/tools.ts:96-100`, `core/analysis-scope.ts:265-284`, `core/constants.ts:131-133`                                                          |
| 8   | server ↔ CH ↔ PG                | server never checks CH `dim_build_pin` vs PG active generation                                                                                                                              | `clickhouse-analysis-repo.ts:781,831,870,921,1037`; `shell/repo/generation-repo.ts:124-135`                                                                                              |
| 9   | server ↔ DB                     | buyer-geo list filter joins `analysis_facts_*` (stale population)                                                                                                                           | `shell/repo/offset-search-repo.ts:203-236`                                                                                                                                               |
| 10  | server SDL ↔ DB                 | DA `publicationDate` filter bound to `finalization_date`                                                                                                                                    | `offset-search-repo.ts:111-113`, `procurement-repo.ts:697`, `core/filters.ts:361-368`; `typedefs.ts` (undocumented)                                                                      |
| 11  | server ↔ DB                     | `uniqueCode` "selective" but unindexed                                                                                                                                                      | `core/filters.ts:492`, `mcp/tools.ts:218`; `pg_indexes` on `direct_acquisitions`                                                                                                         |
| 12  | server GraphQL/MCP inputs       | money inputs as floats                                                                                                                                                                      | `typedefs.ts:684,686,347`; `tools.ts:111-120`; `clickhouse-analysis-repo.ts:440,443`; `procurement-repo.ts:786`; `offset-search-repo.ts:310`                                             |
| 13  | server core ↔ server CH repo    | two accepted-value-state sets                                                                                                                                                               | `core/constants.ts:62-67` vs `clickhouse-analysis-repo.ts:65`                                                                                                                            |
| 14  | server ↔ OS                     | engine gated on an env map that Chronos never sets; serving role limited to `unified_*`                                                                                                     | `k8s/base/configmap.yaml:34-35`; `build-redesign-app.ts:552-577`; `opensearch-serving-access.yaml:49`                                                                                    |
| 15  | client ↔ server                 | client sends engine-only filters/sort/facets to a SQL backend                                                                                                                               | client `src/features/procurement/api/graphql/procurement-filters.ts:72-74,97-99`; server `offset-search-repo.ts:562-575`                                                                 |
| 16  | client ↔ scrapper               | `procurementSourceSystemSchema.parse` throws on any new `source_system` token                                                                                                               | client `procurement-mappers.ts:126,174,206`; DB domain 7 tokens today                                                                                                                    |
| 17  | client ↔ server                 | client renders `catalogItemName/Description` for DA items (latent PII path)                                                                                                                 | client `procurement-queries.ts:537-541`; server item 2                                                                                                                                   |
| 18  | server MCP ↔ GraphQL            | MCP breakdown items carry `valueSum`/`valueWithheldAssociationSum`; golden's GraphQL selection lacks them; MCP is a 4-tool subset (no procedure search, no `get_procurement_grain_quality`) | `typedefs.ts:796-812`; `tools.ts:386-403`; golden `:778-797`                                                                                                                             |
| 19  | scrapper artifact ↔ DB ↔ server | matrix hash `9f552ef4…3bdf9` = sha256 of `prod-db/contracts/procurement-analysis-combinations-v2.json` = live `matrix_hash` (builds 7, 8); server no longer vendors or checks it            | `prod/lanes/analysis-combinations.ts:566-573`; server `core/combinations.ts:13-16`, `core/analysis-usecases.ts:224-226` (v1 sha `1ce871d5…f412` is the retired artifact)                 |
| 20  | docs ↔ DB                       | `_prod-schema/procurement.tsv` (2026-06-16) misses 33 relations; `schema.ts` comments stale                                                                                                 | `docs/server-redesign/_prod-schema/procurement.tsv`; `shell/db/schema.ts:3-4,42-47,177-178,254-255,274-276`                                                                              |
| 21  | k8s render ↔ live               | `load-da-detail` step and `da-detail-full` CronJob rendered, not applied                                                                                                                    | `k8s/environments/chronos/writers/public-contracts/public-contracts-daily-load.yaml:86-105`, `kustomization.yaml:29`                                                                     |
| 22  | docs ↔ DB                       | reserved range `20260806T09*` for `framework_agreements/members`; only `framework_role` column applied                                                                                      | `TRACKER.md:1148-1156`; `src/db/prod-migrations/20260806T090000__procurement_contract_framework_role.ts:45-50`                                                                           |

**Where the chain agrees (verified, worth keeping):** every table/column declared in `shell/db/schema.ts` (17 tables) exists live with a matching type class; no server-read column is missing from the DB (two soft nullability notes: `cpv_divisions.source_version`, `analysis_generations.started_at` declared nullable, live NOT NULL); every client-requested field exists in the SDL; enum sets are consistent supersets; live `quality` jsonb validates against `QualityVerdictSchema` (`generation-repo.ts:62-82`); numeric/int8/date come through as strings (`modules/shared/shell/db/pool.ts:19-20,35-40`); no `parseFloat` in the module; amounts compared with `!== null` and summed with `decimal.js`/BigInt (`analysis-usecases.ts:214,585-605,792`; `clickhouse-analysis-repo.ts:741-780`); list value filters/sorts bind to `value_ron_comparable` (`core/filters.ts:88-100,200-212,337-349`; `offset-search-repo.ts:86,300-303`; `core/search.ts:227-236`), OS `value_comparable_bani` (`opensearch-query.ts:211-212,286-290`), CH `value_awarded_*_bani` (`clickhouse-analysis-repo.ts:90-146`); `sanitizeCurrency` exposes only an ISO token next to the comparable measure (`mappers.ts:218-222`); withheld-identifier CUIs are nulled/rejected (`resolvers.ts:103-109`, `arg-translation.ts:149-151`, `opensearch-query.ts:55-56`); `da_details` prose is redacted (`mappers.ts:472-497`); search documents are built from header fields only through `withheldIdentifierScrubSql` (`load-prod.ts:175,6546-6820`) and the OS mappings carry no `privacy_class` because nothing restricted is indexed; `privacy_class` is 100% `public` on procedures, contracts, DAs, modifications, procedure_details, procedure_lots, ted tables, subsequent_contracts and all `analysis_facts_*` (planner), `contact_pii` only on `da_details` (558,488 exact, 5.1%) and `da_items` (2.17% planner).

---

## §1 Database findings in detail (Chronos `transparenta_prod`)

### 1.1 Inventory (reltuples / total size, 08:11Z)

procedures 1,014,325 / 1.8 GB (exact 1,011,431) · contracts 3,964,270 / 10 GB (exact 4,077,953 during load) · direct_acquisitions 35,476,656 / 58 GB · contract_modifications 52,295 / 80 MB · procedure_details 311,787 · procedure_lots 1,223,689 · procedure_addresses 772,598 · procedure_award_criteria 568,538 · procedure_cpv_codes 498,617 · procedure_ted_links 69,582 · ted_notices 267,456 (exact 348,834) · subsequent_contracts 63,246 · subsequent_contract_residuals 424 · award_attribution 617,015 · contract_value_observations 10,954,424 / 9.1 GB · value_observation_subjects 5,001,284 · da_details 11,105,126 / 19 GB · da_items 16,732,147 / 12 GB · cpv_codes 13,828 · cpv_divisions 45 · fx_rates 237,466 · record_classifications (partitioned, one partition `_r1` 50,000) · classification_releases 1 · da_anchor_conflicts 0 · aggregate_filter_thresholds 2 · analysis_generations 2 · analysis_facts_contracts 3,294,179 / 2.6 GB · analysis_facts_direct_acquisitions 26,536,460 / 12 GB · analysis_facts_procedures 623,890 · analysis_rollup_authority_dims_monthly 15,505,435 / 6.5 GB · analysis_rollup_cpv_code_monthly 1,612,525 · analysis_rollup_edge_monthly 21,397,960 / 9.7 GB · analysis_rollup_region_cpv_monthly 222,341 · analysis_rollup_supplier_cpv_monthly 10,417,733 / 3.7 GB · analysis_rollup_value_states_monthly 3,006 · record_change_log 29,757,620 / 8.6 GB · MVs: org_edge_monthly_rollups 8,239,435, authority_cpv_division_monthly_rollups 5,186,170, supplier_cpv_division_monthly_rollups 9,193,940, same_day_direct_acquisition_candidates 1,151,328, aggregate_quality_by_grain 2, public_contracts_filter_capabilities_v1 16 · views procurement_flow_facts_v1, public_contracts_filter_capabilities_v1_refresh_source. Six `analysis_rollup_*` tables (≈20 GB) are read by nothing.

```sql
select n.nspname, c.relname, c.relkind, c.reltuples::bigint, pg_size_pretty(pg_total_relation_size(c.oid))
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='procurement' and c.relkind in ('r','m','v','p') order by 2;
```

### 1.2 Coverage

- Contracts (exact per group): canonical `contract_award` with `value_ron_comparable`: e-lic 395,886/425,093 (93.1%), seap 696,874/776,054 (89.8%); canonical `framework_agreement` 0/1,102,425 (`ambiguous_grain`, by design). Planner: `value_ron` null .057, `value_ron_comparable` null .7255, `contract_date` null .0771, `title` null .362, `currency` null .389, `is_canonical` t .573, `record_kind` {framework .502, award .498}, `framework_role` {ceiling .564, standalone .292, call_off .144}, `value_state` {not_applicable .427, ambiguous_grain .274, official_exact .269, conflicting .016, source_missing .008, ron_equivalent .005}.
- Procedures (exact): `state_date` 0/1,011,431; `publication_date` e-lic 0/312,159, seap initiation 604,334/662,182, award_no_init 25,975/34,389; `foreign_currency_only` 3,752; sources {seap_notice .693, elicitatie .307}.
- DAs (1% sample ≈338k rows): seap_da canonical publication_date 96.9%, value 99.8%, comparable 99.0%, cpv 99.3%, supplier_cui 99.1%, authority_cui **73.7%**, status unknown 96.4%; elicitatie_da dates 100%, comparable 92.2%, finalized 92.2%/cancelled 7.8%; seap_dan publication 78.1%. Planner: `publication_date` null .0457, `status` {unknown .560, finalized .365, awarded .044, cancelled .032}, `value_state` {official_exact .840, not_applicable .154, invalid .0055}, `is_canonical` .875, sources {seap_da .576, elicitatie_da .396, seap_dan .028}.
- Rescue path: every accepted contract_award has `value_obs_id` and `canonical_value_source` populated (3% sample 1.0000); build 8 `valueRescued` = 0 (the July memory "rescue columns 100% unpopulated" is stale for the observation tables, still true for `contracts.value_observations` jsonb).

### 1.3 Consistency checks (see issue 17 for the list; all passed or quantified)

Canonical→procedure 92.2% (FK); modifications chain 0 orphans; TED 100% integral; undated bucket = `month_start IS NULL` (uq indexes `NULLS NOT DISTINCT`), every dated `month_start` is day 1, undated records per grain equal `facts_counts.canonicalUndated` (contract 97,194; DA 624,393; procedure 369,326); DA outcome remap holds (0.5% sample: state 3/4/6/8 → cancelled 2,242/1,108/1,130/761, 7 → finalized 62,559, no other pairs; `identity.ts:851-856`); DA postmortem signatures all quarantined (0 accepted rows > 3.7M, 0 state∈{3,4,6,8} non-cancelled, 437 garbled-date rows all `invalid_source_value`); `da_date_floor_2007` constraints applied and `convalidated` (0 rows < 2007; run 19108 skipped 38,714 rows on the check).

### 1.4 Analysis generation

- `matrix_hash` `9f552ef40b548e0812eedb9d0009e60e6577a037ae7d477f328f557593f3bdf9` on builds 7 and 8 = `shasum -a 256 prod-db/contracts/procurement-analysis-combinations-v2.json` (raw bytes; pinned at `analysis-combinations.ts:566-573`, 554 combinations). v1 sha `1ce871d5…f412`.
- Quality (build 8, exact): contract spend `allow_disclosed` (value .3967, spend_population_accepted .8482), time `degraded` (date .9375), geo allow (.9802); procedure spend allow (.9697), time `abstain` (date .4071); DA all allow (date .9724, value .9473, accepted .9915). Independently recomputed from the facts by (is_canonical, record_kind) group-by: contract date (727,647×.9541 + 828,253×.9230)/1,555,900 = .9375 ✓; value 727,647×.8482/1,555,900 = .3967 ✓; procedure date .407 ✓. Thresholds (`aggregate_filter_thresholds`) and server floors (`core/constants.ts:287-288,328`: 0.95 / 0.75 / 0.5) agree. A new generation today would publish contract spend ≈0.91 accepted (3% sample), still `allow_disclosed`.
- Rollups reconcile: all six rollups × 3 grains `matches=true`; cross-rollup totals equal to the cent for 2024-03 and 2025-10 (e.g. contract 2024-03 14,297 rows / 18,299,946,799.90 in edge, authority_dims, cpv_code, supplier_cpv, region_cpv); top-10 + other + unknown = total (contract 2024-03 authority: 9,609,497,859.26 + 8,656,860,693.35 + 33,588,247.29 = 18,299,946,799.90 ✓; DA 2025-10 supplier ✓); three edges equal direct facts sums. `value_states_monthly` is a census of all rows (43,799 vs 14,297 canonical for 2024-03). Builds 7 and 8 both retained in every rollup (N-1 by design, `PRUNE_RETIRED_SQL`).

### 1.5 Open items, current numbers

F1 — issue 8. F2 — contract_award canonical accepted 0.912 (3% sample) vs 0.8482 at build 8; framework canonicals 0 by design. 2026-07 reload rows — repaired: seap_da `publication_date` NULL 6.7%, `value_ron` NULL 0.5% (1% sample; was ~7M rows missing both). E-licitatie `publication_date` — 0% and `state_date` 100% NULL corpus-wide (issue 11). DA postmortem — signatures quarantined (§1.3), `value_rules_version` 5 (issue 4).

## §2 Scrapper findings in detail

### 2.1 Load path (code)

Upsert-only on natural keys: procedures `(source_system, source_ref)` `load-prod.ts:5086-5088`; contracts `(contract_key)` `:5159-5169`; DAs `(da_key)` `:5243-5245`; modifications `(source_ref)` `:5348-5356`; flows `(source_id, source_ref)` `:5577-5593`; observations `:5194-5216`. Deletes only in the four guarded `*-stale-delete` stages (`:256-276`, guards `load/stale-families.ts:32-160`, floors `:203-204`). Nightly `--stages cpv,procedures,contracts,direct-acquisitions,modifications,dedup,gate,flows` auto-inserts value-observations / supplier-checksum-rescue / value-resolution / gate / core-org-mint (`:830-868`), so value resolution runs nightly (which is what reverted v6). Advisory lock `pg_try_advisory_lock(hashtext('public-contracts'), hashtext('public-contracts:load-prod'))` (`:770-822`; throws on contention; analysis lane shares it with 10×30 s retry then skips cleanly, `lanes/analysis-pipeline-lock.ts:9-105`, `analysis-facts.ts:1653-1680`); live `pg_locks` showed it held by pid 901928 = tonight's daily-load pod. Two-tier gate: BLOCK = parity/reconcile/closure/one-active, WARN = coverage/rescue/undated/overlap (`lanes/analysis-facts-validate.ts:1-19,233-236`); structural failure → generation `failed`, its rollups deleted, previous active retained (`analysis-facts.ts:1527,846-956`). `--rollback` proof: one repeatable-read transaction with reserved ids −1, rolled back (`:2917-3087`, `analysis-facts-sql.ts:1145-1151`). Determinism: `build_id` is an identity column, so a re-run mints a new id/`published_at`; `matrix_hash` is constant; facts upserted in place only when the guarded tuple differs (`analysis-facts-sql.ts:538-552`); rollup content is deterministic for identical facts; `compareRollupGenerations` treats content equality as the invariant. Value rules and remap: §(d) items 3–5; rule order `value-resolution.ts:12-30`; engine never writes `value_ron` (`:42-47`); DA label precedence `:832-856`; procedures `:890-950`. Digest parity (`load/digest-parity.ts:62-112`, 1024 xor buckets, keyset only) last `valid` 2026-08-20 12:58 (run 19343); the nightly skips it by design (`load-prod.ts:2175-2180`) and the validate CronJob is suspended.

### 2.2 CronJobs (Chronos, live 08:15Z)

| CronJob                                                                                                                                                                                                                                               | schedule    | suspend  | lastSchedule      | lastSuccessful    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- | ----------------- | ----------------- |
| analysis-facts                                                                                                                                                                                                                                        | 30 6 * * *  | **True** | None              | 2026-07-24T16:34Z |
| daily-load                                                                                                                                                                                                                                            | 10 1 * * *  | False    | 2026-09-09T01:10Z | 2026-09-07T15:54Z |
| stale-delete                                                                                                                                                                                                                                          | 30 3 17 * * | **True** | None              | None              |
| validate                                                                                                                                                                                                                                              | 30 5 * * *  | **True** | None              | 2026-07-24T01:14Z |
| All on digest `db3ab998…` (`1f3caaef`, 2026-07-25). Not Argo-reconciled. Live daily-load args: `load-ca-detail; load-ted; load-subsequent-contracts; load-prod --stages cpv,procedures,contracts,direct-acquisitions,modifications,dedup,gate,flows`. |

### 2.3 Migrations

`src/db/prod-migrations/` 228 files = `system_control.kysely_migration` 228 rows, `comm` diff empty both ways; all 44 procurement/contract-named migrations applied (list: `20260614T090000__procurement_domain` … `20260820T101000__da_date_floor_2007_validate`). Out-of-order applies (`20260719T100000` on 07-25 after `20260723/20260725`; `20260726T151000` on 07-30; `20260707T150000` at 14:04 after `20260707T16*` at 11:00) are permitted by `allowUnorderedMigrations: true` and scoped `--only` applies (`NOTES:1398`). Reserved bands in `TRACKER.md:1956-2004` all have applied files inside them. Raw DB: 55 files = 55 Griffin ledger rows.

### 2.4 Tests

- Unit (no browser/DB): `vitest --project unit src/sources/public-contracts src/db` → **54 files passed, 2 skipped; 844 tests passed, 15 skipped, 0 failed** (8.7 s). `prod/` alone: 13 files / 164 passed.
- PG integration (`*.pg.test.ts`, 9 procurement files) on a throwaway `pgvector/pgvector:pg18` container reached over an SSH tunnel (Docker Desktop would not start locally; the runner pins Node 24 vs local 26, so vitest was invoked directly): **8/9 files passed** (58 cases: `analysis-facts-migrations`, `ca-detail-children-hash`, `load-prod-procedures-upsert`, `value-model-migrations`, `value-observations-stage`, `value-resolution` incl. "v6: stamps framework_role" and "second run writes 0 rows", `lanes/load-classifications`, `search-documents-privacy-class`). `analysis-facts.pg.test.ts`: run 1 killed by a 25-min wrapper with 23+ passes / 0 failures; run 2 70 passed / 32 failed, of which 24 are the suite's hard-coded 10–30 s per-case timeouts over the tunnel and 8 are cascades in the case following a timeout (lock/truncate deadlock). **Environment-inconclusive; needs a local-daemon rerun.** `pnpm check` was not run (ETL transition ledger deadline 2026-09-10). 64 other `.pg.test.ts` files in the source not run.

## §3 Server findings in detail

### 3.1 Gate semantics (code, then live)

`core/gate-v2.ts:136-247 decideAnswer` (count always allow `:144`; spend allow/allow_disclosed→degraded `SPEND_SERVED_DISCLOSED`/abstain `:184-200`; time/geo class-based `:202-246`; missing verdict → `MISSING_QUALITY_VERDICT` unless synthesized from `meta_value_coverage_v2` `:151-177`); `core/envelope.ts:51-77` answerability; `generation-repo.ts:124-135` reads `status='active'` row, TypeBox-validates each grain and drops malformed ones (fail-safe abstain), 5 s micro-cache. Confirmed on Local (08:25Z): `procurementStats {}` → procedure spend served / time abstain, contract spend degraded `SPEND_SERVED_DISCLOSED` / time degraded, DA served; series 2025: procedure `abstained GENERATION_LACKS_CAPABILITY`, contract `degraded TIME_COVERAGE_DEGRADED` 12 points, DA served — all matching `analysis_generations.quality`. Record lists and details answer on Deployed and Local while money abstains. `matrix_hash` reported by the app = DB = artifact.

### 3.2 Three-way comparison (Local GraphQL == Local MCP == CH raw; Deployed for records)

- Records (Deployed vs Chronos `row_to_json`): procedure 3240354, contract 2814028, DA 76771943 — every field equal (strings "1174456.00", "8880.00", "133977.31"; statuses, CUIs, CPVs, value states). MCP `search_procurement_contracts {authorityCui:"4340650", year:2026}` item for 2814028 equal. MCP DA by uniqueCode → issue 13; no MCP procedure tool.
- Aggregates: stats `{authorityCui:"4340650", grain:contract, year:2025}` → 117 / 31 / 3,341,058.16 (GraphQL = MCP = CH `334105816` bani); breakdown `{cpvDivision:"30", grain:direct_acquisition, year:2025}` supplier top-5 by count = CH to the bani, top+other+unknown = 15,705 + 147,262 + 50 = 163,017 = total ✓; series contract 2025 monthly `9043 8785 12213 17397 12484 9377 5981 7606 9823 12634 13600 8701` equal on all three; procedure series abstains on both transports (correct). Stats `{}` byte-identical GraphQL vs MCP for all grains. (Deployed cannot be compared for aggregates — issue 1.)

### 3.3 Search

Engine selection `build-redesign-app.ts:552-577`; engine-only paths `core/search.ts:150-172,181-201`, `offset-search-repo.ts:562-575`. Deployed `provenance.engine = "postgres"` on all grains; Local contracts/procedures `opensearch asOf 2026-07-24T22:44Z`, DA `postgres`. Field-by-field sample of four `proto_procurement_contracts_v1` docs (1956868, 1957001, 1957788, 1957793) vs PG rows vs GraphQL detail: all equal (awarded_bani 48,823,400 ↔ `value_ron 488234.00` ↔ `"488234.00"`, cpv, notice/contract numbers, status, record_kind, value_state).

### 3.4 Privacy paths — §(d) row 2 and the "agrees" paragraph; no `privacy_class` predicate on base-record reads (harmless today, gate absent).

---

## (e) Suggested improvements

**Server** (`~/projects/devostack/hack-for-facts-eb-server`)

1. Read `di.privacy_class` in `shell/repo/procurement-repo.ts:598-619` and redact or drop non-public items in `mappers.ts:454` (with an `itemsRedactedCount`), before `resolveDaFks` ever runs; add a privacy case to `tests/unit/procurement/mappers.test.ts` and drop the "PII-free" claim in `shell/mcp/tools.ts:5`. Reason: a restricted class must never reach a response; today it is only masked by issue 5.
2. Surface "analysis backend unconfigured" and "search engine unconfigured" in `/api/v1/health` and `ProcurementAnswerMeta` instead of a generic Database error (`clickhouse-analysis-repo.ts:1161-1173`, `index.ts:102-109`), and delete the two stale rollup-fallback comments (`clickhouse-analysis-repo.ts:7-8`, `build-redesign-app.ts:542`). Decide what `k8s/overlays/chronos-dev/configmap-patch.yaml:18` should point at; the base value `http://chronos-prod-clickhouse:8123` resolves to no Service — the CHI exposes `transparenta-eu-etl-clickhouse.transparenta-eu-etl-prod.svc` (8443 TLS) and a Tailscale-fronted 8123.
3. Verify CH `dim_build_pin` against the PG active generation on every analysis read (`clickhouse-analysis-repo.ts:781-1037`) and expose `publishedAt`/data cut-off on the wire; abstain when they disagree. Reason: issues 2 and 10 are invisible to callers.
4. Stop joining `analysis_facts_*` for buyer geography on the SQL list path (`offset-search-repo.ts:203-236`); derive geography from the record's own `authority_cui` → `core.public_entities/territories` as the cursor lists already do (`procurement-repo.ts:287-289`). Reason: issue 7.
5. Replace `valueMin/valueMax: Float` and MCP `z.number()` with decimal strings (reuse `DecimalRangeInput`/`ronToBani`), compute `deltaPct` with `decimal.js`, and derive the CH accepted-state literal from `core/constants.ts:62`. Files: `typedefs.ts:684,686,347`, `tools.ts:111-120`, `clickhouse-analysis-repo.ts:65,440-443`, `mappers.ts:265-271`.
6. Either bind the DA `publicationDate` filter to `publication_date` or rename the filter to `finalizationDate` in the SDL (`offset-search-repo.ts:111-113`, `core/filters.ts:361-368`, `typedefs.ts`). Reason: issue 15.
7. Mark `uniqueCode` non-selective until an index exists, and log the list failure at warn level (`core/filters.ts:492`, `mcp/tools.ts:218`, `shell/repo/procurement-repo.ts`).
8. Rewrite `CATALOG_RECONCILIATION.md` §generation surface, the `schema.ts` header comments, and regenerate `docs/server-redesign/_prod-schema/procurement.tsv` from `information_schema` via a script. Add a `privacy_class = 'public'` predicate (or kernel helper) to every base-record select.
9. Re-point the golden at ClickHouse (or at what the server actually reads), run it once against the Deployed config, and add cases for the undated bucket, CH↔PG parity, the compatibility caveat, and privacy (`tests/integration/procurement/procurement-golden.test.ts`).

**Scrapper** (`~/projects/devostack/hack-for-facts-eb-scrapper`)

1. Bump the four public-contracts CronJob pins to a current image in one reviewed change (`k8s/environments/chronos/writers/public-contracts/kustomization.yaml:14,36,67-68`) and make `value_rules_version` monotonic in the distinct guard (`prod/lanes/value-resolution.ts:719-728`: never rewrite a row whose stamp is higher than the running code). Reason: issue 4.
2. Complete activation checklist item 4 for `analysis-facts` (unsuspend + flip `etl.sync_policy`), or publish build 9 by one-off, so the backfill reaches facts/rollups; then either build a real CH loader or retire the CH path from the server. Files: `public-contracts-analysis-facts.yaml`, `prod-db/ch-prototype/*`, `PROCUREMENT_CLICKHOUSE_ANALYTICS_SPEC.md`. Reason: issue 2.
3. Make the DA/procedure lanes fail (or warn loudly) when `sourceWatermark` does not advance for N days (`PROCUREMENT_SERVING_PARITY_RUNBOOK.md` Step 0.5; `load-prod.ts` run notes), and repair the e-licitatie extraction fleet. Reason: issue 3.
4. Run `resolveDaFks` (`prod/lanes/da-detail.ts:658-671`) as its own idempotent step and apply the rendered `da-detail-full` CronJob — after server improvement 1 ships. Reason: issue 5.
5. Rerun the attribution lane after any backfill and make `award_attribution_coverage` BLOCK-tier above a small ceiling (`validate.ts:1505-1545`); have the analysis lane consume `award_attribution` (`lanes/analysis-facts-sql.ts`). Reason: issue 6.
6. Mint `record_kind` from `framework_role` for e-licitatie rows (`value-resolution.ts:522-523`), and fix the CH prototype loader's `date_basis` NULLing (`prod-db/ch-prototype/13-load-v2.sql`). Reason: issues 9, 10.
7. Fix the 2026-06-14 future-dated rows (3,049 contracts, 566 procedures with business date > insert date; V1) or gate them out of period buckets; add a `contract_date <= load date` validate check.
8. Finalize `etl.load_runs` on unhandled pg errors (`load-run-abort.ts`, `prod-cli.ts:253`), add a retry/backoff to the daily-load Job, and cut the cpv stage's 5h34m raw full-scan (`load-prod.ts:902-930`).
9. Refresh or drop the six legacy MVs and `public_contracts_filter_capabilities_v1` after reconciling the 0.95 vs 0.75 thresholds; drop the six unread `analysis_rollup_*` tables (≈20 GB) or make the server read them. Reason: issue 8.
10. Docs: close or retire the pending items in §16; fix `TRACKER.md:340/:2215/:341/:1148-1156`, `PUBLIC_CONTRACTS_NOTES.md:351-363,8594-8600`, `PROCUREMENT_CONTRACT.md:78-80`, `PROCUREMENT_FINISH_WAVE.md`, `PROCUREMENT_DOMAIN_GOAL.md:195-199`; add procurement to `CHRONOS_MIGRATION_REMAINING_WORK_2026-09-07.md`.

**Client** (`~/projects/devostack/hack-for-facts-eb-client`, reference only)

- Gate relevance sort / facets / supplier geography on `provenance.engine` (`procurement-filters.ts:72-74,97-99`); make `procurementSourceSystemSchema` tolerant of unknown tokens (`procurement-mappers.ts:126,174,206`).

---

## (f) Could not verify

- Post-promotion base backup and analytics alias switch (`TRACKER.md:340` "pending"): no backup objects inspected.
- Whether `PROD_CLICKHOUSE_URL=''` on chronos-dev is intentional (commit `b4e0ec38` message gives no reason).
- Which host `.claude/redesign-prod.env` targets, other than the `pg_stat_activity` correlation (Tailscale proxy pod `10.42.0.113`, role `transparenta_prod_agent_readonly`, sessions appearing/disappearing with the Local server); the env was never read.
- Exact (non-sampled) counts on the 35M-row DA table for `value_rules_version`, per-source canonical splits, column-shift escapes, and `da_items` contact_pii (planner + samples only; no index on `privacy_class`).
- Whether the 2026-08-19 one-off actually stamped `value_rules_version = 6` before the 08-21 revert (ledger notes drop `rulesVersion`; inferred from the 38.96M/39.0M-row rewrites and image ancestry; the one-off image `09079977…` is not resolvable in the local clone).
- Post-2026-08-20 raw↔prod digest parity (no parity run exists since run 19343).
- Raw `direct_acquisition_details.cpv_code` 0%-populated defect (`NOTES:6540`): raw column not probed.
- The writer of the two non-Kysely ledger timestamps (`20260616T220000`, `20260616T221000`).
- The `analysis-facts.pg.test.ts` result on a local Docker daemon (tunnel run environment-inconclusive), and the names of the 2 vitest-skipped unit files.
- OpenSearch index listing under the Deployed reader (403 by design; admin listing done in-pod), and the 5th sampled OS document (output truncated).
- Exact cause of the CH `date_basis NULL` drift (loader SQL in `prod-db/ch-prototype`, not traced line by line).
- Whether Phoenix `hack-for-facts-prod` holds any procurement table (not probed; the legacy server has no procurement module).
- Whether any framework/calloff/modification analysis grain works on Deployed (needs ClickHouse wired).

---

## Appendix — load-bearing queries (Chronos unless stated)

```sql
-- generations / hash
select build_id, status, started_at, published_at, matrix_hash, load_run_id from procurement.analysis_generations order by build_id;
-- facts gap (exact)
select 'contracts' t, count(*) live_canonical, count(*) filter (where f.contract_id is null) canonical_missing_from_facts
from procurement.contracts c left join procurement.analysis_facts_contracts f on f.contract_id=c.contract_id where c.is_canonical;      -- 2303572 | 789922
select date_trunc('month', created_at)::date m, count(*) from procurement.contracts group by 1 order by 1;                                  -- 2026-08 bucket = 803245
select 'procedures' t, count(*) live, count(*) filter (where f.procedure_id is null) missing_from_facts
from procurement.procedures p left join procurement.analysis_facts_procedures f on f.procedure_id=p.procedure_id;                        -- 1011431 | 388498
select count(*) from procurement.direct_acquisitions where da_id > (select max(da_id) from procurement.analysis_facts_direct_acquisitions); -- 7347323
-- value rules stamp
select value_rules_version, count(*) from procurement.procedures group by 1;                              -- 5 | 1011431
select tablename, attname, most_common_vals, most_common_freqs from pg_stats where schemaname='procurement' and attname='value_rules_version';
-- v6 → v5 revert
select run_id, target_table, started_at, rows_loaded from etl.load_runs where source_id='public-contracts' and target_table='procurement.value_resolution' and started_at between '2026-08-18' and '2026-08-27' order by run_id;
-- freshness (V1)
select tablename, attname, (histogram_bounds::text::text[])[array_length(histogram_bounds::text::text[],1)] from pg_stats where schemaname='procurement' and tablename in ('contracts','procedures','direct_acquisitions') and attname in ('created_at','updated_at');
select count(*) filter (where contract_date > created_at::date), count(*), max(contract_date) from procurement.contracts where contract_date >= '2026-06-14';
-- DA detail reachability (V2)
select null_frac from pg_stats where schemaname='procurement' and tablename='da_details' and attname='da_id';   -- 1
select da_id, da_key, status from procurement.direct_acquisitions where da_key in ('elicitatie_da:104243095','elicitatie_da:104243106','elicitatie_da:104612483');
-- award attribution gate
select left(to_jsonb(v)::text, 600) from etl.validation_results v where v::text like '%award_attribution_coverage%' order by 1 desc limit 2;
-- F1 live flows coverage (sampled)
select flow_type, count(*) sampled_rows, round(count(flow_date)::numeric/count(*),4) date_cov, round(count(amount_ron)::numeric/count(*),4) amount_cov,
  round(count(payer_cui)::numeric/count(*),4) payer_cov, round(count(payee_cui)::numeric/count(*),4) payee_cov, round(count(classification_code)::numeric/count(*),4) cpv_cov
from flows.money_flows tablesample system (2) group by 1 order by 1;   -- direct_acquisition 0.9791 / 0.9936 / 0.8490 ; procurement_contract 0.9514 / 0.4499 / 0.9946
-- legacy capability rows
select * from procurement.aggregate_quality_by_grain; select * from procurement.public_contracts_filter_capabilities_v1;
-- record_kind vs framework_role
select source_system, record_kind, framework_role, count(*) from procurement.contracts tablesample system (3) where is_canonical group by 1,2,3;
-- migrations
select name, timestamp from system_control.kysely_migration order by name;   -- 228 rows
-- Griffin raw freshness
select max(first_seen_at), max(last_seen_at) from elicitatie_source.ca_notice_contracts;  -- 2026-06-30 18:36Z
select max(captured_at) from elicitatie_source.ca_notice_detail_projection;              -- 2026-07-03 00:35Z
```

Deployed probes (curl, JSON body): `POST https://dev-chronos-api.transparenta.eu/api/v1/graphql` with `{ procurementStats {} }` → Database error (08:15:42Z); `{ procurementDirectAcquisition(id:"2354482") { detailAvailability detail { itemCount } } }` → `NOT_CAPTURED`, `null` (09:36:43Z). MCP `POST /api/v1/mcp` `tools/call aggregate_procurement {shape:"stats"}` → "procurement analytics backend (ClickHouse) is not configured" (08:16:40Z).
