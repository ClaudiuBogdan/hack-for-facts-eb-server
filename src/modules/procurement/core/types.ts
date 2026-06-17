/**
 * Procurement module — view models (plan §2). Grounded in
 * `_prod-schema/procurement.tsv`. Money = decimal STRING (§14.1, precision-safe);
 * dates `YYYY-MM-DD`; bigint ids = string. NO PII in this source. Diagnostic /
 * loader-bookkeeping columns are excluded from these models (plan §2 N3): raw
 * `supplier_raw`/`cpv_raw`/`status_raw`, `dup_method`/`dup_confidence`,
 * `source_ref`/`source_system` internal keys, `state_id`, `source_updated_at`,
 * and the raw `attrs` jsonb. `is_canonical`/`dup_group_id` ARE surfaced (dedup
 * transparency).
 *
 * `currency` is NOT exposed as a plain ISO code: per audit F1/F7 the loader nulls
 * `value_ron` for non-RON rows and repurposes the column as a flag carrier. It is
 * mapped at the repo boundary to `isRon` / `valueSuspect` and never leaks raw.
 */

import type {
  ContractStatus,
  DaSourceSystem,
  DaStatus,
  ProcedureStatus,
  ProcurementGrain,
} from './constants.js';

// ── entity view models ─────────────────────────────────────────────────────────

export interface ProcurementProcedure {
  readonly procedureId: string;
  readonly noticeNo: string | null;
  readonly noticeKind: string | null;
  readonly procedureType: string | null;
  readonly contractKind: string | null;
  readonly title: string | null;
  readonly authorityCui: string | null;
  readonly authorityName: string | null;
  readonly cpvCode: string | null;
  readonly cpvDivisionCode: string | null;
  readonly estimatedValueRon: string | null;
  readonly awardedValueRon: string | null;
  /** True iff the value columns are in RON (procedures also carry the F1/F7 flag). */
  readonly isRon: boolean;
  readonly valueSuspect: boolean;
  readonly status: ProcedureStatus;
  readonly countyName: string | null;
  readonly publicationDate: string | null;
  readonly stateDate: string | null;
}

export interface ProcurementContract {
  readonly contractId: string;
  readonly contractKey: string;
  readonly procedureId: string | null;
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
  /** True iff value_ron is in RON (audit F1: non-RON rows have value_ron nulled). */
  readonly isRon: boolean;
  /** True iff the row carries a non-RON native value the loader could not convert. */
  readonly valueSuspect: boolean;
  readonly status: ContractStatus;
  readonly countyName: string | null;
  readonly isCanonical: boolean;
  readonly dupGroupId: string | null;
}

export interface ProcurementDirectAcquisition {
  readonly daId: string;
  readonly daKey: string;
  readonly sourceSystem: DaSourceSystem;
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
  readonly isRon: boolean;
  readonly valueSuspect: boolean;
  readonly status: DaStatus;
  readonly countyName: string | null;
  readonly publicationDate: string | null;
  readonly finalizationDate: string | null;
  readonly isCanonical: boolean;
  readonly dupGroupId: string | null;
}

export interface ProcurementModification {
  readonly modificationId: string;
  readonly contractId: string | null;
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
  /** Derived = delta / nullif(before, 0) (PC-8). Null when before is 0/null. */
  readonly deltaPct: number | null;
  readonly modificationType: string | null;
  readonly year: number | null;
}

// ── detail composites ──────────────────────────────────────────────────────────

export interface ProcedureDetail {
  readonly procedure: ProcurementProcedure;
  readonly contracts: readonly ProcurementContract[];
}

export interface ContractDetail {
  readonly contract: ProcurementContract;
  readonly procedure: ProcurementProcedure | null;
  readonly modifications: readonly ProcurementModification[];
}

// ── aggregate view models (rollup-backed; §3a(2)) ──────────────────────────────

export interface ProcurementEdge {
  readonly authorityCui: string;
  readonly authorityName: string | null;
  readonly supplierCui: string;
  readonly supplierName: string | null;
  readonly grain: ProcurementGrain;
  readonly flowCount: string;
  readonly amountRonSum: string | null;
  readonly amountPresentCount: string;
  readonly amountMissingCount: string;
  readonly firstFlowDate: string | null;
  readonly lastFlowDate: string | null;
  readonly evidenceRefsSample: readonly string[];
}

export interface SupplierConcentration {
  readonly authorityCui: string;
  readonly grain: ProcurementGrain;
  readonly supplierCount: number;
  /** `value` only when the grain's spend rankings are gate-approved; else `count`. */
  readonly basis: 'value' | 'count';
  readonly top1Share: number | null;
  readonly top5Share: number | null;
  readonly hhi: number | null;
  /** Null when basis='count' (no value sum is gate-approved). */
  readonly totalRon: string | null;
  readonly caveats: readonly string[];
}

export interface GrainQuality {
  readonly grain: ProcurementGrain;
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

export interface AuthorityCpvRow {
  readonly authorityCui: string;
  readonly cpvDivisionCode: string;
  readonly cpvDivisionLabelEn: string | null;
  readonly grain: ProcurementGrain;
  readonly flowCount: string;
  readonly amountRonSum: string | null;
  /**
   * SUM of the MV's per-month `distinct_supplier_count` — i.e. supplier-MONTH
   * occurrences over the period, NOT distinct suppliers across the whole period
   * (the MV is monthly-grained, so a supplier active in N months counts N times).
   * Codex #8 — named to reflect the grain; a true period-distinct needs a different
   * rollup (org_edge gives distinct counterparties when needed).
   */
  readonly supplierMonthCount: string;
  readonly firstFlowDate: string | null;
  readonly lastFlowDate: string | null;
}

/**
 * PC-2: a supplier's total to a (buyer) region × CPV division — aggregated ACROSS
 * all buying authorities in that region (NOT fragmented per authority, Codex #2).
 * `distinctAuthorityCount` is the number of distinct buyers in the region the
 * supplier served.
 */
export interface SupplierCpvRow {
  readonly supplierCui: string;
  readonly supplierName: string | null;
  readonly authorityRegion: string | null;
  readonly cpvDivisionCode: string;
  readonly grain: ProcurementGrain;
  readonly flowCount: string;
  readonly amountRonSum: string | null;
  readonly distinctAuthorityCount: string;
}

export interface SameDayCandidate {
  readonly candidateDate: string;
  readonly authorityCui: string;
  readonly authorityName: string | null;
  readonly supplierCui: string;
  readonly supplierName: string | null;
  readonly cpvCode: string | null;
  readonly cpvDivisionCode: string | null;
  readonly sameDayCount: string;
  readonly sameDayTotalRon: string | null;
  readonly maxSingleAmountRon: string | null;
  readonly evidenceRefsSample: readonly string[];
}

// ── reference / discovery ──────────────────────────────────────────────────────

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

/** A name→value discovery hit (the Entity Resolution Gate output, §7.6). */
export interface ProcurementResolveHit {
  readonly value: string;
  readonly label: string | null;
  readonly kind: string;
  readonly confidence: number;
}

// ── contributor / entity-360 ───────────────────────────────────────────────────

export interface ProcurementRoleSummary {
  readonly contractCount: string;
  readonly daCount: string;
  /**
   * Per-grain RON subtotals — NEVER one summed scalar across grains (§14.6). Null
   * for a grain whose value is not gate-approved (e.g. procurement_contract spend).
   */
  readonly contractTotalRon: string | null;
  readonly daTotalRon: string | null;
  /** Top counterparties for this role (top-5). */
  readonly top: readonly ProcurementEdge[];
  /** Which measure `top` is ranked by (value when the grain's spend is gate-approved, else count). */
  readonly rankBasis: 'value' | 'count';
}

export interface ProcurementProfileSlice {
  readonly cui: string;
  readonly asAuthority: ProcurementRoleSummary;
  readonly asSupplier: ProcurementRoleSummary;
  readonly spendByCpvDivision: readonly AuthorityCpvRow[];
  readonly caveats: readonly string[];
  readonly refreshedAt: string | null;
}

// ── aggregate filter cores (parsed at the surface; passed to the aggregate repo) ──

/**
 * Edge aggregate filter (org_edge_monthly_rollups; PC-1/3/5/6). org_edge has NO
 * CPV dimension — a CPV-category question routes to the cpv-division MVs
 * (`CpvAggFilter`/`RegionCpvAggFilter`) instead, so there is deliberately no
 * `cpvDivision` here (GLM review #1). `monthFrom` defaults to `ROLLUP_MIN_MONTH`
 * in the repo so the dims index always range-scans (never seq-scans the MV).
 * For `repeatedPairs`, exactly one of `authorityCui` / `supplierCui` is the anchor.
 */
export interface EdgeAggFilter {
  readonly grain: ProcurementGrain;
  readonly monthFrom?: string;
  readonly monthTo?: string;
  readonly topN: number;
  /** PC-6: minimum distinct active months for a repeated pair. */
  readonly minMonths?: number;
}

export interface CpvAggFilter {
  readonly grain: ProcurementGrain;
  readonly cpvDivisions?: readonly string[];
  readonly monthFrom?: string;
  readonly monthTo?: string;
  readonly topN: number;
}

export interface RegionCpvAggFilter {
  readonly region: string;
  readonly cpvDivision: string;
  readonly grain: ProcurementGrain;
  readonly monthFrom?: string;
  readonly monthTo?: string;
  readonly topN: number;
}

export interface SplitFilter {
  readonly authorityCui?: string;
  readonly candidateDateFrom?: string;
  readonly candidateDateTo?: string;
  readonly minSameDayCount: number;
  readonly cpvDivision?: string;
}

export type { ProcurementGrain, ProcedureStatus, ContractStatus, DaStatus, DaSourceSystem };
