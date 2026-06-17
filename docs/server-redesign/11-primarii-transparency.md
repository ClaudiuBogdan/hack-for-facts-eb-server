# 11 — primarii-transparency (`primarii_transparency` schema)

> **Module:** `src/modules/primarii-transparency/`
> **Schema:** `primarii_transparency` (11 tables). **GraphQL prefix:** `Primarii*`.
> **REST prefix:** `/api/v1/primarii-transparency/`. **doc_type:** `primarii_transparency_entity`.
> **Conforms to:** [`00-foundation-shared-kernel.md`](./00-foundation-shared-kernel.md)
> (topology §2, DB contract §3, kernel §4, filters §7/§14.2, scalars §14.1,
> namespacing §14.8, privacy §8.2). Deviations are called out inline.

This source is a **curated transparency-QA registry over Romanian local-government
entities (UAT town/commune halls)**. Each entity (keyed by CUI) carries a
research snapshot that asserts whether the UAT publishes three legally-required
transparency artifacts — **organigrama** (org chart), **numar_angajati** (staff
headcount), **salarii** (salary disclosures) — plus a derived data-quality status
and the evidence documents backing each claim. Its **strongest correlation axis is
territory (UAT/county), not money flows**; it owns no `flows.money_flows` rows.

---

## 1. Summary & data status

**Prod schema:** `primarii_transparency` only. No `source_*` staging in serving
(loader streams from the raw DB `transparenta_eu_primarii_transparency`; serving
holds logical raw references, not bytes — bytes live in MinIO, per NOTES).

**Live row counts** (griffin `transparenta-prod-postgres-1`, 2026-06-16,
`pg_stat_user_tables`):

| Table | Rows | Grain | Status |
|-------|-----:|-------|--------|
| `current_entity_status` | **3,187** | 1 per UAT CUI (current view) | ✅ populated — **primary read surface** |
| `entity_snapshots` | **3,109** | 1 per (cui, source_result_version) research run | ✅ populated |
| `entity_category_statuses` | **9,327** | (snapshot, category) — 3 categories × snapshots | ✅ populated |
| `documents` | **7,233** | 1 per evidence document | ✅ populated |
| `salary_amount_claims` | **14,903** | extracted salary line | ✅ populated |
| `salary_documents` | **2,301** | salary doc + year/period dims | ✅ populated |
| `staffing_claims` | **3,109** | 1 per snapshot (headcount) | ✅ populated |
| `organigrama_claims` | **3,109** | 1 per snapshot (org-chart status) | ✅ populated |
| `load_issues` | **1,880** | loader QA event | ✅ populated (ops surface) |
| `entity_registry_links` | **0** | CUI → registry link | ⚠ **DDL-only, deferred** |
| `fact_evidence_refs` | **0** | generic fact→evidence ref | ⚠ **DDL-only, deferred** |

**Measured distributions** (drive the filter enums in §7):

- `current_entity_status.data_quality_status` (the headline filter):
  `medium` 2,559 · `high` 265 · `review_needed` 169 · `low` 116 · `missing` 78.
- `current_entity_status.result_status`:
  `partial` 2,723 · `complete` 265 · `blocked` 113 · `missing_result` 78 ·
  `not_found` 5 · `error` 3.
- `entity_type`: `admin_commune_hall` 2,861 · `admin_town_hall` 216 ·
  `admin_municipality` 103 · `admin_sector_hall` 6 · `primarie` 1.
- `county`: **43 distinct** (Romanian county names as **text**, e.g. "Cluj") —
  **there is no SIRUTA column anywhere in this schema** (see §2 territory).
- `documents.category`: `salarii` 4,062 · `organigrama` 1,842 · `numar_angajati`
  805 · `other` 524.
- `load_issues`: `evidence_missing` 1,859 (warning) · `evidence_empty` 18 (error)
  · `evidence_hash_mismatch` 3 (error). The 21 errors are why
  `data_quality_passed=false` while `passed=true` (structural gate, per NOTES).

**Deferred (DDL-only, plan accordingly):**

- `entity_registry_links` (0 rows) — the *designed* CUI→`public_entities`/`companies`
  link table. **The module MUST NOT depend on it for identity/territory linkage.**
  Linkage is computed live by joining `cui` to the kernel identity/territory hub
  (§2, §4). The repo exposes a `getRegistryLinks(cui)` method that returns `[]`
  today and lights up automatically when the loader populates it — no API change.
- `fact_evidence_refs` (0 rows) — generic fact→raw-evidence pointer. Evidence is
  currently reachable via `documents` and per-claim `source_excerpt`/`raw_*` ids;
  do not surface `fact_evidence_refs` until populated.

**Not surfaced in v1 (populated but intentionally out of scope):**

- `salary_documents` (2,301 rows) — the salary-doc year/period dimension table
  (`year`, `period`, `is_latest`, FK to `documents`). It backs a plausible "latest
  salary disclosure year per UAT" question but adds a third claim surface for
  marginal value; **v1 exposes salary evidence via `documents` (`category=salarii`)
  + `salary_amount_claims` only.** Add a `/entities/:cui/salary-documents` surface
  in v2 if the year/`is_latest` dimension is needed (the `salary_documents_cui_year_idx`
  is ready for it).

**What this source does NOT have** (honesty for the contributor/entity-360 wiring):

- No money: no `flows.money_flows` rows, no `amount`/spend semantics other than the
  *self-reported* `salary_amount_claims.amount_ron` (a claim extracted from a
  disclosure PDF, **not** a verified payment). It is **not** a flow fact and MUST
  NOT be summed into entity-360 totals (§4 grain note).
- No SIRUTA column — territory is via CUI→hub or the denormalized `county` text.
- The CUIs are **UAT institutions** (public entities), so this links to
  `core.public_entities`, not the `companies` registry.

---

## 2. Schema → domain model

Module `core/types.ts` view models (kernel scalars from §14.1: `cui:string`,
`org_id:string`/BigInt, money as string, `date` as `YYYY-MM-DD`; **note the
`*_date`/`as_of_date` columns on claims/documents/snapshots are stored as `text`,
not `date`** — see the type column — so they pass through as strings unparsed and
the plan does NOT promise date-range filtering on them).

```ts
// Identity + territory denormalized onto the current view; canonical metadata via hub.
export interface PrimariiEntityStatus {        // ← current_entity_status (primary)
  readonly cui: string;
  readonly snapshotId: string | null;          // bigint → string
  readonly entityName: string;
  readonly entityType: string | null;          // admin_commune_hall | admin_town_hall | ...
  readonly county: string | null;              // denormalized text (no SIRUTA here)
  readonly websiteUrl: string | null;
  readonly resultStatus: string;               // partial | complete | blocked | missing_result | not_found | error
  readonly dataQualityStatus: 'high'|'medium'|'low'|'missing'|'review_needed';
  readonly confidence: number | null;          // 0..1 real
  readonly evidenceCoverage: number | null;    // 0..1 real
  readonly missingRequiredCategories: readonly string[];   // text[]
  readonly issueCount: number;
  readonly updatedAt: string;                   // ISO
}

export interface PrimariiCategoryStatus {       // ← entity_category_statuses
  readonly category: 'organigrama'|'numar_angajati'|'salarii';
  readonly status: 'found'|'not_found'|'unknown'|'blocked';
  readonly evidenceCount: number;
  readonly missingEvidenceCount: number;
}

export interface PrimariiSnapshot {             // ← entity_snapshots (history)
  readonly snapshotId: string;
  readonly cui: string;
  readonly entityName: string;
  readonly entityType: string | null;
  readonly county: string | null;
  readonly websiteUrl: string | null;
  readonly wikipediaUrl: string | null;
  readonly sourceResultVersionId: string | null;
  readonly schemaVersion: string | null;
  readonly resultStatus: string;
  readonly confidence: number | null;
  readonly researchedAt: string | null;        // ISO timestamptz
  readonly organigramaStatus: string | null;
  readonly numarAngajatiStatus: string | null;
  readonly salariiStatus: string | null;
  readonly missingRequiredCategories: readonly string[];
  readonly validationIssues: readonly string[];
  readonly loadedAt: string;
}

export interface PrimariiDocument {             // ← documents (evidence inventory)
  readonly documentPk: string;
  readonly cui: string;
  readonly category: string | null;            // salarii | organigrama | numar_angajati | other
  readonly documentType: string | null;
  readonly title: string | null;
  readonly sourceUrl: string | null;           // public source link
  readonly contentSha256: string | null;       // identity of the stored MinIO object
  readonly contentBytes: string | null;        // bigint → string
  readonly publishedDate: string | null;       // TEXT (unparsed)
  readonly effectiveDate: string | null;       // TEXT (unparsed)
  // local_path / raw_evidence_* are RAW pointers → excluded from default projection (§8)
}

export interface PrimariiSalaryClaim {          // ← salary_amount_claims
  readonly salaryAmountClaimId: string;
  readonly cui: string;
  readonly documentPk: string | null;
  readonly amountRon: string;                   // numeric(18,2) → string. SELF-REPORTED, not a flow.
  readonly roleTitle: string | null;
  readonly periodStart: string | null;         // real DATE here → YYYY-MM-DD
  readonly periodEnd: string | null;
  readonly confidence: number | null;
}

export interface PrimariiStaffingClaim {        // ← staffing_claims
  readonly cui: string;
  readonly totalPositions: number | null;
  readonly occupiedPositions: number | null;
  readonly vacantPositions: number | null;
  readonly asOfDate: string | null;            // TEXT
  readonly confidence: number | null;
}
```

**Identity (CUI) linkage.** `cui` is `text` and DB-constrained to `^[0-9]+$`
(digits only — already normalized; apply kernel `normalizeCui` defensively on
input but the stored value needs no `RO` strip). The cross-source key is **CUI**
(§14.1). The repo resolves the org via the kernel `IdentityRepo.findByCui(cui)` and
the canonical public-entity record via `core.public_entities.cui` (these CUIs are
UAT public entities). **Link-not-merge:** never reassign org_id.

**Territory (SIRUTA) linkage — the central architectural point.** This schema has
**no SIRUTA column** and only a free-text `county`. Geographic filtering and
canonical territory metadata therefore resolve through the **kernel territory hub**:

```
primarii_transparency.cui
  └─ core.public_entities.cui  →  territorial_siruta_code (text)
       └─ core.territories.territorial_siruta_code
            → county_code, siruta_code, county_siruta_code, region, population, name
```

- **Fast county filter:** the denormalized `current_entity_status.county` text
  (indexed) backs the cheap `county=` filter for the common "all UATs in Cluj"
  case — no join needed. **Caveat:** it is a *name* string with no guaranteed
  canonical spelling/diacritics; the plan declares it a best-effort filter and
  routes canonical/SIRUTA-based geography through the hub.
- **Canonical SIRUTA / region / population filters** (`siruta[]`, `region[]`,
  `is_uat`, `min/maxPopulation`) compile to a join `… JOIN core.public_entities pe
  ON pe.cui = t.cui JOIN core.territories ter ON ter.territorial_siruta_code =
  pe.territorial_siruta_code` then filter on the **hub** columns. This join is
  **fully index-backed** (verified live, 2026-06-16): `core.public_entities` has a
  **unique PK on `cui`** (`public_entities_pkey`) and an index on
  `territorial_siruta_code` (`public_entities_territorial_siruta_code_idx`);
  `core.territories` has a **unique index on `territorial_siruta_code`**
  (`territories_territorial_siruta_code_key`). So each of the ≤3,187 rows resolves
  via two unique/index seeks — cheap, no scan.
  - ⚠ **Contract gap (cross-module need, see §13).** The binding contract's
    `TerritoryRepo` (§4.2) is **SIRUTA-keyed only** (`byTerritorialSiruta`,
    `byCounty`, `searchUat`, `listCounties`, `listRegions`) — it exposes **no
    `cui → territory` resolver**, and `core.public_entities` belongs to the
    *identity* hub (§4.1), not the territory hub. **The kernel must add a
    `cui → {territorial_siruta_code, county_code, siruta_code, region, population}`
    resolver** (proposed: `IdentityRepo.territoryForCui(cui)` + a matching
    territory-filter builder the module composes). This module **does not** invent a
    private `core.public_entities` join (§3 forbids source repos touching kernel
    schemas except via kernel repos); it consumes the kernel resolver once it
    exists. **Until then, geographic filtering is limited to the denormalized
    `county` text path**, and `region`/`siruta`/`isUat`/population filters are
    declared **capability-gated** (return `InvalidInput` "geographic resolution
    unavailable" rather than silently dropping the predicate).
  - Coverage of the CUI→public_entities→territory path is **not yet measured** and
    is surfaced as a `coverage` caveat on geographic aggregates (catalog Coverage
    Gate).

**PII / excluded columns.** This domain is institutional QA, **no person PII**
(salary claims are aggregate role-level disclosures, not named individuals — verify
`role_title` carries no person names at projection time; if a value looks like a
name, it is still institutional disclosure text, but we do **not** expose any
free-text excerpt by default). Default projections **exclude**:
`local_path`, `raw_document_id`, `raw_document_key`, `raw_evidence_occurrence_id`,
`raw_evidence_object_id`, `raw_quality_run_id`, `raw_claim_observation_id`
(internal raw-DB/object-store pointers), and `*.source_excerpt` (raw text snippet —
opt-in only via a detail flag, never in list responses). `attrs` jsonb is
projected as opaque `JSON` only on detail endpoints, never filtered on.

---

## 3. Repo interface (ports)

`core/ports.ts`. All methods return `Result<T, ApiError>` (neverthrow, §5.1). The
repo touches **only** `primarii_transparency.*`. Geography against
`core.public_entities` + `core.territories` is **not** a private join here — it is
delegated to the kernel `cui → territory` resolver (proposed
`IdentityRepo.territoryForCui`, a §13.0 cross-module gap), so the identity/territory
hubs stay authoritative. Until that resolver ships, the territory-dependent repo
paths are capability-gated (§7.1/§13.0).

```ts
export interface PrimariiFilters { /* the compiled FilterInput from §7 specs */ }

export interface PrimariiRepository {
  // ── current registry (primary surface) ──────────────────────────────────
  // current_entity_status_pkey (cui). county_idx for county=; quality_idx for
  // (data_quality_status, result_status). Territory filters delegate to the kernel
  // cui→territory resolver (gated, §13.0); county= uses the local county_idx.
  listEntities(
    f: PrimariiEntityFilters,
    page: OffsetPage, sort: PrimariiEntitySort
  ): Promise<Result<{ rows: PrimariiEntityStatus[]; total: number }, ApiError>>;

  getEntity(cui: string): Promise<Result<PrimariiEntityStatus | null, ApiError>>;

  // entity profile bundle for detail page / entity-360 slice: current status +
  // 3 category statuses + staffing + organigrama + doc counts by category.
  getEntityProfile(cui: string): Promise<Result<PrimariiEntityProfile | null, ApiError>>;

  // ── category / claim detail (per-CUI, indexed by cui) ────────────────────
  // entity_category_statuses PK is (snapshot_id, category); cui_idx is (cui, category, status).
  // getCategoryStatuses scopes to the CURRENT snapshot_id (from current_entity_status) to
  // avoid returning stale-snapshot category rows.
  getCategoryStatuses(cui: string): Promise<Result<PrimariiCategoryStatus[], ApiError>>;   // entity_category_statuses_cui_idx (cui, category, status)
  getStaffing(cui: string): Promise<Result<PrimariiStaffingClaim | null, ApiError>>;        // staffing_claims_cui_idx
  getOrganigrama(cui: string): Promise<Result<PrimariiOrganigramaClaim | null, ApiError>>;  // organigrama_claims_cui_idx
  listSalaryClaims(
    cui: string, page: OffsetPage
  ): Promise<Result<{ rows: PrimariiSalaryClaim[]; total: number }, ApiError>>;             // salary_amount_claims_cui_amount_idx

  // ── document inventory ───────────────────────────────────────────────────
  // documents_cui_category_idx (cui, category). Cross-entity list MUST be filtered
  // (cui or category) — no unbounded scan.
  listDocuments(
    f: PrimariiDocumentFilters, page: OffsetPage, sort: PrimariiDocumentSort
  ): Promise<Result<{ rows: PrimariiDocument[]; total: number }, ApiError>>;

  // ── history ────────────────────────────────────────────────────────────
  // entity_snapshots_cui_loaded_idx (cui, loaded_at desc)
  listSnapshots(cui: string, page: OffsetPage): Promise<Result<{ rows: PrimariiSnapshot[]; total: number }, ApiError>>;

  // ── aggregates (analytics) ───────────────────────────────────────────────
  // GROUP BY county | data_quality_status | result_status | entity_type.
  // 'region' grouping requires the kernel cui→territory resolver (§13 gap) — gated.
  aggregateStatus(
    groupBy: 'county'|'region'|'data_quality_status'|'result_status'|'entity_type',
    f: PrimariiEntityFilters
  ): Promise<Result<PrimariiStatusBucket[], ApiError>>;   // PrimariiStatusBucket = { key, total, withEvidence?: number }

  aggregateCategoryCoverage(
    f: PrimariiEntityFilters
  ): Promise<Result<PrimariiCategoryCoverage[], ApiError>>;  // per category: found/not_found/unknown/blocked counts + coverage

  // ── ops / QA ─────────────────────────────────────────────────────────────
  listLoadIssues(
    f: { cui?: string; severity?: 'info'|'warning'|'error'; issueCode?: string },
    page: OffsetPage
  ): Promise<Result<{ rows: PrimariiLoadIssue[]; total: number }, ApiError>>;  // load_issues_cui_severity_idx / load_issues_code_idx

  // ── deferred (return [] until loader populates; no API break when it does) ─
  getRegistryLinks(cui: string): Promise<Result<PrimariiRegistryLink[], ApiError>>;  // entity_registry_links (0 rows today)

  // ── contributor support (§4) ──────────────────────────────────────────────
  presenceFor(cui: string): Promise<Result<{ present: boolean; status?: string; dataQuality?: string } | null, ApiError>>;
}
```

**Index/scan notes** (all indexes verified live, §1):

- Every per-CUI method is point/range-indexed on `cui`. No method scans
  cross-entity without a bound: `listEntities` is bounded by an indexed predicate
  (`county` or `(data_quality_status, result_status)`) or a small full-table scan
  (3,187 rows — cheap, but capped at `pageSize ≤ 100` with offset+exact `total`).
- `listDocuments` REQUIRES at least one of `cui` / `category` (both indexed via
  `documents_cui_category_idx`); the spec marks them as the driving predicates.
  7,233 rows total — offset pagination with exact `total` is cheap (§14.4).
- Territory (`region`/`siruta`/population) filters add the
  `core.public_entities`/`core.territories` join; these are kernel-cached small
  dimension tables — acceptable for the ≤3,187-row registry. `statement_timeout`
  15s class for the hub-join aggregates.

---

## 4. Usecases

`core/usecases/` (framework-free, over ports, `Result`):

| Usecase | Signature | Notes |
|---------|-----------|-------|
| `listTransparencyEntities` | `(filters, page, sort) → { rows, total }` | the registry browse/list |
| `getEntityTransparencyProfile` | `(cui) → PrimariiEntityProfile \| NotFound` | current status + categories + staffing + organigrama + doc counts; the detail page + entity-360 slice |
| `listEntityDocuments` | `(filters, page, sort) → { rows, total }` | document inventory |
| `listEntitySnapshots` | `(cui, page) → { rows, total }` | research history |
| `listSalaryClaims` | `(cui, page) → { rows, total }` | per-UAT salary disclosures (count-grade, **not** spend) |
| `getTransparencyStats` | `(groupBy, filters) → buckets` | county/region/status/type rollups for client dashboards + MCP |
| `getCategoryCoverage` | `(filters) → per-category coverage` | "which UATs publish organigrame?" — answers catalog-style coverage Qs |
| `listLoadIssues` | `(filters, page) → { rows, total }` | ops/QA surface |
| `resolveFilters` | `(dim, q) → candidates` | name→value (county, entity name→CUI, status enums) — wraps kernel discovery (§7.4) |

**Cross-source contributor (§4.4/§14.7).** Registered as a `SourceContributor`
with `source: 'primarii_transparency'`. Both methods return the **kernel**
`SourcePresence` / `EntityProfileSlice` types (§4.4) — the transparency-specific
fields ride in the kernel slice's generic payload (`attrs`/`data`), they are NOT a
bespoke return shape (this is what lets the registry iterate uniformly):

```ts
presenceFor(cui): Result<SourcePresence | null>
  // SourcePresence { source:'primarii_transparency', present, label:'Transparency QA',
  //                  attrs: { dataQualityStatus, resultStatus } }
profileSlice(cui): Result<EntityProfileSlice | null>
  // EntityProfileSlice { source:'primarii_transparency', kind:'transparency',
  //                      data: { dataQualityStatus, resultStatus, evidenceCoverage,
  //                              categories:[{category,status}], documentCount } }
```

> **Cross-module note:** if the kernel `EntityProfileSlice` does not yet carry a
> generic `data`/`attrs` slot, that is a kernel addition to flag in the consistency
> pass (§13). The point of §14.7 is the *registry uniformity*; this module must not
> widen the kernel type unilaterally.

`profileSlice` is the **same** `getEntityTransparencyProfile`-derived slice the REST
entity-360 and the GraphQL `Entity.primariiTransparency` field call (§14.7 — single
source of truth). It contributes to **XS-1 / XS-3 / XS-5** (the institution-360 and
region questions in the catalog) as the *governance/transparency* dimension.

- **`flow_type`:** **NONE.** This module registers no `flows.money_flows` rows and
  contributes nothing to the unified flow summary. The salary `amount_ron` is a
  self-reported disclosure claim, NOT a payment — the contributor explicitly does
  **not** report a spend total (Grain Gate, §14.6).
- **`doc_type`:** **`primarii_transparency_entity`** (see §9) — one search doc per
  UAT transparency profile (entity-level, not per-document), so global search /
  entity-360 can find "primaria X transparency status".

---

## 5. REST endpoints

Prefix `/api/v1/primarii-transparency/`. All routes `config: { public: true }`
(§14.11 — explicit per-route flag, not prefix bypass). TypeBox schemas for every
query/param; `Static<typeof Schema>` is the handler input. Every read carries the
domain freshness watermark (§10) in `meta`. Each route contributes an OpenAPI
fragment merged at `/api/v1/openapi.json`.

| Method | Path | Query / params | Response | Pagination | Cache TTL | `statement_timeout` |
|--------|------|----------------|----------|-----------|-----------|---------------------|
| GET | `/entities` | `PrimariiEntityFilter` (§7) + `page,pageSize,sort` | `PrimariiEntityStatus[]` | offset + exact `total` | 10 min | 5s |
| GET | `/entities/:cui` | path `cui` (`^[0-9]+$`) | `PrimariiEntityProfile` (status + categories + staffing + organigrama + doc counts) | — | 10 min | 5s |
| GET | `/entities/:cui/documents` | `category?`, `documentType?`, `page,pageSize,sort` | `PrimariiDocument[]` | offset + total | 10 min | 5s |
| GET | `/entities/:cui/salary-claims` | `page,pageSize` | `PrimariiSalaryClaim[]` | offset + total | 10 min | 5s |
| GET | `/entities/:cui/snapshots` | `page,pageSize` | `PrimariiSnapshot[]` | offset + total | 10 min | 5s |
| GET | `/documents` | `PrimariiDocumentFilter` (**requires** `cui` or `category`) + page/sort | `PrimariiDocument[]` | offset + total | 10 min | 5s |
| GET | `/aggregate` | `groupBy=county\|region\|data_quality_status\|result_status\|entity_type` + `PrimariiEntityFilter` (`region` gated, §13) | `PrimariiStatusBucket[]` + `coverage` | none (bounded) | 15 min | 15s |
| GET | `/category-coverage` | `PrimariiEntityFilter` | `PrimariiCategoryCoverage[]` (+coverage caveats) | none | 15 min | 15s |
| GET | `/load-issues` | `cui?`, `severity?`, `issueCode?` + page | `PrimariiLoadIssue[]` | offset + total | 5 min | 5s |
| GET | `/filters/resolve` | `dim=county\|entity\|status`, `q` | `{ value, label, score }[]` | none | 10 min | 5s |

- Envelope per §5.2 (`{ ok, data, meta }`) + `requestId` (§14.11). 404
  (`NotFound`) for unknown `:cui`.
- **No `/entities/:cui/flows`** here — that is the kernel cross-source route
  (`/api/v1/entities/:cui/flows`); this module contributes no flows (§4).
- `total` is exact everywhere (all collections are small — ≤3,187 entities, 7,233
  documents — so the filtered `COUNT(*)` is cheap even on un-indexed predicates →
  §14.4 offset guard satisfied; no estimated counts needed).

OpenAPI notes: tag `primarii-transparency`; `data_quality_status` and
`result_status` documented as closed enums with the live distribution as
`description` examples.

---

## 6. GraphQL

Schema-stitched in-process (§6.2). All types `Primarii*` PascalCase (§14.8).
Module contributes `typeDefs` + resolvers extending root `Query`, plus the
`Entity` extension.

```graphql
enum PrimariiDataQuality { HIGH MEDIUM LOW MISSING REVIEW_NEEDED }
enum PrimariiResultStatus { PARTIAL COMPLETE BLOCKED MISSING_RESULT NOT_FOUND ERROR }
enum PrimariiCategory { ORGANIGRAMA NUMAR_ANGAJATI SALARII }
enum PrimariiCategoryState { FOUND NOT_FOUND UNKNOWN BLOCKED }
enum PrimariiEntityType { ADMIN_COMMUNE_HALL ADMIN_TOWN_HALL ADMIN_MUNICIPALITY ADMIN_SECTOR_HALL PRIMARIE }
enum PrimariiEntitySortKey { DATA_QUALITY CONFIDENCE EVIDENCE_COVERAGE ISSUE_COUNT ENTITY_NAME UPDATED_AT }

type PrimariiEntityStatus {
  cui: CUI!
  entityName: String!
  entityType: PrimariiEntityType        # closed 5-value set (matches §12 enum test)
  county: String
  websiteUrl: String
  resultStatus: PrimariiResultStatus!
  dataQualityStatus: PrimariiDataQuality!
  confidence: Float
  evidenceCoverage: Float
  missingRequiredCategories: [String!]!
  issueCount: Int!
  updatedAt: DateTime!
  # canonical territory resolved lazily via the kernel cui→territory resolver (DataLoader on CUI).
  # ⚠ that resolver does not exist in the contract yet (§13 cross-module gap); until it ships this
  # field returns null. Null is also returned where the CUI→public_entities→territory path is incomplete.
  territory: Territory
}

type PrimariiCategoryStatus { category: PrimariiCategory!  status: PrimariiCategoryState!  evidenceCount: Int!  missingEvidenceCount: Int! }
type PrimariiStaffingClaim { totalPositions: Int  occupiedPositions: Int  vacantPositions: Int  asOfDate: String  confidence: Float }
type PrimariiOrganigramaClaim { status: PrimariiCategoryState!  effectiveDate: String  summary: String  confidence: Float }
type PrimariiSalaryClaim { salaryAmountClaimId: BigInt!  amountRon: Money!  roleTitle: String  periodStart: Date  periodEnd: Date  confidence: Float }
type PrimariiDocument { documentPk: BigInt!  cui: CUI!  category: String  documentType: String  title: String  sourceUrl: String  contentSha256: String  contentBytes: BigInt  publishedDate: String  effectiveDate: String }
type PrimariiLoadIssue { severity: String!  issueCode: String!  cui: CUI  message: String!  createdAt: DateTime! }

type PrimariiEntityProfile {
  status: PrimariiEntityStatus!
  categories: [PrimariiCategoryStatus!]!
  staffing: PrimariiStaffingClaim       # nullable: 3,109 staffing rows < 3,187 entities
  organigrama: PrimariiOrganigramaClaim # nullable: 3,109 organigrama rows < 3,187 entities → returns null (whole object), never a partial
  documentCounts: [PrimariiCategoryCount!]!
}
type PrimariiCategoryCount { category: String!  count: Int! }
type PrimariiStatusBucket { key: String!  total: Int!  withEvidence: Int }
type PrimariiCategoryCoverage { category: PrimariiCategory!  found: Int!  notFound: Int!  unknown: Int!  blocked: Int!  coverage: Float! }

# Relay connections (same cursor encoder as REST, §14.3)
type PrimariiEntityConnection { edges: [PrimariiEntityEdge!]!  pageInfo: PageInfo!  totalCount: Int! }
type PrimariiEntityEdge { node: PrimariiEntityStatus!  cursor: String! }

extend type Query {
  primariiEntities(filter: PrimariiEntityFilter, first: Int, after: String, sort: PrimariiEntitySortKey): PrimariiEntityConnection!
  primariiEntity(cui: CUI!): PrimariiEntityProfile
  primariiDocuments(filter: PrimariiDocumentFilter!, first: Int, after: String): PrimariiDocumentConnection!
  primariiStats(groupBy: PrimariiStatGroupBy!, filter: PrimariiEntityFilter): [PrimariiStatusBucket!]!
  primariiCategoryCoverage(filter: PrimariiEntityFilter): [PrimariiCategoryCoverage!]!
}

# Entity join (§6.2) — resolved via the SAME contributor.profileSlice usecase (§14.7),
# DataLoader keyed by CUI.
extend type Entity {
  primariiTransparency: PrimariiEntityProfile
}
```

- Resolvers are thin: parse args → call the matching core usecase (no logic in
  resolvers). `Entity.primariiTransparency` uses a CUI-keyed DataLoader that calls
  `contributor.profileSlice` (prevents N+1 on entity fan-out).
- `Money` scalar for `amountRon` (string, precision-safe) — but the field is
  documented as a **self-reported disclosure claim, not verified spend**.
- Errors mapped to `extensions.code = ApiError.type`. Connection cursor `fhash`
  matches REST (§14.3).

---

## 7. Filters — collection specs (priority area)

Two filterable collections, each declared once as a `CollectionFilterSpec` (§14.2)
from which the kernel derives the REST TypeBox schema, the GraphQL `input`, and the
MCP input fragment — so the three surfaces never drift. `canonicalizeFilters`
output feeds the cache key + cursor `fhash` + tri-surface equivalence test.

### 7.1 `primarii_entities` spec (the registry — the high-value surface)

| Field | Type | Ops | Driving column / index | REST param | GraphQL input | MCP |
|-------|------|-----|------------------------|-----------|---------------|-----|
| `cui` | string[] | `in` | `current_entity_status.cui` (pk) | `cui` (CSV) | `cui: [CUI!]` | discovery: entity name→CUI |
| `dataQualityStatus` | enum[] | `in` | `data_quality_status` (`quality_idx`) | `dataQualityStatus` | `[PrimariiDataQuality!]` | enum |
| `resultStatus` | enum[] | `in` | `result_status` (`quality_idx` 2nd col) | `resultStatus` | `[PrimariiResultStatus!]` | enum |
| `entityType` | enum[] | `in` | `entity_type` (no index — 5-value scan, cheap) | `entityType` | `[PrimariiEntityType!]` | enum (5 values) |
| `county` | string[] | `in` | `current_entity_status.county` (`county_idx`) — **denormalized text, best-effort** | `county` (CSV) | `[String!]` | discovery: county name→name |
| `region` | string[] | `in` | **hub** (gated, §13): `core.territories.region` via CUI resolver | `region` | `[String!]` | discovery |
| `siruta` | string[] | `in` | **hub** (gated, §13): `core.territories.siruta_code`/`territorial_siruta_code` via CUI resolver | `siruta` (CSV) | `[SIRUTA!]` | discovery: locality→SIRUTA |
| `isUat` | bool | `eq` | **hub** (gated, §13): `core.public_entities.is_uat` | `isUat` | `Boolean` | — |
| `minPopulation`/`maxPopulation` | int | `gte`/`lte` | **hub** (gated, §13): `core.territories.population` | `minPopulation`/`maxPopulation` | `population: {from,to}` | — |
| `minConfidence` | number | `gte` | `confidence` (no index — scan, cheap) | `minConfidence` | `Float` | — |
| `minEvidenceCoverage` | number | `gte` | `evidence_coverage` (no index — scan, cheap) | `minEvidenceCoverage` | `Float` | — |
| `hasIssues` | bool | `eq` | `issue_count > 0` (no index — scan, cheap) | `hasIssues` | `Boolean` | — |
| `missingCategory` | enum[] | `in` (array overlap) | `missing_required_categories` (text[] `&&`, **no index — scan**) | `missingCategory` | `[PrimariiCategory!]` | enum |
| `publishesCategory` (join) | enum + state | `eq` | `entity_category_statuses (category,status)` semijoin on **current** `(cui, snapshot_id)` (`cui_idx (cui,category,status)`) | `publishesCategory=salarii` (+ `categoryState=found`) | nested input | enum — answers "UATs that publish salarii" |
| `q` | string | `contains` | **text engine: Meili** (entity-name autocomplete) → CUIs; PG `entity_name ILIKE` fallback when Meili down (§14.5) | `q` | `String` | discovery |
| `exclude` | nested | — | symmetric on `dataQualityStatus`,`resultStatus`,`county`,`region`,`entityType` (fields marked `exclude:true`) | `exclude.x` | `exclude: PrimariiEntityFilter` | — |

- **Sort:** default `dataQualityStatus` asc then `issueCount` desc (worst-first for
  review workflows is opt-in; default surfaces best-known first). Allowed:
  `DATA_QUALITY, CONFIDENCE, EVIDENCE_COVERAGE, ISSUE_COUNT, ENTITY_NAME, UPDATED_AT`.
- **`isNull` is available** on `confidence`/`evidence_coverage` (catalog
  presence/coverage Qs, §14.2 mandatory).
- **The two category mechanisms answer different questions — `missingCategory` is
  authoritative for "missing".** `missingCategory` filters
  `current_entity_status.missing_required_categories` (the loader's verdict on
  *required-but-absent* categories) — this is the source of truth for coverage
  gaps. `publishesCategory` semijoins `entity_category_statuses` for the
  raw per-category *evidence state* (`found`/`not_found`/`unknown`/`blocked`),
  scoped to the **current snapshot** (`AND ecs.snapshot_id = ces.snapshot_id`) so it
  never matches stale snapshots. A category can be `not_found` yet absent from
  `missing_required_categories` (it was not *required*); when both are supplied the
  filters AND together, never silently reconcile.
- **All filters are on the 3,187-row `current_entity_status`** (county/quality
  indexed; the rest are cheap scans on a small table — stated honestly, not all
  index seeks).
- **Geographic filters beyond `county` are capability-gated** (§4.2/§13): until the
  kernel `cui→territory` resolver exists, `region`/`siruta`/`isUat`/population
  return `InvalidInput` "geographic resolution unavailable" rather than dropping
  the predicate; they carry a `coverage` caveat once live.

### 7.2 `primarii_documents` spec

| Field | Type | Ops | Driving column / index | Notes |
|-------|------|-----|------------------------|-------|
| `cui` | string[] | `in` | `documents.cui` (`cui_category_idx` leading col → index seek) | one of cui/category **required** |
| `category` | enum[] | `in` | `documents.category` (2nd col of `cui_category_idx`) | **category-alone is NOT an index seek** (leading col is `cui`) → small scan of 7,233 rows, acceptable |
| `documentType` | string[] | `in` | `documents.document_type` (no index — scan) | |
| `hasContent` | bool | `eq`/`isNull` | `content_sha256 IS NOT NULL` (no index — scan) | "evidence actually stored" |
| `q` | string | `contains` | **PG `title ILIKE` un-indexed scan** — no `pg_trgm` index exists on `documents.title`, NOT a Meili index | text engine = plain Postgres `ILIKE` over 7,233 rows (cheap); declared, not trigram |

Sort: default `cui` then `category`. No date sort (`published_date`/`effective_date`
are unparsed `text` — declared non-sortable, non-rangeable).

### 7.3 Golden question → filter examples (from the catalog)

These map the catalog's territory/coverage intent to this source (it has no
procurement/legal IDs; its catalog contribution is the **governance/coverage**
dimension of XS-1/3/5):

| Question | Filter |
|----------|--------|
| "Which UATs in Cluj county fully publish their transparency data?" | `county=[Cluj] & dataQualityStatus=[high] & resultStatus=[complete]` |
| "Commune halls missing salary disclosures" | `entityType=[admin_commune_hall] & missingCategory=[salarii]` |
| "Transparency coverage by county" | `GET /aggregate?groupBy=county` (+ `coverage`) |
| "UATs flagged for review with evidence problems" | `dataQualityStatus=[review_needed] & hasIssues=true` |
| "Does primaria X (CUI 4426318) publish its organigrama?" | discovery name→CUI → `getEntityProfile` → category `organigrama` status |
| "Transparency coverage in region Nord-Vest for towns over 20k people" | `region=[Nord-Vest] & entityType=[admin_town_hall] & minPopulation=20000` (hub join + coverage caveat) |

### 7.4 Discovery / resolve dimensions

`/filters/resolve?dim=&q=` (+ MCP discovery tool) exposes:
`entity` (entity name → CUI, via Meili `primarii_transparency_entities` index +
`core.organizations` name search), `county` (county name normalize),
`status` (Romanian label → enum, e.g. "transparent/complet" → `complete`).
SIRUTA/locality resolution delegates to the shared kernel territory resolver.

---

## 8. MCP tools

`shell/mcp/`. TypeBox input+output; handler calls a core usecase; output is
`{ ok, kind, query, link, item|items, summary?, coverage?, caveats? }` (§6.3 + the
catalog Core Rule fields). Rate-limited; bounded result sizes; raw/excerpt columns
never returned.

**(1) Discovery — `resolve_primarii_filters`** (the shared §7.4 tool, parameterized):
- input: `{ dim: 'entity'|'county'|'status'|'siruta', q: string, limit?: number }`
- output: `{ ok, kind:'filter_values', items: [{ value, label, score }], link }`
- usecase: `resolveFilters`. `link` → client filter deep link.

**(2) Query — `get_primarii_entity_transparency`** (snapshot):
- input: `{ cui: string }`
- output: `{ ok, kind:'entity_transparency', item: PrimariiEntityProfile, link, summary }`
- usecase: `getEntityTransparencyProfile`.
- summary template: *"{entityName} ({county}) — transparency {dataQualityStatus},
  result {resultStatus}; publishes {found categories}/3 required categories
  (organigrama/headcount/salaries), {documentCount} evidence documents."*

**(3) Query — `list_primarii_entities`** (filtered list / coverage ranking):
- input: the `primarii_entities` filter fragment + `limit`, `sort`
- output: `{ ok, kind:'entity_list', items:[...], denominator, coverage, link, summary }`
- usecase: `listTransparencyEntities`. Returns `denominator` (rows before filter)
  and per-dimension `coverage` per the catalog Core Rule.

**(4) Query — `aggregate_primarii_transparency`** (coverage/dashboards):
- input: `{ groupBy, filter? }`
- output: `{ ok, kind:'aggregate', items: buckets, denominator, coverage, caveats, link }`
- usecase: `getTransparencyStats` / `getCategoryCoverage`. Geographic groupings
  attach the territory-coverage caveat (CUI→hub path < 100%).

`link` deep-link format: `/transparency/uat/{cui}` (detail),
`/transparency?county={county}&quality={status}` (filtered list).

---

## 9. Search integration

- **`doc_type` owned:** `primarii_transparency_entity` — **one search document per
  UAT transparency profile** (entity-grain, not per-evidence-document). This makes
  a UAT discoverable by name/county and surfaces its transparency status in global
  search + entity-360. Per-document (`documents`) rows are **not** individually
  indexed (low retrieval value; they are evidence artifacts, not searchable
  content).
- **Projection into `search.documents`** (written by the scrapper `search` lane;
  the server only reads):
  - `doc_id` = `primarii_transparency_entity:{cui}`
  - `title` = `entity_name` (+ `entity_type`)
  - `body` = synthesized: county + data_quality_status + result_status + which
    categories are published/missing (a short Romanian sentence for full-text)
  - `cuis` = `[cui]`
  - `county_name` = `county`
  - `doc_date` = `updated_at::date`; `amount_ron` = **NULL** (no money)
  - `url` = client deep link `/transparency/uat/{cui}`
  - `attrs` = `{ dataQualityStatus, resultStatus, missingRequiredCategories, evidenceCoverage }`
- **Indices:** Meili index `primarii_transparency_entities` (instant entity-name /
  county autocomplete — backs the `q` filter + discovery); OpenSearch index
  `primarii_transparency` (full-text body + terms aggregation on
  `attrs.dataQualityStatus` / `county_name` for relevance + facet counts).
- **Semantic gating (§14.5):** no embeddings planned for v1 (entity-name search is
  the right tool; transparency profiles are short structured records, not prose).
  `search.documents.embedded_at` stays null for this `doc_type`; semantic fields
  degrade to `null` + caveat, never error. This is a deliberate non-dependency.
- **Fallback:** when Meili/OS are down, `q` falls back to PG
  `current_entity_status.entity_name ILIKE` (capability gate, §14.5).

---

## 10. Sync / freshness impact on serving

- **Loader cadence:** this is a **periodic full-rebuild** lane (NOTES: prod load
  truncates+repopulates inside one transaction; `current_entity_status` is the
  derived current view over `entity_snapshots`). Cadence is research-driven
  (re-research of UATs), not high-frequency — expect **weekly-to-monthly**
  refreshes, not intraday.
- **Cache TTLs** (§5) of 10–15 min are safe: the serving data only changes on a
  loader run, never on the request path.
- **"As-of" semantics:** every read surfaces the domain freshness watermark from
  the loader-completion stamp (`etl`/`system_control`, §14.11). If no stamp exists
  for this domain yet, **interim is TTL-only** — stated explicitly here; the
  fallback "as-of" is `max(current_entity_status.updated_at)` exposed in `meta`.
- **Mutability:** records are **mutable, not append-only** — a UAT's status and
  category claims change as it is re-researched. The current view (`current_entity_status`)
  always reflects the latest snapshot; history is preserved in `entity_snapshots`
  (queryable via `/entities/:cui/snapshots`). No per-row change feed is exposed;
  freshness is whole-domain.

---

## 11. Wiring

```ts
export interface PrimariiModuleDeps {
  db: Kysely<ProdDatabase>;            // typed over primarii_transparency.* + core.* (read-only)
  identityRepo: IdentityRepo;          // kernel — CUI resolution
  territoryRepo: TerritoryRepo;        // kernel — county/SIRUTA/region/population; needs cui→territory resolver (§13.0)
  searchClients: { meili?: MeiliClient; opensearch?: OpenSearchClient };  // capability-gated (§14.5)
  cache: CacheMiddleware;
  searchCaps: SearchCapabilities;
}
export function makePrimariiTransparencyModule(deps: PrimariiModuleDeps): {
  restPlugin: FastifyPluginAsync;
  graphql: { typeDefs: string; resolvers: IResolvers };
  mcpTools: McpTool[];
  contributor: SourceContributor;      // source:'primarii_transparency'
  repos: { primarii: PrimariiRepository };
};
```

- **Env additions:** none beyond kernel-owned (`PROD_DATABASE_URL`, `MEILI_*`,
  `OPENSEARCH_URL`). No synthetic/embedding env needed (no semantic v1).
- **`build-app.ts`:** construct after kernel; register REST plugin under
  `/api/v1/primarii-transparency`, merge GraphQL slice into root schema, register
  the 4 MCP tools, register the contributor into the kernel registry. Order-independent.
- **Legacy superseded:** none directly — this domain did not exist in the old
  monolithic `unified` module (it is a new prod source). The kernel territory hub
  it leans on supersedes the old per-module UAT lookups.

---

## 12. Testing

- **Unit** (`tests/unit/primarii-transparency/`): usecases over mocked ports;
  `primarii_entities` + `primarii_documents` filter-spec → SQL compilation snapshot
  tests (incl. the **current-snapshot-scoped** `publishesCategory` semijoin
  (`AND ecs.snapshot_id = ces.snapshot_id`) and the `missing_required_categories`
  `&&` array-overlap); enum validation (5 dataQuality / 6 resultStatus / 5
  entityType / 3 category values — assert closed sets match live distributions);
  cursor encode/decode + `fhash`; `contributor.profileSlice` returns the kernel
  `EntityProfileSlice` shape (not a bespoke object).
- **Integration** (`tests/integration/primarii-transparency/`): REST + GraphQL +
  MCP against a seeded fixture schema; **tri-surface equivalence** — equivalent
  filters return identical rows across REST `/entities`, GraphQL `primariiEntities`,
  and MCP `list_primarii_entities` (driven by `canonicalizeFilters`). Assert
  raw/excerpt columns never appear in any surface (`local_path`, `raw_*`,
  `source_excerpt`). Assert `getRegistryLinks` returns `[]` without error
  (DDL-only). Assert geographic aggregate carries a `coverage` field. Assert
  `region`/`siruta` filters return `InvalidInput` while the kernel resolver is
  absent (capability gate, §13.0) — and resolve correctly once it is mocked present.
- **Golden filters:** the §7.3 table shipped as integration cases (county+quality,
  missing-category via `missingCategory`, coverage-by-county, region+population via
  the gated resolver).

---

## 13. Open questions / risks

0. **BINDING cross-module need — kernel `cui → territory` resolver.** The
   contract's `TerritoryRepo` (§4.2) is SIRUTA-keyed only and has no
   `cui → territory` method; `core.public_entities` lives in the *identity* hub.
   Every geographic filter beyond the denormalized `county` text
   (`region`/`siruta`/`isUat`/population) and the `Entity.territory` /
   `PrimariiEntityStatus.territory` fields depend on a resolver the contract does
   **not** ship. **Ask for the consistency pass:** add
   `IdentityRepo.territoryForCui(cui)` (or a kernel territory-filter builder) that
   joins `core.public_entities.cui → territorial_siruta_code → core.territories`.
   The join is **fully index-backed** — verified live 2026-06-16:
   `public_entities_pkey (cui)` unique + `public_entities_territorial_siruta_code_idx`,
   `territories_territorial_siruta_code_key` unique — so it is two index seeks per
   row, not a scan (this closes the earlier index-verification risk). Until the
   kernel resolver exists, those filters/fields are **capability-gated** (return
   `InvalidInput` / `null`), not silently dropped. This module does **not** add a
   private `core.public_entities` join (§3 forbids it).
1. **Territory linkage coverage is unmeasured.** Even with the resolver, the
   **match rate of these 3,187 UAT CUIs against `core.public_entities`** is not yet
   measured. If high (these are UATs → likely strong), the `county`-text filter can
   be deprecated in favor of SIRUTA. **Action:** scrapper should measure and record
   it in NOTES; the API surfaces it as a `coverage` caveat until then.
2. **`entity_registry_links` (DDL-only) is the intended canonical linker.** Until
   the loader populates it, identity/territory linkage is computed live. Decision
   needed: is the live CUI join sufficient long-term, or should the loader
   materialize `entity_registry_links` (and feed `registry='public_entities'` +
   confidence)? The API is built to absorb either.
3. **Overlap with `primarii-wikipedia` (separate raw slice).** `entity_snapshots`
   carries `wikipedia_url`, and there is a separate `primarii_wikipedia` raw schema
   (3,187 canonical links) that is **not** in `transparenta_prod` and has **no
   server module assigned** in this 12-plan set. Decision: should the Wikipedia
   link registry be promoted to a prod schema + folded into this module's entity
   profile (`websiteUrl`/`wikipediaUrl` enrichment), or stay raw-only? Flagged for
   the consistency pass. *(Cross-module: potential `primarii_wikipedia` prod slice.)*
4. **`salary_amount_claims` mislabeling risk.** `amount_ron` is a self-reported
   disclosure claim, not a payment. The contributor explicitly excludes it from any
   spend total (Grain Gate). Risk: a client/agent treats it as spend — mitigated by
   the `Money` field's documentation and the contributor reporting **no** flow_type.
5. **`county` text quality.** 43 distinct values; diacritics/spelling not
   guaranteed canonical. The `county=` filter is best-effort; SIRUTA via hub is the
   reliable path. Low risk (small closed set) but documented.
6. **No date filtering.** `published_date`/`effective_date`/`as_of_date` are
   unparsed `text` in the schema; the plan deliberately does **not** offer date
   ranges on them (only `salary_amount_claims.period_start/end` are real `date`).
   Acceptable for v1; revisit if the loader normalizes these to `date`.
```
