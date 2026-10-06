/**
 * Only the five R5 public views (scraper migration
 * 20261006T180000__public_enterprises_public_read_views) enter the server DB
 * type. The canonical base tables and the internal `current_*` views are
 * deliberately absent: every privacy, currency and parent rule lives in the
 * views. Timestamps and dates are read as `::text` by the repository.
 */
export interface PublicSourceSnapshotRow {
  snapshot_id: string;
  source_family: string;
  source_scope: string;
  source_url: string | null;
  content_sha256: string | null;
  observed_at: string | null;
  source_last_modified_at: string | null;
  accepted_at: string | null;
  loaded_at: string;
  raw_status: string | null;
}

export interface PublicRegistryObservationRow {
  registry_observation_key: string;
  snapshot_id: string;
  source_family: string;
  source_record_key: string;
  cui: string;
  raw_cui: string | null;
  cui_checksum_status: string;
  publish_status: string;
  observed_name: string | null;
  observed_year: number | null;
  status_raw: string | null;
  status_normalized: string | null;
  raw_subordination: string | null;
  derived_authority_level: string | null;
  source_evidence_key: string;
  source_url: string | null;
}

export interface PublicAuthorityEdgeRow {
  control_edge_key: string;
  snapshot_id: string;
  source_family: string;
  source_record_key: string;
  enterprise_cui: string;
  authority_cui: string | null;
  authority_name: string | null;
  raw_subordination: string | null;
  authority_level: string;
  authority_level_method: string;
  apt_type_id: number | null;
  enterprise_status_raw: string | null;
  effective_from: string | null;
  effective_to: string | null;
  source_evidence_key: string;
  source_url: string | null;
}

export interface PublicEnterpriseMembershipRow {
  cui: string;
  organization_cui: string;
  current_families: string[];
  is_current_member: boolean;
}

export interface PublicAmepipIndicatorRow {
  snapshot_id: string;
  enterprise_cui: string;
  year: number;
  source_sheet: string;
  version: string;
  indicator_key: string;
  kpi_code: string | null;
  indicator_name: string;
  measure_unit: string | null;
  value_kind: string;
  raw_value: string | null;
  /** `numeric::text` in the view: exact decimal text, never a JS number. */
  numeric_value: string | null;
  boolean_value: boolean | null;
  text_value: string | null;
  source_row_number: number | null;
  source_evidence_key: string;
  source_url: string | null;
}

declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'public_enterprises.public_source_snapshots': PublicSourceSnapshotRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'public_enterprises.public_registry_observations': PublicRegistryObservationRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'public_enterprises.public_authority_edges': PublicAuthorityEdgeRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'public_enterprises.public_enterprise_memberships': PublicEnterpriseMembershipRow;
    // eslint-disable-next-line @typescript-eslint/naming-convention -- Schema-qualified Kysely table key.
    'public_enterprises.public_amepip_indicators': PublicAmepipIndicatorRow;
  }
}
