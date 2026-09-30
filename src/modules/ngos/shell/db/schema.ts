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

/** Full RNONG purpose per non-withheld observation (scraper migration 20260930T110000); null is a blank cell. */
export interface NgoPublicPurposeRow {
  legal_record_id: string;
  purpose: string | null;
}
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'ngo.rnong_public_purposes': NgoPublicPurposeRow;
  }
}

/** Profile-section allowlists (scraper migration 20260930T100000); current snapshot only. */
export interface NgoPublicSectionSnapshotRow {
  source_id: string;
  source_snapshot_id: string;
  source_url: string;
  source_declared_snapshot_date: string | null;
  loaded_at: string;
}
/** service_name and locality are null whenever county_only is true. */
export interface NgoPublicSocialServiceRow {
  cui: string;
  service_type: string | null;
  service_code: string | null;
  service_name: string | null;
  county: string | null;
  locality: string | null;
  capacity: number | null;
  license_number: string | null;
  licensed_on: string | null;
  county_only: boolean;
  source_record_key: string;
}
export interface NgoPublicSocialServiceProviderRow {
  cui: string;
  certificate_number: string | null;
  accreditation_decision_number: string | null;
  source_record_key: string;
}
export interface NgoPublicSocialEnterpriseCertificateRow {
  cui: string;
  certificate_number: string | null;
  certificate_date: string | null;
  valid_until: string | null;
  certificate_status: string | null;
  source_record_key: string;
}
export interface NgoPublicEmploymentAccreditationRow {
  cui: string;
  certificate_number: string | null;
  issued_on: string | null;
  source_record_key: string;
}
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'ngo.public_section_snapshots': NgoPublicSectionSnapshotRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'ngo.public_social_services': NgoPublicSocialServiceRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'ngo.public_social_service_providers': NgoPublicSocialServiceProviderRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'ngo.public_social_enterprise_certificates': NgoPublicSocialEnterpriseCertificateRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'ngo.public_employment_accreditations': NgoPublicEmploymentAccreditationRow;
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
