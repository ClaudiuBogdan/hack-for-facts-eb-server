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

export interface ProcurementProceduresTable {
  procedure_id: string; // bigint → string
  source_system: string;
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

export interface ProcurementContractModificationsTable {
  modification_id: string;
  contract_id: string | null;
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

declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'procurement.procedures': ProcurementProceduresTable;
    'procurement.contracts': ProcurementContractsTable;
    'procurement.direct_acquisitions': ProcurementDirectAcquisitionsTable;
    'procurement.contract_modifications': ProcurementContractModificationsTable;
    'procurement.cpv_divisions': ProcurementCpvDivisionsTable;
    'procurement.cpv_codes': ProcurementCpvCodesTable;
    'procurement.org_edge_monthly_rollups': ProcurementOrgEdgeRollupTable;
    'procurement.authority_cpv_division_monthly_rollups': ProcurementAuthorityCpvRollupTable;
    'procurement.supplier_cpv_division_monthly_rollups': ProcurementSupplierCpvRollupTable;
    'procurement.same_day_direct_acquisition_candidates': ProcurementSameDayCandidatesTable;
    'procurement.aggregate_quality_by_grain': ProcurementGrainQualityTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
