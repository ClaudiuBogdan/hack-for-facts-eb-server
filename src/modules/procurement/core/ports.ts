/**
 * Procurement module — repo ports (plan §3). All methods return
 * `Result<T, ApiError>`. Two repos:
 *   - `ProcurementRepo`          — the 4 base tables (procedures/contracts/DAs/mods).
 *   - `ProcurementAggregateRepo` — the 5 materialized views + the grain gate.
 * Source repos touch only `procurement.*` + read-only `core.*`; cross-source money
 * totals go through the kernel `FlowsRepo`, NOT here (§4.3/§14.6).
 */

import type {
  AuthorityCpvRow,
  ContractDetail,
  CpvAggFilter,
  CpvDivision,
  CpvMatch,
  EdgeAggFilter,
  GrainQuality,
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
