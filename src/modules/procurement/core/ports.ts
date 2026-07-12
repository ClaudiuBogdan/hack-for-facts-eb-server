/**
 * Procurement module — repo ports (plan §3). All methods return
 * `Result<T, ApiError>`. Three repos:
 *   - `ProcurementRepo`          — the 4 base tables (procedures/contracts/DAs/mods).
 *   - `ProcurementAggregateRepo` — the legacy flow MVs + the grain gate (analyst
 *     queries, presence/profile).
 *   - `AnalysisRepo`             — the scraper-built `procurement.analysis_*`
 *     generation + wave-1 rollups (the six-shape surface, design §5).
 * Source repos touch only `procurement.*` + read-only `core.*`; cross-source money
 * totals go through the kernel `FlowsRepo`, NOT here (§4.3/§14.6).
 */

import type { AnalysisScope } from './analysis-scope.js';
import type { AnalysisRoute } from './combinations.js';
import type { MeasureId, SeriesBucket } from './constants.js';
import type { GenerationQuality } from './gate-v2.js';
import type { ProcurementSearchFilter } from './search.js';
import type {
  AuthorityCpvRow,
  ContractDetail,
  CpvAggFilter,
  CpvDivision,
  CpvMatch,
  DirectAcquisitionDetail,
  EdgeAggFilter,
  GrainQuality,
  OffsetSearchRequest,
  OffsetSearchResult,
  ProcedureDetail,
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementEdge,
  ProcurementModification,
  ProcurementProcedure,
  ProcurementProfileSlice,
  RegionCpvAggFilter,
  SameDayCandidate,
  SplitFilter,
  SupplierConcentration,
  SupplierCpvRow,
  SupplierRecordConnection,
} from './types.js';
import type { ApiError, CursorPage, FilterInput, SourcePresence } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/** A cursor page request (first + opaque after + sort key). */
export interface CursorPageRequest {
  readonly first: number;
  readonly after?: string;
  readonly sort?: string;
}

/** A bounded offset page request (small, bounded collections only). */
export interface OffsetPageRequest {
  readonly page: number;
  readonly pageSize: number;
}

export interface OffsetResult<T> {
  readonly items: readonly T[];
  /** Planner-estimated total (no blocking COUNT on the fact tables). */
  readonly total: number | null;
  readonly estimated: boolean;
}

export interface ProcurementRepo {
  // ── procedures (cursor by (publication_date desc, procedure_id desc)) ──
  listProcedures(
    f: FilterInput,
    p: CursorPageRequest
  ): Promise<Result<CursorPage<ProcurementProcedure>, ApiError>>;
  getProcedure(id: string): Promise<Result<ProcurementProcedure | null, ApiError>>;
  getProcedureDetail(id: string): Promise<Result<ProcedureDetail | null, ApiError>>;

  // ── contracts (cursor by (contract_date desc, contract_id desc)) ──
  listContracts(
    f: FilterInput,
    p: CursorPageRequest
  ): Promise<Result<CursorPage<ProcurementContract>, ApiError>>;
  getContract(id: string): Promise<Result<ProcurementContract | null, ApiError>>;
  getContractDetail(id: string): Promise<Result<ContractDetail | null, ApiError>>;
  /** Per-contract modifications — bounded (capped, contract_id-indexed); no pagination needed. */
  getContractModifications(
    id: string
  ): Promise<Result<readonly ProcurementModification[], ApiError>>;

  // ── direct_acquisitions (cursor ONLY by (finalization_date desc, da_id desc);
  //    selective filter REQUIRED — runtime check, §3a(1)/§7.3) ──
  listDirectAcquisitions(
    f: FilterInput,
    p: CursorPageRequest
  ): Promise<Result<CursorPage<ProcurementDirectAcquisition>, ApiError>>;
  getDirectAcquisition(id: string): Promise<Result<ProcurementDirectAcquisition | null, ApiError>>;
  getDirectAcquisitionDetail(id: string): Promise<Result<DirectAcquisitionDetail | null, ApiError>>;

  // ── modifications (cursor by (modification_date desc, modification_id desc)) ──
  listModifications(
    f: FilterInput,
    p: CursorPageRequest
  ): Promise<Result<CursorPage<ProcurementModification>, ApiError>>;
  /** PC-8: contracts modified by > pct — delta_pct computed + threshold pushed down. */
  listModificationsAboveDelta(
    pct: number,
    f: FilterInput,
    p: CursorPageRequest
  ): Promise<Result<CursorPage<ProcurementModification>, ApiError>>;

  // ── CPV discovery ──
  listCpvDivisions(): Promise<Result<readonly CpvDivision[], ApiError>>;
  resolveCpv(q: string, limit: number): Promise<Result<readonly CpvMatch[], ApiError>>;

  // ── offset search (the client contract; ADDITIVE — the cursor lists above stay
  //    exactly as the MCP tools use them) ──
  searchProceduresOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementProcedure>, ApiError>>;
  searchContractsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementContract>, ApiError>>;
  searchDirectAcquisitionsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementDirectAcquisition>, ApiError>>;
  searchModificationsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest
  ): Promise<Result<OffsetSearchResult<ProcurementModification>, ApiError>>;

  // ── detail-bundle support (batched; DataLoader-backed at the resolver) ──
  modificationsForContracts(
    contractIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, readonly ProcurementModification[]>, ApiError>>;
  contractsByIds(
    contractIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, ProcurementContract>, ApiError>>;
  supplierRecords(
    supplierCui: string,
    first: number,
    after: string | undefined
  ): Promise<Result<SupplierRecordConnection, ApiError>>;
}

export interface ProcurementAggregateRepo {
  /** The gate — read FIRST by every aggregate usecase (live per request, §0/C1). */
  grainQuality(): Promise<Result<readonly GrainQuality[], ApiError>>;

  // PC-1 / PC-3 — org_edge_monthly_rollups (pruned by dim + grain + month). The
  // `cui` is the anchor dimension (authority for topSuppliers, supplier for
  // topAuthorities); kept explicit (not in the filter) so the driving index is
  // unambiguous and the surface mirrors the plan's `(cui, f)` shape. `orderByValue`
  // is set by the usecase from the live gate (value when spend_rankings_allowed,
  // else flow_count) — the gate must NOT be ignored by the repo (§14.6 / I6).
  topSuppliersForAuthority(
    cui: string,
    f: EdgeAggFilter,
    orderByValue: boolean
  ): Promise<Result<readonly ProcurementEdge[], ApiError>>;
  topAuthoritiesForSupplier(
    cui: string,
    f: EdgeAggFilter,
    orderByValue: boolean
  ): Promise<Result<readonly ProcurementEdge[], ApiError>>;
  // PC-6 — repeated pairs anchored on one side. `side` picks the driving index
  // (authority_idx vs supplier_idx); explicit (not in the filter) for the same reason.
  repeatedPairs(
    cui: string,
    side: 'authority' | 'supplier',
    f: EdgeAggFilter
  ): Promise<Result<readonly ProcurementEdge[], ApiError>>;

  // PC-5 — supplier concentration / HHI over edges for one authority. `basis` is
  // chosen from the live gate (value when spend_rankings_allowed, else count).
  // Kept on the legacy MV path for `get_procurement_concentration` until the MV
  // stack retires; the analysis surface has its own concentration executor.
  supplierConcentration(
    cui: string,
    f: EdgeAggFilter,
    basis: 'value' | 'count'
  ): Promise<Result<SupplierConcentration, ApiError>>;

  // PC-4 — authority spend by CPV division × period.
  authorityCpvSpend(
    cui: string,
    f: CpvAggFilter,
    orderByValue: boolean
  ): Promise<Result<readonly AuthorityCpvRow[], ApiError>>;

  // PC-2 — top suppliers by region × CPV division (buyer region; supplier region
  // is gate-blocked at the surface).
  topSuppliersByRegionCpv(
    f: RegionCpvAggFilter,
    orderByValue: boolean
  ): Promise<Result<readonly SupplierCpvRow[], ApiError>>;

  // PC-7 — same-day DA splitting candidates (offset over a filter-bounded slice;
  // a selective filter — authorityCui or a date window — is required, §3a).
  sameDaySplittingCandidates(
    f: SplitFilter,
    p: OffsetPageRequest
  ): Promise<Result<OffsetResult<SameDayCandidate>, ApiError>>;

  // contributor support (§4.4).
  presenceFor(cui: string): Promise<Result<SourcePresence | null, ApiError>>;
  profileSlice(cui: string): Promise<Result<ProcurementProfileSlice | null, ApiError>>;
}

// ── analysis package (design §5–§6.2) ──────────────────────────────────────────

/** The single active serving generation, resolved ONCE per request. */
export interface ActiveGeneration {
  readonly buildId: string;
  readonly publishedAt: string | null;
  readonly quality: GenerationQuality;
  readonly matrixHash: string | null;
}

/** One stats read — everything the stats block AND its envelope need. */
export interface AnalysisStatsRead {
  readonly rows: string;
  readonly withValue: string;
  readonly withEstimated: string;
  readonly valueAwardedSum: string | null;
  readonly valueEstimatedSum: string | null;
  readonly minMonth: string | null;
  readonly maxMonth: string | null;
  /** The `month_start IS NULL` bucket under the same dimensions (design §3.2). */
  readonly undatedCount: string;
  readonly undatedValueRon: string | null;
}

/** One monthly series row; `month: null` tags the undated bucket. */
export interface AnalysisSeriesRow {
  readonly month: string | null;
  /** The requested measure's value for this bucket. */
  readonly value: string | null;
  readonly recordCount: string;
  readonly withValue: string;
  readonly valueAwardedSum: string | null;
}

/** One query-time-bucketed distinct row; `bucket: null` tags the undated bucket. */
export interface AnalysisDistinctRow {
  readonly bucket: string | null;
  readonly value: string;
  readonly recordCount: string;
  readonly withValue: string;
  readonly valueAwardedSum: string | null;
}

export interface AnalysisBreakdownBucketRow {
  readonly kind: 'top' | 'other' | 'unknown';
  /** The dimension value; null for `other`/`unknown`. */
  readonly key: string | null;
  readonly recordCount: string;
  readonly withValue: string;
  readonly valueAwardedSum: string | null;
}

/** Buckets + the scope totals — from ONE statement, so they reconcile by construction. */
export interface AnalysisBreakdownRead {
  readonly buckets: readonly AnalysisBreakdownBucketRow[];
  readonly totals: AnalysisStatsRead;
}

export interface ConcentrationRow {
  readonly supplierKey: string;
  /** The basis measure (awarded value sum or record count) as a decimal string. */
  readonly measure: string;
}

export interface ConcentrationRead {
  /** One row per DISTINCT KNOWN supplier in scope (zero-basis suppliers included). */
  readonly rows: readonly ConcentrationRow[];
  readonly totals: AnalysisStatsRead;
  /**
   * The basis measure held by records with an UNKNOWN (NULL) supplier — they
   * cannot enter the concentration and their weight is disclosed instead.
   */
  readonly unknownSupplierMeasure: string | null;
}

/**
 * The analysis rollup reader. Every statement pins `build_id` to the generation
 * resolved by `activeGeneration()` — a mid-request cutover can never mix builds.
 */
export interface AnalysisRepo {
  /** null when no generation is active (package not yet published). */
  activeGeneration(): Promise<Result<ActiveGeneration | null, ApiError>>;
  statsFor(
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string
  ): Promise<Result<AnalysisStatsRead, ApiError>>;
  seriesFor(
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string,
    measure: MeasureId
  ): Promise<Result<readonly AnalysisSeriesRow[], ApiError>>;
  /** Per-bucket COUNT(DISTINCT key) — the repo buckets; core never re-buckets distincts. */
  distinctSeriesFor(
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string,
    key: 'supplier' | 'authority',
    bucket: SeriesBucket
  ): Promise<Result<readonly AnalysisDistinctRow[], ApiError>>;
  breakdownFor(
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string,
    dimension: string,
    topN: number,
    rankBy: 'value' | 'count'
  ): Promise<Result<AnalysisBreakdownRead, ApiError>>;
  concentrationRowsFor(
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string,
    basis: 'value' | 'count'
  ): Promise<Result<ConcentrationRead, ApiError>>;
}
