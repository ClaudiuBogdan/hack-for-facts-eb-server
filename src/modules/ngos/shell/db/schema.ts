/** Only audited views enter the server DB type. Restricted base tables are deliberately absent. */
export interface NgoPublicSnapshotRow {
  source_snapshot_id: string;
  source_declared_snapshot_date: string | null;
  loaded_at: string;
  captured_at: string;
  refresh_overdue: boolean;
  accepted_at: string | null;
  row_count: number;
  is_current: boolean;
  source_url: string;
  coverage_basis: string;
  national_completeness: string;
  privacy_class: string;
}
export interface NgoPublicRecordRow {
  legal_record_id: string;
  source_snapshot_id: string;
  source_row_number: number;
  registry_number: string;
  special_registry_number: string | null;
  source_registration_date: string | null;
  entity_kind: string;
  legal_form: string;
  organization_name: string;
  normalized_name: string | null;
  name_withheld: boolean;
  court_name: string;
  source_registry_status: string;
  county: string | null;
  locality: string | null;
  source_cui: string | null;
  linked_organization_cui: string | null;
  is_branch: boolean | null;
  source_reports_public_utility: boolean | null;
  source_declared_snapshot_date: string | null;
  loaded_at: string;
  captured_at: string;
  refresh_overdue: boolean;
  accepted_at: string | null;
  snapshot_row_count: number;
  is_current: boolean;
  source_url: string;
  coverage_basis: string;
  national_completeness: string;
  privacy_class: string;
}
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'ngo.rnong_public_snapshots': NgoPublicSnapshotRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'ngo.rnong_public_records': NgoPublicRecordRow;
  }
}

export interface NgoPublicFiscalRow {
  cui: string;
  is_vat_payer: boolean | null;
  is_inactive: boolean | null;
  is_split_vat: boolean | null;
  main_caen_code: string | null;
  main_caen_rev: string | null;
  status_date: string | null;
  retrieved_at: string | null;
  source_url: string;
  source_snapshot_id: string;
  privacy_class: string;
}
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'ngo.public_fiscal_status': NgoPublicFiscalRow;
  }
}
