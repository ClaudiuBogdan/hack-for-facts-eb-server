/**
 * Procurement module — repo ports (plan §3). All methods return
 * `Result<T, ApiError>`. Two repos:
 *   - `ProcurementRepo`          — the 4 base tables (procedures/contracts/DAs/mods).
 *   - `AnalysisRepo`             — the scraper-built `procurement.analysis_*`
 *     generation + wave-1 rollups (the six-shape surface, design §5).
 * Source repos touch only `procurement.*` + read-only `core.*`; cross-source money
 * totals go through the kernel `FlowsRepo`, NOT here (§4.3/§14.6).
 */

import type { AnalysisScope } from './analysis-scope.js';
import type { AnalysisRoute } from './combinations.js';
import type { MeasureId, SeriesBucket } from './constants.js';
import type { BasisCoverageRow, GenerationQuality } from './gate-v2.js';
import type { ProcurementSearchFilter } from './search.js';
import type {
  ContractDetail,
  CpvCodeLabel,
  CpvDivision,
  CpvMatch,
  DirectAcquisitionDetail,
  OffsetSearchRequest,
  OffsetSearchResult,
  ProcedureDetail,
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementModification,
  ProcurementProcedure,
  SupplierRecordConnection,
} from './types.js';
import type { ApiError, CursorPage, FilterInput } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/** A cursor page request (first + opaque after + sort key). */
export interface CursorPageRequest {
  readonly first: number;
  readonly after?: string;
  readonly sort?: string;
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
  listCpvCodeLabels(codes: readonly string[]): Promise<Result<readonly CpvCodeLabel[], ApiError>>;
  resolveCpv(q: string, limit: number): Promise<Result<readonly CpvMatch[], ApiError>>;

  // ── offset search (the client contract; ADDITIVE — the cursor lists above stay
  //    exactly as the MCP tools use them) ──
  searchProceduresOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest,
    facets?: readonly string[]
  ): Promise<Result<OffsetSearchResult<ProcurementProcedure>, ApiError>>;
  searchContractsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest,
    facets?: readonly string[]
  ): Promise<Result<OffsetSearchResult<ProcurementContract>, ApiError>>;
  searchDirectAcquisitionsOffset(
    f: ProcurementSearchFilter,
    p: OffsetSearchRequest,
    facets?: readonly string[]
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
    after: string | undefined,
    includeCancelled: boolean
  ): Promise<Result<SupplierRecordConnection, ApiError>>;
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
  /** Framework grain only: Σ attributed ceiling (null elsewhere). */
  readonly valueCeilingSum: string | null;
  /** Contract grain only: Σ modification-adjusted value (null elsewhere). */
  readonly valueModAdjustedSum: string | null;
  readonly valueAwardedMatchedSum: string | null;
  readonly minMonth: string | null;
  readonly maxMonth: string | null;
  /** The `month_start IS NULL` bucket under the same dimensions (design §3.2). */
  readonly undatedCount: string;
  readonly undatedValueRon: string | null;
  /**
   * Association-withheld mass (supplier-money reads only): Σ attributed −
   * Σ supplier over the same scope — the multi-member consortium money whose
   * internal split is unobservable. Null on attributed-basis reads AND when
   * the scope holds no attributed money; '0.00' means "nothing withheld".
   */
  readonly valueWithheldAssociationSum: string | null;
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
  /**
   * The basis the buckets were ACTUALLY ranked and limited by. A requested
   * `value` ranking over a scope with no value-bearing rows on the read's money
   * basis would order an all-zero tie, so the repo re-ranks by record count
   * BEFORE applying top-N and reports `count` here. Never a relabeling: the
   * returned population is the count-ranked one.
   */
  readonly rankedBy: 'value' | 'count';
}

export interface ConcentrationRead {
  /** DISTINCT KNOWN suppliers in scope (zero-basis suppliers included). */
  readonly supplierCount: number;
  /** Known suppliers whose basis measure is strictly positive. */
  readonly positiveSupplierCount: number;
  /**
   * Exact positive-basis aggregates. Value-basis values are RON decimal
   * strings; count-basis values are record-count decimal strings.
   *
   * Returning these six scalars instead of one row per supplier keeps the
   * HTTP response bounded while leaving ratio/HHI calculation in core.
   */
  readonly measureTotal: string;
  readonly top1Measure: string;
  readonly top5Measure: string;
  /**
   * Sum of each positive supplier measure squared. Value basis is RON²;
   * count basis is records².
   */
  readonly measureSquaredSum: string;
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
  /**
   * Per-basis coverage rows for the build (value-basis wave; the data layer's
   * `meta_value_coverage_v2`). Gates every non-awarded money basis and the new
   * populations' time/geo verdicts; cached per build (immutable).
   */
  basisCoverage(buildId: string): Promise<Result<readonly BasisCoverageRow[], ApiError>>;
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
  concentrationFor(
    route: AnalysisRoute,
    scope: AnalysisScope,
    buildId: string,
    basis: 'value' | 'count'
  ): Promise<Result<ConcentrationRead, ApiError>>;
}
