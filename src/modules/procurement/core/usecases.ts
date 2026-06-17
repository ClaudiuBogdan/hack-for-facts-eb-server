/**
 * Procurement module — usecases (plan §4). Framework-free, over the ports,
 * `Result`-returning. GraphQL + MCP call the SAME usecase → tri-surface parity.
 *
 * GATE ENFORCEMENT lives HERE (not the repo), data-driven off the live gate
 * (`grainQuality()`), never code constants (§0/C1, §4):
 *   - filter_answers_allowed=false for the requested grain → ABSTAIN: empty rows +
 *     caveats listing the grain's blockers; no fabricated number.
 *   - spend_rankings_allowed=false → return rows but rank by flow_count, and force
 *     concentration/share measures count-based (basis='count'); add a caveat.
 *   - supplier_region_filters_allowed=false + a supplier-region request → InvalidInput.
 *
 * Base-table search/detail usecases are thin pass-throughs (no gate — the gate is an
 * AGGREGATE concept; base lists are bounded by indexed predicates + cursor instead).
 */

import { err, ok, type Result } from 'neverthrow';

import { DEFAULT_GRAIN, PROCUREMENT_GRAIN_NOTE } from './constants.js';

import type {
  CursorPageRequest,
  OffsetPageRequest,
  ProcurementAggregateRepo,
  ProcurementRepo,
} from './ports.js';
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
  ProcurementGrain,
  ProcurementModification,
  ProcurementProcedure,
  ProcurementProfileSlice,
  RegionCpvAggFilter,
  SameDayCandidate,
  SplitFilter,
  SupplierConcentration,
} from './types.js';
import type { ApiError, CursorPage, FilterInput } from '@/modules/shared/index.js';

// ── gate helper ────────────────────────────────────────────────────────────────

export interface GateResult<T> {
  readonly data: T;
  readonly grain: ProcurementGrain;
  readonly caveats: readonly string[];
  /** The gate row used (for as-of/projectionVersion surfacing). */
  readonly gate: GrainQuality;
}

/** A human blockers string, with a fallback when the gate lists none. */
const blockersText = (blockers: readonly string[]): string =>
  blockers.length > 0 ? blockers.join('; ') : 'coverage below threshold';

/** Look up the live gate row for a grain (the gate is recomputed per refresh). */
const gateFor = async (
  agg: ProcurementAggregateRepo,
  grain: ProcurementGrain
): Promise<Result<GrainQuality, ApiError>> => {
  const r = await agg.grainQuality();
  if (r.isErr()) return err(r.error);
  const row = r.value.find((g) => g.grain === grain);
  if (row === undefined) {
    // The gate MV always carries both grains; a missing row is a data fault, not
    // an abstain — surface it rather than silently returning empty.
    return err({ type: 'Database', message: `grain gate has no row for '${grain}'` });
  }
  return ok(row);
};

// ── base-table search / detail (no gate; index-bounded + cursor) ───────────────

export const searchProcedures = (
  repo: ProcurementRepo,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ProcurementProcedure>, ApiError>> => repo.listProcedures(filter, page);

export const getProcedureDetail = (
  repo: ProcurementRepo,
  id: string
): Promise<Result<ProcedureDetail | null, ApiError>> => repo.getProcedureDetail(id);

export const searchContracts = (
  repo: ProcurementRepo,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ProcurementContract>, ApiError>> => repo.listContracts(filter, page);

export const getContractDetail = (
  repo: ProcurementRepo,
  id: string
): Promise<Result<ContractDetail | null, ApiError>> => repo.getContractDetail(id);

export const searchDirectAcquisitions = (
  repo: ProcurementRepo,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ProcurementDirectAcquisition>, ApiError>> =>
  repo.listDirectAcquisitions(filter, page);

export const getDirectAcquisitionDetail = (
  repo: ProcurementRepo,
  id: string
): Promise<Result<ProcurementDirectAcquisition | null, ApiError>> => repo.getDirectAcquisition(id);

export const listModifications = (
  repo: ProcurementRepo,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ProcurementModification>, ApiError>> =>
  repo.listModifications(filter, page);

export const listModificationsAboveDelta = (
  repo: ProcurementRepo,
  pct: number,
  filter: FilterInput,
  page: CursorPageRequest
): Promise<Result<CursorPage<ProcurementModification>, ApiError>> =>
  repo.listModificationsAboveDelta(pct, filter, page);

export const listCpvDivisions = (
  repo: ProcurementRepo
): Promise<Result<readonly CpvDivision[], ApiError>> => repo.listCpvDivisions();

export const resolveCpv = (
  repo: ProcurementRepo,
  q: string,
  limit: number
): Promise<Result<readonly CpvMatch[], ApiError>> => repo.resolveCpv(q, limit);

// ── aggregate usecases (gate-enforced) ─────────────────────────────────────────

/**
 * Run a gate check for an edge/cpv aggregate, then the supplied repo call. Returns
 * the gate-degraded result + caveats. `filter_answers_allowed=false` → abstain.
 */
const withGate = async <T>(
  agg: ProcurementAggregateRepo,
  grain: ProcurementGrain,
  run: (gate: GrainQuality) => Promise<Result<T, ApiError>>,
  empty: T,
  spendSuppressedCaveat?: (grain: ProcurementGrain) => string
): Promise<Result<GateResult<T>, ApiError>> => {
  const gateR = await gateFor(agg, grain);
  if (gateR.isErr()) return err(gateR.error);
  const gate = gateR.value;
  if (!gate.filterAnswersAllowed) {
    return ok({
      data: empty,
      grain,
      gate,
      caveats: [
        `grain '${grain}' is not gate-approved for filtered aggregate answers: ${blockersText(gate.blockers)}`,
      ],
    });
  }
  const r = await run(gate);
  if (r.isErr()) return err(r.error);
  const caveats: string[] = [];
  if (!gate.spendRankingsAllowed && spendSuppressedCaveat !== undefined) {
    caveats.push(spendSuppressedCaveat(grain));
  }
  return ok({ data: r.value, grain, gate, caveats });
};

const countRankedCaveat = (grain: ProcurementGrain): string =>
  `spend rankings not gate-approved for '${grain}' grain — ranked by flow_count`;

export const topSuppliers = (
  agg: ProcurementAggregateRepo,
  cui: string,
  f: EdgeAggFilter
): Promise<Result<GateResult<readonly ProcurementEdge[]>, ApiError>> =>
  // The repo orders by value ONLY when the grain's spend rankings are gate-approved;
  // else by flow_count (the gate is data-driven, never ignored — §14.6 / I6).
  withGate(
    agg,
    f.grain,
    (gate) => agg.topSuppliersForAuthority(cui, f, gate.spendRankingsAllowed),
    [],
    countRankedCaveat
  );

export const topAuthorities = (
  agg: ProcurementAggregateRepo,
  cui: string,
  f: EdgeAggFilter
): Promise<Result<GateResult<readonly ProcurementEdge[]>, ApiError>> =>
  withGate(
    agg,
    f.grain,
    (gate) => agg.topAuthoritiesForSupplier(cui, f, gate.spendRankingsAllowed),
    [],
    countRankedCaveat
  );

export const repeatedPairs = (
  agg: ProcurementAggregateRepo,
  cui: string,
  side: 'authority' | 'supplier',
  f: EdgeAggFilter
): Promise<Result<GateResult<readonly ProcurementEdge[]>, ApiError>> =>
  withGate(agg, f.grain, () => agg.repeatedPairs(cui, side, f), []);

export const authorityCpvSpend = (
  agg: ProcurementAggregateRepo,
  cui: string,
  f: CpvAggFilter
): Promise<Result<GateResult<readonly AuthorityCpvRow[]>, ApiError>> =>
  withGate(
    agg,
    f.grain,
    (gate) => agg.authorityCpvSpend(cui, f, gate.spendRankingsAllowed),
    [],
    countRankedCaveat
  );

/**
 * PC-2: top suppliers by region × CPV. Region here is a BUYER (authority) region,
 * which is allowed; the `supplier_region_filters_allowed` gate only blocks a
 * SUPPLIER-side region request (rejected at the surface before this runs).
 */
export const topSuppliersByRegionCpv = (
  agg: ProcurementAggregateRepo,
  f: RegionCpvAggFilter
): Promise<Result<GateResult<readonly import('./types.js').SupplierCpvRow[]>, ApiError>> =>
  withGate(
    agg,
    f.grain,
    (gate) => agg.topSuppliersByRegionCpv(f, gate.spendRankingsAllowed),
    [],
    countRankedCaveat
  );

/** PC-5: concentration. The repo computes basis from the gate (value vs count). */
export const supplierConcentration = async (
  agg: ProcurementAggregateRepo,
  cui: string,
  f: EdgeAggFilter
): Promise<Result<SupplierConcentration, ApiError>> => {
  const gateR = await gateFor(agg, f.grain);
  if (gateR.isErr()) return err(gateR.error);
  const gate = gateR.value;
  if (!gate.filterAnswersAllowed) {
    return ok({
      authorityCui: cui,
      grain: f.grain,
      supplierCount: 0,
      basis: 'count',
      top1Share: null,
      top5Share: null,
      hhi: null,
      totalRon: null,
      caveats: [
        `grain '${f.grain}' is not gate-approved for filtered aggregate answers: ${blockersText(gate.blockers)}`,
      ],
    });
  }
  // Value-based concentration only when the grain's spend rankings are gate-approved;
  // else count-based (shares/HHI over flow_count, totalRon null) — §7.5/I6.
  const basis: 'value' | 'count' = gate.spendRankingsAllowed ? 'value' : 'count';
  return agg.supplierConcentration(cui, f, basis);
};

/**
 * PC-7: same-day DA splitting candidates (DA grain only — no contract grain).
 * Reads the live DA gate first: if the direct_acquisition grain is not gate-approved
 * for filtered answers, abstain (empty page) rather than surface derived candidates.
 */
export const sameDaySplittingCandidates = async (
  agg: ProcurementAggregateRepo,
  f: SplitFilter,
  page: OffsetPageRequest
): Promise<Result<import('./ports.js').OffsetResult<SameDayCandidate>, ApiError>> => {
  const gateR = await gateFor(agg, 'direct_acquisition');
  if (gateR.isErr()) return err(gateR.error);
  if (!gateR.value.filterAnswersAllowed) {
    return ok({ items: [], total: 0, estimated: false });
  }
  return agg.sameDaySplittingCandidates(f, page);
};

export const grainQuality = (
  agg: ProcurementAggregateRepo
): Promise<Result<readonly GrainQuality[], ApiError>> => agg.grainQuality();

// ── contributor (entity-360) ───────────────────────────────────────────────────

export const getProcurementProfile = (
  agg: ProcurementAggregateRepo,
  cui: string
): Promise<Result<ProcurementProfileSlice | null, ApiError>> => agg.profileSlice(cui);

export { DEFAULT_GRAIN, PROCUREMENT_GRAIN_NOTE };
