# 07 — PNRR module (Recovery & Resilience Plan)

> **Conforms to** `00-foundation-shared-kernel.md` (binding). PNRR is the most
> complete prior-art slice — the full vertical (model + loader + reconciliation +
> flows + search + a thin REST/MCP/client surface) is already done in the OLD
> `unified` module on `feat/unified-explorer`. This plan **redesigns that surface
> onto the shared kernel** and substantially widens it: typed Kysely repo over the
> live `pnrr.*` schema, full filter specs for every collection, REST+GraphQL+MCP
> parity, the cross-source contributor, and the grain-gated flow contract (§14.6).
> Scalars per §14.1 (`Money` = string, `org_id`/`BigInt` = string), namespacing
> `Pnrr*` (§14.8), PII excluded (§8.2/§14.9-style structural exclusion).
>
> **Module path:** `src/modules/pnrr/`. **Supersedes:**
> `modules/unified/shell/repo/pnrr-source-repo.ts`,
> `modules/unified/shell/rest/sources/routes-pnrr.ts`, and the MCP
> `get_pnrr_entity` tool.

---

## 1. Summary & data status

PNRR is **live and proven** in `transparenta_prod` (scrapper `PNRR_NOTES.md`
Phase E/F/G, 2026-06-16): migration applied, loader green at exact raw counts,
reconciliation done, flows + search derived, two-tier gate green, zero-drift
convergence, search indices live. The server is **read-only** over this state.

**Schema:** `pnrr` (16 tables) + shared kernel schemas (`core`, `flows`,
`search`). Source snapshot: `_prod-schema/pnrr.tsv`. Migrations:
`scrapper/src/src/db/prod-migrations/20260616T200000__pnrr_domain.ts`,
`…/20260616T201000__search_documents_pnrr.ts`.

**Tables & measured row counts** (from `PNRR_NOTES.md` Phase E, exact-count gate):

| Group       | Table                                | Rows                       | Role in module                                      |
| ----------- | ------------------------------------ | -------------------------- | --------------------------------------------------- |
| Dimensions  | `pnrr.components`                    | 16 (C1–C16)                | program structure; filter resolve                   |
|             | `pnrr.measures`                      | 103 (`fenix_reference`)    | investment/reform taxonomy; filter resolve          |
|             | `pnrr.measure_aliases`               | 138                        | payment free-text → fenix (internal; not a surface) |
| Identity    | `pnrr.entities`                      | 18,876                     | reconciled CUI spine — the headline collection      |
|             | `pnrr.entity_registry_links`         | 17,442 (92.4% of entities) | hub membership (public_entities / companies)        |
| Ledger      | `pnrr.payments`                      | 73,333                     | source-native cash facts (the grain)                |
|             | `pnrr.commitments`                   | 24,967                     | obligation facts (progress)                         |
|             | `pnrr.commitment_snapshots`          | 741,515                    | MIPE progress time-series                           |
|             | `pnrr.program_indicators`            | 30                         | program KPI timeline                                |
|             | `pnrr.national_projects`             | 98                         | ORDS Fenix register (not flow-wired)                |
| Procurement | `pnrr.announcements`                 | 21,481                     | applications/announcements                          |
|             | `pnrr.announcement_contacts_private` | 21,481                     | **RESTRICTED PII — never surfaced**                 |
|             | `pnrr.lots`                          | 23,742                     | announcement lots                                   |
|             | `pnrr.documents`                     | 46,046                     | doc metadata (files not migrated)                   |
|             | `pnrr.acquisitions`                  | 15,446                     | awarded contracts                                   |
|             | `pnrr.contractors`                   | 15,773                     | winner/subcontractor graph (role-graded)            |

**Derived (shared, owned by kernel — module reads, does not write):**
`flows.money_flows` source_id=`pnrr` = **112,207** rows across `flow_type ∈
{pnrr_payment 73,333, pnrr_commitment 24,078, pnrr_subcontract 14,796}`. Flow
counts are < their table counts by design: commitments 24,078 < 24,967 (889 have
no derivable flow — null/zero value or null CUI, the same 96.4% CUI-validity
residual from the gate); subcontract 14,796 < 15,446 acquisitions (214 self-awards
excluded + acquisitions with no resolvable winning_bidder). These gaps are the
counting invariant working, not data loss. `search.documents` totals **71,679**
PII-free docs across doc_type ∈ `{pnrr_entity, pnrr_announcement, pnrr_acquisition,
pnrr_contractor, pnrr_measure}` (the legacy `pnrr_project`/`pnrr_payment` types are
read-compatible subsets of this total, not added on top), live in Meili+OpenSearch
index `unified_pnrr`.

**Deferred (documented in NOTES, not modeled in serving v1):** locality SIRUTA on
ledger facts (county SIRUTA is 100%/99.3%); per-payment search docs (would flood);
`transparency_projects`/`transparency_budgets`/CKAN file lanes; `person`/timeline
MIPE kinds. The module surfaces what's modeled; it must **not** assume the deferred
columns exist.

**Currency invariant (measured):** `pnrr.payments` carry BOTH `amount_lei` AND
`amount_eur` (100%, period-official rate — stored, not recomputed). Every other
fact is RON-only (`amount_eur` NULL in flows). The module never recomputes EUR.

---

## 2. Schema → domain model

Module domain types in `src/modules/pnrr/core/types.ts`. All money is `string`
(§14.1), all dates `YYYY-MM-DD` strings, `org_id` never appears (the cross-source
key is CUI). Row → view-model mapping (camelCase view model ← snake_case column):

### 2.1 Identity spine (headline)

```ts
// pnrr.entities (+ entity_registry_links aggregated)
export interface PnrrEntity {
  readonly cui: string; // entities.cui (PK, normalized via core.normalize_cui)
  readonly name: string | null; // entities.resolved_name (ANAF>source cache)
  readonly nameSource: string | null; // entities.name_source
  readonly caenCode: string | null; // entities.caen_code (ANAF cache)
  readonly isActive: boolean | null; // entities.is_active (ANAF)
  readonly isVatPayer: boolean | null; // entities.is_vat_payer (ANAF)
  readonly roles: {
    // entities.is_* role flags
    readonly beneficiary: boolean;
    readonly applicant: boolean;
    readonly winner: boolean;
    readonly subcontractor: boolean;
  };
  readonly hubs: readonly ('public_entities' | 'companies')[]; // entity_registry_links.registry
  readonly firstSeenSource: string | null; // entities.first_seen_source
}
```

`PnrrEntity.name`/`caenCode` are a **rebuildable cache** (NOTES decision #2/#5).
The repo MAY (capability-gated) overlay the canonical name from the kernel
`IdentityRepo` when present; default reads the cache (`resolved_name`) to avoid a
join on the hot path. **Link, not merge** — `hubs` is a list because the same CUI
may link to both `public_entities` and `companies` (no flattening).

### 2.2 Ledger facts (the grain — §14.6)

```ts
export interface PnrrPayment {
  // pnrr.payments — source-native cash fact
  readonly paymentKey: string; // payment_key (PK)
  readonly beneficiaryCui: string | null;
  readonly beneficiaryName: string | null;
  readonly componentCode: string | null;
  readonly measureFenix: string | null; // resolved (nullable if alias unmatched)
  readonly measureRaw: string | null;
  readonly amountLei: string | null; // numeric → string; nullable column (100% present in static snapshot, NOT enforced)
  readonly amountEur: string | null; // numeric → string; nullable column (do NOT type Money! — future APPENDed rows may be NULL)
  readonly paymentDate: string | null; // date
  readonly countyName: string | null;
  readonly countySiruta: string | null;
  readonly localityName: string | null; // localitySiruta deferred → omit
  readonly caenDivision: string | null;
  readonly financingSource: string | null;
  readonly source: { system: string; retrievedAt: string | null };
}
export interface PnrrCommitment {
  // pnrr.commitments — obligation fact
  readonly commitmentKey: string;
  readonly beneficiaryCui: string | null;
  readonly beneficiaryName: string | null;
  readonly idAngajament: string | null;
  readonly contractNumber: string | null;
  readonly componentCode: string | null;
  readonly measureCode: string | null; // clean I#/R#
  readonly totalValue: string | null;
  readonly euValue: string | null;
  readonly nationalPublicValue: string | null; // total_value column is nullable

  readonly vatValue: string | null;
  readonly ineligibleValue: string | null;
  readonly financialProgress: number | null;
  readonly physicalProgress: number | null;
  readonly commitmentDate: string | null;
  readonly endDate: string | null;
  readonly status: string;
  readonly countyName: string | null;
  readonly countySiruta: string | null;
}
export interface PnrrCommitmentSnapshot {
  // pnrr.commitment_snapshots — MIPE progress series
  readonly snapshotId: string;
  readonly sourceRecordId: string;
  readonly snapshotDate: string;
  readonly beneficiaryCui: string | null;
  readonly contractNumber: string | null;
  readonly commitmentKey: string | null;
  readonly linkConfidence: number | null; // nullable soft link
  readonly financialProgress: number | null;
  readonly physicalProgress: number | null;
  readonly stage: string | null;
  readonly receivedEur: string | null;
  readonly paidEur: string | null;
  readonly allocatedEur: string | null;
}
```

### 2.3 Procurement graph

```ts
export interface PnrrAnnouncement {
  // pnrr.announcements (PII scrubbed)
  readonly announcementKey: string;
  readonly platformProjectId: string | null;
  readonly applicantCui: string | null;
  readonly applicantName: string | null;
  readonly projectName: string | null;
  readonly callName: string | null;
  readonly componentCode: string | null;
  readonly budgetValue: string | null;
  readonly status: string;
  readonly countySiruta: string | null;
  // is_personal_recipient is INTERNAL (PII gate signal) — NOT projected
}
export interface PnrrAcquisition {
  // pnrr.acquisitions (awarded contract)
  readonly acquisitionKey: string;
  readonly announcementKey: string | null;
  readonly beneficiaryCui: string | null;
  readonly beneficiaryName: string | null; // applicant
  readonly procedureType: string | null;
  readonly signedAt: string | null;
  readonly fullContractValue: string | null;
  readonly currency: string | null; // column has default 'RON' but is nullable → not Money!/String!

  readonly awardCriterion: string | null;
  readonly frameworkAgreement: boolean | null;
  readonly hasAssociationLeader: boolean | null;
  readonly hasThirdPartySupport: boolean | null;
  readonly hasSubcontractor: boolean | null;
}
export interface PnrrContractor {
  // pnrr.contractors (winner/sub graph)
  readonly contractorKey: string;
  readonly acquisitionKey: string | null;
  readonly role: PnrrContractorRole; // winning_bidder | foreign_winning_bidder | subcontractor | association_leader | third_party_support
  readonly contractorCui: string | null; // null for foreign
  readonly contractorName: string | null;
  readonly contractorCountry: string | null;
  readonly contractValue: string | null;
  readonly currency: string | null;
  readonly confidence: string | null;
  readonly validationStatus: string | null;
}
export interface PnrrMeasure {
  // pnrr.measures
  readonly fenixReference: string;
  readonly componentCode: string | null;
  readonly measureType: 'investment' | 'reform' | null;
  readonly measureNumber: number | null;
  readonly measureName: string | null;
}
export interface PnrrComponent {
  readonly componentCode: string;
  readonly componentName: string | null;
  readonly pillar: string | null;
}
```

### 2.4 Identity (CUI) + territory (SIRUTA) linkage

- **CUI** is the cross-source link for every entity/fact (`beneficiary_cui`,
  `applicant_cui`, `contractor_cui`). Resolves through the kernel `IdentityRepo`
  for the `Entity` join; **no FK** to the hubs (link-not-merge). DataLoader key =
  CUI string (§14.1).
- **Territory** denormalized as `county_name` + `county_siruta` (resolved by the
  loader, 100%/99.3%). Canonical territory metadata (population/region) comes from
  the kernel `TerritoryRepo` when a geo filter or geo facet needs it. **Locality
  SIRUTA is NULL by design** — the module exposes `localityName` (string) but no
  locality SIRUTA filter (documented deferral); a county-level geo filter is the
  contract.

### 2.5 PII / excluded columns (hard constraint — §8.2)

**Structurally excluded from every repo row type, REST/GraphQL/MCP projection, and
search doc** (the §14.9 pattern applied to PNRR):

- The entire `pnrr.announcement_contacts_private` table (`contact_first_name`,
  `contact_last_name`, `contact_email`, `contact_phone`) — the row type has no
  such fields; **no repo method selects this table**.
- `pnrr.announcements.is_personal_recipient` and `pnrr.payments.is_personal_recipient`
  are **internal gate signals**, never projected. (They are why per-payment search
  docs are excluded and why announcement `attrs` is PII-scrubbed by the loader.)
- `attrs jsonb` on every table is **not** projected wholesale; the repo selects
  named columns only (defends against future PII landing in `attrs`).
- **Internal columns deliberately omitted from all projections** (not PII but not
  part of the public contract, per §8.2 "enumerate excluded"): `announcements.county_id_raw`
  (platform-internal id, not SIRUTA), every `*_raw`/`status_raw`, and the
  provenance columns `raw_item_id`, `source_record_hash`, `transform_version`,
  `source_table`/`source_pk`/`run_id` (contractors). `source_system`/`retrieved_at`
  ARE surfaced (as a `source` sub-object) for provenance/as-of.

A dedicated test (`pnrr-pii.test.ts`) asserts no surface emits a `contact_*` or
`is_personal_recipient` field, and that `search.documents` for any `pnrr_*`
doc_type contains zero email-like strings (mirrors the loader's search-PII gate).

---

## 3. Repo interface (ports)

`src/modules/pnrr/core/ports.ts` — one `PnrrRepository`, all methods return
`Result<T, ApiError>`. Reads `pnrr.*` only (+ kernel hubs via the kernel repos,
never inline). Money columns cast to text (`::text`) at the SQL boundary so int8
parser config can't precision-lose; counts use planner estimates where flagged.

```ts
export interface PnrrRepository {
  // ── Identity spine (headline) ──
  listEntities(f: PnrrEntityFilter, page: CursorPage): Promise<Result<Conn<PnrrEntity>, ApiError>>;
  getEntity(cui: string): Promise<Result<PnrrEntity | null, ApiError>>;
  getEntityProfile(cui: string): Promise<Result<PnrrEntityProfile | null, ApiError>>; // ledger+commit+procurement rollup (replaces old getEntityProfile, widened)

  // ── Ledger ──
  listPayments(
    f: PnrrPaymentFilter,
    page: CursorPage
  ): Promise<Result<Conn<PnrrPayment>, ApiError>>;
  aggregatePayments(
    f: PnrrPaymentFilter,
    by: PnrrPaymentGroupBy
  ): Promise<Result<readonly PnrrPaymentAggRow[], ApiError>>; // 15s class
  listCommitments(
    f: PnrrCommitmentFilter,
    page: CursorPage
  ): Promise<Result<Conn<PnrrCommitment>, ApiError>>;
  getCommitmentProgress(
    commitmentKey: string
  ): Promise<Result<readonly PnrrCommitmentSnapshot[], ApiError>>; // time-series for one commitment
  listProgramIndicators(): Promise<Result<readonly PnrrProgramIndicator[], ApiError>>; // 30 rows, small

  // ── Procurement graph ──
  listAcquisitions(
    f: PnrrAcquisitionFilter,
    page: CursorPage
  ): Promise<Result<Conn<PnrrAcquisition>, ApiError>>;
  getAcquisition(key: string): Promise<Result<PnrrAcquisitionDetail | null, ApiError>>; // + announcement + lots + contractors
  listContractors(
    f: PnrrContractorFilter,
    page: CursorPage
  ): Promise<Result<Conn<PnrrContractor>, ApiError>>;
  rankContractors(
    f: PnrrContractorFilter,
    by: 'value' | 'awards',
    limit: number
  ): Promise<Result<readonly PnrrContractorRankRow[], ApiError>>; // 15s class

  // ── Taxonomy / dimensions (also feeds filter resolve) ──
  listComponents(): Promise<Result<readonly PnrrComponent[], ApiError>>; // 16 rows
  listMeasures(f: PnrrMeasureFilter): Promise<Result<readonly PnrrMeasure[], ApiError>>; // 103 rows
  resolveDimension(
    dim: PnrrResolveDim,
    q: string,
    limit: number
  ): Promise<Result<readonly ResolveHit[], ApiError>>; // name→value
}
```

`ResolveHit` and `SourcePresence`/`EntityProfileSlice` are **kernel-owned shared
types** (`shared/core/types.ts`), not PNRR types — discovery/resolve is shared
infra (§7.4). `PnrrResolveDim` is the PNRR-local enum (`entity`|`component`|
`measure`|`county`|`contractor`). The GraphQL `resolve` surface is the shared
kernel type (no `Pnrr*` prefix needed); the PNRR-specific aggregate/summary types
referenced in §6 (`PnrrPaymentAggRow`, `PnrrContractorRankRow`, `PnrrPaymentSummary`,
`PnrrCommitmentSummary`, `PnrrProcurementSummary`, `PnrrAcquisitionDetail`) are all
`Pnrr*`-prefixed and defined in the module SDL.

**Index/partition notes** (verified live, `pg_indexes schemaname='pnrr'`):

| Method                                      | Driving index                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listEntities` (q)                          | `entities_pkey` + trigram on `resolved_name` (kernel)                                                                           | name match via kernel `IdentityRepo.searchByName` or `ILIKE` fallback; CUI exact via PK                                                                                                                                                                                                                                                                                                       |
| `listPayments` by CUI                       | `payments_beneficiary_cui_idx`                                                                                                  | the hot path                                                                                                                                                                                                                                                                                                                                                                                  |
| `listPayments` by date                      | `payments_payment_date_idx`                                                                                                     | cursor sort `(payment_date, payment_key)`                                                                                                                                                                                                                                                                                                                                                     |
| `listPayments` by component                 | `payments_component_idx`                                                                                                        |                                                                                                                                                                                                                                                                                                                                                                                               |
| `aggregatePayments`                         | indexed **filter** drives; the GROUP BY itself is a bounded scan                                                                | the per-group key (`component`/`measure`/`county`/`year`) is NOT an index — the _filter_ (cui/date/component) bounds the scan; an unfiltered group-by is rejected unless windowed by a ≤1yr `dateFrom/To` (15s class)                                                                                                                                                                         |
| `listCommitments` by CUI / contract         | `commitments_beneficiary_cui_idx` / `commitments_contract_number_idx`                                                           |                                                                                                                                                                                                                                                                                                                                                                                               |
| `getCommitmentProgress`                     | `commitment_snapshots_commitment_idx` (soft link) **or** `commitment_snapshots_cui_contract_idx`                                | 741k table — MUST be bounded by `commitment_key` OR `(beneficiary_cui, contract_number)`; never an unbounded scan. **`commitment_key` is a NULLABLE soft link** (not 100% coverage) → see §13 #2: the endpoint accepts a commitment_key but the repo resolves it to the commitment's `(beneficiary_cui, contract_number)` and queries on that index so unlinked snapshots are still reachable |
| `listAcquisitions` by CUI/date/announcement | `acquisitions_beneficiary_cui_idx` / `_signed_at_idx` / `_announcement_idx`                                                     |                                                                                                                                                                                                                                                                                                                                                                                               |
| `getAcquisition` detail                     | `acquisitions_pkey` + `lots_announcement_idx` + `contractors_acquisition_idx`                                                   | bounded fan-out per acquisition                                                                                                                                                                                                                                                                                                                                                               |
| `listContractors` / `rankContractors`       | `contractors_cui_idx` / `contractors_role_idx` / `contractors_acquisition_idx`                                                  | rank is a bounded group-by, 15s class                                                                                                                                                                                                                                                                                                                                                         |
| `getEntityProfile`                          | `payments_beneficiary_cui_idx` + `commitments_beneficiary_cui_idx` + `acquisitions_beneficiary_cui_idx` + `contractors_cui_idx` | 4 indexed scans by CUI (the old surface's shape, widened)                                                                                                                                                                                                                                                                                                                                     |

`commitment_snapshots` is the only large (741k) table; **every** method touching
it is bounded by an indexed predicate (commitment_key or cui+contract). There are
no partition children in the `pnrr` schema (unlike budget/procurement).

---

## 4. Usecases

`src/modules/pnrr/core/usecases/` — framework-free, over `PnrrRepository` (+
kernel `FlowsRepo` where a unified flow view is needed). Thin; REST/GraphQL/MCP
call the same usecase.

| Usecase                                             | Signature                                         | Notes                                                |
| --------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `listPnrrEntities`                                  | `(repo, filter, page) → Result<Conn<PnrrEntity>>` | headline directory                                   |
| `getPnrrEntityProfile`                              | `(repo, cui) → Result<PnrrEntityProfile \| null>` | ledger + commitments + procurement rollup (PII-free) |
| `listPnrrPayments` / `aggregatePnrrPayments`        | filter+page / filter+groupBy                      | source-native ledger                                 |
| `listPnrrCommitments` / `getPnrrCommitmentProgress` |                                                   | progress time-series gated on a key                  |
| `listPnrrAcquisitions` / `getPnrrAcquisition`       |                                                   | award detail + contractors                           |
| `listPnrrContractors` / `rankPnrrContractors`       |                                                   | winner/sub graph; rank from **source facts** (§14.6) |
| `listPnrrComponents` / `listPnrrMeasures`           |                                                   | dimensions                                           |
| `resolvePnrrFilters`                                | `(repo, dim, q, limit) → Result<ResolveHit[]>`    | name→value (kernel discovery, §7.4)                  |

### 4.1 Cross-source contributor (§4.4 / §14.7)

`makePnrrContributor(repo): SourceContributor` with `source = 'pnrr'`:

```ts
presenceFor(cui): // SELECT EXISTS in pnrr.entities + counts (payments/commitments/acquisitions/contractor wins) → SourcePresence
profileSlice(cui): // = getPnrrEntityProfile(cui) projected to EntityProfileSlice (totals + roles + hubs + top components)
```

`Entity.pnrr` GraphQL resolver calls **the same** `profileSlice` (§14.7) — the
contributor is the single cross-source mechanism. Registered at wiring time;
entity-360/global-search/compare pick PNRR up without kernel edits.

### 4.2 Flow / doc-type ownership (Grain Gate — §14.6)

- **Registers `flow_type`s:** `pnrr_payment` (cash disbursement — the ONLY cash
  flow), `pnrr_commitment` (obligation; `amount_eur` NULL; **never summed with
  payments**), `pnrr_subcontract` (procurement award; ONE per acquisition;
  `amount_eur` NULL). Added to `shared/core/types.ts` `FLOW_TYPES` so GraphQL/MCP
  enums stay in sync.
- **Authority split (declared per question):**
  - Unified **entity-360 flow summary / counterparty network / cross-source
    totals** → kernel `FlowsRepo` over `flows.money_flows` (`/api/v1/entities/:cui/flows`).
  - PNRR-native **payment totals, by-component/measure/county breakdowns,
    contractor rankings, commitment progress** → the PNRR repo over `pnrr.*`
    facts. These are the authoritative source for PNRR-specific numbers.
  - **Counting invariant (loader-proven, surfaced as a caveat):** "PNRR cash
    disbursed = SUM(pnrr_payment)". A response MUST NOT add amounts across
    `flow_type`. Any view mixing `flows.money_flows` with a `pnrr.*` rollup labels
    both grains. Self-award acquisitions (214, applicant==winner) are excluded
    from `pnrr_subcontract` award flows (loader gate = 0 self-loops); the module
    surfaces this as a caveat on contractor rankings.
- **Registers `doc_type`s:** `pnrr_entity`, `pnrr_announcement`,
  `pnrr_acquisition`, `pnrr_contractor`, `pnrr_measure` (+ legacy
  `pnrr_project`/`pnrr_payment` read-compatible). **Never** per-payment docs.

---

## 5. REST endpoints

Prefix `/api/v1/pnrr/`. TypeBox schemas derived from the §7 filter specs via the
kernel `toTypeBox(spec)`. Every route `config: { public: true }` (§14.11). Envelope
`{ ok, data, meta?, requestId }`. OpenAPI fragment exported and merged at
`/api/v1/openapi.json`.

| Method | Path                              | Query/Params                    | Response                                                    | Pagination                                                | Cache TTL | stmt timeout |
| ------ | --------------------------------- | ------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- | --------- | ------------ |
| GET    | `/pnrr/entities`                  | `PnrrEntityFilter` (§7.1)       | `PnrrEntity[]`                                              | cursor `(cui asc)` default; `total_payments desc` opt-in  | 300s      | 5s/15s       |
| GET    | `/pnrr/entities/:cui`             | `cui`                           | `PnrrEntity`                                                | —                                                         | 600s      | 5s           |
| GET    | `/pnrr/entities/:cui/profile`     | `cui`                           | `PnrrEntityProfile`                                         | —                                                         | 300s      | 15s          |
| GET    | `/pnrr/payments`                  | `PnrrPaymentFilter` (§7.2)      | `PnrrPayment[]`                                             | cursor `(payment_date desc, payment_key)`                 | 120s      | 5s           |
| GET    | `/pnrr/payments/aggregate`        | `PnrrPaymentFilter` + `groupBy` | `PnrrPaymentAggRow[]`                                       | —                                                         | 300s      | 15s          |
| GET    | `/pnrr/commitments`               | `PnrrCommitmentFilter`          | `PnrrCommitment[]`                                          | cursor `(commitment_date desc, commitment_key)`           | 120s      | 5s           |
| GET    | `/pnrr/commitments/:key/progress` | `key`                           | `PnrrCommitmentSnapshot[]` (date asc)                       | —                                                         | 300s      | 5s           |
| GET    | `/pnrr/acquisitions`              | `PnrrAcquisitionFilter`         | `PnrrAcquisition[]`                                         | cursor `(signed_at desc, acquisition_key)`                | 120s      | 5s           |
| GET    | `/pnrr/acquisitions/:key`         | `key`                           | `PnrrAcquisitionDetail` (+ announcement, lots, contractors) | —                                                         | 300s      | 5s           |
| GET    | `/pnrr/contractors`               | `PnrrContractorFilter`          | `PnrrContractor[]`                                          | cursor `(contract_value desc nulls last, contractor_key)` | 120s      | 5s           |
| GET    | `/pnrr/contractors/rank`          | `PnrrContractorFilter` + `by`   | `PnrrContractorRankRow[]`                                   | offset (≤100)                                             | 300s      | 15s          |
| GET    | `/pnrr/components`                | —                               | `PnrrComponent[]` (16)                                      | —                                                         | 3600s     | 5s           |
| GET    | `/pnrr/measures`                  | `PnrrMeasureFilter`             | `PnrrMeasure[]` (≤103)                                      | —                                                         | 3600s     | 5s           |
| GET    | `/pnrr/program-indicators`        | —                               | `PnrrProgramIndicator[]` (30)                               | —                                                         | 600s      | 5s           |
| GET    | `/pnrr/filters/resolve`           | `dim`, `q`, `limit`             | `ResolveHit[]`                                              | —                                                         | 300s      | 5s           |

**Notes:** cursor lists are §14.3-enveloped (`fhash` over `canonicalizeFilters`);
`entities` cursor on `total_payments` requires a stable secondary key (`cui`) and
a per-request precomputed payment-total CTE bounded by the filter. Offset+`total`
is used ONLY for `contractors/rank` (bounded by filter, ≤100) per §14.4; large
lists (payments) are cursor and any total is `{ total, estimated: true }`. The old
unified routes (`/api/v1/unified/pnrr/entities`, `.../profile`) are superseded;
their two behaviors are preserved by `/pnrr/entities` + `/pnrr/entities/:cui/profile`
with a widened profile.

---

## 6. GraphQL

In-process schema stitch (§6.2). All types `Pnrr*`-prefixed (§14.8); CI conflict
test guards collisions. Resolvers are thin → same usecases as REST; `Entity.pnrr`
goes through the contributor (§14.7). **Enum values are deliberately DB-identical
(snake_case `winning_bidder`, `pnrr_payment`)** — they mirror the `pnrr.contractors.role`
and `flows.money_flows.flow_type` string values verbatim so no value-mapping layer
is needed; the consistency pass must not "normalize" them to SCREAMING_SNAKE (it
would break the value contract).

```graphql
enum PnrrContractorRole {
  winning_bidder
  foreign_winning_bidder
  subcontractor
  association_leader
  third_party_support
}
enum PnrrMeasureType {
  investment
  reform
}
enum PnrrPaymentGroupBy {
  component
  measure
  county
  year
}
enum PnrrFlowType {
  pnrr_payment
  pnrr_commitment
  pnrr_subcontract
} # mirrors kernel FLOW_TYPES
type PnrrEntity {
  cui: CUI!
  name: String
  nameSource: String
  caenCode: String
  isActive: Boolean
  isVatPayer: Boolean
  roles: PnrrEntityRoles!
  hubs: [String!]! # public_entities | companies (link, not merge)
  firstSeenSource: String
  profile: PnrrEntityProfile # lazy; resolves via the SAME getPnrrEntityProfile usecase the contributor.profileSlice and REST /profile call (§14.7) — no second path
}
type PnrrEntityRoles {
  beneficiary: Boolean!
  applicant: Boolean!
  winner: Boolean!
  subcontractor: Boolean!
}

type PnrrEntityProfile {
  entity: PnrrEntity!
  payments: PnrrPaymentSummary! # count, totalLei: Money!, totalEur: Money!, firstDate, lastDate, byComponent
  commitments: PnrrCommitmentSummary!
  procurement: PnrrProcurementSummary! # acquisitionsAsBeneficiary, acquisitionsValue: Money, wonAsContractor
  grainNote: String! # "cash=SUM(payments); commitments are obligations, not summed"
}

type PnrrPayment {
  paymentKey: ID!
  beneficiaryCui: CUI
  beneficiaryName: String
  componentCode: String
  measureFenix: String
  amountLei: Money
  amountEur: Money
  paymentDate: Date
  countyName: String
  countySiruta: SIRUTA
  localityName: String
  caenDivision: String
  financingSource: String
}
type PnrrCommitment {
  commitmentKey: ID!
  beneficiaryCui: CUI
  beneficiaryName: String
  contractNumber: String
  componentCode: String
  measureCode: String
  totalValue: Money
  euValue: Money
  nationalPublicValue: Money
  vatValue: Money
  ineligibleValue: Money
  financialProgress: Float
  physicalProgress: Float
  commitmentDate: Date
  endDate: Date
  status: String!
  countySiruta: SIRUTA
  progress: [PnrrCommitmentSnapshot!]!
} # progress resolved lazily, bounded by key (see §3/§13 #2)
type PnrrCommitmentSnapshot {
  snapshotId: ID!
  sourceRecordId: ID!
  snapshotDate: Date!
  financialProgress: Float
  physicalProgress: Float
  stage: String
  receivedEur: Money
  paidEur: Money
  allocatedEur: Money
  linkConfidence: Float
} # node id is the composite (snapshotId, sourceRecordId); snapshotId alone is NOT unique
type PnrrAcquisition {
  acquisitionKey: ID!
  announcementKey: ID
  beneficiaryCui: CUI
  beneficiaryName: String
  procedureType: String
  signedAt: Date
  fullContractValue: Money
  currency: String
  frameworkAgreement: Boolean
  hasSubcontractor: Boolean
  contractors: [PnrrContractor!]!
}
type PnrrContractor {
  contractorKey: ID!
  acquisitionKey: ID
  role: PnrrContractorRole!
  contractorCui: CUI
  contractorName: String
  contractorCountry: String
  contractValue: Money
  currency: String
  confidence: String
  validationStatus: String
}
type PnrrComponent {
  componentCode: ID!
  componentName: String
  pillar: String
}
type PnrrMeasure {
  fenixReference: ID!
  componentCode: String
  measureType: PnrrMeasureType
  measureNumber: Int
  measureName: String
}
type PnrrProgramIndicator {
  snapshotId: ID!
  snapshotDate: Date!
  nrProjects: Int
  allocatedEur: Money
  receivedEur: Money
  paidEur: Money
}

type PnrrEntityConnection {
  edges: [PnrrEntityEdge!]!
  pageInfo: PageInfo!
}
type PnrrEntityEdge {
  node: PnrrEntity!
  cursor: String!
}
# + PnrrPaymentConnection / PnrrAcquisitionConnection / PnrrContractorConnection / PnrrCommitmentConnection (same shape)

extend type Query {
  pnrrEntities(filter: PnrrEntityFilter, first: Int = 20, after: String): PnrrEntityConnection!
  pnrrEntity(cui: CUI!): PnrrEntity
  pnrrPayments(filter: PnrrPaymentFilter, first: Int = 20, after: String): PnrrPaymentConnection!
  pnrrPaymentAggregate(
    filter: PnrrPaymentFilter
    groupBy: PnrrPaymentGroupBy!
  ): [PnrrPaymentAggRow!]!
  pnrrCommitments(
    filter: PnrrCommitmentFilter
    first: Int = 20
    after: String
  ): PnrrCommitmentConnection!
  pnrrAcquisitions(
    filter: PnrrAcquisitionFilter
    first: Int = 20
    after: String
  ): PnrrAcquisitionConnection!
  pnrrAcquisition(key: ID!): PnrrAcquisition
  pnrrContractors(
    filter: PnrrContractorFilter
    first: Int = 20
    after: String
  ): PnrrContractorConnection!
  pnrrContractorRank(
    filter: PnrrContractorFilter
    by: String = "value"
    limit: Int = 20
  ): [PnrrContractorRankRow!]!
  pnrrComponents: [PnrrComponent!]!
  pnrrMeasures(filter: PnrrMeasureFilter): [PnrrMeasure!]!
  pnrrProgramIndicators: [PnrrProgramIndicator!]!
}

# Entity join (§6.2/§14.7): each source extends Entity; resolved via contributor + CUI DataLoader
extend type Entity {
  pnrr: PnrrEntityProfile
}
```

**DataLoaders:** `Entity.pnrr` batches `cui[]` → `contributor.profileSlice` (one
batched query against the 4 CUI indexes). `PnrrCommitment.progress` and
`PnrrAcquisition.contractors` are lazily resolved and bounded by their parent key
(no N+1 on list pages — DataLoader by `commitment_key` / `acquisition_key`).
Filter `input` types are generated from the §7 specs via `toGraphQLInput(spec)`.

---

## 7. Filters (priority area)

One `CollectionFilterSpec` per collection (kernel-shipped pipeline, §14.2 — the
module only declares specs). `canonicalizeFilters` output drives the cache key,
the cursor `fhash`, and the tri-surface equivalence test. `q` text engine declared
per collection. `isNull` is available for coverage questions.

### 7.1 `pnrr_entities` spec

| Field                     | type   | ops        | driving column / index                                     | REST ↔ GraphQL ↔ MCP          |
| ------------------------- | ------ | ---------- | ---------------------------------------------------------- | ----------------------------- |
| `cui`                     | string | eq, in     | `entities.cui` (PK)                                        | `cui` / `cui:[CUI!]` / `cui`  |
| `q`                       | string | contains   | `entities.resolved_name` (trigram via kernel)              | `q` / `q` / resolved first    |
| `role`                    | enum   | eq         | `entities.is_{beneficiary,applicant,winner,subcontractor}` | `role=beneficiary…`           |
| `hub`                     | enum   | eq, in     | `entity_registry_links.registry` (EXISTS)                  | `hub=companies`               |
| `caenCode`                | string | eq, prefix | `entities.caen_code`                                       | `caenPrefix`                  |
| `isActive` / `isVatPayer` | bool   | eq, isNull | `entities.is_active` / `is_vat_payer`                      |                               |
| `hasNoHub`                | bool   | eq         | `NOT EXISTS entity_registry_links`                         | unmatched residual (coverage) |

Sort: **default `cui asc`** (PK — index-backed, stable cursor). `name` (trigram-
backed). `total_payments desc` is **opt-in** and uses a per-request CTE
`SELECT beneficiary_cui, SUM(amount_lei) FROM pnrr.payments GROUP BY 1` joined to
the filtered entity set; cursor resumes on `(total_payments, cui)` carried in the
envelope. It runs in the 15s class and is intended for filtered slices (a role/hub
filter shrinks the set); an unfiltered 18,876-entity `total_payments` sort is
allowed but flagged estimated. (The headline directory defaults to `cui` so the
common page load never triggers the full payment aggregate.)

### 7.2 `pnrr_payments` spec

| Field                         | type         | ops            | driving column / index                                                                                   |
| ----------------------------- | ------------ | -------------- | -------------------------------------------------------------------------------------------------------- |
| `beneficiaryCui`              | string       | eq, in         | `payments_beneficiary_cui_idx`                                                                           |
| `componentCode`               | enum(C1–C16) | eq, in         | `payments_component_idx`                                                                                 |
| `measureFenix`                | string       | eq, in, isNull | `payments_measure_fenix_idx` (isNull = unresolved measures, coverage)                                    |
| `countySiruta`                | string       | eq, in         | `payments.county_siruta` — **NO index** (residual filter only)                                           |
| `dateFrom`/`dateTo`           | date         | between        | `payments_payment_date_idx` (also cursor key)                                                            |
| `year`                        | int          | eq             | `payment_date` range (no `year` column/index) → compiles to `dateFrom/To` on `payments_payment_date_idx` |
| `minAmountLei`/`maxAmountLei` | number       | gte/lte        | `payments.amount_lei` — **NO index** (residual; overflow-guarded numeric)                                |
| `caenDivision`                | string       | eq, prefix     | `payments.caen_division` — **NO index** (residual)                                                       |
| `financingSource`             | string       | eq             | `payments.financing_source` — **NO index** (residual)                                                    |

Sort: default `payment_date desc`; allowed `payment_date`, `amount_lei`.
`q` not backed (use search endpoint). Amount filters guard numeric(18,2) overflow.

**Index-bound rule (Foundation §3).** The migration indexes only
`beneficiary_cui`, `payment_date`, `component_code`, `measure_fenix` on
`pnrr.payments`. `countySiruta`/`caenDivision`/`financingSource`/`minAmount` are
**residual filters** — the kernel composer applies them only AFTER an indexed
driving predicate (`beneficiaryCui`, a `dateFrom/To` bound, `componentCode`, or
`measureFenix`). `listPayments`/`aggregatePayments` **reject a request whose
filter set has no indexed predicate** (`InvalidInput: "needs at least one of
cui/date/component/measure"`), except `aggregatePayments` over a bounded
`dateFrom/To` window (≤1 year, `payment_date` index), which is a planned bounded
scan in the 15s class. If county/caen filtering becomes a hot path, the scrapper
adds the index — the server never adds indexes (§F5).

Same index-bound rule applies to all three collections (indexed driving predicate
required; the rest are residual filters):

- **commitments** (indexed: `beneficiary_cui`, `contract_number`, `component_code`):
  driving = `beneficiaryCui` (in) / `contractNumber` (eq) / `componentCode`.
  Residual = `measureCode`, `status` (enum), `countySiruta`, `commitmentDateFrom/To`,
  `minTotalValue`/`maxTotalValue`, `minFinancialProgress`/`maxFinancialProgress`.
  (24,967 rows — a status-only scan is cheap but still requires a driving predicate
  for contract consistency.)
- **acquisitions** (indexed: `beneficiary_cui`, `signed_at`, `announcement_key`):
  driving = `beneficiaryCui` (in) / `signedAtFrom/To` / `announcementKey` (eq).
  `componentCode` lives on `pnrr.announcements` (no column on acquisitions) → join
  `acquisitions.announcement_key → announcements_pkey`, filter on
  `announcements_component_idx`. Residual = `procedureType` (enum),
  `minContractValue`/`maxContractValue`, `frameworkAgreement`/`hasSubcontractor`/
  `hasAssociationLeader`/`hasThirdPartySupport` (bool).
- **contractors** (indexed: `contractor_cui`, `acquisition_key`, `role`): driving =
  `contractorCui` (in) / `acquisitionKey` (eq) / `role` (enum, `contractors_role_idx`).
  Residual = `contractorCountry` (eq — foreign), `validationStatus`, `confidence`,
  `minContractValue`/`maxContractValue`.

### 7.4 Discovery / resolve dimensions (§7.4)

`GET /pnrr/filters/resolve?dim=&q=` + the MCP discovery tool resolve:
`entity` (name→CUI via `pnrr.entities`/kernel trigram), `component` (label→C-code),
`measure` (name→fenix_reference), `county` (name→SIRUTA via kernel TerritoryRepo),
`contractor` (name→CUI). Measures/components are tiny (103/16) → in-process resolve.

### 7.5 Golden question → filter examples

`AI_AGENT_FILTER_QUESTION_CATALOG.md` has no PNRR section yet; these are the
module's golden cases (to be added to the catalog) and integration fixtures:

| Q    | Question                                              | Filters / endpoint                                                                                                                                                                                          |
| ---- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PN-1 | Total PNRR cash disbursed to entity X                 | `/pnrr/entities/:cui/profile` → `payments.totalLei` (SUM(pnrr_payment); caveat: not commitments)                                                                                                            |
| PN-2 | PNRR payments by component for county Y in year Z     | `/pnrr/payments/aggregate?countySiruta=&year=&groupBy=component`                                                                                                                                            |
| PN-3 | Who won PNRR contracts under measure M (investment)   | `/pnrr/acquisitions?componentCode=` + `/pnrr/contractors?role=winning_bidder` (rank by value)                                                                                                               |
| PN-4 | Top contractors across PNRR by award value            | `/pnrr/contractors/rank?by=value` (source facts, self-award excluded — caveat)                                                                                                                              |
| PN-5 | Commitment progress over time for contract C          | `/pnrr/commitments/:key/progress` (MIPE series, bounded by key)                                                                                                                                             |
| PN-6 | PNRR beneficiaries that are NOT in any identity hub   | `/pnrr/entities?hasNoHub=true` (coverage; 1,434 residual = 18,876 − 17,442)                                                                                                                                 |
| PN-7 | Payments with unresolved measure (data-quality probe) | `/pnrr/payments?measureFenix.isNull=true` — returns the _rows_ with no fenix link; distinct from the gate's by-VALUE metric (98.75% of payment value resolved → 1.25% residual value; 31 unmatched aliases) |
| PN-8 | Program KPI timeline                                  | `/pnrr/program-indicators`                                                                                                                                                                                  |

---

## 8. MCP tools

`src/modules/pnrr/shell/mcp/`. TypeBox input+output; handler → usecase; output
`{ ok, kind, query, link, item|items, summary?, caveats? }` (§6.3). PII never
returned. Rate-limited; bounded sizes.

| Tool                                     | Input                   | Usecase                 | Output `kind` | `link`                          | summary template                                                                                                                                                                      |
| ---------------------------------------- | ----------------------- | ----------------------- | ------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve_pnrr_filters` (discovery, §7.4) | `{ dim, q, limit? }`    | `resolvePnrrFilters`    | `resolve`     | —                               | "Found N matches for «q» as {dim}"                                                                                                                                                    |
| `get_pnrr_entity` (supersedes old)       | `{ cui }`               | `getPnrrEntityProfile`  | `entity`      | `{client}/pnrr/{cui}`           | "{name} ({cui}): {payCount} payments = {totalLei} lei / {totalEur} eur; {commitCount} commitments; won {wonCount} contracts. PNRR cash = SUM(payments); commitments are obligations." |
| `rank_pnrr_contractors`                  | `{ filter, by, limit }` | `rankPnrrContractors`   | `ranking`     | `{client}/pnrr/contractori?...` | "Top {limit} PNRR contractors by {by} (self-awards excluded)"                                                                                                                         |
| `aggregate_pnrr_payments`                | `{ filter, groupBy }`   | `aggregatePnrrPayments` | `aggregate`   | `{client}/pnrr/plati?...`       | "PNRR payments grouped by {groupBy}: {topRow}…"                                                                                                                                       |

`get_pnrr_entity` improves the old single-CUI tool by carrying the **grain caveat**
in `summary` (cash vs commitment) and `caveats` (hub-match/measure residuals from
the gate). The discovery tool is the shared kernel resolver parameterized for PNRR
dims. Inputs reuse the §7 specs (`resolve_pnrr_filters` mirrors `/filters/resolve`).

---

## 9. Search integration

`doc_type`s **owned** (already live, index `unified_pnrr` in Meili+OpenSearch):
`pnrr_entity` (beneficiary/contractor names → instant autocomplete),
`pnrr_announcement` (project/call names), `pnrr_acquisition`, `pnrr_contractor`,
`pnrr_measure` — together **71,679 docs** (the live total). (Legacy
`pnrr_project`/`pnrr_payment` are read-compatible subsets within that total, not
additions; **no new per-payment docs** — 73k would flood.)

- **Projection** (scrapper `search` lane writes; server reads): `search.documents`
  rows carry `doc_id`, `doc_type`, `title`, `body`, `cuis text[]`, `doc_date`,
  `amount_ron`, `county_name`, `url`, `attrs`. The server queries via the kernel
  hybrid contract: **Meili** for entity-name autocomplete, **OpenSearch** for
  full-text/relevance + terms aggregations, **Postgres `search.documents`** ILIKE
  fallback when services are down.
- **PII gate (hard):** the loader scrubs emails from title/body and the module's
  test asserts zero email-like strings in any `pnrr_*` doc; `contact_*` columns are
  never projected (§2.5). `is_personal_recipient` rows are flagged and withheld.
- **Semantic gating (§4.5/§14.5):** no vector column on `search.documents` in the
  current snapshot and PNRR v1 is **deterministic-only, no embeddings** (NOTES
  decision). Semantic fields return `null` + `caveats:["semantic search unavailable"]`
  — never error. Capability resolved once at boot by the kernel.

`q` backing per surface: `/pnrr/entities?q=` → Meili (autocomplete); a future
`/pnrr/search` full-text endpoint (if added) → OpenSearch; offline fallback →
`search.documents` ILIKE.

---

## 10. Sync / freshness impact on serving

The corpus is currently a **static snapshot** (last `retrieved_at` 2026-05-19; raw
cutover to prod-raw executed). Per-lane live cadence (from NOTES Phase H): payments
**monthly APPEND**, commitments **weekly MUTABLE** (progress), announcements/
acquisitions **weekly MUTABLE**, contractors APPEND-with-parent, measures/persons
monthly FULL REFRESH, MIPE per-snapshot APPEND. Loader is idempotent + convergent
(zero-drift proven); derived flows/search re-derive on change.

**Serving implications:**

- Cache is **TTL-only** today (no per-domain loader-completion stamp wired for
  PNRR yet — state explicitly per §14.11). TTLs in §5 reflect the static corpus
  (dimensions 1h; entities/aggregates 300–600s; lists 120s). When the loader
  publishes a `pnrr` watermark into `etl`/`system_control`, the kernel cache buster
  - an "as-of" field on reads should be wired (follow-up; interim = TTL-only,
    documented).
- **As-of semantics:** the module surfaces a `dataAsOf` field on profile/aggregate
  responses sourced from `max(retrieved_at)` over the relevant facts (cheap, indexed
  on the small profile path; for aggregates use the lane's batch stamp). MIPE
  progress series carry `snapshotDate` so callers see temporal coverage directly.
- A full flows re-derive is I/O-bound (~29 min on the 19 GB shared table) — a
  loader concern, **not** request-path; the server never triggers derivation.

---

## 11. Wiring

```ts
makePnrrModule(deps: {
  db: Kysely<ProdDatabase>;            // shared kernel instance (reads pnrr.* + core/flows/search)
  flowsRepo: FlowsRepo;                // kernel — unified flow view only
  identityRepo: IdentityRepo;          // kernel — Entity join name/hub overlay
  territoryRepo: TerritoryRepo;        // kernel — county SIRUTA resolve
  search: { meili: MeiliClient; opensearch: OpenSearchClient; capabilities: SearchCapabilities };
  cache: Cache; rateLimiter: RateLimiter; config: PnrrConfig;
}): PnrrModule  // { restPlugin, graphql: { typeDefs, resolvers }, mcpTools, contributor, repos }
```

- **Env additions:** none beyond kernel (`PROD_DATABASE_URL`, `MEILI_*`,
  `OPENSEARCH_URL`, pool/limit knobs). PNRR index name `unified_pnrr` is config
  (default). Feature-flaggable off via the kernel module-enable list.
- **build-app registration:** construct after kernel; register `restPlugin` under
  `/api/v1/pnrr`, merge GraphQL slice into root schema (CI conflict test), register
  `mcpTools`, register `contributor` into the kernel registry. Data-independent
  order (no inter-module deps).
- **Legacy superseded:** the OLD `unified` PNRR surface —
  `modules/unified/shell/repo/pnrr-source-repo.ts`,
  `modules/unified/shell/rest/sources/routes-pnrr.ts`, and the MCP
  `get_pnrr_entity` registration in `modules/mcp/shell/server/mcp-server.ts` (the
  optional `pnrrRepo` dep). The two old REST behaviors are preserved + widened.

---

## 12. Testing

- **Unit** (`tests/unit/pnrr/`): usecases with a mocked `PnrrRepository`; filter
  spec → SQL compilation snapshot tests for each collection (verify driving column
  - parameterization, esp. the `commitment_snapshots` bounded-scan guard); cursor
    encode/decode incl. `fhash` mismatch → `InvalidInput`; money `::text` → string
    mappers (no float); `canonicalizeFilters` stability.
- **Integration** (`tests/integration/pnrr/`): REST+GraphQL+MCP against a seeded
  fixture schema (or read-only prod connection); **tri-surface equivalence** — same
  `canonicalizeFilters` input yields identical rows across REST/GraphQL/MCP for
  each collection; `Entity.pnrr` resolver == REST `/entities/:cui/profile`
  (contributor parity, §14.7).
- **Privacy test** (`tests/unit/pnrr/pnrr-pii.test.ts`): no surface emits
  `contact_*` or `is_personal_recipient`; no repo method selects
  `announcement_contacts_private`; `pnrr_*` search docs have zero email-like
  strings (mirrors the loader gate, decision #5/§2.5).
- **Grain test**: assert the profile usecase never sums `amount_lei` across
  flow_types; `grainNote` present; `rank_pnrr_contractors` excludes self-awards.
- **Golden filters** (§7.5): PN-1…PN-8 as integration cases with measured
  expected values from the live gate (e.g. CNAIR cui 16054368 → 1,229 payments =
  6.21B lei / 1.26B eur, component C4 — the verified Phase G smoke).

---

## 13. Open questions / risks

1. **Entity name overlay (cache vs hub join).** `pnrr.entities.resolved_name` is a
   rebuildable cache; the kernel `IdentityRepo` holds canonical names. Default =
   read the cache (hot path). **Decision:** confirm whether `Entity.pnrr` and the
   directory should prefer the kernel canonical name when present (one extra
   batched join) or trust the cache. Low-risk either way; proposing cache-default
   - optional overlay.
2. **`commitment_snapshots` (741k) exposure + nullable soft link.** Surfaced ONLY
   via `/commitments/:key/progress` and `PnrrCommitment.progress` (lazy). The MIPE
   `commitment_key` soft link is NULLABLE (not 100% coverage), so the repo resolves
   the requested `commitmentKey` to the commitment's `(beneficiary_cui,
contract_number)` and queries `commitment_snapshots_cui_contract_idx` — this way
   progress for snapshots that were never soft-linked is still reachable (PN-5 does
   not silently return empty). **No** unbounded list endpoint. Confirm: (a) this is
   the intended contract, and (b) the cui+contract resolution is acceptable vs a
   strict commitment_key match (proposing the resilient cui+contract path).
3. **`contractors/rank` offset+total.** Permitted under §14.4 because it's bounded
   by filter (≤100). If an unfiltered global rank is wanted, switch to estimated
   total. Confirm the default `by` (proposing `value`).
4. **Cross-module overlap with `procurement`.** PNRR-funded contracts may ALSO
   appear in the national `procurement` schema (e-licitatie). v1 keeps them
   **separate** (the PNRR procurement graph is platform-sourced, distinct grain) —
   correlation across the two is a kernel entity-360 concern, not a PNRR-module
   join. Flag for the consistency pass: ensure `Pnrr*` vs `Procurement*` types
   don't imply they're the same fact.
5. **Cross-module need (companies/identity).** `Entity.pnrr` and hub overlay depend
   on the kernel `IdentityRepo` over `core.organizations`/`companies` being wired;
   `hubs=[companies]` requires the companies registry present. Coordinate with the
   companies module (02) and the kernel.
6. **Freshness watermark (interim TTL-only).** No PNRR loader-completion stamp in
   `etl`/`system_control` yet (§10). Interim cache is TTL-only; the `dataAsOf`
   field is the stopgap. Confirm acceptable for v1.
7. **Locality SIRUTA / platform county_id deferred.** No locality-level geo filter
   in v1 (county only). Documented deferral; confirm no client route needs it.

---

## Reviewer note

Adversarial review performed by a general-purpose reviewer subagent against the
foundation contract (§14.1 scalars, §14.2 filter pipeline, §14.6 grain gate, §14.7
contributor parity, §14.8 namespacing, §8.2/§14.9 PII exclusion, §4.5/§14.5
semantic gate) and the live `pnrr` schema/indexes. Findings incorporated above.
Net changes from review:

- **Scalars (§14.1):** all money view-model/SDL fields made nullable
  (`amountLei`/`amountEur`/`totalValue`/`fullContractValue`/`currency` are nullable
  columns — `Money!`/`String!` over them would hard-error a resolver on the first
  NULL row APPENDed under the sync model).
- **Index-awareness (§3/§7):** added the explicit index-bound rule — only
  `beneficiary_cui`/`payment_date`/`component_code`/`measure_fenix` are indexed on
  payments (analogous sets on commitments/acquisitions/contractors);
  `countySiruta`/`caenDivision`/`financingSource`/amount are **residual filters**
  needing an indexed driving predicate; requests with no indexed predicate are
  rejected. Corrected aggregate notes (the per-group key is NOT an index — the
  _filter_ bounds the scan); changed `/pnrr/entities` default sort to `cui` (PK)
  so the headline page never triggers the full payment aggregate.
- **`commitment_snapshots` soft link:** the endpoint resolves `commitmentKey` →
  `(beneficiary_cui, contract_number)` so progress for unlinked snapshots stays
  reachable (PN-5 never silently empty).
- **Namespacing (§14.8):** clarified `ResolveHit`/`SourcePresence`/
  `EntityProfileSlice` are kernel-owned shared types; all PNRR aggregate/summary
  types are `Pnrr*`; snake_case enum values flagged as deliberately DB-identical.
- **Contributor parity (§14.7):** `PnrrEntity.profile` AND `Entity.pnrr` both
  resolve via the one `getPnrrEntityProfile` usecase (no divergent second path).
- **PII (§8.2):** enumerated omitted internal columns (`county_id_raw`, `*_raw`,
  provenance) alongside the structurally-excluded PII.
- **Counts:** footnoted why flow counts < table counts (counting invariant working);
  tightened search-doc total (71,679 is the full count, legacy types a subset) and
  the PN-6/PN-7 golden metrics.
- Retained: `grainNote`/grain-test first-class; `is_personal_recipient` internal-only;
  offset guard on `contractors/rank`; `dataAsOf` + TTL-only freshness; cross-module
  `procurement` overlap flagged for the consistency pass.
