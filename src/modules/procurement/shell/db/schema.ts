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
  currency: string | null; // ⚠ repurposed non-RON flag carrier (audit F1/F7)
  status: string;
  county_name: string | null;
  is_canonical: boolean;
  dup_group_id: string | null; // bigint → string
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
  parent_code: string | null; // 100% NULL (corrupt)
  cpv_level: number | null; // 100% NULL (corrupt)
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

// ── materialized views (the aggregate path) ────────────────────────────────────

export interface ProcurementOrgEdgeRollupTable {
  projection_version: string;
  month_start: string; // date
  source_grain: string;
  authority_cui: string;
  authority_name: string | null;
  supplier_cui: string;
  supplier_name: string | null;
  authority_county_code: string | null;
  authority_county_name: string | null;
  authority_region: string | null;
  flow_count: string; // bigint → string
  amount_ron_sum: string | null; // numeric(20,2) → string
  amount_present_count: string;
  amount_missing_count: string;
  date_present_count: string;
  cpv_present_count: string;
  distinct_cpv_code_count: string;
  distinct_cpv_division_count: string;
  authority_territory_present_count: string;
  first_flow_date: string | null;
  last_flow_date: string | null;
  evidence_refs_sample: string[];
  refreshed_at: string | null;
}

export interface ProcurementAuthorityCpvRollupTable {
  projection_version: string;
  month_start: string;
  source_grain: string;
  authority_cui: string;
  authority_name: string | null;
  authority_county_code: string | null;
  authority_county_name: string | null;
  authority_region: string | null;
  cpv_division_code: string;
  cpv_division_label_en: string | null;
  flow_count: string;
  amount_ron_sum: string | null;
  amount_present_count: string;
  amount_missing_count: string;
  distinct_supplier_count: string;
  first_flow_date: string | null;
  last_flow_date: string | null;
  evidence_refs_sample: string[];
  refreshed_at: string | null;
}

export interface ProcurementSupplierCpvRollupTable {
  projection_version: string;
  month_start: string;
  source_grain: string;
  authority_cui: string;
  authority_name: string | null;
  supplier_cui: string;
  supplier_name: string | null;
  authority_county_code: string | null;
  authority_county_name: string | null;
  authority_region: string | null;
  cpv_division_code: string;
  cpv_division_label_en: string | null;
  flow_count: string;
  amount_ron_sum: string | null;
  amount_present_count: string;
  amount_missing_count: string;
  distinct_cpv_code_count: string;
  first_flow_date: string | null;
  last_flow_date: string | null;
  evidence_refs_sample: string[];
  refreshed_at: string | null;
}

export interface ProcurementSameDayCandidatesTable {
  projection_version: string;
  candidate_date: string;
  authority_cui: string;
  authority_name: string | null;
  supplier_cui: string;
  supplier_name: string | null;
  authority_county_code: string | null;
  authority_county_name: string | null;
  authority_region: string | null;
  cpv_code: string | null;
  cpv_division_code: string | null;
  cpv_division_label_en: string | null;
  same_day_count: string;
  same_day_total_ron: string | null;
  max_single_amount_ron: string | null;
  amount_present_count: string;
  amount_missing_count: string;
  evidence_refs_sample: string[];
  refreshed_at: string | null;
}

export interface ProcurementGrainQualityTable {
  projection_version: string;
  source_grain: string;
  rows_count: string;
  authority_cui_present_count: string;
  supplier_cui_present_count: string;
  amount_present_count: string;
  cpv_present_count: string;
  date_present_count: string;
  authority_count: string;
  authority_territory_count: string;
  authority_cui_coverage_rate: string; // numeric → string
  supplier_cui_coverage_rate: string;
  amount_coverage_rate: string;
  cpv_coverage_rate: string;
  date_coverage_rate: string;
  authority_territory_coverage_rate: string;
  filter_answers_allowed: boolean;
  spend_rankings_allowed: boolean;
  supplier_region_filters_allowed: boolean;
  blockers: string[];
  refreshed_at: string | null;
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

declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'procurement.procedures': ProcurementProceduresTable;
    'procurement.contracts': ProcurementContractsTable;
    'procurement.direct_acquisitions': ProcurementDirectAcquisitionsTable;
    'procurement.contract_modifications': ProcurementContractModificationsTable;
    'procurement.cpv_divisions': ProcurementCpvDivisionsTable;
    'procurement.cpv_codes': ProcurementCpvCodesTable;
    'procurement.ted_notices': ProcurementTedNoticesTable;
    'procurement.procedure_ted_links': ProcurementProcedureTedLinksTable;
    'procurement.org_edge_monthly_rollups': ProcurementOrgEdgeRollupTable;
    'procurement.authority_cpv_division_monthly_rollups': ProcurementAuthorityCpvRollupTable;
    'procurement.supplier_cpv_division_monthly_rollups': ProcurementSupplierCpvRollupTable;
    'procurement.same_day_direct_acquisition_candidates': ProcurementSameDayCandidatesTable;
    'procurement.aggregate_quality_by_grain': ProcurementGrainQualityTable;
    'procurement.analysis_generations': ProcurementAnalysisGenerationsTable;
    'procurement.analysis_rollup_edge_monthly': ProcurementAnalysisEdgeRollupTable;
    'procurement.analysis_rollup_authority_dims_monthly': ProcurementAnalysisAuthorityDimsRollupTable;
    'procurement.analysis_rollup_supplier_cpv_monthly': ProcurementAnalysisSupplierCpvRollupTable;
    'procurement.analysis_rollup_cpv_code_monthly': ProcurementAnalysisCpvCodeRollupTable;
    'procurement.analysis_rollup_region_cpv_monthly': ProcurementAnalysisRegionCpvRollupTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
