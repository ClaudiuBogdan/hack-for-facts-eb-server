import type {
  NgoPublicEmploymentAccreditationRow,
  NgoPublicPurposeRow,
  NgoPublicSectionSnapshotRow,
  NgoPublicSocialEnterpriseCertificateRow,
  NgoPublicSocialServiceProviderRow,
  NgoPublicSocialServiceRow,
} from './schema.js';

/**
 * Allowlisted outputs of the SELECT-only data-layer functions `ngo.public_organization_profile(cui)`
 * and `ngo.public_financial_statements(cui, years)`. Office, custody, hash and storage-pointer
 * columns are structurally absent; the repository selects exactly these names. The function's
 * legacy `purpose_availability` is not read: purpose comes from `ngo.rnong_public_purposes`.
 * Dates/timestamps are read as `::text`.
 */
export interface NgoOrganizationProfileRow {
  organization_key: string;
  source_snapshot_id: string;
  registry_number: string;
  registry_number_valid: boolean;
  observation_count: number;
  legal_record_ids: string[];
  organization_name: string | null;
  name_withheld: boolean;
  entity_kind: string | null;
  legal_form: string | null;
  special_registry_number: string | null;
  court_names: (string | null)[];
  source_registration_date: string | null;
  source_registry_status: string | null;
  county: string | null;
  locality: string | null;
  is_branch: boolean | null;
  source_reports_public_utility: boolean | null;
  source_cui: string | null;
  organization_cui: string | null;
  identity_method: string | null;
  court_differs: boolean;
  name_differs: boolean;
  category_differs: boolean;
  status_differs: boolean;
  county_differs: boolean;
  locality_differs: boolean;
  source_cui_differs: boolean;
  identity_differs: boolean;
  cui_conflict: boolean;
  anaf_registration_availability: string;
  anaf_reference: string | null;
  anaf_status_date: string | null;
  anaf_retrieved_at: string | null;
  anaf_registration_state_text: string | null;
  anaf_registration_state: string | null;
  anaf_registration_state_date: string | null;
  anaf_registration_date: string | null;
  anaf_legal_form: string | null;
  anaf_organization_form: string | null;
  anaf_fiscal_office: string | null;
  anaf_is_inactive: boolean | null;
  anaf_inactivated_on: string | null;
  anaf_reactivated_on: string | null;
  anaf_inactive_register_removed_on: string | null;
  fiscal_availability: string;
  fiscal_is_inactive: boolean | null;
  fiscal_is_vat_payer: boolean | null;
  fiscal_main_caen_code: string | null;
  fiscal_status_date: string | null;
  fiscal_retrieved_at: string | null;
  fiscal_source_snapshot_id: string | null;
  financials_availability: string;
  financial_years: number[];
}

/** Profile-section view rows for one admitted CUI, read in the profile's own snapshot. */
export interface NgoProfileSectionRows {
  readonly purposes: readonly NgoPublicPurposeRow[];
  readonly snapshots: readonly NgoPublicSectionSnapshotRow[];
  readonly socialServices: readonly NgoPublicSocialServiceRow[];
  readonly socialServiceAccreditations: readonly NgoPublicSocialServiceProviderRow[];
  readonly socialEnterpriseCertificates: readonly NgoPublicSocialEnterpriseCertificateRow[];
  readonly employmentServiceAccreditations: readonly NgoPublicEmploymentAccreditationRow[];
}

export interface NgoPublicFinancialStatementRow {
  fiscal_year: number;
  source_row_number: number;
  source_url: string;
  dictionary_url: string;
  captured_at: string;
  /** jsonb: ordered `{code, name, normalizedName}` definitions; validated before use. */
  indicator_definitions: unknown;
  /** jsonb: reported I-code → exact integer string; validated before use. */
  indicators: unknown;
}
