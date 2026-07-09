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
 * `currency` is NOT exposed as the raw column: per audit F1/F7 the loader nulls
 * `value_ron` for non-RON rows and repurposes the column as a flag carrier (its
 * tail holds CPV codes and bare amounts). It is mapped at the repo boundary to
 * `isRon` / `valueSuspect` plus a SANITIZED `currency` token — see `mappers.ts`.
 */

import type {
  ContractStatus,
  DaSourceSystem,
  DaStatus,
  ProcedureStatus,
  ProcurementGrain,
  SearchSort,
} from './constants.js';

// ── entity view models ─────────────────────────────────────────────────────────

export interface ProcurementProcedure {
  readonly procedureId: string;
  readonly sourceSystem: string;
  readonly sourceUrl: string | null;
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
  /** Sanitized ISO-ish token, or null. Never the raw `currency` column. */
  readonly currency: string | null;
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
  readonly sourceSystem: string;
  readonly sourceUrl: string | null;
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
  readonly currency: string | null;
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
  readonly sourceUrl: string | null;
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
  readonly sourceUrl: string | null;
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

/** A dedup-suppressed sibling of a canonical row (same `dup_group_id`). */
export interface DuplicateRef {
  readonly sourceSystem: string;
  readonly id: string;
}

/** The EU Tenders-Electronic-Daily notice a procedure was published under. */
export interface TedRef {
  readonly tedNoticeNo: string;
  readonly sourceUrl: string;
}

export interface ProcedureDetail {
  readonly procedure: ProcurementProcedure;
  readonly contracts: readonly ProcurementContract[];
  /**
   * Always null in v1: `procedure_lots` carries no winner identity and no awarded
   * value (only estimated), so a per-lot winner cannot be derived without fabrication.
   */
  readonly perLotWinners: null;
  /** Always empty for procedures — the table has no `dup_group_id` (see schema.ts). */
  readonly duplicates: readonly DuplicateRef[];
  readonly ted: TedRef | null;
}

export interface ContractDetail {
  readonly contract: ProcurementContract;
  readonly procedure: ProcurementProcedure | null;
  readonly modifications: readonly ProcurementModification[];
  readonly duplicates: readonly DuplicateRef[];
  /** Inherited from the contract's procedure (contracts have no direct TED link). */
  readonly ted: TedRef | null;
}

export interface DirectAcquisitionDetail {
  readonly directAcquisition: ProcurementDirectAcquisition;
  readonly duplicates: readonly DuplicateRef[];
}

// ── offset search (the client contract) ────────────────────────────────────────

/**
 * `total` is null when the exact count exceeded `SEARCH_COUNT_CAP` OR when the
 * count statement failed/timed out — in both cases `estimated: true` tells the
 * client to render "10000+". A count failure NEVER fails the page itself.
 */
export interface OffsetSearchResult<T> {
  readonly items: readonly T[];
  readonly total: number | null;
  readonly estimated: boolean;
}

/** The parsed, validated offset page request. */
export interface OffsetSearchRequest {
  readonly page: number;
  readonly pageSize: number;
  readonly sort: SearchSort;
}

/** A canonical flow record on a supplier's timeline, tagged with its source table. */
export type SupplierRecord =
  | { readonly grain: 'procurement_contract'; readonly contract: ProcurementContract }
  | { readonly grain: 'direct_acquisition'; readonly directAcquisition: ProcurementDirectAcquisition };

export interface SupplierRecordEdge {
  readonly cursor: string;
  readonly node: SupplierRecord;
}

export interface SupplierRecordConnection {
  /** Always null: an exact count over two 3.3M/26M-row tables is not affordable. */
  readonly total: null;
  readonly edges: readonly SupplierRecordEdge[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

// ── scope aggregates (the 5 shared queries) ────────────────────────────────────

/** Empty = platform-wide. `cpvCode` is rejected in v1 (no 8-digit-grained MV). */
export interface ScopeFilter {
  readonly authorityCui?: string;
  readonly supplierCui?: string;
  readonly cpvDivision?: string;
  readonly cpvCode?: string;
  /** `YYYY-MM` — the rollups are monthly. */
  readonly monthFrom?: string;
  readonly monthTo?: string;
}

export interface ProcurementStats {
  /**
   * Sum over the in-scope grains whose `spend_rankings_allowed` is true. Null when
   * no in-scope grain is spend-approved. Never mixes an approved grain's money with
   * a suppressed one's (the suppressed grain contributes nothing, not zero).
   */
  readonly totalValueRon: string | null;
  readonly contractsCount: string;
  readonly directAcquisitionsCount: string;
  readonly proceduresCount: string;
  readonly buyersCount: string;
  readonly suppliersCount: string;
  readonly firstFlowDate: string | null;
  readonly lastFlowDate: string | null;
}

/** One ranked counterparty ON ONE GRAIN — rows are never summed across grains. */
export interface TopPartyRow {
  readonly authorityCui: string | null;
  readonly authorityName: string | null;
  readonly supplierCui: string | null;
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

export interface CategoryRow {
  readonly cpvDivisionCode: string | null;
  readonly cpvDivisionLabelEn: string | null;
  readonly cpvDivisionLabelRo: string | null;
  readonly grain: ProcurementGrain;
  readonly flowCount: string;
  readonly amountRonSum: string | null;
  readonly amountPresentCount: string;
  readonly amountMissingCount: string;
}

/**
 * One point per MONTH (never per grain — the client keys its timeline on `month`).
 * `flowCount` sums every in-scope grain (a count is always allowed); the amount
 * columns sum only the spend-approved grains.
 */
export interface MonthlyPoint {
  readonly month: string;
  readonly flowCount: string;
  readonly amountRonSum: string | null;
  readonly amountPresentCount: string;
  readonly amountMissingCount: string;
}

/** The per-grain gate as the client consumes it (rates stringified, as-of + cadence). */
export interface CapabilityGate {
  readonly sourceGrain: ProcurementGrain;
  readonly rowsCount: string;
  readonly authorityCuiCoverageRate: string;
  readonly supplierCuiCoverageRate: string;
  readonly amountCoverageRate: string;
  readonly cpvCoverageRate: string;
  readonly dateCoverageRate: string;
  readonly filterAnswersAllowed: boolean;
  readonly spendRankingsAllowed: boolean;
  readonly supplierRegionFiltersAllowed: boolean;
  readonly blockers: readonly string[];
  /** The MV refresh watermark as `YYYY-MM-DD` (etl.lane_watermarks has no procurement row). */
  readonly dataAsOf: string | null;
  /** Always null: no refresh schedule is declared anywhere, and the MVs drift. */
  readonly cadence: null;
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

export type { ProcurementGrain, ProcedureStatus, ContractStatus, DaStatus, DaSourceSystem, SearchSort };
