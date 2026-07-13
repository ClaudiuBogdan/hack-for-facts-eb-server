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
  | {
      readonly grain: 'direct_acquisition';
      readonly directAcquisition: ProcurementDirectAcquisition;
    };

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

export type {
  ProcurementGrain,
  ProcedureStatus,
  ContractStatus,
  DaStatus,
  DaSourceSystem,
  SearchSort,
};
