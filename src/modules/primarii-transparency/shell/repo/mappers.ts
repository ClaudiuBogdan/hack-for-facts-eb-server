/**
 * Primarii-transparency repo — row → view-model mappers (plan §2).
 *
 * Each row interface lists the snake_case columns the repo SELECTs (NEVER the raw
 * pointers `local_path`/`raw_*`/`source_excerpt`, §8). Timestamptz columns are cast
 * `::text` at the SQL boundary (the pool only overrides the int8 parser), so they
 * arrive as ISO strings the DateTime scalar + cursor keyset expect. `real` columns
 * arrive as JS numbers; `numeric`/`bigint` as strings.
 */

import type {
  PrimariiCategoryStatus,
  PrimariiDocument,
  PrimariiEntityStatus,
  PrimariiLoadIssue,
  PrimariiOrganigramaClaim,
  PrimariiRegistryLink,
  PrimariiSalaryClaim,
  PrimariiSnapshot,
  PrimariiStaffingClaim,
} from '../../core/types.js';

const toStringArray = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

// ── current_entity_status ────────────────────────────────────────────────────

export interface EntityStatusRow {
  cui: string;
  snapshot_id: string | null;
  entity_name: string;
  entity_type: string | null;
  county: string | null;
  website_url: string | null;
  result_status: string;
  data_quality_status: string;
  confidence: number | null;
  evidence_coverage: number | null;
  missing_required_categories: unknown;
  issue_count: number;
  updated_at: string; // ::text
}

export const mapEntityStatus = (r: EntityStatusRow): PrimariiEntityStatus => ({
  cui: r.cui,
  snapshotId: r.snapshot_id,
  entityName: r.entity_name,
  entityType: r.entity_type,
  county: r.county,
  websiteUrl: r.website_url,
  resultStatus: r.result_status,
  dataQualityStatus: r.data_quality_status,
  confidence: r.confidence,
  evidenceCoverage: r.evidence_coverage,
  missingRequiredCategories: toStringArray(r.missing_required_categories),
  issueCount: r.issue_count,
  updatedAt: r.updated_at,
});

// ── entity_category_statuses ─────────────────────────────────────────────────

export interface CategoryStatusRow {
  category: string;
  status: string;
  evidence_count: number;
  missing_evidence_count: number;
}

export const mapCategoryStatus = (r: CategoryStatusRow): PrimariiCategoryStatus => ({
  category: r.category,
  status: r.status,
  evidenceCount: r.evidence_count,
  missingEvidenceCount: r.missing_evidence_count,
});

// ── staffing_claims ──────────────────────────────────────────────────────────

export interface StaffingRow {
  total_positions: number | null;
  occupied_positions: number | null;
  vacant_positions: number | null;
  as_of_date: string | null;
  confidence: number | null;
}

export const mapStaffing = (r: StaffingRow): PrimariiStaffingClaim => ({
  totalPositions: r.total_positions,
  occupiedPositions: r.occupied_positions,
  vacantPositions: r.vacant_positions,
  asOfDate: r.as_of_date,
  confidence: r.confidence,
});

// ── organigrama_claims ───────────────────────────────────────────────────────

export interface OrganigramaRow {
  status: string;
  effective_date: string | null;
  summary: string | null;
  confidence: number | null;
}

export const mapOrganigrama = (r: OrganigramaRow): PrimariiOrganigramaClaim => ({
  status: r.status,
  effectiveDate: r.effective_date,
  summary: r.summary,
  confidence: r.confidence,
});

// ── documents ────────────────────────────────────────────────────────────────

export interface DocumentRow {
  document_pk: string;
  cui: string;
  category: string | null;
  document_type: string | null;
  title: string | null;
  source_url: string | null;
  content_sha256: string | null;
  content_bytes: string | null;
  published_date: string | null;
  effective_date: string | null;
}

export const mapDocument = (r: DocumentRow): PrimariiDocument => ({
  documentPk: r.document_pk,
  cui: r.cui,
  category: r.category,
  documentType: r.document_type,
  title: r.title,
  sourceUrl: r.source_url,
  contentSha256: r.content_sha256,
  contentBytes: r.content_bytes,
  publishedDate: r.published_date,
  effectiveDate: r.effective_date,
});

// ── salary_amount_claims ─────────────────────────────────────────────────────

export interface SalaryClaimRow {
  salary_amount_claim_id: string;
  cui: string;
  document_pk: string | null;
  amount_ron: string;
  role_title: string | null;
  period_start: string | null; // ::text of a real DATE
  period_end: string | null;
  confidence: number | null;
}

export const mapSalaryClaim = (r: SalaryClaimRow): PrimariiSalaryClaim => ({
  salaryAmountClaimId: r.salary_amount_claim_id,
  cui: r.cui,
  documentPk: r.document_pk,
  amountRon: r.amount_ron,
  // role_title is empty for all live rows (no PII); pass through as null when blank.
  roleTitle: r.role_title !== null && r.role_title.trim() !== '' ? r.role_title : null,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  confidence: r.confidence,
});

// ── entity_snapshots ─────────────────────────────────────────────────────────

export interface SnapshotRow {
  snapshot_id: string;
  cui: string;
  entity_name: string;
  entity_type: string | null;
  county: string | null;
  website_url: string | null;
  wikipedia_url: string | null;
  source_result_version_id: string | null;
  schema_version: string | null;
  result_status: string;
  confidence: number | null;
  researched_at: string | null; // ::text
  organigrama_status: string | null;
  numar_angajati_status: string | null;
  salarii_status: string | null;
  missing_required_categories: unknown;
  validation_issues: unknown;
  loaded_at: string; // ::text
}

export const mapSnapshot = (r: SnapshotRow): PrimariiSnapshot => ({
  snapshotId: r.snapshot_id,
  cui: r.cui,
  entityName: r.entity_name,
  entityType: r.entity_type,
  county: r.county,
  websiteUrl: r.website_url,
  wikipediaUrl: r.wikipedia_url,
  sourceResultVersionId: r.source_result_version_id,
  schemaVersion: r.schema_version,
  resultStatus: r.result_status,
  confidence: r.confidence,
  researchedAt: r.researched_at,
  organigramaStatus: r.organigrama_status,
  numarAngajatiStatus: r.numar_angajati_status,
  salariiStatus: r.salarii_status,
  missingRequiredCategories: toStringArray(r.missing_required_categories),
  validationIssues: toStringArray(r.validation_issues),
  loadedAt: r.loaded_at,
});

// ── load_issues ──────────────────────────────────────────────────────────────

export interface LoadIssueRow {
  severity: string;
  issue_code: string;
  cui: string | null;
  message: string;
  created_at: string; // ::text
}

export const mapLoadIssue = (r: LoadIssueRow): PrimariiLoadIssue => ({
  severity: r.severity,
  issueCode: r.issue_code,
  cui: r.cui,
  message: r.message,
  createdAt: r.created_at,
});

// ── entity_registry_links (DDL-only today) ───────────────────────────────────

export interface RegistryLinkRow {
  registry: string;
  registry_cui: string;
  link_confidence: number | null;
}

export const mapRegistryLink = (r: RegistryLinkRow): PrimariiRegistryLink => ({
  registry: r.registry,
  registryCui: r.registry_cui,
  linkConfidence: r.link_confidence,
});
