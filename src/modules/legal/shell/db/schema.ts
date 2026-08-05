/**
 * Legal module — `ProdDatabase` augmentation (foundation §3, module-augmentation
 * pattern §14). **05 OWNS the acts/sections tables**; 06 adds the `legal.mo_*`
 * tables (mo_issues, mo_act_publications, mo_lifecycle_edges) in a separate
 * declaration-merge under the same `legal` module.
 *
 * Scalars (§14.1):
 *  - `bigint` → `string` (act_id, node_id, external_act_id, event_id, mo_issue_id).
 *  - **`act_documents.document_id` is `text`** → `string` everywhere (the embeddings
 *    and references foreign keys are text too).
 *  - `date` → `'YYYY-MM-DD'` string; `timestamptz` → ISO string; `jsonb` → object.
 *  - `vector(768)` is NEVER selected into a row type (it streams as a SQL literal in
 *    the HNSW order-by); the column is typed as `unknown` and never projected.
 *
 * Only the columns the module reads are typed; the `embedding` vector column is
 * declared `never`-readable so a stray `select('embedding')` is a type error.
 */

import type { ColumnType } from 'kysely';

/** read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;
/** jsonb column: object on read; server is read-only so write types are unused. */
type Jsonb = ColumnType<Record<string, unknown>, never, never>;
/** a pgvector column — present in the table but never selected into a row. */
type Vector = ColumnType<never, never, never>;

// ── acts spine ───────────────────────────────────────────────────────────────

export interface LegalActsTable {
  act_id: string; // bigint → string
  act_natural_key: string;
  act_type: string;
  act_number: string | null;
  act_year: number | null; // smallint
  issuer_slug: string | null;
  canonical_document_id: string | null; // text
  display_citation: string;
  status: string;
  status_evidence: Jsonb;
  entry_into_force: string | null; // date
  in_degree: number; // integer
}

export interface LegalActDocumentsTable {
  document_id: string; // TEXT
  act_id: string; // bigint → string
  version_kind: string;
  version_date: string | null; // date
  is_canonical: boolean | null;
  den: string | null;
  title: string | null;
  issuer_raw: string | null;
  publication_raw: string | null;
  entry_into_force: string | null; // date
  first_publication_date: string | null; // date
  status_markers: string[] | null; // text[]
  extraction_status: string | null;
  compatibility_tier: string | null;
  source_url: string | null; // legislatie.just.ro deep link — 100% populated
  mo_part: number | null; // smallint — best-effort hint (broken; §13)
  mo_number: string | null;
  mo_date: string | null; // date
}

export interface LegalActCitationKeysTable {
  act_type: string;
  act_number: string;
  act_year: number; // smallint
  issuer_slug: string;
  act_id: string; // bigint → string
}

export interface LegalActAliasesTable {
  alias: string;
  act_id: string; // bigint → string
}

export interface LegalActReferencesTable {
  source_document_id: string; // text
  ref_index: number; // smallint
  relation: string;
  target_raw: string;
  target_class: string;
  target_act_id: string | null; // bigint → string
  target_external_act_id: string | null; // bigint → string
  target_fragment: string | null;
  resolution: string;
  confidence: number | null; // real
  candidates: Jsonb;
  resolver_version: string;
}

export interface LegalActStatusEventsTable {
  event_id: string; // bigint → string
  act_id: string; // bigint → string
  event_kind: string;
  effective_date: string | null; // date
  source_act_id: string | null; // bigint → string
  evidence: Jsonb;
  event_source: string; // 'portal' | 'monitorul-oficial'
}

export interface LegalExternalActsTable {
  external_act_id: string; // bigint → string
  identity_key: string;
  display_citation: string;
  kind: string;
}

// ── structure / metadata / embeddings ─────────────────────────────────────────

export interface LegalDocumentNodesTable {
  node_id: string; // bigint → string
  document_id: string; // text
  parent_node_id: string | null; // bigint → string
  node_kind: string;
  label: string | null;
  number_key: string | null;
  path: string;
  order_index: number; // integer
  char_start: number | null; // integer
  char_end: number | null; // integer
  splitter_version: string | null;
  // v2 columns (tldf-projection lane, migration 20260804T122000+):
  role: string | null; // NULL = structural node; non-null = in-node run row
  number_system: string | null;
  number_status: string | null; // parsed|unparsed|ambiguous|numberless
}

export interface LegalDocumentSummariesTable {
  document_id: string; // text
  description: string | null;
  summary: string | null;
  plain_language_summary: string | null;
  semantic_text: string | null;
  document_category: string | null;
  domains: string[] | null; // text[]
  affected_audiences: string[] | null; // text[]
  keywords: string[] | null; // text[]
  key_dates: Jsonb;
  penalties_mentioned: boolean | null;
  fiscal_impact: string | null;
  confidence: number | null; // real
  source_extraction_status: string | null; // 'accepted' | 'suspicious'
  model: string | null;
  prompt_version: string | null;
  source_updated_at: Tstz | null;
}

export interface LegalDocumentEmbeddingsTable {
  document_id: string; // text
  config_key: string; // 'general-v1'
  model: string;
  dimensions: number;
  embedding: Vector; // vector(768) — never selected
  input_template_version: string | null;
  source_updated_at: Tstz | null;
}

export interface LegalSectionEmbeddingsTable {
  document_id: string; // text
  section_key: string; // 'art:1'
  config_key: string; // 'article-v1'
  model: string;
  dimensions: number;
  embedding: Vector; // vector(768) — never selected
  node_path: string | null;
  article_number: string | null;
  input_template_version: string | null;
  splitter_version: string | null;
  source_text_sha256: string | null;
  source_updated_at: Tstz | null;
}

/**
 * Declaration-merge the acts/sections `legal.*` tables onto the kernel
 * `ProdDatabase`. 06 adds `legal.mo_issues` / `legal.mo_act_publications` /
 * `legal.mo_lifecycle_edges` in its own module file under the same interface.
 */
declare module '@/modules/shared/shell/db/types.js' {
  interface ProdDatabase {
    /* eslint-disable @typescript-eslint/naming-convention -- Kysely table keys are the schema-qualified live names (foundation §3) */
    'legal.acts': LegalActsTable;
    'legal.act_documents': LegalActDocumentsTable;
    'legal.act_citation_keys': LegalActCitationKeysTable;
    'legal.act_aliases': LegalActAliasesTable;
    'legal.act_references': LegalActReferencesTable;
    'legal.act_status_events': LegalActStatusEventsTable;
    'legal.external_acts': LegalExternalActsTable;
    'legal.document_nodes': LegalDocumentNodesTable;
    'legal.document_summaries': LegalDocumentSummariesTable;
    'legal.document_embeddings': LegalDocumentEmbeddingsTable;
    'legal.section_embeddings': LegalSectionEmbeddingsTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
