/**
 * Primarii-transparency module — `ProdDatabase` augmentation (foundation §3, §14
 * module-augmentation pattern).
 *
 * Types the live `primarii_transparency.*` tables onto the single kernel Kysely
 * instance via TS declaration merging. Table keys are the schema-qualified live
 * names exactly as the prod snapshot. The `core.*` tables this module reads through
 * the kernel resolver (`public_entities`/`territories`) are already typed by the
 * kernel — this module never joins them privately (§3 / plan §3).
 *
 * Scalars (§14.1): `bigint` ids (`snapshot_id`/`document_pk`/`*_claim_id`/
 * `content_bytes`) are `string` (the pool's int8 parser); `numeric` (`amount_ron`)
 * is `string` (money precision); `real` (`confidence`/`evidence_coverage`) is
 * `number`; `timestamptz` is an ISO string; `text[]` is `string[]`; `attrs`/
 * `payload` jsonb is `Record<string, unknown>` (read-only). `*_date`/`as_of_date`
 * columns on documents/claims are stored as TEXT (NOT date) — `string | null`,
 * unparsed. `period_start`/`period_end` on salary_amount_claims are real DATE.
 *
 * Raw-pointer columns (`local_path`, `raw_*`, `source_excerpt`) are typed where
 * they physically exist but are NEVER selected into a default projection (§8 PII /
 * raw-evidence exclusion).
 */

import type { ColumnType } from 'kysely';

/** A read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;
/** jsonb column read-only (server is read-only). */
type Jsonb = ColumnType<Record<string, unknown>, never, never>;
/** text[] column read-only. */
type TextArray = ColumnType<string[], never, never>;

export interface PrimariiCurrentEntityStatusTable {
  cui: string;
  snapshot_id: string | null; // bigint → string
  entity_name: string;
  entity_type: string | null;
  county: string | null;
  website_url: string | null;
  result_status: string;
  data_quality_status: string;
  confidence: number | null; // real
  evidence_coverage: number | null; // real
  missing_required_categories: TextArray;
  issue_count: number; // integer
  updated_at: Tstz;
}

export interface PrimariiEntitySnapshotsTable {
  snapshot_id: string; // bigint → string
  cui: string;
  entity_name: string;
  entity_type: string | null;
  county: string | null;
  website_url: string | null;
  wikipedia_url: string | null;
  source_result_version_id: string | null; // bigint → string
  source_result_sha256: string | null;
  schema_version: string | null;
  result_status: string;
  confidence: number | null;
  researched_at: Tstz | null;
  organigrama_status: string | null;
  numar_angajati_status: string | null;
  salarii_status: string | null;
  missing_required_categories: TextArray;
  validation_issues: TextArray;
  attrs: Jsonb;
  loaded_at: Tstz;
}

export interface PrimariiEntityCategoryStatusesTable {
  snapshot_id: string; // bigint → string
  cui: string;
  category: string;
  status: string;
  evidence_count: number;
  missing_evidence_count: number;
  attrs: Jsonb;
}

export interface PrimariiDocumentsTable {
  document_pk: string; // bigint → string
  snapshot_id: string | null;
  cui: string;
  raw_document_id: string | null; // RAW pointer — never projected (§8)
  raw_document_key: string | null; // RAW pointer — never projected (§8)
  category: string | null;
  document_type: string | null;
  title: string | null;
  source_url: string | null;
  local_path: string | null; // RAW pointer — never projected (§8)
  raw_evidence_occurrence_id: string | null; // bigint; RAW pointer — never projected
  raw_evidence_object_id: string | null; // bigint; RAW pointer — never projected
  content_sha256: string | null;
  content_bytes: string | null; // bigint → string
  published_date: string | null; // TEXT (unparsed)
  effective_date: string | null; // TEXT (unparsed)
  attrs: Jsonb;
  created_at: Tstz;
}

export interface PrimariiSalaryAmountClaimsTable {
  salary_amount_claim_id: string; // bigint → string
  snapshot_id: string | null;
  cui: string;
  document_pk: string | null; // bigint → string
  amount_ron: string; // numeric(18,2) → string
  role_title: string | null;
  period_start: string | null; // real DATE → YYYY-MM-DD
  period_end: string | null;
  confidence: number | null;
  raw_quality_run_id: string | null; // RAW pointer — never projected (§8)
  raw_claim_observation_id: string | null; // bigint; RAW pointer — never projected
  source_excerpt: string | null; // RAW text — never projected (§8)
  attrs: Jsonb;
}

export interface PrimariiStaffingClaimsTable {
  staffing_claim_id: string; // bigint → string
  snapshot_id: string | null;
  cui: string;
  total_positions: number | null;
  occupied_positions: number | null;
  vacant_positions: number | null;
  as_of_date: string | null; // TEXT (unparsed)
  confidence: number | null;
  raw_claim_observation_id: string | null;
  source_excerpt: string | null; // RAW text — never projected (§8)
  attrs: Jsonb;
}

export interface PrimariiOrganigramaClaimsTable {
  organigrama_claim_id: string; // bigint → string
  snapshot_id: string | null;
  cui: string;
  status: string;
  effective_date: string | null; // TEXT (unparsed)
  summary: string | null;
  confidence: number | null;
  raw_claim_observation_id: string | null;
  source_excerpt: string | null; // RAW text — never projected (§8)
  attrs: Jsonb;
}

export interface PrimariiLoadIssuesTable {
  load_issue_id: string; // bigint → string
  load_run_id: string | null;
  severity: string;
  issue_code: string;
  cui: string | null;
  source_result_version_id: string | null;
  raw_evidence_occurrence_id: string | null;
  raw_evidence_object_id: string | null;
  message: string;
  payload: Jsonb;
  created_at: Tstz;
}

export interface PrimariiEntityRegistryLinksTable {
  link_id: string; // bigint → string
  cui: string;
  registry: string;
  registry_cui: string;
  link_confidence: number | null;
  attrs: Jsonb;
  created_at: Tstz;
}

/**
 * Declaration-merge the `primarii_transparency.*` tables onto the kernel
 * `ProdDatabase`. Importing the module barrel (which re-exports this file) pulls the
 * augmentation into scope. `salary_documents` + `fact_evidence_refs` are NOT typed
 * (out of v1 scope per plan §1).
 */
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'primarii_transparency.current_entity_status': PrimariiCurrentEntityStatusTable;
    'primarii_transparency.entity_snapshots': PrimariiEntitySnapshotsTable;
    'primarii_transparency.entity_category_statuses': PrimariiEntityCategoryStatusesTable;
    'primarii_transparency.documents': PrimariiDocumentsTable;
    'primarii_transparency.salary_amount_claims': PrimariiSalaryAmountClaimsTable;
    'primarii_transparency.staffing_claims': PrimariiStaffingClaimsTable;
    'primarii_transparency.organigrama_claims': PrimariiOrganigramaClaimsTable;
    'primarii_transparency.load_issues': PrimariiLoadIssuesTable;
    'primarii_transparency.entity_registry_links': PrimariiEntityRegistryLinksTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
