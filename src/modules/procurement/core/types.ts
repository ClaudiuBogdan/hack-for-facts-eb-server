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
 * Value semantics come from the data layer's VALUE MODEL (rules v2): every row
 * carries `valueState` (the honest resolution outcome) and
 * `valueRonComparable` (+basis) — the ONLY cross-row-comparable money measure.
 * `valueRon`/`awardedValueRon` stay as the row's own parsed evidence. The
 * legacy `isRon`/`valueSuspect` derivation is gone: since the Phase-F loader
 * the `currency` column is a clean RON/EUR/USD enum (still sanitized at the
 * mapper for pre-Phase-F residue).
 */

import type {
  ContractStatus,
  DaSourceSystem,
  DaStatus,
  ProcedureStatus,
  ProcurementGrain,
  SearchSort,
  ValueComparableBasis,
  RecordKind,
  ValueState,
} from './constants.js';
import type { ContractDisplayTitle } from './contract-display-title.js';

// ── value-model resolution block (shared by the three valued grains) ──────────

export interface ValueResolution {
  /** Honest per-row resolution outcome; null = not yet resolved (transient). */
  readonly valueState: ValueState | null;
  /** Engine rule label ('own_value', 'dup_group_rescue', 'framework_guard', …). */
  readonly valueStateRule: string | null;
  /** True iff valueState is one of the ACCEPTED states (money is servable). */
  readonly valueAccepted: boolean;
  /** The only cross-row-comparable money measure (decimal string). */
  readonly valueRonComparable: string | null;
  readonly valueComparableBasis: ValueComparableBasis | null;
  readonly valueRulesVersion: number | null;
  readonly valueResolvedAt: string | null;
}

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
  readonly status: ProcedureStatus;
  readonly countyName: string | null;
  readonly publicationDate: string | null;
  readonly stateDate: string | null;
  readonly value: ValueResolution;
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
  /** Source-owned contract title; never backfilled from another record. */
  readonly title: string | null;
  /** Read-only presentation title and inseparable source provenance. */
  readonly displayTitle: ContractDisplayTitle | null;
  readonly authorityCui: string | null;
  readonly authorityName: string | null;
  readonly supplierCui: string | null;
  readonly supplierName: string | null;
  readonly cpvCode: string | null;
  readonly cpvDivisionCode: string | null;
  readonly valueRon: string | null;
  readonly estimatedValueRon: string | null;
  readonly currency: string | null;
  readonly status: ContractStatus;
  readonly countyName: string | null;
  readonly isCanonical: boolean;
  readonly dupGroupId: string | null;
  readonly value: ValueResolution;
  /** Winning evidence family when accepted ('seap_own' | 'elicitatie_ca_award' | 'dup_group'). */
  readonly canonicalValueSource: string | null;
  /** True when own/cross evidence disagrees (state 'conflicting_sources'). */
  readonly valueDisagreement: boolean;
  /** Record kind (v5): frameworks are umbrellas, not purchases. NULL reads as contract_award. */
  readonly recordKind: RecordKind;
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
  readonly status: DaStatus;
  readonly countyName: string | null;
  readonly publicationDate: string | null;
  readonly finalizationDate: string | null;
  readonly isCanonical: boolean;
  readonly dupGroupId: string | null;
  readonly value: ValueResolution;
}

export interface ProcurementModification {
  readonly modificationId: string;
  readonly contractId: string | null;
  readonly sourceUrl: string | null;
  readonly linkMethod: 'notice_no' | 'authority_cui+contract_no' | null;
  readonly linkConfidence: number | null;
  readonly authorityCui: string | null;
  /** Projected because `q` matches on it — a name-only hit must be explicable. */
  readonly authorityName: string | null;
  readonly supplierCui: string | null;
  readonly supplierName: string | null;
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
/** One result-set facet dimension. Never an authoritative analytic total. */
export interface SearchFacet {
  readonly dimension: string;
  readonly buckets: readonly { readonly key: string; readonly count: number }[];
  /**
   * Records outside the returned buckets (`sum_other_doc_count`). Disclosed,
   * never silently dropped — a truncated facet that reads as complete is a lie.
   */
  readonly otherCount: number;
}

/**
 * Where a text query matched inside one record, as a fragment of the ORIGINAL
 * text with the matched terms wrapped in U+27E6 … U+27E7.
 *
 * Those markers are deliberately NOT markup: the client splits on them and
 * renders its own element, so a title that itself contains `<mark>` — or any
 * other markup — can never become markup in the page.
 *
 * Fragments are presentational only. They come from the search index, which is
 * as of `SearchProvenance.asOf`, while every rendered value comes from Postgres
 * — so a fragment is a hint about the match, never a source of record.
 */
export interface SearchHighlight {
  /** The record id (the grain's primary key, as the item's `id` field carries it). */
  readonly id: string;
  readonly title?: string;
  readonly authorityName?: string;
  readonly supplierName?: string;
}

/** Which surface answered, and how fresh that answer is. */
export interface SearchProvenance {
  readonly engine: 'opensearch' | 'postgres';
  /** Search-index build timestamp (ISO-8601); null when the engine is Postgres. */
  readonly asOf: string | null;
}

export interface OffsetSearchResult<T> {
  readonly items: readonly T[];
  readonly total: number | null;
  readonly estimated: boolean;
  /** Present only when facets were requested AND the engine served the page. */
  readonly facets?: readonly SearchFacet[];
  /** Present only for a `q` page the engine served; one entry per matched item. */
  readonly highlights?: readonly SearchHighlight[];
  readonly provenance?: SearchProvenance;
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

/** A full CPV code label (official CPV-2008 relabel preferred over best-effort). */
export interface CpvCodeLabel {
  readonly code: string;
  readonly labelRo: string | null;
  readonly labelEn: string | null;
  readonly divisionCode: string | null;
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
