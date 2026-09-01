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
 * Historically only the columns the module reads were typed. `document_nodes`
 * is now typed in full against the live DDL (2026-09-01) so the schema is
 * checkable against the database rather than against current usage; the other
 * tables still follow the read-only-columns rule. The `embedding` vector column
 * is declared `never`-readable so a stray `select('embedding')` is a type
 * error.
 */

import type { ColumnType } from 'kysely';

/** read-only timestamptz returned as an ISO string. */
type Tstz = ColumnType<string, never, never>;
/** jsonb column: object on read; server is read-only so write types are unused. */
type Jsonb = ColumnType<Record<string, unknown>, never, never>;
/** jsonb ARRAY column. `own_text` is `[[start, end], ...]`, not an object, so
 * the `Jsonb` Record type above would mistype it. */
type JsonbArray = ColumnType<readonly unknown[], never, never>;
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
  // NULLABLE in the live DDL: `(disposition = 'role') = (node_kind IS NULL)`,
  // so the 13,491,697 role rows carry NULL here. It was declared non-null,
  // which contradicted `outline-repo.ts:55`, whose own row type has always
  // said `string | null` and whose :67 branch handles the null.
  node_kind: string | null;
  label: string | null;
  number_key: string | null;
  path: string;
  order_index: number; // integer
  char_start: number | null; // integer
  char_end: number | null; // integer
  splitter_version: string | null;
  // v2 columns (tldf-projection lane, migration 20260804T122000+).
  // NOT NULL since the v6 load: `document_nodes_run_id_not_null` is VALIDATED
  // and 0 rows are null (checked 2026-09-01). The previous note here said this
  // was NULL on 10,152 legacy split-v2 rows and that the generation FK was
  // still NOT VALID — both are now false: `document_nodes_generation_fk` is
  // VALIDATED too. Reads still join document_generations on
  // (document_id, run_id), which remains correct and cheap; it is simply no
  // longer the only thing standing between a caller and a retired generation.
  run_id: string; // bigint → string
  node_type: string | null; // grammar token (ART, PRT, POR, …); outline keys on this
  role: string | null; // NULL = structural node; non-null = in-node run row
  number_system: string | null;
  number_status: string | null; // parsed|unparsed|ambiguous|numberless
  // ── TLDF v1.1 (portal-tree-v6 / tldf-compiler-v4, live 2026-09-01) ─────────
  // The live table has 33 columns; this type declared 16, so the rest were
  // UNSELECTABLE — Kysely cannot project a column it does not know about.
  // Typing them does NOT expose them: there is still no query, resolver or
  // route that reads any of the columns below. This removes the type-layer
  // blocker; the API surface is separate work.
  disposition: string | null; // node|role|presentation|facsimile|unmarked
  origin: string | null;
  source_element_id: string | null;
  source_ordinal: number | null; // integer
  own_text: JsonbArray | null; // [[start, end], ...] span pairs
  structure_parser_version: string | null;
  colspan: number | null; // smallint — table cell geometry (v1.1)
  rowspan: number | null; // smallint
  source_strike_scope: string | null;
  source_struck_repealed: boolean | null;
  annotation_role: string | null;
  changed_since_base_form: boolean | null;
  // ── provenance / privacy (present since the v2 lane, never typed here) ────
  source_url: string | null;
  privacy_class: string; // NOT NULL in the DDL
  privacy_tags: string[] | null; // text[]
  contains_personal_data: boolean; // NOT NULL in the DDL
  updated_at: Tstz | null;
}

/**
 * `legal.document_node_assets` — one row per `imagine` node
 * (237,522 rows as of 2026-09-01).
 *
 * KEYED ON `node_id`, which is recompile-scoped and deliberately never served
 * (`outline-repo.ts:25-26`), so any asset lookup must resolve
 * `(document_id, path)` -> `node_id` PINNED to the served generation before
 * joining here.
 *
 * `bytes_held` is FALSE and `sha256` NULL on every live row today: the image
 * bytes are not in object storage, and `src` is a live origin URL. An endpoint
 * built against this table now would proxy the origin per request, which is
 * exactly what the envelope's no-locator design exists to avoid.
 */
export interface LegalDocumentNodeAssetsTable {
  node_id: string; // bigint → string
  asset_id: string;
  src: string;
  source_src: string;
  width: number | null; // smallint
  height: number | null; // smallint
  alt: string | null;
  sha256: string | null;
  bytes_held: boolean;
  privacy_class: string;
}

/**
 * `legal.document_source_strikes` — source-state strike facts (129 rows over
 * 77 documents as of 2026-09-01). The per-block signal already reaches clients inside the
 * TLDF envelope (`struck`, `struck_repealed`); this table is the relational
 * side, and every live row is `mechanism='s'`, `syntax_status='balanced'`,
 * `legal_repealed=false`.
 */
export interface LegalDocumentSourceStrikesTable {
  document_id: string;
  run_id: string; // bigint → string
  ordinal: number; // integer
  source_path: string;
  mechanism: string;
  syntax_status: string;
  direct_s_par_child: boolean;
  legal_repealed: boolean;
  char_start: number | null;
  char_end: number | null;
  privacy_class: string;
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

// ── TLDF render artifact (document_generations + document_render) ─────────────

export interface LegalDocumentGenerationsTable {
  document_id: string; // text, PK
  run_id: string; // bigint → string
  body_sha256: string;
  text_sha256: string;
  tree_digest: string;
  link_digest: string;
  structure_parser_version: string;
  compiler_version: string;
  compiled_at: Tstz;
  render_status: string; // 'served' | 'content_unavailable' | 'superseded_pending'
}

export interface LegalDocumentRenderTable {
  document_id: string; // text
  run_id: string; // bigint → string
  chunk_index: number; // integer
  chunk_count: number; // integer
  block_id: string | null;
  tldf: Jsonb; // the physical TLDF payload — envelope, manifest, or chunk group
  privacy_class: string; // 'public' | 'restricted'
  compiled_at: Tstz;
}

/** The portal's source-asserted anchor graph (one row per mark occurrence). */
export interface LegalDocumentLinkEdgesTable {
  edge_id: string; // bigint identity → string
  document_id: string; // the CITING document
  run_id: string; // bigint → string
  source_node_path: string | null;
  char_start: number;
  char_end: number;
  link_text: string | null;
  link_kind: string; // 'act' | 'act_missing_id' | 'external' | 'internal'
  target_document_id: string | null;
  target_act_id: string | null; // bigint → string
  target_fragment: string | null;
  target_node_path: string | null;
  href: string | null;
  target_resolution: string | null;
  ordinal: number;
  privacy_class: string; // 'public' | 'restricted'
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
    'legal.document_node_assets': LegalDocumentNodeAssetsTable;
    'legal.document_source_strikes': LegalDocumentSourceStrikesTable;
    'legal.document_generations': LegalDocumentGenerationsTable;
    'legal.document_render': LegalDocumentRenderTable;
    'legal.document_link_edges': LegalDocumentLinkEdgesTable;
    'legal.document_summaries': LegalDocumentSummariesTable;
    'legal.document_embeddings': LegalDocumentEmbeddingsTable;
    'legal.section_embeddings': LegalSectionEmbeddingsTable;
    /* eslint-enable @typescript-eslint/naming-convention -- restore the rule after the schema-qualified table keys */
  }
}
