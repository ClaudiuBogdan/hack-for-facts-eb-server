# 03 — Private Companies (`companies` domain)

> **Status:** plan. Conforms to [`00-foundation-shared-kernel.md`](00-foundation-shared-kernel.md)
> (the binding contract). Where this module deviates, it says so with rationale.
>
> **Source:** ANAF (fiscal status, financial statements / _bilanț_) + ONRC
> (company registry: identity, status, representatives, authorized CAEN, EU
> branches). Raw DB `transparenta_eu_private_companies` on the prod raw cluster;
> served from `transparenta_prod` schema `companies.*` + the kernel
> `core`/`flows`/`search` schemas.
>
> **Role in the platform:** this is the **CUI identity spine**. ~3.99M
> `kind='company'` rows in `core.organizations` originate here. Every other
> source that carries a supplier/counterparty CUI links _to_ this hub
> (link-not-merge, §2 below). Getting the identity contract right here is the
> highest-leverage decision in the redesign.

---

## 1. Summary & data status

**Prod schemas owned:** `companies.*` (7 tables). **Kernel schemas read:**
`core.organizations`, `core.organization_identifiers`, `core.classification_codes`
(CAEN labels), `flows.money_flows` (only via the kernel `FlowsRepo`),
`search.documents` (read-only projection).

**Live row counts** (verified on griffin `transparenta-prod-postgres-1`,
2026-06-16; cross-checked against `PRIVATE_COMPANIES_NOTES.md` load log):

| Table                                   | Rows             | Notes                                                                                                                                                                                                          |
| --------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.organizations` (`kind='company'`) | 3,985,167        | the CUI spine; 1:1 with `companies.registrations`                                                                                                                                                              |
| `core.organization_identifiers`         | 8,062,163 loaded | `ro-cui` + `cod-inmatriculare` schemes; **co-owned** — this table is shared with public entities (R7). Number is companies-load total (source 8,072,163; Δ = 10k smoke rows), not a clean companies-only count |
| `companies.registrations`               | 3,985,167        | one row per CUI; headline status by lifecycle priority                                                                                                                                                         |
| `companies.fiscal_status`               | 3,867,146        | ANAF TVA-endpoint snapshot (3.5wk stale at load)                                                                                                                                                               |
| `companies.financials`                  | 2,970,240        | (cui, year); grows with the 25.8M-request bilanț drain (→ ~14M at full drain)                                                                                                                                  |
| `companies.representatives`             | 3,499,816        | (cui, name, role); 2.06M distinct normalized names                                                                                                                                                             |
| `companies.caen_activities`             | 18,270,650       | (cui, caen_rev, caen_code, source); volume long pole                                                                                                                                                           |
| `companies.status_flags`                | 4,377,299        | (cui, status_code); concurrent SET, never a timeline                                                                                                                                                           |
| `companies.eu_branches`                 | 221              | (cui, branch_key); EU/EEA branches                                                                                                                                                                             |

**Deferred / not in prod (declared, not built here):**

- **`caen_profile`** projection (ANAF main vs ONRC authorized sets, mismatch
  flags, normalized sector) — `COMPANIES_DATA_RESEARCH.md` finding 5. The
  server can compute the join live; a materialized projection is a scrapper
  follow-up. The plan exposes the raw `caen_activities` + `fiscal_status.main_caen_code`
  and labels the coverage gap, but does **not** assume `caen_profile` exists.
- **`latest_financials`** projection — computed live via `DISTINCT ON (cui)` in
  the repo until a scrapper rollup lands (research finding, feature 1). The
  driving index for this is the `financials_pkey (cui, year)` — `DISTINCT ON`
  walks it; acceptable at the per-CUI grain, NOT for a global "richest companies"
  list (see §3/§7 perf notes — that needs a `(year, turnover desc)` index or a
  rollup, neither of which exists → the global rank endpoint is **capability-gated
  / count-only** until earned).
- **Real ANAF `stare_inregistrare`** (lifecycle/radiation state) — **not
  extracted into serving** (`COMPANIES_DATA_RESEARCH.md` Verification Correction
  1, MATERIAL). The current `companies.fiscal_status.is_active` is _not_ an
  operating indicator; it is the complement of ANAF's _declared-fiscally-inactive_
  list flag. **`is_active` MUST NOT be exposed under that name** (see §2 + §13-R1).
- **Identity history / aliases** for the 95,152 re-registered CUIs (research
  finding 1) — raw has it; serving keeps the one current row. Surfaced as a
  caveat, not a feature here.
- **Semantic search** (pgvector) — `vector` extension is installed in
  `transparenta_prod`, but `search.documents` has **no vector column** in the
  snapshot. Capability-gated per contract §14.5; never hard-depended.

**Sync posture (affects serving freshness, §10):** no reliable change timestamp
anywhere in this source → refreshes are full upserts of current state. Tiered
cadence (NOTES decision 3): ANAF stages weekly during the drain / monthly after;
ONRC stages + reconcile-deletes monthly per snapshot; TVA monthly. Manual CLI
trigger for now. The serving API surfaces an **as-of** watermark, not a freshness
guarantee.

---

## 2. Schema → domain model

Module domain types live in `src/modules/companies/core/types.ts`. All money is
`string` (numeric precision), `org_id` is `string` (bigint), dates are
`YYYY-MM-DD` strings (kernel scalar table §14.1). CUI is the link key everywhere.

### 2.1 Identity linkage (link-not-merge — the spine contract)

- A company is addressed by **normalized CUI**, never by `org_id`. The kernel
  `IdentityRepo.findByCui(cui)` resolves `core.organizations` (where
  `cui = $1 AND kind = 'company'` is the companies-domain view). **This module
  never reassigns or merges `org_id`s** across registries — if budget's
  `core.public_entities` and a `companies` row share a CUI, they remain two rows;
  correlation is by CUI at query time (research feature 7: only 8 entity / 1
  main-creditor overlaps exist today, so this is cheap).
- CUI normalization is the kernel `normalizeCui` (§14.1) **and** the DB
  `core.normalize_cui()` — the two MUST stay equivalent (the migration comment
  pins this). The module re-uses the kernel function; it does not re-implement.
- **CUI is 1–13 digits** (every `companies.*` table has
  `cui ~ '^[0-9]{1,13}$'`). Validation at the route boundary rejects anything
  that does not normalize to that shape with `InvalidInput` (not a DB round-trip).
- `core.organization_identifiers` carries two schemes for companies:
  `ro-cui` (value = CUI) and `cod-inmatriculare` (value = registration number).
  Its columns are `scheme, value, org_id, source` — **there is no `cui` column**
  (verified against `core.tsv`). Reverse lookup is therefore **two-hop**: seek
  `(scheme, value)` on `organization_identifiers_pkey` to get `org_id`, then join
  `core.organizations` on `org_id` (filtered `kind='company'`) to project `cui`.
  **Reverse lookup is one-to-many** for `cod_inmatriculare`: 76 numbers map to
  152 CUIs (research finding 3). The registration-number resolver returns a
  **list of CUIs**, never a single org.

### 2.2 Table-by-table mapping

| Prod table.column                               | Domain view-model field                                                   | Notes / transform                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------- |
| `core.organizations.org_id`                     | `Organization.orgId: string`                                              | bigint→string; identity only, not the link key                                                                                                                                                                                                                                                      |
| `core.organizations.cui`                        | `cui: string`                                                             | the link key; `kind='company'` filter is the domain boundary                                                                                                                                                                                                                                        |
| `core.organizations.name` / `normalized_name`   | `name` / `normalizedName`                                                 | `normalized_name` is loader-normalized (C-locale lower + NFD strip); **name search does NOT use it in Postgres** (§7)                                                                                                                                                                               |
| `core.organizations.registration_number`        | `registrationNumber`                                                      | duplicate of `registrations.cod_inmatriculare`; prefer the registrations value                                                                                                                                                                                                                      |
| `companies.registrations.cui` (PK)              | `CompanyRegistration.cui`                                                 |                                                                                                                                                                                                                                                                                                     |
| `…cod_inmatriculare`                            | `codInmatriculare`                                                        | one-to-many lookup (§2.1)                                                                                                                                                                                                                                                                           |
| `…legal_form`                                   | `legalForm`                                                               | e.g. SRL/SA/PFA                                                                                                                                                                                                                                                                                     |
| `…registration_date`                            | `registrationDate: string \| null`                                        | **256,142 NULL** (ONRC stopped publishing dates after 2024-09-03); expose `registrationDatePresent: bool` so coverage is honest                                                                                                                                                                     |
| `…status_code` / `status_label`                 | `headlineStatus: { code, label } \| null`                                 | headline derived by lifecycle priority in the loader (1084 radiată > 1070 faliment > … > 1048 funcțiune > other 1xxx > 2xxx). Labels mojibake-repaired                                                                                                                                              |
| `…raw_address` / `raw_county` / `raw_locality`  | `address: { display, county, locality }`                                  | **`raw_county` is the 99.996%-coverage county** — all county filtering uses it (NOT `county_name`, which is SIRUTA-matched and effectively urban-only)                                                                                                                                              |
| `…uat_siruta_code` / `uat_name` / `county_name` | `territory: { sirutaCode, uatName, countyName, matchConfidence } \| null` | NULL territory for ~36.3% (rural; urban-only matcher). `match_confidence ∈ {safe, unmatched}`                                                                                                                                                                                                       |
| `…match_confidence`                             | `territory.matchConfidence`                                               | drives the "geo present" caveat                                                                                                                                                                                                                                                                     |
| `…snapshot_at`                                  | `sources[onrc].snapshotDate`                                              | the ONRC snapshot watermark                                                                                                                                                                                                                                                                         |
| `companies.fiscal_status.is_active`             | **dropped (not exposed)**                                                 | **NOT operating-active** and exactly `NOT is_inactive` on all 3.87M rows (research Correction 1). Exposing it (even renamed) duplicates `declaredFiscallyInactive` — so it is omitted from every surface (§13-R1)                                                                                   |
| `…is_inactive`                                  | `declaredFiscallyInactive: bool`                                          | ANAF _declared-fiscally-inactive list_ flag — the single fiscal-inactivity boolean exposed. NOT an operating/lifecycle state                                                                                                                                                                        |
| `…is_vat_payer`                                 | `vatPayer: bool`                                                          |                                                                                                                                                                                                                                                                                                     |
| `…main_caen_code`                               | `fiscal.mainCaenCode`                                                     | ANAF's main CAEN; **1,012,993 companies have no ONRC CAEN at all** — coverage gap, not mismatch                                                                                                                                                                                                     |
| `…registered_name`                              | `fiscal.registeredName`                                                   | fallback name when org name absent                                                                                                                                                                                                                                                                  |
| `…snapshot_at`                                  | `sources[anaf].snapshotDate`                                              | ANAF (TVA endpoint) watermark; ~3.5wk stale                                                                                                                                                                                                                                                         |
| `companies.financials.*` (20 typed cols)        | `FinancialYear.summary`                                                   | typed columns: `turnover, net_profit, net_loss, employees, total_revenue, total_expenses, gross_profit, gross_loss, receivables, current_assets, fixed_assets, cash_and_bank, prepaid_expenses, deferred_income, subscribed_capital, inventories, debts, provisions, total_equity, patrimony_regie` |
| `companies.financials.employees`                | `employees: string` (bigint)                                              | **bigint** — source garbage outliers (max 5,009,387,154) overflow int4. Gate flags absurd; API never coerces to JS number                                                                                                                                                                           |
| `companies.financials.lines` (jsonb)            | `lines: Record<string, string> \| null`                                   | full statement (221 variable indicator names); render-only                                                                                                                                                                                                                                          |
| `companies.representatives.*`                   | `Representative { name, role }`                                           | high-degree placeholder noise (`FARA REPREZENTANT` on 35,646 cos) — flagged, not filtered, in the network view                                                                                                                                                                                      |
| `companies.caen_activities.*`                   | `CaenActivity { caenCode, caenRev, source, label }`                       | label from `core.classification_codes` where `system = 'caen\_'                                                                                                                                                                                                                                     |     | caen_rev` |
| `companies.status_flags.*`                      | `StatusFlag { code, label }`                                              | concurrent SET; labels mojibake-repaired                                                                                                                                                                                                                                                            |
| `companies.eu_branches.*`                       | `EuBranch { branchName, country, euid, fiscalCode }`                      | 221 rows                                                                                                                                                                                                                                                                                            |

### 2.3 PII / excluded columns

- **No party-name privacy class here** (companies are public legal entities; ONRC
  publishes representatives). `representatives.name` _is_ exposed — it is public
  registry data. (Contrast with `justice`, §8.2 of the contract.)
- **Excluded from default projection (semantic-safety, not PII):**
  - `companies.fiscal_status.is_active` — **dropped entirely** (§13-R1): it is the
    exact complement of `is_inactive`, carries a misleading "active" name, and adds
    no information. Only `declaredFiscallyInactive` (= `is_inactive`) is exposed.
- No `*_private` / contact tables exist in `companies.*`.

---

## 3. Repo interface (ports)

`src/modules/companies/core/ports.ts`. All methods return `Result<T, ApiError>`
(neverthrow). The repo touches only `companies.*` + the kernel read schemas it is
allowed (`core.organizations`, `core.organization_identifiers`,
`core.classification_codes`). **It does NOT query `flows.money_flows`** — the
public-money slice comes from the kernel `FlowsRepo` (contract §4.3/§14.6).

```ts
export interface CompaniesRepository {
  // ── detail (per-CUI, all index-backed by PK / cui indexes) ──
  getProfile(cui: string): Promise<Result<CompanyProfileData | null, ApiError>>;
  //   parallel fan-out, each WHERE cui = $1:
  //   core.organizations (organizations_cui_uq) + companies.registrations (PK)
  //   + fiscal_status (PK) + caen_activities (PK prefix scan on cui)
  //   + representatives (PK prefix) + financials (PK prefix, year desc)
  //   + status_flags (PK prefix) + eu_branches (PK prefix)
  //   + caen label join to core.classification_codes (PK (system, code))

  getFinancials(cui: string): Promise<Result<readonly FinancialYearRow[], ApiError>>;
  //   companies.financials WHERE cui = $1 ORDER BY year DESC — financials_pkey

  getLatestFinancial(cui: string): Promise<Result<FinancialYearRow | null, ApiError>>;
  //   DISTINCT ON (cui) … ORDER BY cui, year DESC — financials_pkey

  // ── list / filter (the filterable collection §7) ──
  listCompanies(
    filters: CompanyListFilters,
    sort: CompanySort,
    page: OffsetPage
  ): Promise<Result<{ rows: readonly CompanyListRow[]; total: number }, ApiError>>;
  //   FROM core.organizations o WHERE o.kind='company'
  //   LEFT JOIN companies.registrations r ON r.cui=o.cui   (registrations_pkey)
  //   LEFT JOIN companies.fiscal_status f ON f.cui=o.cui    (fiscal_status_pkey)
  //   status filter → registrations_status_idx; caen filter → EXISTS over
  //   caen_activities_code_idx. Total is BOUNDED (cap 10,000, §7 perf).
  //   ⚠ name `q` is NOT handled here in Postgres — see resolveByName (Meili).

  // ── resolution / discovery (§7.4) ──
  resolveByName(q: string, limit: number): Promise<Result<readonly CompanyNameHit[], ApiError>>;
  //   PRIMARY path = kernel SearchClient (Meilisearch company index) — instant
  //   prefix/typo search over 3.99M names. Postgres has NO trigram index on
  //   core.organizations.name/normalized_name (verified) → an ILIKE '%q%' is a
  //   3.99M-row seq scan and is FORBIDDEN as the default. Postgres pg_trgm
  //   similarity() is the DEGRADED fallback only when Meili is down, and is
  //   itself unindexed → hard-capped + statement_timeout-guarded (§5.5).
  findByRegistrationNumber(cod: string): Promise<Result<readonly CompanyNameHit[], ApiError>>;
  //   TWO-HOP: organization_identifiers WHERE scheme='cod-inmatriculare' AND
  //   value=$1 (index seek on PK (scheme,value)) → org_id, JOIN core.organizations
  //   ON org_id (kind='company') → project cui. organization_identifiers has NO
  //   cui column. Returns a LIST (one-to-many, research finding 3).
  resolveCaen(label: string, limit: number): Promise<Result<readonly CaenCodeHit[], ApiError>>;
  //   core.classification_codes WHERE system LIKE 'caen_%' AND label ILIKE $1 — small (3,111 codes)
  resolveCounty(q: string): Promise<Result<readonly string[], ApiError>>;
  //   distinct raw_county values matching q (small fixed set ~42 counties)

  // ── aggregates ──
  countByCounty(filters: CompanyListFilters): Promise<Result<readonly CountyCount[], ApiError>>;
  //   GROUP BY raw_county. ⚠ no index on raw_county → an UNFILTERED group is a
  //   3.99M seq scan (the 10k LIST cap does NOT bound a GROUP BY). Gated: the
  //   /companies/aggregate?groupBy=county endpoint REQUIRES ≥1 selective predicate
  //   (county/status/caen) OR the earned index registrations(raw_county) before
  //   it runs unbounded. 15s aggregate timeout class.
  countByStatus(filters: CompanyListFilters): Promise<Result<readonly StatusCount[], ApiError>>;
  //   GROUP BY status_code → registrations_status_idx
  countByCaenDivision(filters): Promise<Result<readonly CaenDivisionCount[], ApiError>>;
  //   left(caen_code,2) over caen_activities — heavy (18.27M); count-grain only

  // ── contributor support (§4) ──
  presenceFor(cui: string): Promise<Result<SourcePresence | null, ApiError>>;
  profileSlice(cui: string): Promise<Result<CompanyEntitySlice | null, ApiError>>;
}
```

**Index / perf notes (verified against the live `pg_indexes`):**

| Query class                                       | Driving index                                                          | Note                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| profile per-CUI                                   | `organizations_cui_uq`, all `companies.*` PKs                          | 8 parallel seeks; <5ms each                                                                                                                                                                                                                                                                                                                                                                             |
| status filter                                     | `registrations_status_idx`                                             | btree on `status_code`                                                                                                                                                                                                                                                                                                                                                                                  |
| caen filter / label                               | `caen_activities_code_idx` (code), `caen_activities_pkey` (cui prefix) | EXISTS subquery                                                                                                                                                                                                                                                                                                                                                                                         |
| county filter / group                             | **none** (seq-scan over registrations)                                 | list filter bounded by 10k count cap, but a `GROUP BY raw_county` aggregate is NOT — gate the unfiltered county aggregate (require a selective predicate). Earned-index candidate is **`registrations(raw_county[, status_code])`** — note this **supersedes** the research's `registrations(county_name, status_code)` suggestion (the plan filters on `raw_county`, not the urban-only `county_name`) |
| registration-number lookup                        | `organization_identifiers_pkey (scheme,value)`                         | index seek; one-to-many                                                                                                                                                                                                                                                                                                                                                                                 |
| **name search**                                   | **none in Postgres**                                                   | **MUST use Meilisearch** — the single biggest divergence from the old unified module (§13-R2)                                                                                                                                                                                                                                                                                                           |
| **global financial rank** (`year, turnover desc`) | **none**                                                               | no `financials(year,turnover desc)` index, no rollup → **not offered as a value-ranked list**; count-only or capability-gated (§7)                                                                                                                                                                                                                                                                      |

---

## 4. Usecases

`src/modules/companies/core/usecases/` — framework-free, over the ports, returning
`Result`.

| Usecase                    | Signature                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `makeCompanyProfile`       | `(deps, { rawCui }) → Result<CompanyProfile, ApiError>`     | normalize CUI → `getProfile` → assemble. **Presence is decided first by the cheap `core.organizations` (cui PK) seek**, short-circuiting the 8-table fan-out so a 404 for an unknown CUI does not pay 8 seeks (it 404s only if absent everywhere, but the common case resolves on the first seek). Public-money slice injected from kernel `FlowsRepo.summaryByCui(cui, 'payee')` |
| `makeCompanyList`          | `(deps, ListInput) → Result<CompanyListResponse, ApiError>` | offset paginate; total bounded at 10,000; default sort `name asc, cui asc`                                                                                                                                                                                                                                                                                                        |
| `makeCompanyFinancials`    | `(deps, { rawCui }) → Result<FinancialsResponse, ApiError>` | full year series + computed `latest` + `trajectory` (latest vs year-1, research feature 2)                                                                                                                                                                                                                                                                                        |
| `makeCompanyResolve`       | `(deps, { dim, q }) → Result<ResolveResponse, ApiError>`    | name→CUI (Meili), regnum→CUIs, caen-label→code, county-name→county. Echoes resolved entity + asks for disambiguation when >1 (catalog Entity Resolution Gate)                                                                                                                                                                                                                     |
| `makeCompanyCountyProfile` | `(deps, CountyInput) → Result<CountyProfile, ApiError>`     | count-by-county/status/caen aggregates; coverage-aware (research feature 4)                                                                                                                                                                                                                                                                                                       |
| `makeCompanyContributor`   | factory → `SourceContributor`                               | `presenceFor` + `profileSlice` for the kernel registry                                                                                                                                                                                                                                                                                                                            |

**Cross-source contributor (§4.4 / §14.7).** The module registers a
`SourceContributor` with `source: 'companies'`:

```ts
presenceFor(cui): { source: 'companies', present: boolean,
                    count?: { financials, caenActivities, representatives },
                    asOf: { onrc?: string, anaf?: string } }
//   present := EXISTS in core.organizations(kind='company') OR companies.registrations
profileSlice(cui): CompanyEntitySlice  // the same object Entity.company resolves (§14.7)
//   { headlineStatus, vatPayer, legalForm, registrationDate, latestFinancial, territory }
```

- **`flow_type` registered: NONE.** Companies do not _originate_ a flow type.
  In `flows.money_flows`, a company appears only as a **payee** (`payee_cui`) of
  `direct_acquisition` / `procurement_contract` / `pnrr_payment` / `pnrr_commitment`
  / `pnrr_subcontract` flows owned by procurement/pnrr. The companies contributor
  therefore reads the flow summary **as payee** via the kernel and labels it
  "public money received" — it adds nothing to `FLOW_TYPES`.
- **`doc_type` registered:** `company` (§9). The scrapper `search` lane projects
  one `search.documents` row per company; the server only reads.

**Grain Gate (§14.6) declaration.** Per flow question:

| Question                                                           | Authoritative source                                  | Grain                                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| "public money this company received, total + by year + top payers" | kernel `FlowsRepo` (`flows.money_flows`, `payee_cui`) | unified flow summary — the only flow answer companies gives                       |
| "is this company a public supplier at all"                         | kernel `FlowsRepo.presenceAsPayee(cui)`               | unified                                                                           |
| top-N suppliers / concentration / same-day splits                  | **procurement module** (its own facts/rollups)        | NOT a companies answer — companies never mixes its registry grain with flow grain |

---

## 5. REST endpoints

Prefix `/api/v1/companies/`. TypeBox schemas on every query/param. Envelope per
§5.2 (`{ ok, data, meta?, requestId }`). Routes carry `config: { public: true }`
(§14.11 — explicit flag, not prefix bypass).

| Method · Path                      | Query / Params (TypeBox)                                      | Response                                                          | Pagination                                                                                                                                    | Cache    | Timeout                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `GET /companies`                   | `CompanyListQuery` (§7 filter spec → TypeBox)                 | `CompanyListRow[]`                                                | **offset** (`page`,`pageSize`≤100), `meta.page={page,pageSize,total}` with `total` **bounded ≤10,000** + `estimated:true` when capped (§14.4) | TTL 300s | 5s                                                                                                       |
| `GET /companies/:cui`              | `cui` (string, normalized)                                    | `CompanyProfile` (full assembly + public-money)                   | —                                                                                                                                             | TTL 300s | 5s                                                                                                       |
| `GET /companies/:cui/financials`   | `cui`; `yearFrom?`,`yearTo?`                                  | `{ years[], latest, trajectory }`                                 | —                                                                                                                                             | TTL 300s | 5s                                                                                                       |
| `GET /companies/:cui/public-money` | `cui`; `yearFrom?`,`yearTo?`                                  | kernel flow summary (payee) `{ totalRon, byYear[], topPayers[] }` | offset (topPayers capped 50)                                                                                                                  | TTL 300s | 15s                                                                                                      |
| `GET /companies/aggregate`         | `CompanyListQuery` + `groupBy ∈ {county,status,caenDivision}` | `{ groups[], denominator, coverage }`                             | —                                                                                                                                             | TTL 600s | 15s — **`groupBy=county` requires ≥1 selective filter** until `registrations(raw_county)` is earned (§3) |
| `GET /companies/filters/resolve`   | `dim ∈ {name,regnum,caen,county}`, `q`, `limit?`              | `{ dim, q, matches[], ambiguous:bool }`                           | —                                                                                                                                             | TTL 120s | 5s (name dim hits Meili)                                                                                 |

Notes:

- `GET /companies` with a `q=` (name) param **resolves through Meili first**
  inside `makeCompanyList` (it calls `resolveByName`, takes the CUI set, then
  hydrates rows from Postgres by CUI). It never does an in-DB name LIKE. If Meili
  is down, `q=` degrades to the capped pg_trgm fallback and the response carries
  `caveats:["name search degraded (search service unavailable)"]`.
- `GET /companies/:cui/public-money` and the `publicMoney` block of the profile
  are sourced from the **kernel** `FlowsRepo`, not this module's repo (§4.3).
- Every read echoes the domain **as-of watermark** in `meta`
  (`meta.asOf = { onrc, anaf }`, §10/§14.11) — companies data is snapshot-stale by
  design and the API must say so.
- **OpenAPI:** the module exports an `openapi` fragment merged at
  `/api/v1/openapi.json`. Tag `companies`. The `declaredFiscallyInactive` schema
  description documents inline that `is_active` (its complement) is intentionally
  not exposed and is NOT an operating indicator (the drop is a contract, §13-R1).

---

## 6. GraphQL

`src/modules/companies/shell/graphql/`. Types are **domain-prefixed `Company*`**
(§14.8 — no bare `Status`/`Document`). Module `typeDefs` + `resolvers` extend the
root `Query` and the kernel `Entity` join type. Resolvers are thin: parse → same
usecase the REST handler calls.

Kernel-owned (declared once in the root schema, referenced here, **not redefined**
— the §14.8 schema-merge conflict test would fail on a redefinition): scalars
`CUI`, `Money`, `Date`, `BigInt`, `SIRUTA`, `JSON`; the `PageInfo` connection type;
and the `Entity` join type. Everything below is **module-owned `Company*`** SDL.

```graphql
# --- kernel (referenced, not redefined): CUI Money Date BigInt SIRUTA JSON PageInfo Entity ---

type CompanyStatus {
  code: String!
  label: String!
}

type CompanyTerritory {
  sirutaCode: SIRUTA
  uatName: String
  countyName: String
  matchConfidence: CompanyMatchConfidence!
}
enum CompanyMatchConfidence {
  SAFE
  UNMATCHED
}

type CompanyFiscal {
  vatPayer: Boolean
  # = is_inactive. The ONLY fiscal-inactivity boolean. NOT an operating/lifecycle
  # state; is_active (its exact complement) is intentionally dropped (§13-R1).
  declaredFiscallyInactive: Boolean
  mainCaenCode: String
  asOf: Date
}

type CompanyFinancialYear {
  year: Int!
  turnover: Money
  netProfit: Money
  netLoss: Money
  employees: BigInt
  summary: JSON! # the 20 typed metrics
  lines: JSON # full statement; render-only
}

type CompanyCaenActivity {
  code: String!
  rev: String!
  label: String
  source: String!
}
type CompanyRepresentative {
  name: String!
  role: String!
}
type CompanyStatusFlag {
  code: String!
  label: String
}
type CompanyEuBranch {
  branchName: String
  country: String
  euid: String
  fiscalCode: String
}

type Company {
  cui: CUI!
  orgId: BigInt!
  name: String!
  legalForm: String
  codInmatriculare: String
  registrationDate: Date
  registrationDatePresent: Boolean!
  headlineStatus: CompanyStatus
  statusFlags: [CompanyStatusFlag!]!
  territory: CompanyTerritory
  address: CompanyAddress!
  fiscal: CompanyFiscal
  caenActivities: [CompanyCaenActivity!]!
  representatives: [CompanyRepresentative!]!
  financials: [CompanyFinancialYear!]!
  euBranches: [CompanyEuBranch!]!
  publicMoney: CompanyPublicMoney # kernel FlowsRepo (payee)
  asOf: CompanyAsOf! # { onrc, anaf } watermark
}
# CompanyAddress.county = raw_county (99.996% cov, honest); CompanyTerritory.countyName
# = county_name (SIRUTA-matched, urban-only) — deliberately two different "county" values.
type CompanyAddress {
  display: String!
  county: String
  locality: String
}
type CompanyPublicMoney {
  totalRon: Money!
  flowCount: Int!
  byYear: [CompanyPublicMoneyYear!]!
  topPayers: [CompanyPublicMoneyPayer!]!
}
type CompanyPublicMoneyYear {
  year: Int
  flowType: String!
  totalRon: Money!
  count: Int!
}
type CompanyPublicMoneyPayer {
  cui: CUI
  name: String
  totalRon: Money!
  count: Int!
}
type CompanyAsOf {
  onrc: Date
  anaf: Date
}

enum CompanySort {
  NAME
  REGISTRATION_DATE
  CUI
} # asc default; value-sorts (turnover/employees) NOT offered (§7.1/R3)
enum CompanyResolveDim {
  NAME
  REGNUM
  CAEN
  COUNTY
}
type CompanyResolveHit {
  value: String!
  label: String
  cui: CUI
  confidence: Float
}
input CompanyFilterExclude { # symmetric to inclusion, exclude:true fields only (§7.1)
  cui: [CUI!]
  county: [String!]
  status: [String!]
  caenCode: [String!]
  legalForm: [String!]
  vatPayer: Boolean
  declaredFiscallyInactive: Boolean
  mainCaenCode: [String!]
}
type CompanyCountyGroup {
  key: String!
  count: Int!
}
type CompanyCountyProfile {
  groups: [CompanyCountyGroup!]!
  denominator: Int!
  coverage: JSON!
}

type CompanyEdge {
  node: Company!
  cursor: String!
}
type CompanyConnection {
  edges: [CompanyEdge!]!
  pageInfo: PageInfo!
  totalCount: Int
  totalEstimated: Boolean!
}

input CompanyFilter { # generated from the §7 spec (toGraphQLInput)
  cui: [CUI!]
  county: [String!] # → raw_county
  status: [String!] # → registrations.status_code
  caenCode: [String!] # → caen_activities.caen_code
  legalForm: [String!]
  vatPayer: Boolean
  declaredFiscallyInactive: Boolean
  registrationDateFrom: Date
  registrationDateTo: Date
  registrationDatePresent: Boolean # isNull op (§14.2 mandatory)
  hasFinancials: Boolean # isNull-style presence
  exclude: CompanyFilterExclude
}

extend type Query {
  company(cui: CUI!): Company
  companies(filter: CompanyFilter, sort: CompanySort, first: Int, after: String): CompanyConnection!
  companyResolve(dim: CompanyResolveDim!, q: String!, limit: Int): [CompanyResolveHit!]!
  companyCountyProfile(filter: CompanyFilter): CompanyCountyProfile!
}

extend type Entity { # the kernel join type (§4.4/§14.7)
  company: Company # resolved via contributor.profileSlice(cui) + DataLoader keyed by CUI
}
```

- **DataLoader:** `Entity.company` is resolved by a per-request DataLoader keyed
  by **CUI** (not org*id, §14.1). It calls the \_same* `contributor.profileSlice`
  the REST entity-360 calls (§14.7) → tri-surface equivalence. Batched
  `WHERE cui = ANY($1)` over `core.organizations` + `companies.registrations`.
- **Connections** use the kernel cursor encoder (`fhash` of
  `canonicalizeFilters`, §14.3); on an `fhash` mismatch (filters changed
  mid-pagination) the resolver returns `InvalidInput` ("cursor/filter mismatch;
  restart pagination", GraphQL code `INVALID_INPUT`) — never silently re-applies
  (§14.3). The REST list offers offset pagination; the two modes are **not
  interchangeable** (no cursor↔offset translation) — GraphQL is connection-only,
  REST is offset.
- `companies` connection `totalCount` is **bounded** (≤10,000) and carries
  `totalEstimated` (§14.4) — large unfiltered lists never `COUNT(*)` 3.99M rows.

---

## 7. Filters (priority area)

The kernel ships the filter pipeline (§14.2); this module **declares specs** that
consume it. One `CollectionFilterSpec` per filterable collection. `canonicalizeFilters`
output feeds the cache key, the cursor `fhash`, and the tri-surface equivalence test.

### 7.1 `companies` collection filter spec

| Field                      | type   | ops                   | driving column (alias.col)    | index                      | array | exclude | notes                                                                                                                                                       |
| -------------------------- | ------ | --------------------- | ----------------------------- | -------------------------- | ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cui`                      | string | `in`,`eq`             | `o.cui`                       | `organizations_cui_uq`     | ✓     | ✓       | normalized 1–13 digits                                                                                                                                      |
| `county`                   | string | `in`,`eq`             | `r.raw_county`                | none (bounded)             | ✓     | ✓       | **`raw_county`, 99.996% cov — NOT `county_name`**                                                                                                           |
| `status`                   | string | `in`,`eq`             | `r.status_code`               | `registrations_status_idx` | ✓     | ✓       | headline code (enum-ish; validated against status nomenclature)                                                                                             |
| `caenCode`                 | string | `in`,`eq`,`prefix`    | `ca.caen_code` (EXISTS)       | `caen_activities_code_idx` | ✓     | ✓       | `prefix` compiles to **sargable** `caen_code LIKE $1 \|\| '%'` (range scan on the btree), NOT `left(code,2)=` (non-sargable). CAEN division = 2-char prefix |
| `legalForm`                | string | `in`,`eq`             | `r.legal_form`                | none                       | ✓     | ✓       | SRL/SA/PFA                                                                                                                                                  |
| `vatPayer`                 | bool   | `eq`                  | `f.is_vat_payer`              | none (joins fiscal)        | ✗     | ✓       |                                                                                                                                                             |
| `declaredFiscallyInactive` | bool   | `eq`                  | `f.is_inactive`               | none                       | ✗     | ✓       | NOT operating-inactive (§13-R1)                                                                                                                             |
| `registrationDate`         | date   | `gte`,`lte`,`between` | `r.registration_date`         | none                       | ✗     | ✗       | `xFrom`/`xTo`                                                                                                                                               |
| `registrationDatePresent`  | bool   | `isNull`              | `r.registration_date`         | none                       | ✗     | ✗       | **mandatory `isNull` (§14.2)** — 256,142 NULL dates                                                                                                         |
| `hasFinancials`            | bool   | `isNull`              | EXISTS `companies.financials` | `financials_pkey`          | ✗     | ✗       | coverage question                                                                                                                                           |
| `mainCaenCode`             | string | `in`,`eq`             | `f.main_caen_code`            | none                       | ✓     | ✓       | ANAF main CAEN                                                                                                                                              |

**Sort:** `{ default: 'name', allowed: ['name','registrationDate','cui'] }`.
**Excluded by design from sort:** `turnover`/`employees` global value sorts —
no `financials(year, turnover desc)` index and no rollup exist (verified). A
value-ranked global list is **not offered**; it would require the deferred
`latest_financials` rollup or an earned index (§13-R3). County/status profiles
are count-ranked, which is index-safe.

### 7.2 Text engine backing `q`

- The list `q` (company name) is backed by **Meilisearch** (instant prefix/typo),
  resolved to a CUI set then hydrated from Postgres. **Postgres has no trigram
  index on the name** (verified) → `ILIKE`/`similarity()` is the **degraded
  fallback only**, capped + `statement_timeout`-guarded, with a `caveats` entry.
- This is a deliberate improvement over the old unified `searchCompanies`, which
  ran `normalized_name LIKE '%q%'` + `similarity() ORDER BY` directly against
  ~4M rows in Postgres (a seq scan in prod). See §13-R2.

### 7.3 Surface mapping (REST ↔ GraphQL ↔ MCP)

- REST: scalars → query params; arrays → CSV (declared); ranges →
  `registrationDateFrom`/`registrationDateTo`; exclusion → `exclude.county=...`.
- GraphQL: `input CompanyFilter`; arrays → lists; ranges → `…From`/`…To` fields;
  exclusion → nested `exclude: CompanyFilterExclude`.
- MCP: same field names as REST; discovery tool resolves names→codes first.
- **Gotcha:** the county term must be matched **without `unaccent()`** — the
  `unaccent` extension is **NOT installed** in `transparenta_prod` (verified). The
  old code's `lower(unaccent(raw_county))` would throw. Options (decision §13-R4):
  match against a loader-normalized county (preferred), or fold with
  `pg_trgm`/`lower()` + a curated diacritic map. **Do not call `unaccent()`.**

### 7.4 Discovery / resolve dimensions

`name` (→ CUI via Meili), `regnum` (→ CUI list via the two-hop identifiers→organizations
join, §2.1), `caen` (label → code, 3,111 codes), `county` (text → canonical
`raw_county`). Driving doc: `AI_AGENT_FILTER_QUESTION_CATALOG.md`.

### 7.5 Golden question → filter examples (from the catalog)

| Catalog ID                    | Question                                                      | Resolved filter                                                                             |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| JD-1 / XS-4 (companies slice) | "Is company _Y_ a registered company; what is its status?"    | `companyResolve(name,"Y")` → `cui`; `company(cui)` → `headlineStatus`, `statusFlags`        |
| (registry)                    | "Companies in Cluj county that are radiată"                   | `{ county:['Cluj'], status:['1084'] }`                                                      |
| (registry)                    | "VAT-paying SRLs registered after 2020-01-01 in Timiș"        | `{ county:['Timis'], legalForm:['SRL'], vatPayer:true, registrationDateFrom:'2020-01-01' }` |
| (coverage)                    | "How many companies have no registration date?"               | `aggregate?groupBy=status` + `registrationDatePresent=false` → `denominator` + count        |
| PC-3 mirror                   | "What public money did company _Y_ receive, by year?"         | `company(cui).publicMoney` (kernel flows, payee)                                            |
| (sector)                      | "Companies authorized for CAEN division 47 (retail) in Ilfov" | `{ county:['Ilfov'], caenCode:['47'] with prefix op }`                                      |
| (resolution)                  | "Find the company with registration number J40/9216/2018"     | `companyResolve(regnum,"J40/9216/2018")` → **list** (one-to-many possible)                  |

---

## 8. MCP tools

`src/modules/companies/shell/mcp/`. TypeBox input + output; handler calls the
core usecase; output `{ ok, kind, query, link, item|items, summary? }`. Rate-limited,
bounded results. Naming `<verb>_company_<noun>`.

### 8.1 Discovery tool — `resolve_company_filter`

```ts
input:  { dim: 'name'|'regnum'|'caen'|'county', q: string, limit?: number }
output: { ok, kind:'resolution', query, matches: [{ value, label, cui?, confidence }],
          ambiguous: boolean, link, summary }
// calls makeCompanyResolve. name→Meili; regnum→identifiers (LIST); caen→codes; county→canonical.
// summary: "Resolved \"Dedeman\" to CUI 4505500 (DEDEMAN SRL, Bacău)."
```

### 8.2 Query tools

- **`get_company_snapshot`** — `input { cui }` → `{ ok, kind:'company', item: CompanySnapshot, link, summary }`.
  Calls `makeCompanyProfile` (compact slice: status, fiscal flags, latest
  financial, territory, public-money total). `link = /companies/<cui>`.
  `summary`: "DEDEMAN SRL (CUI 4505500), Bacău, status funcțiune, VAT payer;
  2024 turnover 12.3B RON, 11,402 employees; received 0 RON public money."
- **`list_companies`** — `input: CompanyFilter + sort + page` → bounded list
  (`items`, `denominator`, `coverage`, `caveats`). Calls `makeCompanyList`.
  Enforces the catalog **Entity Resolution Gate**: ranks/filters by CUI/code, not
  names; echoes resolved entities.
- **`get_company_financials`** — `input { cui, yearFrom?, yearTo? }` → year series
  - latest + trajectory. Calls `makeCompanyFinancials`.
- **`company_county_profile`** — `input: CompanyFilter + groupBy` → count-ranked
  aggregate with `denominator` + `coverage` (catalog Coverage Gate). **Refuses /
  labels** value-weighted ("biggest by turnover") rankings as not-yet-publishable —
  the reason is **R3** (no `financials(year,turnover desc)` index and no
  `latest_financials` rollup → a global value rank is a full scan/sort), **not** the
  catalog Amount Integrity Gate (which governs the _flows/public-money_ surface, not
  company turnover). Count-weighted rankings allowed.

All tool outputs carry `asOf` (onrc/anaf watermarks) and a `coverage` block where
a count/aggregate is returned (catalog Core Rule).

---

## 9. Search integration

- **`doc_type` owned:** `company`. **Coordination dependency (not a verified
  fact):** the `search.documents` columns exist (`cuis`, `county_name`, `attrs`,
  verified in `search.tsv`), but the plan does NOT assume company rows are populated
  yet — the scrapper `search` lane must project them, and that population is a
  Phase-3 dependency the same way the missing vector column is. The desired
  projection is one `search.documents` row per company: `doc_id = "company:" || cui`,
  `title = name`, `body = name + legal_form + county + status_label + main caen
label`, `cuis = [cui]`, `county_name = raw_county`,
  `attrs = { status_code, legal_form, vat_payer, has_financials }`. **The server
  only reads/queries these — it never writes** (contract §4.5).
- **Meilisearch:** index `companies` (or the shared entity index filtered by
  `doc_type='company'`) — instant entity-name autocomplete; the primary backing
  for `resolveByName` and list `q=`. Searchable: `title`/name; filterable:
  `county_name`, `status_code`, `legal_form`, `vat_payer`.
- **OpenSearch:** the `documents` index, `doc_type='company'` — relevance/full-text
  - `county`/`status` terms aggregations for faceted browse.
- **Semantic / pgvector:** **capability-gated** (§14.5). `vector` ext is installed
  but `search.documents` has no vector column in the snapshot → semantic fields
  return `null` + `caveats:["semantic search unavailable"]`, never error. Company
  name search has low semantic value anyway (exact/prefix dominates).

---

## 10. Sync / freshness impact on serving

- **Cadence (NOTES decision 3, Option A):** ANAF stages (fiscal, financials)
  weekly during the bilanț drain / monthly after; ONRC stages + reconcile-deletes
  monthly per snapshot; TVA monthly. **Manual CLI trigger** today (CronJob vs
  Temporal is a platform-open decision).
- **As-of semantics (mandatory surface):** companies data is snapshot-stale by
  construction — ONRC single snapshot 2026-05-18; ANAF TVA drained 2026-05-19;
  bilanț still draining. Every read returns `meta.asOf = { onrc, anaf }` from
  `registrations.snapshot_at` / `fiscal_status.snapshot_at` (domain-level
  watermark). This is required, not optional (§14.11) — the velocity/new-registration
  features are meaningless without it (research feature 6).
- **Cache TTLs:** read-through TTL (300s detail/list, 600s aggregates) is the
  interim invalidation. If/when an `etl.load_runs` completion stamp (companies
  gate-green row, `target_table='companies:gate'`) is readable, bust cache on it
  and surface the load watermark (§14.11). Until that signal is wired into the
  serving path, **TTL-only** + the per-row `snapshot_at` as-of (stated explicitly).
- **Mutable, not append-only:** financials grow with the drain; status_flags and
  representatives are reconcile-deleted on ONRC refresh. The API must not cache a
  per-CUI profile longer than the TTL across a refresh boundary; a stale topPayers
  or financial year is acceptable within TTL.

---

## 11. Wiring

- `makeCompaniesModule(deps): CompaniesModule` returns
  `{ restPlugin, graphql: { typeDefs, resolvers }, mcpTools, contributor, repos }`.
- **Deps:** kernel `Kysely<ProdDatabase>` (read-only), kernel `FlowsRepo`
  (public-money slice), kernel `SearchClient` (Meili for name resolution), kernel
  `cache`, kernel `IdentityRepo` (CUI resolution), `SearchCapabilities`.
- **Env additions:** none beyond kernel-owned (`PROD_DATABASE_URL`, `MEILI_*`,
  `OPENSEARCH_URL`). Module is feature-flag-able off via the kernel module-enable
  list.
- **build-app registration:** construct after kernel; register REST plugin under
  `/api/v1/companies`, merge GraphQL slice into root, register MCP tools, register
  the `companies` contributor into the kernel registry. Order-independent (no
  cross-module deps; §10 of the contract).
- **Legacy superseded:** the old `unified` module's companies surface
  (`/api/v1/unified/companies`, `companies-source-repo.ts`,
  `make-company-profile.ts`, `make-company-search.ts` on `feat/unified-explorer`).
  It keeps running during the transition; the new module mounts under
  `/api/v1/companies` and `Company*` GraphQL types (no collision). Final cutover
  is platform #19.

---

## 12. Testing

- **Unit** (`tests/unit/companies/`): `makeCompanyProfile`/`makeCompanyFinancials`/
  `makeCompanyList`/`makeCompanyResolve` over mocked ports; filter spec → SQL
  compilation snapshot (incl. `prefix`/`isNull`/`exclude`/county-without-unaccent);
  cursor encode/decode + `fhash`; CUI normalization (1–13 digits, `RO` prefix,
  garbage→`InvalidInput`); employees-bigint-as-string (no JS-number coercion).
- **Integration** (`tests/integration/companies/`): REST + GraphQL + MCP against a
  seeded fixture schema; **tri-surface equivalence** — same `CompanyFilter` →
  identical CUIs/rows across REST/GraphQL/MCP (the `canonicalizeFilters` contract);
  `Entity.company` resolves via the same contributor slice REST uses; degraded
  name-search path when Meili mock is down (returns capped fallback + caveat).
- **Golden filters:** the §7.5 table as integration cases, plus the catalog
  refusal cases: value-ranked "biggest by turnover" must be **refused/labeled**
  (Amount Integrity Gate); region/territory answers must disclose the ~36.3%
  unmatched-territory coverage (Coverage Gate).
- **Privacy/semantics test:** assert no REST/GraphQL/MCP surface emits a field
  literally named `is_active` (or any "active"-named boolean), and that
  `declaredFiscallyInactive`'s schema description carries the "NOT
  operating-active / complement intentionally dropped" caveat.

---

## 13. Open questions / risks

- **R1 — `is_active` is dropped, not exposed (DECIDED, MATERIAL).**
  `companies.fiscal_status.is_active` is the exact complement of `is_inactive`
  (`is_active == NOT is_inactive` on all 3.87M rows) and is the _fiscally-inactive-list_
  flag, **not** an operating indicator (`COMPANIES_DATA_RESEARCH.md` Verification
  Correction 1). **Decision (this plan): drop `is_active` from every surface** and
  expose only `declaredFiscallyInactive` (= `is_inactive`) — exposing both, even
  renamed, would re-introduce the redundant/misleading pair the correction warns
  against. The only genuinely-open item is deferred: the **real operating state
  (`stare_inregistrare` + radiation date) is unextracted in serving** — a scrapper
  enrichment follow-up; once it lands, a `CompanyFiscal.lifecycleState` field is
  added then.
- **R2 — name search moves to Meili (architectural).** Verified: no trigram index
  on `core.organizations.name`/`normalized_name` in prod. The old unified module's
  in-DB `LIKE '%q%'` + `similarity()` is a 3.99M-row seq scan and is not viable.
  Name search is Meili-primary, pg_trgm-degraded (capped). **Decision:** accept
  Meili as the hard dependency for name search quality (with graceful degrade), or
  earn a `gin (normalized_name gin_trgm_ops)` index (a scrapper migration, ~large
  on 3.99M rows). Recommend Meili-primary.
- **R3 — no global value-ranked company list.** No `financials(year, turnover desc)`
  index and no `latest_financials` rollup exist. "Top companies by turnover/employees"
  is **not offered** as a list; only per-CUI financials and count-ranked county/sector
  profiles. **Decision:** defer to a scrapper rollup (`latest_financials` /
  `financials` rank index) before promising value-ranked discovery.
- **R4 — `unaccent` is not installed in `transparenta_prod`** (verified). The old
  county filter `lower(unaccent(raw_county))` would throw. Resolve via a
  loader-normalized county column (preferred; a scrapper change) or a server-side
  curated diacritic fold; **do not** add `unaccent()` to a server query against a
  DB that lacks the extension. **Decision:** confirm the county-normalization
  approach with the scrapper owner.
- **R5 — territory coverage 63.8% (urban-only matcher).** ~36.3% of companies have
  NULL territory (rural; village→commune SIRUTA layer is a deferred matcher
  iteration). County (`raw_county`) coverage is 99.996%, so **county filters are
  honest; SIRUTA/UAT filters are not** and any UAT-grain answer must disclose
  coverage (Coverage Gate). Use `raw_county` for filtering, `uat_siruta_code` only
  for the subset that has it.
- **R6 — `cod_inmatriculare` one-to-many + re-registered CUIs.** 76 reg-numbers →
  152 CUIs; 95,152 CUIs carry re-registration history collapsed to one current row
  (3,119 companies show financials predating the current reg date). Reg-number
  resolution returns a list; the profile shows the current row only and a caveat;
  identity-history aliasing is a deferred scrapper feature.
- **R7 — `core.organization_identifiers` shared with public entities.** The
  identifiers table is co-owned (companies write `ro-cui`/`cod-inmatriculare`;
  budget writes its own schemes). The companies repo filters by `source`/`scheme`
  when reading; it never assumes the table is companies-only.
