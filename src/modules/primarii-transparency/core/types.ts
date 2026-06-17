/**
 * Primarii-transparency module — view-model types & dimensions (plan §2).
 *
 * A curated transparency-QA registry over Romanian local-government entities
 * (UAT town/commune halls), keyed by CUI. Each entity asserts whether the UAT
 * publishes three legally-required transparency artifacts (organigrama / staff
 * headcount / salary disclosures), plus a derived data-quality status and the
 * evidence documents backing each claim. The strongest correlation axis is
 * TERRITORY (UAT/county), NOT money — this source owns no `flows.money_flows`
 * rows (§4 grain gate).
 *
 * Scalar contract (§14.1): `cui`/`county` text → string; `snapshot_id`/
 * `document_pk`/`salaryAmountClaimId` bigint → string (BigInt scalar, never JS
 * number); `amount_ron` numeric(18,2) → string (Money, SELF-REPORTED, not spend);
 * `confidence`/`evidence_coverage` real → number; `updated_at` timestamptz → ISO
 * string; `*_date`/`as_of_date` on documents/claims are stored as TEXT (unparsed)
 * and pass through as strings — the plan does NOT promise date-range filtering on
 * them. `period_start`/`period_end` on salary claims are real DATE → 'YYYY-MM-DD'.
 *
 * Kernel types (`Territory`, `EntityProfileSlice`, `ResolveHit`, `SourcePresence`)
 * are reused un-prefixed; module types are `Primarii*` (§14.8).
 */

import type { ResolveHit, Territory } from '@/modules/shared/index.js';

// ── closed enum value sets (verified live 2026-06-16; drive §7 filters + tests) ──

/** `current_entity_status.data_quality_status` — the headline filter. */
export const PRIMARII_DATA_QUALITY = ['high', 'medium', 'low', 'missing', 'review_needed'] as const;
export type PrimariiDataQuality = (typeof PRIMARII_DATA_QUALITY)[number];

/** `current_entity_status.result_status`. */
export const PRIMARII_RESULT_STATUS = [
  'partial',
  'complete',
  'blocked',
  'missing_result',
  'not_found',
  'error',
] as const;
export type PrimariiResultStatus = (typeof PRIMARII_RESULT_STATUS)[number];

/** The three legally-required transparency categories. */
export const PRIMARII_CATEGORY = ['organigrama', 'numar_angajati', 'salarii'] as const;
export type PrimariiCategory = (typeof PRIMARII_CATEGORY)[number];

/** `entity_category_statuses.status` — the per-category evidence state. */
export const PRIMARII_CATEGORY_STATE = ['found', 'not_found', 'unknown', 'blocked'] as const;
export type PrimariiCategoryState = (typeof PRIMARII_CATEGORY_STATE)[number];

/** `current_entity_status.entity_type` — closed 5-value set (verified live). */
export const PRIMARII_ENTITY_TYPE = [
  'admin_commune_hall',
  'admin_town_hall',
  'admin_municipality',
  'admin_sector_hall',
  'primarie',
] as const;
export type PrimariiEntityType = (typeof PRIMARII_ENTITY_TYPE)[number];

/** `load_issues.severity`. */
export const PRIMARII_ISSUE_SEVERITY = ['info', 'warning', 'error'] as const;
export type PrimariiIssueSeverity = (typeof PRIMARII_ISSUE_SEVERITY)[number];

/** Aggregate groupings for status rollups (`region` is hub-join, gated on coverage). */
export const PRIMARII_STAT_GROUP_BY = [
  'county',
  'region',
  'data_quality_status',
  'result_status',
  'entity_type',
] as const;
export type PrimariiStatGroupBy = (typeof PRIMARII_STAT_GROUP_BY)[number];

/** Discovery dimensions for `resolve` (§7.4). `siruta` delegates to the kernel hub. */
export const PRIMARII_RESOLVE_DIMS = ['entity', 'county', 'status', 'siruta'] as const;
export type PrimariiResolveDim = (typeof PRIMARII_RESOLVE_DIMS)[number];

/** Allowed list sort keys (cursor keyset tiebroken on `cui`). */
export const PRIMARII_ENTITY_SORT_KEYS = [
  'data_quality',
  'confidence',
  'evidence_coverage',
  'issue_count',
  'entity_name',
  'updated_at',
] as const;
export type PrimariiEntitySortKey = (typeof PRIMARII_ENTITY_SORT_KEYS)[number];

// ── view models ──────────────────────────────────────────────────────────────

/** `current_entity_status` (primary read surface — 1 per UAT CUI, current view). */
export interface PrimariiEntityStatus {
  readonly cui: string;
  readonly snapshotId: string | null; // bigint → string
  readonly entityName: string;
  readonly entityType: string | null; // closed 5-value set (see PRIMARII_ENTITY_TYPE)
  readonly county: string | null; // denormalized text (no SIRUTA here)
  readonly websiteUrl: string | null;
  readonly resultStatus: string;
  readonly dataQualityStatus: string;
  readonly confidence: number | null; // 0..1 real
  readonly evidenceCoverage: number | null; // 0..1 real
  readonly missingRequiredCategories: readonly string[]; // text[]
  readonly issueCount: number;
  readonly updatedAt: string; // ISO
}

/** `entity_category_statuses` — per-category evidence state, scoped to current snapshot. */
export interface PrimariiCategoryStatus {
  readonly category: string; // organigrama | numar_angajati | salarii
  readonly status: string; // found | not_found | unknown | blocked
  readonly evidenceCount: number;
  readonly missingEvidenceCount: number;
}

/** `staffing_claims` — headcount (1 per current snapshot). */
export interface PrimariiStaffingClaim {
  readonly totalPositions: number | null;
  readonly occupiedPositions: number | null;
  readonly vacantPositions: number | null;
  readonly asOfDate: string | null; // TEXT (unparsed)
  readonly confidence: number | null;
}

/** `organigrama_claims` — org-chart status (1 per current snapshot). */
export interface PrimariiOrganigramaClaim {
  readonly status: string; // found | not_found | unknown | blocked
  readonly effectiveDate: string | null; // TEXT (unparsed)
  readonly summary: string | null;
  readonly confidence: number | null;
  // source_excerpt + raw_* are excluded from the default projection (§8).
}

/** Document count per category (for the profile bundle). */
export interface PrimariiCategoryCount {
  readonly category: string;
  readonly count: number;
}

/** The entity profile bundle (detail page + entity-360 slice). */
export interface PrimariiEntityProfile {
  readonly status: PrimariiEntityStatus;
  readonly categories: readonly PrimariiCategoryStatus[];
  readonly staffing: PrimariiStaffingClaim | null; // 3,109 rows < 3,187 entities
  readonly organigrama: PrimariiOrganigramaClaim | null; // null whole-object, never partial
  readonly documentCounts: readonly PrimariiCategoryCount[];
}

/** `entity_snapshots` — research history (queryable per CUI). */
export interface PrimariiSnapshot {
  readonly snapshotId: string;
  readonly cui: string;
  readonly entityName: string;
  readonly entityType: string | null;
  readonly county: string | null;
  readonly websiteUrl: string | null;
  readonly wikipediaUrl: string | null;
  readonly sourceResultVersionId: string | null;
  readonly schemaVersion: string | null;
  readonly resultStatus: string;
  readonly confidence: number | null;
  readonly researchedAt: string | null; // ISO timestamptz
  readonly organigramaStatus: string | null;
  readonly numarAngajatiStatus: string | null;
  readonly salariiStatus: string | null;
  readonly missingRequiredCategories: readonly string[];
  readonly validationIssues: readonly string[];
  readonly loadedAt: string;
}

/** `documents` — evidence inventory (raw pointers excluded from the projection, §8). */
export interface PrimariiDocument {
  readonly documentPk: string; // bigint → string
  readonly cui: string;
  readonly category: string | null; // salarii | organigrama | numar_angajati | other
  readonly documentType: string | null;
  readonly title: string | null;
  readonly sourceUrl: string | null; // public source link
  readonly contentSha256: string | null; // identity of the stored MinIO object
  readonly contentBytes: string | null; // bigint → string
  readonly publishedDate: string | null; // TEXT (unparsed)
  readonly effectiveDate: string | null; // TEXT (unparsed)
}

/** `salary_amount_claims` — per-UAT salary disclosures. SELF-REPORTED, NOT spend. */
export interface PrimariiSalaryClaim {
  readonly salaryAmountClaimId: string; // bigint → string
  readonly cui: string;
  readonly documentPk: string | null;
  readonly amountRon: string; // numeric(18,2) → string. Disclosure claim, not a flow.
  readonly roleTitle: string | null;
  readonly periodStart: string | null; // real DATE → YYYY-MM-DD
  readonly periodEnd: string | null;
  readonly confidence: number | null;
}

/** `load_issues` — loader QA event (ops surface). */
export interface PrimariiLoadIssue {
  readonly severity: string; // info | warning | error
  readonly issueCode: string;
  readonly cui: string | null;
  readonly message: string;
  readonly createdAt: string; // ISO
}

/** A status rollup bucket (county | region | data_quality_status | result_status | entity_type). */
export interface PrimariiStatusBucket {
  readonly key: string;
  readonly total: number;
  /** Entities with at least one stored evidence document (where meaningful). */
  readonly withEvidence: number | null;
}

/** Per-category coverage rollup ("which UATs publish organigrame?"). */
export interface PrimariiCategoryCoverage {
  readonly category: string;
  readonly found: number;
  readonly notFound: number;
  readonly unknown: number;
  readonly blocked: number;
  /** found / total — the share of entities with the category present. */
  readonly coverage: number;
}

/**
 * `entity_registry_links` — DDL-only today (0 rows). The repo returns [] and the
 * shape lights up when the loader populates it (no API change).
 */
export interface PrimariiRegistryLink {
  readonly registry: string;
  readonly registryCui: string;
  readonly linkConfidence: number | null;
}

// Re-export the kernel types the module surfaces, un-prefixed (no fork).
export type { ResolveHit, Territory };
