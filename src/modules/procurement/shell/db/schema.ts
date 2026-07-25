/**
 * Procurement module — `ProdDatabase` augmentation (foundation §3,
 * module-augmentation pattern; plan 10 §2). Types the live `procurement.*` tables
 * + the 5 MVs onto the single kernel Kysely instance via declaration merging.
 *
 * Table keys are the schema-qualified live names (`'procurement.contracts'`) so the
 * repo reads them directly and the planner uses the WHERE-driven index. Scalars
 * (§14.1): `numeric` → `string` (money precision preserved); `bigint` ids → `string`;
 * `date` → `'YYYY-MM-DD'`; `timestamptz` → ISO string. Diagnostic / loader columns
 * (supplier_raw, cpv_raw, status_raw, dup_method, dup_confidence, state_id,
 * source_updated_at, attrs) are OMITTED so the repo cannot select them by accident
 * (plan §2 N3). `source_system` IS typed (the repo derives the public sourceSystem +
 * the currency flag at the boundary) but never projected raw.
 */

// ── base entity tables ─────────────────────────────────────────────────────────

/**
 * NOTE (verified live 2026-07-09): `procedures` has NO `is_canonical` / `dup_group_id`
 * columns — the dedup pass runs on contracts + DAs only. The procedure surface
 * therefore reports `isCanonical: true` / `dupGroupId: null` structurally.
 */
export interface ProcurementProceduresTable {
  procedure_id: string; // bigint → string
  source_system: string;
  source_url: string | null;
  notice_no: string | null;
  notice_kind: string | null;
  procedure_type: string | null;
  contract_kind: string | null;
  title: string | null;
  authority_cui: string | null;
  authority_name: string | null;
  cpv_code: string | null;
  estimated_value_ron: string | null; // numeric(18,2) → string
  awarded_value_ron: string | null;
  currency: string | null;
  status: string;
  county_name: string | null;
  publication_date: string | null; // date
  state_date: string | null;
  // ── value-model resolution columns (scrapper VALUE_RULES_VERSION 2,
  // 2026-07-18): value_state is the honest per-row resolution outcome;
  // value_ron_comparable (+basis 'official' | 'derived_bnr') is the ONLY
  // cross-row-comparable money measure. value_state_detail carries the rule
  // label under `rule`. NULL value_state = row inserted after the last
  // resolution run (transient).
  value_state: string | null;
  value_state_detail: { rule?: string } | null;
  value_ron_comparable: string | null; // numeric → string
  value_comparable_basis: string | null;
  value_rules_version: number | null;
  value_resolved_at: string | null; // timestamptz
}

export interface ProcurementContractsTable {
  contract_id: string;
  contract_key: string;
  source_system: string;
  source_url: string | null;
  procedure_id: string | null;
  notice_no: string | null;
  contract_no: string | null;
  contract_date: string | null;
  title: string | null;
  authority_cui: string | null;
  authority_name: string | null;
  supplier_cui: string | null;
  supplier_name: string | null;
  cpv_code: string | null;
  value_ron: string | null;
  estimated_value_ron: string | null;
  // Since the Phase-F transforms the emitted token is a clean RON/EUR/USD
  // enum (or NULL); the historical repurposed-flag caveat (audit F1/F7) no
  // longer applies to newly loaded rows.
  currency: string | null;
  status: string;
  county_name: string | null;
  is_canonical: boolean;
  dup_group_id: string | null; // bigint → string
  // ── value-model resolution columns (scrapper VALUE_RULES_VERSION 2,
  // 2026-07-18): value_state is the honest per-row resolution outcome;
  // value_ron_comparable (+basis 'official' | 'derived_bnr') is the ONLY
  // cross-row-comparable money measure. value_state_detail carries the rule
  // label under `rule`. NULL value_state = row inserted after the last
  // resolution run (transient).
  value_state: string | null;
  value_state_detail: { rule?: string } | null;
  value_ron_comparable: string | null; // numeric → string
  value_comparable_basis: string | null;
  value_rules_version: number | null;
  value_resolved_at: string | null; // timestamptz
  /** Winning evidence family when accepted ('seap_own' | 'elicitatie_ca_award' | 'dup_group'). */
  canonical_value_source: string | null;
  /** True when own/cross evidence disagrees (state 'conflicting_sources'). */
  value_disagreement: boolean;
  /**
   * Record kind (v5 serving convention): 'contract_award' | 'framework_agreement',
   * stamped from the framework observation marker. NULL = pre-v5 row (reads
   * as contract_award).
   */
  record_kind: string | null;
}

export interface ProcurementDirectAcquisitionsTable {
  da_id: string;
  da_key: string;
  source_system: string;
  source_url: string | null;
  unique_code: string | null;
  title: string | null;
  authority_cui: string | null;
  authority_name: string | null;
  supplier_cui: string | null;
  supplier_name: string | null;
  cpv_code: string | null;
  value_ron: string | null;
  estimated_value_ron: string | null;
  currency: string | null;
  status: string;
  county_name: string | null;
  publication_date: string | null;
  finalization_date: string | null;
  is_canonical: boolean;
  dup_group_id: string | null;
  // ── value-model resolution columns (scrapper VALUE_RULES_VERSION 2,
  // 2026-07-18): value_state is the honest per-row resolution outcome;
  // value_ron_comparable (+basis 'official' | 'derived_bnr') is the ONLY
  // cross-row-comparable money measure. value_state_detail carries the rule
  // label under `rule`. NULL value_state = row inserted after the last
  // resolution run (transient).
  value_state: string | null;
  value_state_detail: { rule?: string } | null;
  value_ron_comparable: string | null; // numeric → string
  value_comparable_basis: string | null;
  value_rules_version: number | null;
  value_resolved_at: string | null; // timestamptz
}

/** No `source_system` column live (unlike the other three grains) — the spec does not ask for one. */
export interface ProcurementContractModificationsTable {
  modification_id: string;
  contract_id: string | null;
  source_url: string | null;
  link_method: string | null;
  link_confidence: number | null; // real
  authority_cui: string | null;
  authority_name: string | null;
  supplier_cui: string | null;
  supplier_name: string | null;
  contract_no: string | null;
  notice_no: string | null;
  modification_date: string | null;
  value_before_ron: string | null;
  value_after_ron: string | null;
  value_delta_ron: string | null;
  modification_type: string | null;
  year: number | null;
  quarter: string | null;
}

// ── CPV reference ──────────────────────────────────────────────────────────────

export interface ProcurementCpvDivisionsTable {
  division_code: string;
  label_en: string;
  label_ro: string | null;
  source_version: string | null;
}

export interface ProcurementCpvCodesTable {
  cpv_code: string;
  label_ro: string | null;
  official_label_ro: string | null; // official CPV-2008 relabel; covers 100% of official codes
  label_en: string | null;
  division_code: string | null;
  parent_code: string | null; // 100% NULL (corrupt)
  cpv_level: number | null; // 100% NULL (corrupt)
}

// ── direct-acquisition detail (what was actually bought) ──────────────────────
//
// Covers ~41% of `procurement.direct_acquisitions` BY DESIGN: the seap_da /
// seap_dan families were loaded from bulk spreadsheet exports and have no detail
// source in existence, and elicitatie pre-2020 is a capture gap. Row absence
// therefore means "no detail feed", NEVER "nothing was purchased" — the repo
// turns that into a typed availability state rather than an empty section.
// See scrapper `prod-db/PROCUREMENT_CONTRACT.md` §DA-detail amendment.
//
// Only SERVED columns are declared. Lineage (`source_detail_hash`,
// `source_content_hash`, `source_response_id`, `source_last_seen_at`,
// `projection_version`, `detail_state_id`) is omitted so the repo cannot select
// it by accident — `detail_state_id` in particular must never be served as a
// status, since the list capture wins.

export interface ProcurementDaDetailsTable {
  da_detail_id: string;
  da_id: string | null;
  direct_acquisition_id: string;
  description: string | null;
  delivery_condition: string | null;
  payment_condition: string | null;
  contract_type_id: number | null;
  contract_type_text: string | null;
  contract_type_locale_key: string | null;
  is_eu_funded: boolean;
  eu_fund_id: number | null;
  eu_fund_text: string | null;
  ca_decision_date: string | null;
  ca_decision_deadline: string | null;
  supplier_decision_date: string | null;
  supplier_decision_deadline: string | null;
  ca_rejection_reason: string | null;
  supplier_rejection_reason: string | null;
  correction_reason: string | null;
  document_count: number;
  /** numeric → string: the item basket total, for the reconciliation disclosure. */
  items_total: string | null;
  items_value_delta: string | null;
  /** NULL when the source recorded no closing value — "unknown", not "false". */
  items_reconciled: boolean | null;
  item_count: number;
  source_url: string;
  /** 'public' | 'contact_pii' — free text on contact_pii rows is API-gated. */
  privacy_class: string;
}

export interface ProcurementDaItemsTable {
  da_item_id: string;
  da_detail_id: string;
  direct_acquisition_id: string;
  item_index: number;
  catalog_item_code: string | null;
  catalog_item_name: string | null;
  catalog_item_description: string | null;
  item_measure_unit: string | null;
  cpv_code: string | null;
  cpv_text: string | null;
  /** numeric → string throughout: money never crosses the wire as a float. */
  item_quantity: string | null;
  unit_price: string | null;
  unit_estimated_price: string | null;
  catalog_unit_price: string | null;
  /** Stored generated column: unit_price * item_quantity. */
  line_value: string | null;
  source_url: string;
  privacy_class: string;
}

// ── TED (Tenders Electronic Daily) linkage ─────────────────────────────────────
//
// Only the SERVED columns are declared. `procedure_ted_links` bridges a procedure
// to the EU notice; verified live 2026-07-09 both `procedure_id` and
// `ted_notice_id` are 100% populated across all 57 965 rows, so the link is a
// direct two-table join — `procedure_details` is NOT needed to recover the
// procedure id and is deliberately not declared here.
//
// `procedure_addresses` is contact PII and is NEVER declared nor selected.

export interface ProcurementTedNoticesTable {
  ted_notice_id: string; // bigint → string
  publication_number: string;
  source_url: string;
}

export interface ProcurementProcedureTedLinksTable {
  ted_link_id: string;
  procedure_id: string | null;
  ted_notice_id: string | null;
}

// ── analysis package (scraper-built; design §6.2) ──────────────────────────────
//
// Only the generation ledger + the 5 wave-1 rollups are declared — the
// `analysis_facts_*` projection tables stay scraper-internal and the serving
// layer never reads them. NULL `month_start` = the undated bucket; NULL dim
// values = unknown buckets. Every read pins `build_id` to the active generation.

export interface ProcurementAnalysisGenerationsTable {
  build_id: string; // bigint identity → string (pg parser)
  status: string; // 'building' | 'active' | 'retired' | 'failed'; exactly one active
  started_at: string | null;
  published_at: string | null;
  facts_counts: unknown; // jsonb
  reconcile: unknown; // jsonb
  quality: unknown; // jsonb — { "<grain>": { coverage: {...}, classes: {...} } }
  matrix_hash: string | null;
  load_run_id: string | null;
  notes: string | null;
}

/** The measures every wave-1 rollup carries (design §6.2). */
interface AnalysisRollupMeasures {
  build_id: string;
  grain: string; // 'procedure' | 'contract' | 'direct_acquisition'
  month_start: string | null; // date; NULL = undated bucket
  record_count: string; // bigint → string
  with_value_count: string;
  value_awarded_sum: string | null; // numeric(20,2) → string
  with_estimated_count: string;
  value_estimated_sum: string | null;
}

/** Key-retaining authority×supplier edges (contract + DA grains only). */
export interface ProcurementAnalysisEdgeRollupTable extends AnalysisRollupMeasures {
  authority_cui: string | null;
  supplier_cui: string | null;
}

export interface ProcurementAnalysisAuthorityDimsRollupTable extends AnalysisRollupMeasures {
  authority_cui: string | null;
  cpv_division: string | null;
  status: string | null;
  procedure_type: string | null;
}

export interface ProcurementAnalysisSupplierCpvRollupTable extends AnalysisRollupMeasures {
  supplier_cui: string | null;
  cpv_division: string | null;
}

export interface ProcurementAnalysisCpvCodeRollupTable extends AnalysisRollupMeasures {
  cpv_code: string | null;
}

export interface ProcurementAnalysisRegionCpvRollupTable extends AnalysisRollupMeasures {
  buyer_region: string | null;
  cpv_division: string | null;
}

/**
 * Counts-only value-state distribution (per grain × month × state; no scope
 * dims — global). Built for transparency surfaces: it explains WHY spend is
 * (not) served by showing the resolution-state census behind the verdict.
 */
export interface ProcurementAnalysisValueStatesRollupTable {
  build_id: string; // bigint → string
  grain: string;
  month_start: string | null; // date; NULL = undated bucket
  value_state: string;
  record_count: string; // bigint → string
}

declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'procurement.procedures': ProcurementProceduresTable;
    'procurement.contracts': ProcurementContractsTable;
    'procurement.direct_acquisitions': ProcurementDirectAcquisitionsTable;
    'procurement.contract_modifications': ProcurementContractModificationsTable;
    'procurement.cpv_divisions': ProcurementCpvDivisionsTable;
    'procurement.cpv_codes': ProcurementCpvCodesTable;
    'procurement.da_details': ProcurementDaDetailsTable;
    'procurement.da_items': ProcurementDaItemsTable;
    'procurement.ted_notices': ProcurementTedNoticesTable;
    'procurement.procedure_ted_links': ProcurementProcedureTedLinksTable;
    'procurement.analysis_generations': ProcurementAnalysisGenerationsTable;
    'procurement.analysis_rollup_edge_monthly': ProcurementAnalysisEdgeRollupTable;
    'procurement.analysis_rollup_authority_dims_monthly': ProcurementAnalysisAuthorityDimsRollupTable;
    'procurement.analysis_rollup_supplier_cpv_monthly': ProcurementAnalysisSupplierCpvRollupTable;
    'procurement.analysis_rollup_cpv_code_monthly': ProcurementAnalysisCpvCodeRollupTable;
    'procurement.analysis_rollup_region_cpv_monthly': ProcurementAnalysisRegionCpvRollupTable;
    'procurement.analysis_rollup_value_states_monthly': ProcurementAnalysisValueStatesRollupTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
