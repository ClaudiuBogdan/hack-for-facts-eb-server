/**
 * Monitorul-Oficial (`mo/` area, plan 06) — `ProdDatabase` augmentation for the
 * `legal.mo_*` gazette tables. **06 OWNS these tables**; the acts/sections part of
 * `legal.*` is declared by `../shell/db/schema.ts` (05). Both declaration-merges
 * target the SAME `ProdDatabase` interface under the single `legal` module.
 *
 * Scalars (foundation §14.1):
 *  - `bigint` → `string` (mo_issue_id, edge_id, act_id, target_act_id, pdf_bytes).
 *  - `date` → `'YYYY-MM-DD'` string; `timestamptz` → ISO string; `jsonb` → object.
 *  - `mo_act_key` / `source_mo_act_key` / `target_mo_act_key` are TEXT (content sha256).
 *
 * Only the columns the repo reads are typed (the server is read-only — write types
 * are `never`).
 */

import type { ColumnType } from 'kysely';

/** read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;
/** jsonb column: object on read; server is read-only so write types are unused. */
type Jsonb = ColumnType<Record<string, unknown>, never, never>;

// ── gazette issues ─────────────────────────────────────────────────────────────

export interface LegalMoIssuesTable {
  mo_issue_id: string; // bigint → string
  part_code: string; // 'PI'|'PII'|'PIM'|'PIII'|'PIV'|'PV'|'PVI'|'PVII'
  issue_label: string;
  issue_number: number | null; // integer
  issue_suffix: string; // '' default
  issue_year: number; // smallint
  issue_date: string | null; // date
  mo_part: number | null; // smallint (generated; PIM → null)
  pdf_url: string | null;
  s3_bucket: string | null; // INTERNAL — excluded from default projection
  s3_key: string | null; // INTERNAL — excluded
  pdf_sha256: string | null; // INTERNAL — excluded
  pdf_bytes: string | null; // bigint → string
  source_issue_id: string | null;
  source_document_id: string | null;
  has_archive_index: boolean;
  has_emonitor_link: boolean;
  first_seen_at: Tstz;
  last_seen_at: Tstz;
}

// ── act publications (one publication event) ────────────────────────────────────

export interface LegalMoActPublicationsTable {
  mo_act_key: string; // TEXT PK (content sha256)
  mo_issue_id: string | null; // bigint → string
  act_type_raw: string | null; // EVIDENCE-only — excluded from default projection
  act_number_raw: string | null; // EVIDENCE-only — excluded
  act_date: string | null; // date
  issuer_raw: string | null; // EVIDENCE-only — excluded
  title: string | null;
  source_pdf_url: string | null;
  act_type: string | null; // loader-rederived
  act_number_norm: string | null;
  act_year: number | null; // smallint
  issue_year: number | null; // smallint
  issuer_slug: string | null;
  act_id: string | null; // bigint → string; null when link-not-merge unresolved
  resolution: string; // 'unique'|'ambiguous'|'unmatched'
  matched_via: string | null; // 'act-year'|'issue-year'|null
  resolver_version: string;
  first_seen_at: Tstz;
  last_seen_at: Tstz;
}

// ── lifecycle edges (one lifecycle relation) ────────────────────────────────────

export interface LegalMoLifecycleEdgesTable {
  edge_id: string; // bigint → string
  source_mo_act_key: string; // FK → mo_act_publications
  relation: string; // 'promulga'|'aproba'|'respinge'|'rectifica'|'republica'
  target_raw: string;
  target_index: number; // smallint
  target_act_type: string | null;
  target_act_number: string | null;
  target_act_year: number | null; // smallint
  target_issuer_slug: string; // NOT NULL DEFAULT ''
  target_act_id: string | null; // bigint → string (identity plane)
  target_mo_act_key: string | null; // MO-local plane
  resolution: string; // 'unique'|'mo-only'|'ambiguous'|'unresolved'
  matched_via: string | null; // 'act-year'|'issue-year'|null
  method: string;
  confidence: number | null; // real
  evidence: Jsonb; // detail-only
  resolver_version: string;
}

/**
 * Declaration-merge the `legal.mo_*` tables onto the kernel `ProdDatabase`. The
 * acts/sections `legal.*` tables (05) are merged by `../shell/db/schema.ts` under
 * the same interface — both contribute to the single `legal` module's typed DB.
 */
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'legal.mo_issues': LegalMoIssuesTable;
    'legal.mo_act_publications': LegalMoActPublicationsTable;
    'legal.mo_lifecycle_edges': LegalMoLifecycleEdgesTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
