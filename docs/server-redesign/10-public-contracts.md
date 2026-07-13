# 10 — Public Contracts (`procurement`) module plan

> **Status:** implemented, with the analysis/API contract superseded by
> [`10-public-contracts-api-remediation-plan.md`](./10-public-contracts-api-remediation-plan.md).
> The old-MV aggregate tools, analyst fields, grain gate, and `Entity.procurement`
> descriptions below are retained only as historical design context; they are not
> part of the remediated public interface. The retained surface is record
> search/detail/CPV discovery plus the generation-stamped six-shape analysis API
> and `aggregate_procurement` MCP tool.
>
> Conforms to `00-foundation-shared-kernel.md` (binding).
> Source: Romanian public procurement — **e-licitatie API + SEAP/data.gov.ro bulk**
> (user decision: TED/CNSC/PAAP/ANAP probe-only, deferred). Served from
> `transparenta_prod.procurement.*` + the kernel `flows`/`core`/`search` schemas.
> This is a **HIGH-VOLUME** module (direct_acquisitions ≈ 19.8M live rows); every
> list/aggregate path below is bounded by an indexed predicate or pre-aggregated
> rollup — there are **no unbounded scans and no blocking `COUNT(*)`** over the
> fact tables.
>
> Heavy-domain note (§3, §14.10): the procurement fact tables are **plain heap
> tables, NOT native partitions** (verified `\d+`/`pg_inherits`: 0 child
> partitions). The "partition scheme" the foundation mandates is therefore an
> **MV-rollup scheme** — five materialized views pre-aggregate the source-native
> answers. See §3a (Partition / rollup scheme) and §7a (Catalog reconciliation),
> both required subsections.

---

## 0. Live-schema facts this plan is grounded in (verified 2026-06-16, griffin)

| Object                                               | Kind        | Live rows                        | Role                                                                  |
| ---------------------------------------------------- | ----------- | -------------------------------- | --------------------------------------------------------------------- |
| `procurement.procedures`                             | table       | 526,333                          | tender/notice lifecycle (e-licitatie CA ∪ SEAP notices)               |
| `procurement.contracts`                              | table       | 2,252,010                        | supplier-level awards (SEAP `contracts` family only)                  |
| `procurement.direct_acquisitions`                    | table       | **19,780,511**                   | catalog buys (elicitatie DA + SEAP DA/DAN)                            |
| `procurement.contract_modifications`                 | table       | 51,801                           | SEAP modifications, linked to contracts/procedures                    |
| `procurement.cpv_codes`                              | table       | 9,748                            | observed CPV vocab — **DATA-QUALITY FLAGGED** (`cpv_level` 100% NULL) |
| `procurement.cpv_divisions`                          | table       | 45                               | official CPV-2008 divisions (clean, English labels)                   |
| `procurement.procurement_flow_facts_v1`              | **view**    | (= proc flows)                   | canonical deterministic fact surface over `flows.money_flows`         |
| `procurement.org_edge_monthly_rollups`               | **matview** | 8,344,915                        | authority↔supplier monthly edges (PC-1/3/6)                           |
| `procurement.authority_cpv_division_monthly_rollups` | **matview** | 5,222,133                        | authority×CPV-division monthly (PC-4)                                 |
| `procurement.supplier_cpv_division_monthly_rollups`  | **matview** | 9,264,776                        | authority×supplier×CPV-division monthly (PC-2)                        |
| `procurement.same_day_direct_acquisition_candidates` | **matview** | 1,158,463                        | same-day DA splitting candidates (PC-7)                               |
| `procurement.aggregate_quality_by_grain`             | **matview** | 2                                | **the grain gate** — which aggregate answers are allowed per grain    |
| `flows.money_flows` (source_id=`procurement`)        | table       | 16,655,987 (144,891 null-amount) | kernel-owned cross-source flow graph                                  |
| `search.documents` (3 procurement doc_types)         | table       | 2,782,639                        | search projection                                                     |

**Grain gate snapshot — current values, NOT frozen contract** (as of the
2026-06-16 MV refresh):

| `source_grain`         | rows (flow-grain) | `filter_answers_allowed` | `spend_rankings_allowed`                    | `supplier_region_filters_allowed` |
| ---------------------- | ----------------- | ------------------------ | ------------------------------------------- | --------------------------------- |
| `direct_acquisition`   | 15,790,420        | **true**                 | **true**                                    | false                             |
| `procurement_contract` | 865,567           | **true**                 | **false** (amount coverage below threshold) | false                             |

⚠ **These three booleans are computed at MV-refresh time from coverage thresholds**
(`amount/authority/supplier/cpv/date/territory coverage` vs fixed cut-offs in
migration `20260616T220000`), NOT constants. The audit's pending consolidation
reload re-runs the gate, which can flip any of them (e.g. amount-coverage fixes
could flip `procurement_contract` spend rankings on; a date-coverage regression
could flip `filter_answers_allowed` off). The server therefore **reads the gate live
per request** from `aggregate_quality_by_grain` (`grain-quality` endpoint / repo
`grainQuality()`); this table is only the current snapshot for orientation. The
`rows` column here is the **flow grain** (flow_facts rows per `source_grain`); the
rollup MV row counts in §0 are monthly-edge aggregates over the same facts — a
different, larger-keyed grain (do not conflate).

`source_grain` ∈ {`direct_acquisition`, `procurement_contract`} **= the `flow_type`**,
NOT a SEAP/elicitatie distinction. Every aggregate endpoint reads the live gate
first and acts on **all three** booleans (§4 enforcement):

- `filter_answers_allowed=false` for the requested grain → the aggregate **abstains**
  (returns `{ ok:true, data:[], caveats:["grain not gate-approved for filtered
aggregate answers: <blockers>"] }`, partial-coverage per the catalog Coverage
  Gate), never fabricates a number.
- `spend_rankings_allowed=false` → return counts + edge facts, **suppress value
  ordering** (rank by `flow_count`), and force concentration/share measures to be
  **count-based, not value-based** (§7.5/I6).
- `supplier_region_filters_allowed=false` → reject `supplierRegion` filters
  (`InvalidInput`).

---

## 1. Summary & data status

**What's in prod now** (DoD phases 1+2 complete; phase 3 = this module). The
loader (`scrapper/src/src/sources/public-contracts`) has run full + reliability
reloads; the 2026-06-15/16 audit fixed 5 critical defects (dates, false-merge
dedup, pipe corruption, garbage money, status) and they are **live and verified**
(`PUBLIC_CONTRACTS_DATA_AUDIT.md` §G2/G3). The server is read-only over the result.

- **Three entity tables, deliberately not one** (migration `20260614T090000`):
  procedures (tender lifecycle) / contracts (supplier awards) / direct_acquisitions
  (catalog buys, ~10× volume, distinct lifecycle). Modifications hang off contracts.
- **Dedup = reversible link layer** (`dup_group_id` + `is_canonical`, partial-unique
  one-canonical-per-group), elicitatie > SEAP precedence; **flows + search read
  canonical rows only**. Do not double-count: every list/aggregate over the base
  tables MUST filter `is_canonical = true` unless explicitly surfacing duplicates.
- **Flows + rollups** derive only from canonical, non-cancelled rows **with a payee**
  (canonical DAs + SEAP contracts); CA notices contribute no money flow in v1.
- **Schemas touched:** owns `procurement.*`; reads kernel `flows.money_flows`
  (only via `FlowsRepo`, §4.3 — never directly), `core.public_entities` /
  `core.territories` / `core.organizations` (read-only join for territory/identity),
  `search.documents` (read-only).

**Known data-quality the API surfaces (not hides)** — from the audit, exposed as
`dataQuality` caveats and the grain gate, never silently:

- `procurement.cpv_codes.cpv_level`/`parent_code` are unpopulated → **CPV hierarchy
  comes from `cpv_divisions` (2-digit) only**; deeper CPV is the raw 8-digit code +
  label, no tree. (Catalog §7a.)
- `procurement_contract` grain has amount coverage below the spend-ranking
  threshold → **value rankings for contracts are gate-suppressed**; counts allowed.
- A residual ~74 canonical DA values 1e9–1e11 (audit N1) and 51k future SEAP DA
  dates (N2) ride the next consolidation reload; the API clamps/flags via the
  grain gate + `is_value_suspect` semantics in `attrs` where present.

**Deferred (documented):** per-lot e-licitatie award detail (no endpoint captured);
non-RON FX conversion (native value kept in raw `attrs`, `value_ron` nulled for
non-RON per audit decision F1); semantic/pgvector search (capability-gated, §9).

---

## 2. Schema → domain model

Module `core/types.ts` view models. Money = string (§14.1); dates `YYYY-MM-DD`;
`org_id` (only on flow facts) = string. **No PII tables in this source** (§8.2):
procurement has no `*_private`/contact tables. Columns **excluded from default
projections** (§8.2 enumeration — diagnostic / loader bookkeeping, not served):
`supplier_raw`, `cpv_raw`, `status_raw`, `dup_method`, `dup_confidence`,
`source_ref`/`source_system` (internal keys; `daId`/`contractId`/`procedureId` are
the public ids), `state_id`, `source_updated_at`, and the raw `attrs` jsonb (its
native-currency/value-suspect sub-keys are surfaced via typed fields/caveats, never
the blob). `dup_group_id`/`is_canonical` are surfaced (dedup transparency).

```ts
// procurement/core/types.ts  (grounded in _prod-schema/procurement.tsv)

export interface ProcurementProcedure {
  readonly procedureId: string; // bigint → string
  readonly sourceSystem: 'elicitatie' | 'seap_notice';
  readonly noticeNo: string | null;
  readonly noticeKind: string | null; // award|initiation|award_no_init|sad|unknown
  readonly procedureType: string | null; // normalized sys_procedure_type / TIP_PROCEDURA
  readonly contractKind: string | null; // works|services|supplies
  readonly title: string | null;
  readonly authorityCui: string | null;
  readonly authorityName: string | null;
  readonly cpvCode: string | null; // normalized 8-digit
  readonly cpvDivisionCode: string | null; // derived: cpvCode[0:2] (join cpv_divisions for label)
  readonly estimatedValueRon: string | null;
  readonly awardedValueRon: string | null;
  readonly currency: string | null;
  readonly status: ProcedureStatus; // published|in_evaluation|awarded|cancelled|suspended|unknown
  readonly countyName: string | null;
  readonly publicationDate: string | null;
  readonly stateDate: string | null;
}

export interface ProcurementContract {
  readonly contractId: string;
  readonly contractKey: string; // seap_c:<entity_key>
  readonly procedureId: string | null; // FK → procedures (on delete set null)
  readonly noticeNo: string | null;
  readonly contractNo: string | null;
  readonly contractDate: string | null;
  readonly title: string | null;
  readonly authorityCui: string | null;
  readonly authorityName: string | null;
  readonly supplierCui: string | null;
  readonly supplierName: string | null;
  readonly cpvCode: string | null;
  readonly cpvDivisionCode: string | null;
  readonly valueRon: string | null;
  readonly estimatedValueRon: string | null;
  readonly currency: string | null; // ⚠ NOT a clean ISO code: per audit F1/F7 the loader nulls value_ron for non-RON and writes a flag token into this column. Map to { isRon, isSuspectNonRon } at the boundary; never expose as a plain currency.
  readonly status: ContractStatus; // awarded|in_progress|closed|cancelled|unknown
  readonly countyName: string | null;
  readonly isCanonical: boolean;
  readonly dupGroupId: string | null;
}

export interface ProcurementDirectAcquisition {
  readonly daId: string;
  readonly daKey: string; // elicitatie_da:<id>|seap_da:<key>|seap_dan:<key>
  readonly sourceSystem: 'elicitatie_da' | 'seap_da' | 'seap_dan';
  readonly uniqueCode: string | null;
  readonly title: string | null;
  readonly authorityCui: string | null;
  readonly authorityName: string | null;
  readonly supplierCui: string | null;
  readonly supplierName: string | null;
  readonly cpvCode: string | null;
  readonly cpvDivisionCode: string | null;
  readonly valueRon: string | null;
  readonly estimatedValueRon: string | null;
  readonly currency: string | null;
  readonly status: DaStatus; // offered|awarded|finalized|cancelled|unknown
  readonly countyName: string | null;
  readonly publicationDate: string | null;
  readonly finalizationDate: string | null;
  readonly isCanonical: boolean;
  readonly dupGroupId: string | null;
}

export interface ProcurementModification {
  readonly modificationId: string;
  readonly contractId: string | null; // FK → contracts (on delete set null); null ⇔ link_method null
  readonly linkMethod: 'notice_no' | 'authority_cui+contract_no' | null;
  readonly linkConfidence: number | null;
  readonly authorityCui: string | null;
  readonly supplierCui: string | null;
  readonly contractNo: string | null;
  readonly noticeNo: string | null;
  readonly modificationDate: string | null;
  readonly valueBeforeRon: string | null;
  readonly valueAfterRon: string | null;
  readonly valueDeltaRon: string | null;
  readonly deltaPct: number | null; // derived = delta/before (PC-8)
  readonly modificationType: string | null;
  readonly year: number | null;
}

// Aggregate view models (rollup-backed; see §3a)
export interface ProcurementEdge {
  // org_edge_monthly_rollups, grouped
  readonly authorityCui: string;
  readonly authorityName: string | null;
  readonly supplierCui: string;
  readonly supplierName: string | null;
  readonly sourceGrain: ProcurementGrain;
  readonly flowCount: string;
  readonly amountRonSum: string | null;
  readonly amountPresentCount: string;
  readonly amountMissingCount: string;
  readonly firstFlowDate: string | null;
  readonly lastFlowDate: string | null;
  readonly evidenceRefsSample: readonly string[];
}
export interface SupplierConcentration {
  // computed over edges (PC-5)
  readonly authorityCui: string;
  readonly sourceGrain: ProcurementGrain;
  readonly supplierCount: number;
  readonly basis: 'value' | 'count'; // count-based when grain spend_rankings_allowed=false (I6)
  readonly top1Share: number | null; // share of basis measure (value sum OR flow count)
  readonly top5Share: number | null;
  readonly hhi: number | null; // Herfindahl over the basis measure
  readonly totalRon: string | null; // null when basis='count'
  readonly caveats: readonly string[];
}
export interface GrainQuality {
  // aggregate_quality_by_grain (the gate)
  readonly sourceGrain: ProcurementGrain;
  readonly rowsCount: string;
  readonly authorityCuiCoverageRate: number;
  readonly supplierCuiCoverageRate: number;
  readonly amountCoverageRate: number;
  readonly cpvCoverageRate: number;
  readonly dateCoverageRate: number;
  readonly authorityTerritoryCoverageRate: number;
  readonly filterAnswersAllowed: boolean;
  readonly spendRankingsAllowed: boolean;
  readonly supplierRegionFiltersAllowed: boolean;
  readonly blockers: readonly string[];
  readonly refreshedAt: string | null;
  readonly projectionVersion: string;
}

// Remaining aggregate row / helper types (rollup-backed; columns from §0 MVs)
export interface AuthorityCpvRow {
  // authority_cpv_division_monthly_rollups
  readonly authorityCui: string;
  readonly cpvDivisionCode: string;
  readonly cpvDivisionLabelEn: string | null;
  readonly sourceGrain: ProcurementGrain;
  readonly flowCount: string;
  readonly amountRonSum: string | null;
  readonly distinctSupplierCount: string;
  readonly firstFlowDate: string | null;
  readonly lastFlowDate: string | null;
}
export interface SupplierCpvRow {
  // supplier_cpv_division_monthly_rollups
  readonly authorityCui: string;
  readonly supplierCui: string;
  readonly supplierName: string | null;
  readonly authorityRegion: string | null;
  readonly cpvDivisionCode: string;
  readonly sourceGrain: ProcurementGrain;
  readonly flowCount: string;
  readonly amountRonSum: string | null;
  readonly evidenceRefsSample: readonly string[];
}
export interface SameDayCandidate {
  // same_day_direct_acquisition_candidates
  readonly candidateDate: string;
  readonly authorityCui: string;
  readonly supplierCui: string;
  readonly cpvCode: string | null;
  readonly cpvDivisionCode: string | null;
  readonly sameDayCount: string;
  readonly sameDayTotalRon: string | null;
  readonly maxSingleAmountRon: string | null;
  readonly evidenceRefsSample: readonly string[]; // candidate = review signal, NOT illegality
}
export interface CpvDivision {
  readonly code: string;
  readonly labelEn: string;
  readonly labelRo: string | null;
}
export interface CpvMatch {
  readonly code: string;
  readonly label: string | null;
  readonly level: 'division' | 'code';
  readonly confidence: number;
}
export interface ResolveHit {
  readonly value: string;
  readonly label: string | null;
  readonly kind: string;
  readonly confidence: number;
}
export interface ProcurementPresence {
  readonly source: 'procurement';
  readonly asAuthority: { contractCount: string; daCount: string };
  readonly asSupplier: { contractCount: string; daCount: string };
}
export interface ProcurementProfileSlice {
  readonly asAuthority: ProcurementEdge[];
  readonly asSupplier: ProcurementEdge[];
  readonly spendByCpvDivision: AuthorityCpvRow[];
  readonly caveats: readonly string[];
}

export type ProcurementGrain = 'direct_acquisition' | 'procurement_contract';
export type ProcedureStatus =
  | 'published'
  | 'in_evaluation'
  | 'awarded'
  | 'cancelled'
  | 'suspended'
  | 'unknown';
export type ContractStatus = 'awarded' | 'in_progress' | 'closed' | 'cancelled' | 'unknown';
export type DaStatus = 'offered' | 'awarded' | 'finalized' | 'cancelled' | 'unknown';
```

**Identity (CUI) linkage:** all entity rows carry `authority_cui` / `supplier_cui`
as **raw text on the row** (no FK to `core.organizations` — platform decision #5,
link-not-merge). The kernel `IdentityRepo` resolves CUI → `Organization` lazily for
detail/`Entity` views; `org_id` is only materialized on `flows.money_flows`
(`payer_org_id`/`payee_org_id`, ~97–99% backfilled). The DataLoader/contributor key
is **CUI** (§14.1), never `org_id`.

**Territory (SIRUTA) linkage:** rows carry denormalized `county_name`; canonical
territory (county_code, region, population) comes from `core.territories` via
`core.public_entities.territorial_siruta_code` joined on `authority_cui` — which is
exactly how `procurement_flow_facts_v1` and the rollups already pre-resolve
`authority_county_code`/`authority_region`. **Buyer (authority) territory is
resolvable; supplier territory is NOT a v1 dimension** (grain gate
`supplier_region_filters_allowed=false` for both grains — needs the company-registry
backfill; catalog §174). Plans surface buyer-region filters; supplier-region
filters are rejected with a typed `InvalidInput` caveat until the gate flips.

---

## 3. Repo interface (ports)

`procurement/core/ports.ts`. All methods return `Result<T, ApiError>`. Two repos:
`ProcurementRepo` (entity tables) and `ProcurementAggregateRepo` (the 5 MVs + gate).
Source repos touch only `procurement.*` + read-only `core.*`/`search.*`; **cross-source
money totals go through the kernel `FlowsRepo`, not here** (§4.3/§14.6).

```ts
export interface ProcurementRepo {
  // ---- procedures (526k; cursor by (publication_date, procedure_id)) ----
  listProcedures(
    f: ProcedureFilterInput,
    p: CursorPage
  ): Promise<Result<Page<ProcurementProcedure>, ApiError>>;
  getProcedure(id: string): Promise<Result<ProcurementProcedure | null, ApiError>>;
  getProcedureContracts(
    id: string,
    p: OffsetPage
  ): Promise<Result<Page<ProcurementContract>, ApiError>>; // procedure_id idx

  // ---- contracts (2.25M; cursor by (contract_date, contract_id)) ----
  listContracts(
    f: ContractFilterInput,
    p: CursorPage
  ): Promise<Result<Page<ProcurementContract>, ApiError>>;
  getContract(id: string): Promise<Result<ProcurementContract | null, ApiError>>;
  getContractModifications(
    id: string,
    p: OffsetPage
  ): Promise<Result<Page<ProcurementModification>, ApiError>>; // contract_id idx

  // ---- direct_acquisitions (19.8M; cursor ONLY by (finalization_date, da_id)) ----
  listDirectAcquisitions(
    f: DaFilterInput,
    p: CursorPage
  ): Promise<Result<Page<ProcurementDirectAcquisition>, ApiError>>;
  getDirectAcquisition(id: string): Promise<Result<ProcurementDirectAcquisition | null, ApiError>>;

  // ---- modifications (52k; cursor by (modification_date, modification_id)) ----
  listModifications(
    f: ModificationFilterInput,
    p: CursorPage
  ): Promise<Result<Page<ProcurementModification>, ApiError>>;
  // PC-8: modified by > X% — delta_pct computed in SQL, threshold pushed down
  listModificationsAboveDelta(
    pct: number,
    f: ModificationFilterInput,
    p: CursorPage
  ): Promise<Result<Page<ProcurementModification>, ApiError>>;

  // ---- CPV discovery (cpv_divisions clean; cpv_codes labels best-effort) ----
  listCpvDivisions(): Promise<Result<readonly CpvDivision[], ApiError>>;
  resolveCpv(q: string, limit: number): Promise<Result<readonly CpvMatch[], ApiError>>; // ILIKE on label_ro/division label
}

export interface ProcurementAggregateRepo {
  // The gate — read FIRST by every aggregate usecase.
  grainQuality(): Promise<Result<readonly GrainQuality[], ApiError>>;

  // PC-1 / PC-3 / PC-6 — org_edge_monthly_rollups, pruned by month_start range
  topSuppliersForAuthority(
    cui: string,
    f: EdgeAggFilter
  ): Promise<Result<readonly ProcurementEdge[], ApiError>>;
  topAuthoritiesForSupplier(
    cui: string,
    f: EdgeAggFilter
  ): Promise<Result<readonly ProcurementEdge[], ApiError>>;
  repeatedPairs(f: EdgeAggFilter): Promise<Result<readonly ProcurementEdge[], ApiError>>;

  // PC-5 — supplier concentration / HHI, computed over edges for one authority
  supplierConcentration(
    cui: string,
    f: EdgeAggFilter
  ): Promise<Result<SupplierConcentration, ApiError>>;

  // PC-4 — authority spend by CPV division × period (authority_cpv_division_monthly_rollups)
  authorityCpvSpend(
    cui: string,
    f: CpvAggFilter
  ): Promise<Result<readonly AuthorityCpvRow[], ApiError>>;

  // PC-2 — top suppliers by region × CPV division (supplier_cpv_division_monthly_rollups)
  topSuppliersByRegionCpv(
    f: RegionCpvAggFilter
  ): Promise<Result<readonly SupplierCpvRow[], ApiError>>;

  // PC-7 — same-day DA splitting candidates (same_day_direct_acquisition_candidates)
  sameDaySplittingCandidates(
    f: SplitFilter,
    p: OffsetPage
  ): Promise<Result<Page<SameDayCandidate>, ApiError>>;

  // contributor slices (see §4)
  presenceByCui(cui: string): Promise<Result<ProcurementPresence | null, ApiError>>;
  profileByCui(cui: string): Promise<Result<ProcurementProfileSlice | null, ApiError>>;
}
```

### 3a. Partition / rollup scheme (REQUIRED — §3, §14.10)

**There are no native table partitions.** `direct_acquisitions` (19.8M) and
`contracts` (2.25M) are plain heap tables (`pg_inherits` → 0 children, verified).
Scale is handled two ways, both mandatory in this plan:

**(1) Fact-table list endpoints — indexed-predicate bounding + cursor.** Every
list query over a big fact table MUST drive off an index and use cursor pagination
(never offset+COUNT). Driving indexes (from `pg_indexes`, live):

| Collection                    | Driving predicate / index                                                                                                                                                          | Cursor sort tuple                                | Hard cap                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------- |
| `direct_acquisitions` (19.8M) | `das_finalization_date_idx`, or `das_authority_cui_idx` / `das_supplier_cui_idx` / `das_cpv_code_idx` / `das_unique_code_idx` when a point filter is present                       | `(finalization_date desc, da_id desc)`           | pageSize ≤ 100             |
| `contracts` (2.25M)           | `contracts_contract_date_idx` / `contracts_authority_cui_idx` / `contracts_supplier_cui_idx` / `contracts_cpv_code_idx` / `contracts_procedure_id_idx` / `contracts_notice_no_idx` | `(contract_date desc, contract_id desc)`         | ≤ 100                      |
| `procedures` (526k)           | `procedures_publication_date_idx` / `procedures_authority_cui_idx` / `procedures_cpv_code_idx` / `procedures_notice_no_idx`                                                        | `(publication_date desc, procedure_id desc)`     | ≤ 100                      |
| `modifications` (52k)         | `contract_modifications_*` (contract_id / authority+contract_no / notice_no)                                                                                                       | `(modification_date desc, modification_id desc)` | offset OK (small, bounded) |

- **Rule:** a `direct_acquisitions` list with NO selective filter is rejected
  (`InvalidInput: "direct-acquisitions list requires authority_cui, supplier_cui,
cpv_code, or a date range"`) — a bare 19.8M cursor walk by date is allowed only
  with an explicit date window. `is_canonical = true` is forced on every list
  unless `includeDuplicates=true` (then results are labelled and capped tighter).
- **No blocking total** (§14.4): cursor pages return `meta.cursor`. For DAs the
  default is `totalEstimated: null` (no count at all). An optional estimate, when a
  client requests it, comes ONLY from the planner row estimate
  (`EXPLAIN (FORMAT JSON)` of the filtered query, read `Plan.Plan Rows`) and is
  returned as `{ total, estimated: true }`. **A real `COUNT(*)` over
  direct_acquisitions is never issued** — `pg_class.reltuples` is a whole-table
  figure and cannot be filter-scaled, so it is not used.

**(2) Aggregate / analytics endpoints — the 5 materialized views.** All top-N /
concentration / HHI / category / same-day / repeated-pair answers come from
**pre-aggregated MVs**, never from a live scan of the 19.8M facts. Each MV is built
over the `procurement_flow_facts_v1` **view** (which itself selects
`flows.money_flows where source_id='procurement'` and left-joins
`cpv_divisions` + `core.public_entities` + `core.territories`). Grain = monthly
(`month_start = date_trunc('month', flow_date)`), partitioned logically by
`source_grain` (= flow_type):

| MV                                               | grain / unique key                                                                                       | pruning predicate every endpoint uses                                                                                                               | catalog Q        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `org_edge_monthly_rollups` (8.34M)               | `(month_start, source_grain, authority_cui, supplier_cui, authority_county_code, authority_region)`      | `authority_cui = $1` **or** `supplier_cui = $1`, `source_grain = $g`, `month_start between $from and $to` (idx: `_authority_idx` / `_supplier_idx`) | PC-1, PC-3, PC-6 |
| `authority_cpv_division_monthly_rollups` (5.22M) | `(month_start, source_grain, authority_cui, authority_county_code, authority_region, cpv_division_code)` | `authority_cui = $1`, `source_grain = $g`, `month_start between` (idx `_authority_idx`)                                                             | PC-4             |
| `supplier_cpv_division_monthly_rollups` (9.26M)  | `(month_start, source_grain, authority_cui, supplier_cui, ..., cpv_division_code)`                       | `authority_region = $r` **+** `cpv_division_code = $d`, `source_grain = $g`, `month_start between` (idx `_region_idx` / `_supplier_idx`)            | PC-2             |
| `same_day_direct_acquisition_candidates` (1.16M) | `(candidate_date, authority_cui, supplier_cui, cpv_code, cpv_division_code)`, `having count>1`           | `authority_cui = $1` (idx `_authority_idx`) and/or `candidate_date between`; grain implicitly `direct_acquisition`                                  | PC-7             |
| `aggregate_quality_by_grain` (2)                 | `source_grain` (the gate)                                                                                | read whole (2 rows)                                                                                                                                 | gate             |

- **The pruning predicate is always `source_grain = $grain AND month_start
BETWEEN $from AND $to` plus the dimension equality** (`authority_cui` /
  `supplier_cui` / `authority_region` / `cpv_division_code`). Endpoints that ask
  "across all time" still bound by `month_start >= '2011-07-01'` (the MV min) to
  keep the planner range-scanning the dims index.
- **Refresh ownership:** MVs are `WITH NO DATA` in the migration and refreshed by
  the scrapper loader's aggregate-filters stage (loader-completion version stamp,
  §10/§14.11). The server **never** refreshes them; it reads `refreshed_at` and
  `projection_version` and surfaces them as the as-of watermark.
- **Combining grains is forbidden in one number** (§14.6): "contracts + DAs"
  answers return **two labelled grain blocks**, never a summed scalar.

---

## 4. Usecases

`procurement/core/usecases/*` — framework-free, over the ports, `Result`-returning.
Thin resolvers/handlers call these; tri-surface parity flows from one usecase per op.

| Usecase                           | Signature                                                      | Notes                              |
| --------------------------------- | -------------------------------------------------------------- | ---------------------------------- |
| `searchProcedures`                | `(f, page) → Page<ProcurementProcedure>`                       | §3a(1) bounded                     |
| `getProcedureDetail`              | `(id) → ProcedureDetail` (procedure + linked contracts head)   |                                    |
| `searchContracts`                 | `(f, page) → Page<ProcurementContract>`                        | canonical-only default             |
| `getContractDetail`               | `(id) → ContractDetail` (contract + modifications + procedure) |                                    |
| `searchDirectAcquisitions`        | `(f, page) → Page<...>`                                        | **selective-filter required**      |
| `getDirectAcquisitionDetail`      | `(id) → ...`                                                   |                                    |
| `listContractModifications`       | `(f, page)` / `aboveDelta(pct, f, page)`                       | PC-8                               |
| `topSuppliers` / `topAuthorities` | `(cui, aggFilter) → Edge[]`                                    | PC-1/PC-3 via gate                 |
| `supplierConcentration`           | `(cui, aggFilter) → SupplierConcentration`                     | PC-5; gate-aware                   |
| `repeatedPairs`                   | `(aggFilter) → Edge[]`                                         | PC-6                               |
| `authorityCpvSpend`               | `(cui, aggFilter) → AuthorityCpvRow[]`                         | PC-4                               |
| `topSuppliersByRegionCpv`         | `(regionCpvFilter) → SupplierCpvRow[]`                         | PC-2                               |
| `sameDaySplittingCandidates`      | `(filter, page) → Page<SameDayCandidate>`                      | PC-7; "candidate ≠ illegal" caveat |
| `resolveProcurementFilter`        | `(dim, q) → ResolveHit[]`                                      | discovery (§7.4)                   |

**Gate enforcement is in the usecase, not the repo** (live read of `grainQuality()`
first, all three booleans):

- `filter_answers_allowed=false` (requested grain) → **abstain**: empty `data` +
  `caveats` listing the grain's `blockers`; no fabricated aggregate.
- `spend_rankings_allowed=false` → return rows (with `amountRonSum` present for
  transparency) but **rank by `flow_count`**, set `caveats:["spend rankings not
gate-approved for <grain> grain"]`, and compute concentration/share **count-based**
  (see §7.5 / I6) — never errors, degrades.
- `supplier_region_filters_allowed=false` + a supplier-region filter supplied →
  `InvalidInput`.

Because the gate is recomputed every reload, none of these decisions are baked into
code constants — they are data-driven off the live MV.

**Cross-source contributor (§4.4 / §14.7):** the module registers a
`SourceContributor` with `source = 'procurement'`:

- `presenceFor(cui)` → `{ source:'procurement', asAuthority:{contractCount, daCount, totalRon}, asSupplier:{contractCount, daCount, totalRon} }` — computed from `org_edge_monthly_rollups` (cheap, indexed by cui), grain-labelled.
- `profileSlice(cui)` → top-5 counterparties each direction + spend-by-CPV-division top-5 + total-by-grain, all rollup-backed, gate-aware. This is the **same** method `Entity.procurement` GraphQL resolver and REST entity-360 call.
- Registers `flow_type` values **`procurement_contract`, `direct_acquisition`** into the kernel `FLOW_TYPES` enum.
- Registers `doc_type`s **`procurement_procedure`, `procurement_contract`, `procurement_direct_acquisition`** (§9).

---

## 5. REST endpoints

Prefix `/api/v1/procurement/`. All query/param/body validated with TypeBox derived
from the filter spec (§7). Envelope per §5.2 + `requestId` (§14.11). Public-read
(`config:{ public:true }`, §14.11). Caching read-through, key
`procurement:<op>:<canonicalizeFilters>`; TTL + loader-version stamp.

| Method | Path                                          | Query/params                                              | Response                                        | Pagination          | Cache TTL | stmt timeout |
| ------ | --------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- | ------------------- | --------- | ------------ |
| GET    | `/procurement/procedures`                     | `ProcedureFilter` (§7)                                    | `ProcurementProcedure[]`                        | cursor              | 5m        | 5s           |
| GET    | `/procurement/procedures/:id`                 | path id                                                   | `ProcedureDetail`                               | —                   | 10m       | 5s           |
| GET    | `/procurement/contracts`                      | `ContractFilter`                                          | `ProcurementContract[]`                         | cursor              | 5m        | 5s           |
| GET    | `/procurement/contracts/:id`                  | path id                                                   | `ContractDetail` (+ modifications, +procedure)  | —                   | 10m       | 5s           |
| GET    | `/procurement/contracts/:id/modifications`    | path id, offset                                           | `ProcurementModification[]`                     | offset              | 10m       | 5s           |
| GET    | `/procurement/direct-acquisitions`            | `DaFilter` (**selective filter required**)                | `ProcurementDirectAcquisition[]`                | cursor              | 5m        | 5s           |
| GET    | `/procurement/direct-acquisitions/:id`        | path id                                                   | DA detail                                       | —                   | 10m       | 5s           |
| GET    | `/procurement/modifications`                  | `ModificationFilter` (+`minDeltaPct`)                     | `ProcurementModification[]`                     | cursor              | 5m        | 5s           |
| GET    | `/procurement/aggregate/top-suppliers`        | `authorityCui` (req), `EdgeAggFilter`                     | `ProcurementEdge[]` (+grain block)              | offset (top-N ≤100) | 15m       | 15s          |
| GET    | `/procurement/aggregate/top-authorities`      | `supplierCui` (req), `EdgeAggFilter`                      | `ProcurementEdge[]`                             | offset              | 15m       | 15s          |
| GET    | `/procurement/aggregate/concentration`        | `authorityCui` (req), `EdgeAggFilter`                     | `SupplierConcentration`                         | —                   | 15m       | 15s          |
| GET    | `/procurement/aggregate/repeated-pairs`       | `EdgeAggFilter` (req authority or supplier)               | `ProcurementEdge[]`                             | offset              | 15m       | 15s          |
| GET    | `/procurement/aggregate/authority-cpv`        | `authorityCui` (req), `CpvAggFilter`                      | `AuthorityCpvRow[]`                             | offset              | 15m       | 15s          |
| GET    | `/procurement/aggregate/region-cpv-suppliers` | `region` (req), `cpvDivision` (req), `RegionCpvAggFilter` | `SupplierCpvRow[]`                              | offset              | 15m       | 15s          |
| GET    | `/procurement/aggregate/same-day-candidates`  | `SplitFilter` (req authorityCui or date range)            | `SameDayCandidate[]`                            | offset              | 15m       | 15s          |
| GET    | `/procurement/aggregate/grain-quality`        | —                                                         | `GrainQuality[]` (the gate, with `refreshedAt`) | —                   | 30m       | 5s           |
| GET    | `/procurement/cpv/divisions`                  | —                                                         | `CpvDivision[]` (45)                            | —                   | 1h        | 5s           |
| GET    | `/procurement/filters/resolve`                | `dim`, `q`                                                | `ResolveHit[]` (§7.4)                           | —                   | 10m       | 5s           |

- **OpenAPI:** module exports a fragment merged at `/api/v1/openapi.json`; every
  aggregate response carries `grain`, `projectionVersion`, `refreshedAt`, and a
  `caveats: string[]` field driven by the grain gate + data-quality notes.
- All aggregate endpoints state grain explicitly (`grain` param, enum
  `direct_acquisition|procurement_contract`, default `direct_acquisition` since it
  is the higher-coverage grain). Mixed-grain is returned as two blocks.

---

## 6. GraphQL

Schema-stitched (§6.2). All types `Procurement`-prefixed (§14.8). Connections reuse
the kernel cursor encoder (`fhash`, §14.3). Resolvers are thin → same usecases.

```graphql
enum ProcurementGrain {
  direct_acquisition
  procurement_contract
}
enum ProcurementContractStatus {
  awarded
  in_progress
  closed
  cancelled
  unknown
}
enum ProcurementProcedureStatus {
  published
  in_evaluation
  awarded
  cancelled
  suspended
  unknown
}
enum ProcurementDaStatus {
  offered
  awarded
  finalized
  cancelled
  unknown
}
enum ProcurementSortKey {
  contract_date
  publication_date
  finalization_date
  value_ron
  modification_date
}

type ProcurementContract {
  contractId: ID!
  contractKey: String!
  procedureId: ID
  noticeNo: String
  contractNo: String
  contractDate: Date
  title: String
  authority: Entity # resolved via kernel IdentityRepo + DataLoader keyed by authorityCui
  supplier: Entity # resolved by supplierCui
  authorityCui: CUI
  supplierCui: CUI
  cpvCode: String
  cpvDivision: ProcurementCpvDivision
  valueRon: Money
  estimatedValueRon: Money
  currency: String
  status: ProcurementContractStatus!
  countyName: String
  isCanonical: Boolean!
  modifications(first: Int, after: String): ProcurementModificationConnection!
}
type ProcurementProcedure {
  procedureId: ID!
  noticeNo: String
  procedureType: String
  contractKind: String
  title: String
  authority: Entity
  authorityCui: CUI
  cpvCode: String
  cpvDivision: ProcurementCpvDivision
  estimatedValueRon: Money
  awardedValueRon: Money
  status: ProcurementProcedureStatus!
  publicationDate: Date
  contracts(first: Int, after: String): ProcurementContractConnection!
}
type ProcurementDirectAcquisition {
  daId: ID!
  uniqueCode: String
  title: String
  authority: Entity
  supplier: Entity
  authorityCui: CUI
  supplierCui: CUI
  cpvCode: String
  cpvDivision: ProcurementCpvDivision
  valueRon: Money
  status: ProcurementDaStatus!
  publicationDate: Date
  finalizationDate: Date
  isCanonical: Boolean!
}
type ProcurementModification {
  modificationId: ID!
  contractId: ID
  linkMethod: String
  valueBeforeRon: Money
  valueAfterRon: Money
  valueDeltaRon: Money
  deltaPct: Float
  modificationDate: Date
}
type ProcurementCpvDivision {
  code: String!
  labelEn: String!
  labelRo: String
}

# Aggregate types (rollup-backed)
type ProcurementEdge {
  authorityCui: CUI!
  authorityName: String
  supplierCui: CUI!
  supplierName: String
  grain: ProcurementGrain!
  flowCount: BigInt!
  amountRonSum: Money
  amountPresentCount: BigInt!
  amountMissingCount: BigInt!
  firstFlowDate: Date
  lastFlowDate: Date
  evidenceRefsSample: [String!]!
} # field set MUST match §2 ProcurementEdge view model (tri-surface parity)
type ProcurementConcentration {
  authorityCui: CUI!
  grain: ProcurementGrain!
  supplierCount: Int!
  top1Share: Float
  top5Share: Float
  hhi: Float
  totalRon: Money
  caveats: [String!]!
}
type ProcurementGrainQuality {
  grain: ProcurementGrain!
  rowsCount: BigInt!
  authorityCuiCoverageRate: Float!
  supplierCuiCoverageRate: Float!
  amountCoverageRate: Float!
  cpvCoverageRate: Float!
  dateCoverageRate: Float!
  authorityTerritoryCoverageRate: Float!
  filterAnswersAllowed: Boolean!
  spendRankingsAllowed: Boolean!
  supplierRegionFiltersAllowed: Boolean!
  blockers: [String!]!
  refreshedAt: DateTime
}

# Relay connections (cursor parity with REST)
type ProcurementContractConnection {
  edges: [ProcurementContractEdge!]!
  pageInfo: PageInfo!
  totalEstimated: Int
}
# ... ProcurementProcedureConnection / ...DirectAcquisitionConnection / ...ModificationConnection identical shape

extend type Query {
  procurementContract(id: ID!): ProcurementContract
  procurementContracts(
    filter: ProcurementContractFilter
    first: Int
    after: String
  ): ProcurementContractConnection!
  procurementProcedure(id: ID!): ProcurementProcedure
  procurementProcedures(
    filter: ProcurementProcedureFilter
    first: Int
    after: String
  ): ProcurementProcedureConnection!
  procurementDirectAcquisitions(
    filter: ProcurementDaFilter!
    first: Int
    after: String
  ): ProcurementDirectAcquisitionConnection!
  procurementModifications(
    filter: ProcurementModificationFilter
    first: Int
    after: String
  ): ProcurementModificationConnection!
  procurementTopSuppliers(authorityCui: CUI!, filter: ProcurementEdgeAggFilter): [ProcurementEdge!]!
  procurementTopAuthorities(
    supplierCui: CUI!
    filter: ProcurementEdgeAggFilter
  ): [ProcurementEdge!]!
  procurementConcentration(
    authorityCui: CUI!
    filter: ProcurementEdgeAggFilter
  ): ProcurementConcentration!
  procurementSameDayCandidates(
    filter: ProcurementSplitFilter!
    page: OffsetPageInput
  ): [ProcurementSameDayCandidate!]!
  procurementGrainQuality: [ProcurementGrainQuality!]!
}

# Entity join (§6.2 / §14.7) — resolved via contributor.profileSlice(cui), DataLoader keyed by CUI
extend type Entity {
  procurement: ProcurementEntitySummary
}
type ProcurementEntitySummary {
  asAuthority: ProcurementRoleSummary! # contractCount, daCount, totalRon (grain-labelled), topSuppliers[5]
  asSupplier: ProcurementRoleSummary! # contractCount, daCount, totalRon, topAuthorities[5]
  spendByCpvDivision: [ProcurementEdge!]!
  caveats: [String!]!
}
```

- `Entity.authority`/`Entity.supplier` and `Entity.procurement` all resolve through
  **one CUI-keyed DataLoader** per request (no N+1 on list fan-out). The DA filter
  arg is **non-null** (`procurementDirectAcquisitions(filter: ProcurementDaFilter!`)
  to structurally enforce §3a(1)'s selective-filter rule at the schema boundary.
- A kernel CI conflict test (§14.8) asserts the stitched schema has no bare/duplicate
  type — all names here are `Procurement*`.

---

## 7. Filters — collection specs (priority area)

Each spec is declared once (`CollectionFilterSpec`, §14.2) → derives TypeBox (REST),
GraphQL `input`, and MCP fragment; compiles via the kernel composer to parameterized
`sql\`\``. `canonicalizeFilters`feeds cache key + cursor`fhash` + tri-surface test.
**`isNull` is supported on coverage-relevant fields\*\* (catalog presence questions).

**Shared families used (§7.2):** Entity (`cui[]`, `name~`), Territory (buyer:
`countyCode[]`, `region[]`), Period (`year`, `dateFrom/To`, `month`), Amount
(`minValueRon`, `maxValueRon`), Classification (CPV: `cpvCode[]`, `cpvCodePrefix[]`,
`cpvDivision[]`), Status/Enum (per-grain status), Exclusion (negatable fields).

### 7.1 `ProcedureFilter`

| Field                       | op(s)      | driving column / index                                                              | REST ↔ GraphQL ↔ MCP            |
| --------------------------- | ---------- | ----------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `authorityCui[]`            | in         | `procedures.authority_cui` / `procedures_authority_cui_idx`                         | CSV param ↔ `[CUI]` ↔ `cui[]`   |
| `cpvCode[]`                 | in         | `procedures.cpv_code` / `procedures_cpv_code_idx`                                   |                                 |
| `cpvCodePrefix[]`           | prefix     | `cpv_code LIKE $p                                                                   |                                 | '%'` (left-anchored → uses idx)                                                                                         |                                     |
| `cpvDivision[]`             | in         | **index-safe range, NOT `substring()`**: `cpv_code >= $d                            |                                 | '000000' AND cpv_code < successor($d)`(uses`\*\_cpv_code_idx`; no functional index exists on `substring(cpv_code,1,2)`) | derive 2-digit from `cpv_divisions` |
| `procedureType`             | eq/in      | `procedures.procedure_type` (no idx; selective with authority)                      | closed enum from observed vocab |
| `contractKind`              | eq         | `procedures.contract_kind` (works/services/supplies)                                |                                 |
| `status`                    | eq/in      | `procedures.status` (enum)                                                          |                                 |
| `noticeNo`                  | eq         | `procedures_notice_no_idx`                                                          |                                 |
| `year` / `dateFrom/To`      | eq/between | `procedures.publication_date` / `procedures_publication_date_idx`                   |                                 |
| `countyCode[]`/`region[]`   | in         | resolved buyer territory via `core` join                                            | buyer side only                 |
| `minValueRon`/`maxValueRon` | gte/lte    | `estimated_value_ron` / `awarded_value_ron` (declare which)                         | overflow-guarded                |
| `q`                         | contains   | **Meili** (autocomplete) / **OpenSearch** (full-text) on title; PG `ILIKE` fallback | engine declared per call        |

- Sort: default `publication_date desc`; allowed `{publication_date, estimated_value_ron}`.

### 7.2 `ContractFilter`

Same shape, driving columns on `contracts.*`: `authorityCui[]`/`supplierCui[]`
(`_authority_cui_idx`/`_supplier_cui_idx`), `cpvCode[]`/prefix/division
(`_cpv_code_idx`), `status` (enum `awarded|in_progress|closed|cancelled|unknown`),
`year`/`dateFrom/To` → `contract_date` (`_contract_date_idx`), `noticeNo`
(`_notice_no_idx`), `procedureId` (`_procedure_id_idx`), `minValueRon`/`maxValueRon`
→ `value_ron`, `includeDuplicates` (bool, default false → forces `is_canonical=true`).
Sort default `contract_date desc`; allowed `{contract_date, value_ron}`.

### 7.3 `DaFilter` (HIGH VOLUME — selective filter required)

Driving columns on `direct_acquisitions.*`: `authorityCui[]`/`supplierCui[]`,
`cpvCode[]`/prefix/division, `uniqueCode` (`_unique_code_idx`), `sourceSystem`
(`elicitatie_da|seap_da|seap_dan`), `status` (`offered|awarded|finalized|cancelled|unknown`),
`year`/`dateFrom/To` → `finalization_date` (`_finalization_date_idx`; note
publication*date is 100% null on elicitatie_da — **date filter binds to
finalization_date** and the spec documents that), `minValueRon`/`maxValueRon`,
`includeDuplicates`. `cpvDivision[]` uses the same index-safe range as §7.1 (never
`substring`). **Validation (all three surfaces):** the spec is marked
`requiresSelective: true`; the kernel composer applies a **runtime** check on the
\_resolved* filter object and rejects an empty / non-selective filter with
`InvalidInput` for REST, GraphQL, and MCP alike. GraphQL's non-null `filter` arg only
guarantees the wrapper object exists — `ProcurementDaFilter{}` still trips the runtime
`requiresSelective` check. A selective filter = at least one of `authorityCui`,
`supplierCui`, `cpvCode`/`cpvDivision`, `uniqueCode`, or a bounded date range
(≤ `PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS`). This enforces §3a(1)/§14.4.
Sort default `finalization_date desc`.

### 7.4 `ModificationFilter`

`contractId`, `authorityCui`+`contractNo`, `noticeNo` (the indexed link columns),
`year`, `dateFrom/To` → `modification_date`, `minDeltaPct` (PC-8 — computed
`value_delta_ron/nullif(value_before_ron,0)`), `linkMethod` (enum/`isNull` for PC-10
"missing linkage"). `modificationType` eq.

### 7.5 Aggregate filters (rollup-backed; §3a(2))

- `EdgeAggFilter`: `grain` (enum, default `direct_acquisition`), `monthFrom/To`
  (→ `month_start between`), `topN` (≤100), optional `countyCode`/`region` (buyer),
  optional `cpvDivision`. Pruning predicate fixed to dim + grain + month range.
- `CpvAggFilter`: `grain`, `cpvDivision[]`, `monthFrom/To`, `topN`.
- `RegionCpvAggFilter`: `region` (req), `cpvDivision` (req), `grain`, `monthFrom/To`, `topN`.
- `SplitFilter`: `authorityCui` and/or `candidateDateFrom/To`, `minSameDayCount`
  (default 2), `cpvDivision`.
- **Gate-coupled validation:** any aggregate filter that requests a
  supplier-side region dimension → rejected (`supplier_region_filters_allowed=false`);
  any request to sort the `procurement_contract` grain by value → silently degraded
  to flow_count ordering with a caveat (`spend_rankings_allowed=false`).

### 7.6 Discovery / resolve dimensions (§7.4)

`/procurement/filters/resolve?dim=&q=` and the MCP discovery tool expose:
`authority` (name → CUI via kernel IdentityRepo, public_entity kind), `supplier`
(name → CUI via IdentityRepo company kind), `cpvDivision` (Romanian/English label →
2-digit code from `cpv_divisions`), `cpv` (label → 8-digit best-effort from
`cpv_codes.label_ro` — **flagged low-confidence; verify `label_ro` coverage at
build, and if it is poor, downgrade `cpv` resolution to code-echo only** since the
catalog warns the whole `cpv_codes` table is unreliable), `region`/`county` (name →
code via TerritoryRepo). Names→codes resolve FIRST; the deterministic SQL then computes.

### 7.7 Golden question → filter examples (catalog PC-1..PC-10)

| Catalog                                      | Resolves to                                                                                                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PC-1 top suppliers of authority X, period T  | `topSuppliers(cui=X, {grain, monthFrom/To, topN})` → org_edge MV; `share_of_institution_total` over the **basis measure** (value when `spend_rankings_allowed`, else flow_count — never a value share for a spend-suppressed grain) |
| PC-2 top suppliers to region R, kind K       | `topSuppliersByRegionCpv({region=R, cpvDivision=d(K), grain})` → supplier_cpv MV                                                                                                                                                    |
| PC-3 top authorities buying from Y           | `topAuthorities(cui=Y, {grain, monthFrom/To})` → org_edge MV; `last_contract_date`=`max(last_flow_date)`                                                                                                                            |
| PC-4 authority X spend by CPV × year         | `authorityCpvSpend(cui=X, {cpvDivision[], monthFrom/To→year})` → authority_cpv MV                                                                                                                                                   |
| PC-5 supplier concentration for X            | `supplierConcentration(cui=X, {grain})` — top1/top5 share + HHI over edges; **`basis='value'` only when the grain's `spend_rankings_allowed=true`, else `basis='count'` (shares/HHI over flow_count, `totalRon=null`)**             |
| PC-6 repeated buyer-supplier pairs           | `repeatedPairs({authorityCui or supplierCui, minMonths})` → org_edge MV, first/last_flow_date                                                                                                                                       |
| PC-7 same-day DA splitting                   | `sameDaySplittingCandidates({authorityCui, dateFrom/To, minSameDayCount})` → same_day MV                                                                                                                                            |
| PC-8 contracts modified > X%                 | `listModificationsAboveDelta(pct, filter)` → modifications, delta_pct in SQL                                                                                                                                                        |
| PC-9 awards to recently-registered suppliers | **cross-source** — supplier list from contracts + supplier `registration_date` from `companies` via kernel; **labelled cross-grain** (NOT this module alone)                                                                        |
| PC-10 procedures/contracts without linkage   | `searchContracts({procedureId isNull})` + `listModifications({linkMethod isNull})` (`missing_link_count`)                                                                                                                           |

### 7a. Catalog ↔ live-schema reconciliation (REQUIRED — §14.10)

| Catalog logical name                                                                      | Live object                                                                                       | Reconciliation note                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `procurement.org_edges` rollup keyed `(authority_cui, supplier_cui, period, category)`    | `procurement.org_edge_monthly_rollups` (matview)                                                  | period = `month_start` (monthly grain); **category is NOT in this MV** — CPV-division category lives in `authority_cpv_division_monthly_rollups` / `supplier_cpv_division_monthly_rollups`. org_edge has NO cpv dimension. Endpoints route PC-2/PC-4 to the cpv-division MVs, PC-1/3/6 to org_edge. |
| "canonical procurement fact table or view, single declared grain"                         | `procurement.procurement_flow_facts_v1` (view over `flows.money_flows`)                           | the canonical fact surface; its `source_grain` column = `flow_type` (`direct_acquisition`/`procurement_contract`).                                                                                                                                                                                  |
| "rebuilt CPV dictionary … do not rely on the currently corrupt `procurement.cpv_codes`"   | `procurement.cpv_divisions` (45 clean) + `cpv_codes` (9,748, `cpv_level`/`parent_code` 100% NULL) | **CONFIRMED corrupt** (live: 0/9748 have cpv_level). Hierarchy + category filters use `cpv_divisions` (2-digit) ONLY; raw 8-digit `cpv_code`+best-effort label allowed for display, never for tree navigation. CPV discovery flags `cpv` (8-digit) hits low-confidence.                             |
| "buyer territory from core.public_entities; supplier territory from company registration" | buyer: pre-joined in flow-facts (`authority_county_code/region`); supplier: **absent**            | buyer-region filters supported; supplier-region filters **gate-blocked** (`supplier_region_filters_allowed=false`) until backfill.                                                                                                                                                                  |
| "explicit duplicate/canonical rules"                                                      | `is_canonical` + `dup_group_id` on contracts/DAs; flows/rollups read canonical only               | every base-table list forces `is_canonical=true` by default.                                                                                                                                                                                                                                        |

---

## 8. MCP tools

The procurement module registers four MCP tools. All use strict Zod input
objects so unknown top-level or nested scope keys are rejected before handler
execution:

- `resolve_procurement_filter` — resolves the procurement-owned CPV dimensions.
- `search_procurement_contracts` — bounded contract search.
- `search_procurement_direct_acquisitions` — bounded DA search with a required
  selective filter.
- `aggregate_procurement` — the generation-stamped stats, series, breakdown,
  and supplier-concentration surface. Unsupported combinations are named matrix
  errors; answers carry `served | degraded | abstained`, a typed reason,
  generation metadata, caveats, and `canonicalScope`.

The six legacy aggregate MCP tools and their stale-MV gate logic were removed
before deployment. The separate legacy `/mcp` tool `query_procurement_filters`
and its MCP-private stale aggregate repository were also removed; `/mcp` now
retains budget tools only. Entity/detail search remains separate from the analysis
generation and is not disabled by an analysis matrix mismatch. Real client deep
links remain deferred; `canonicalScope` is serialization, not a URL.

---

## 9. Search integration

**Owned `doc_type`s** (migration `20260615T180000`, all 3 in the live
`documents_type_check`): `procurement_procedure`, `procurement_contract`,
`procurement_direct_acquisition`. Live count across the three: **2,782,639** rows in
`search.documents`.

- **Projection** (scrapper `search` lane writes; server only reads): each canonical
  serving row → one `search.documents` row (`title` = contract/procedure title,
  `body` = authority+supplier+CPV-label composite, `cuis` = `{authority_cui,
supplier_cui}`, `doc_date` = contract/finalization date, `amount_ron` = value_ron,
  `county_name`, `url` = client deep link, `attrs` = grain + status). DAs are
  projected canonical-only (no duplicate/non-canonical doc rows).
- **Meili** index `procurement` (or shared `entities`) backs autocomplete on
  authority/supplier name + title (the `q` field for name resolution).
- **OpenSearch** index `procurement_documents` backs full-text + terms aggregations
  on title/body; `q` on list endpoints declares OS as the engine when ranking is
  needed, Meili for prefix.
- **Semantic/pgvector:** `SearchCapabilities.semantic` gated (§14.5) — no vector
  column on `search.documents` today; semantic procurement retrieval returns `null` +
  `caveats:["semantic search unavailable"]`. (The scrapper has a procurement
  title+body embedding experiment in raw, not yet projected to serving.)
- **Determinism rule (catalog):** search resolves names→CUIs/CPV but **never
  computes totals** — every numeric answer comes from the deterministic
  rollups/tables, not from OS aggregations.

---

## 10. Sync / freshness impact on serving

Loader cadence (scrapper, `PUBLIC_CONTRACTS_NOTES.md` §I): **daily** e-licitatie
incremental load on the prod watermark; **monthly** SEAP CKAN repoll →
replace-by-resource + stale-delete; flows + the 5 MVs re-derived/refreshed each load;
nightly hardened `validate-prod`. (CronJobs authored, currently `suspend:true` —
GitOps-ready; the server must not assume sub-daily freshness.)

- **As-of semantics:** every aggregate response surfaces the MV `refreshed_at` +
  `projection_version` (both are **confirmed live columns** on every rollup MV) as the
  domain freshness/"as-of" watermark (§14.11). For entity-list responses the
  loader-completion stamp is read from `etl.load_runs` (latest `procurement` row) IF
  that table exists and is granted to the serving role — **this must be verified at
  wiring** (the migration bootstraps `etl.load_runs`, but the `_prod-schema` snapshot
  doesn't cover `etl.*` and the serving grant is unconfirmed). Fallback when absent:
  the MV `refreshed_at`/`projection_version` + TTL only (state it in the response).
- **Cache TTLs** chosen for daily cadence: entity lists/details 5–10m, aggregates
  15m, the grain gate 30m, CPV divisions 1h. Invalidation is TTL + version-stamp
  bust on a new completed load run; never on the request path.
- **Mutability the API must reflect:** status moves (procedures awarded→cancelled,
  DAs offered→finalized) and contract value modifications update rows in place
  (`updated_at`); the server reads current state (status_events deferred — history
  lives in raw snapshots). A response is "current as of `refreshed_at`", not a
  point-in-time snapshot.

---

## 11. Wiring

```ts
makeProcurementModule({ db, identityRepo, territoryRepo, flowsRepo, searchClient,
  cache, capabilities }): ProcurementModule
// → { restPlugin, graphql:{ typeDefs, resolvers }, mcpTools, contributor, repos }
```

- **Deps:** kernel `db` (typed `ProdDatabase`), `IdentityRepo`/`TerritoryRepo`
  (CUI/SIRUTA resolution for `Entity` + territory filters), `FlowsRepo` (only for the
  cross-source entity-360 flow summary — NOT for this module's native top-N),
  `SearchClient`, `cache`, `SearchCapabilities`.
- **Env additions:** none source-specific (uses kernel `PROD_DATABASE_URL`,
  `MEILI_*`, `OPENSEARCH_URL`); optional `PROCUREMENT_DA_LIST_MAX_WINDOW_DAYS`
  (default 366) to bound bare-date DA walks. Module feature-flaggable off via the
  kernel module-enable env list.
- **build-app registration:** REST plugin at `/api/v1/procurement`, GraphQL slice
  merged into root Query + `Entity` extension, MCP tools registered, contributor
  (`source='procurement'`) registered into the kernel registry. Order-independent.
- **Legacy superseded:** the unified-explorer procurement/contracts surfaces
  (`feat/unified-explorer` `src/modules/unified/…contracts`) — those blurred
  award/contract and drowned procedures under DAs; this module replaces them with the
  three-table grain + rollup MVs. Legacy keeps running until the #19 cutover.

---

## 12. Testing

- **Unit** (`tests/unit/procurement/`): filter spec → SQL compilation snapshots for
  each collection (esp. DA `requiresSelective` rejection, CPV prefix left-anchored,
  `isNull` for PC-10/coverage); cursor encode/decode incl. `fhash` mismatch →
  `InvalidInput`; mappers (Money string, bigint string, grain enums); **gate
  enforcement** (procurement_contract value-sort degrade; supplier-region reject).
- **Integration** (`tests/integration/procurement/`): REST + GraphQL + MCP against a
  seeded fixture schema — tri-surface equivalence (same `canonicalizeFilters` → same
  rows) for contracts/DA/aggregate; aggregate endpoints read the gate; cursor
  pagination on 19.8M-shaped fixture without COUNT; `Entity.procurement` DataLoader
  no-N+1 assertion.
- **Golden filters:** PC-1..PC-10 from the catalog as integration cases (table §7.7),
  each asserting it routes to the correct MV/table and respects the grain gate.
- **Data-quality guards:** test that CPV hierarchy never reads `cpv_codes.cpv_level`;
  that non-canonical rows never appear without `includeDuplicates`; that
  combining-grains responses are two labelled blocks (never one summed scalar).

---

## 13. Open questions / risks

1. **`procurement_contract` spend rankings gate-suppressed** (amount coverage below
   threshold). Confirmed in the live gate. Decision: surface contract _counts_ and
   flow facts but suppress value rankings for that grain until coverage improves —
   OR (alt) lower the threshold once the audit's contract value fixes fully land.
   _Recommend:_ keep suppressed + caveat; this is correct given the data.
2. **DA list bare-walk policy.** `requiresSelective` rejects unfiltered 19.8M list;
   a date-only window is allowed. Is a 366-day default window cap acceptable, or
   should DA list always require an entity/cpv filter? _Recommend:_ allow date-window
   but cap span (env-tunable).
3. **PC-9 (young suppliers) is cross-source** (needs `companies.registration_date`).
   Per §4.4 it belongs in a kernel cross-source usecase / `Entity` composition, not
   this module alone — confirm the orchestrator places it there.
4. **CPV deep hierarchy.** `cpv_codes` is corrupt; only the 45 divisions are clean.
   If category analytics below division level is later required, the scrapper must
   rebuild the CPV-2008 tree (catalog "rebuilt CPV dictionary"). Out of v1 server
   scope (data fix, not server).
5. **Residual data-quality (audit N1/N2 + elicitatie procedures publication_date,
   estimated currency-null)** ride the scrapper's next consolidation reload; the
   server's grain gate + caveats already degrade gracefully, but the gate
   `refreshed_at` must be re-checked after that reload so thresholds reflect fixed
   data.
6. **MV refresh windowing.** Full `REFRESH MATERIALIZED VIEW CONCURRENTLY` over
   8–9M-row MVs is loader-side; the server only needs to tolerate a stale read
   during refresh (the version stamp covers this) — confirm the loader uses
   `CONCURRENTLY` so reads aren't blocked.

---

## 14. Adversarial review (incorporated)

Reviewed by a second high-capability agent against `00-foundation` + the live schema,
in two rounds. First-round findings incorporated: (a) `source_grain` clarified
everywhere as `flow_type`, not source-system; (b) DA list selective-filter rule made
structural; (c) catalog `org_edges` has NO category — PC-2/PC-4 routed to the
cpv-division MVs, not org_edge; (d) gate-suppression of `procurement_contract` value
rankings made a usecase-level concern, degraded-not-error; (e) confirmed `cpv_codes`
corruption live (cpv_level 0/9748), hierarchy pinned to `cpv_divisions`; (f) PC-9
reassigned to cross-source kernel; (g) buyer-territory allowed / supplier-territory
gate-blocked.

Second-round (adversarial) findings incorporated:

- **C1** — the three grain-gate booleans are **computed at MV-refresh time**, not
  constants; the server reads them **live per request** (§0 reframed as a snapshot;
  §4 enforcement is data-driven).
- **C2** — `filter_answers_allowed=false` now has defined behavior (**abstain** with
  blockers caveat), so all three gate booleans are enforced (§0, §4).
- **I2** — `currency` documented as a **repurposed suspect-flag carrier** for non-RON
  (audit F1/F7), not a clean ISO code; mapped at the boundary (§2).
- **I4** — DA "estimated total" uses only the `EXPLAIN` plan-rows estimate; **no
  `COUNT(*)` and no `reltuples`-scaling** (§3a).
- **I5** — `requiresSelective` is a **runtime** check on all three surfaces
  (GraphQL non-null is necessary-not-sufficient) (§7.3).
- **I6** — PC-1 share / PC-5 top-k / HHI are **count-based when the grain's spend
  rankings are gate-suppressed**, never value shares (§2 `SupplierConcentration`,
  §7.7).
- **I7** — `cpvDivision` compiles to an **index-safe range** over `cpv_code`, not a
  non-indexed `substring()` (§7.1/§7.3).
- **I3** — `etl.load_runs` version-stamp read flagged **verify-at-wiring**; MV
  `refreshed_at`/`projection_version` (confirmed columns) is the fallback (§10).
- **I8** — `cpv` 8-digit resolution downgraded to code-echo if `label_ro` coverage is
  poor (§7.6); **N3** excluded-column set enumerated (§2); **N5** all aggregate/helper
  row types defined (§2); **I1** `ProcurementEdge` field set reconciled REST↔GraphQL.
