/**
 * TLDF 1.0 — the server-side READ contract, PORTED (never imported) from the
 * scrapper's compiler mirror (`src/sources/portal-legislativ/prod/tldf/
 * format.ts` @ tldf-compiler-v3; authority: scrapper `prod-db/
 * tldf-v1.schema.json`, spec `prod-db/TLDF_SCHEMA_SPEC.md`).
 *
 * The port is deliberate: the server consumes artifacts across a DB boundary
 * and must fail loudly on contract drift rather than silently absorb a
 * compiler change. Drift is caught two ways, both fixture-pinned in
 * `tests/unit/legal/tldf-fixtures.test.ts`:
 *  - reassembly invariants (`reassemble.ts`) reject structurally foreign rows;
 *  - the fold sha gate (`fold.ts`) proves the text against
 *    `document_generations.text_sha256`, a value produced by the scrapper
 *    compiler — outside this codebase.
 *
 * Offsets are UTF-16 code units — JavaScript's native string indexing.
 */

export type TldfShape = 'standard_articles' | 'paragraph_stream' | 'facsimile';
export type TldfPrivacyClass = 'public' | 'restricted';
export type TldfRunRole = 'ttl' | 'den' | 'bdy';
export type TldfSep = '\n' | ' ';
export type TldfOrigin = 'unmarked' | 'facsimil';

/** Half-open [start, end) in UTF-16 code units. */
export type TldfSpan = readonly [number, number];

export interface TldfNumber {
  readonly key: string;
  readonly system: string;
}

export interface TldfRun {
  readonly text: string;
  readonly span: TldfSpan;
  readonly role?: TldfRunRole;
  readonly sep?: TldfSep;
}

/** Closed kind enum (schema $defs.kind — no 'tabel' in v1). */
export const TLDF_KIND_VALUES = [
  'articol',
  'alineat',
  'litera',
  'punct',
  'liniuta',
  'carte',
  'parte',
  'titlu',
  'capitol',
  'sectiune',
  'subcapitol',
  'anexa',
  'apendice',
  'nota',
  'bloc',
  'preformatat',
  'titlu_act',
  'subtitlu_act',
  'emitent',
  'publicare',
  'semnatura',
  'paragraf',
  'citat',
] as const;
export type TldfKind = (typeof TLDF_KIND_VALUES)[number];

export interface TldfBlock {
  /** DOM-path key, or the declared second key form `unmarked:N`. */
  readonly id: string;
  readonly kind: TldfKind;
  readonly type: string;
  readonly source_element_id?: string;
  readonly label?: string;
  /**
   * present = parsed number; null = parser judged it unparsed/ambiguous;
   * absent = proven numberless or outside the numbering program.
   */
  readonly number?: TldfNumber | null;
  /** Subtree hull. */
  readonly span: TldfSpan;
  readonly origin?: TldfOrigin;
  /** Presentation nesting by hull containment, never legal structure. */
  readonly placement?: 'positional';
  readonly content: readonly TldfRun[];
  readonly children?: readonly TldfBlock[];
}

export type TldfMarkKind = 'reference' | 'legal_ref' | 'ref';
export type TldfLinkKind = 'act' | 'act_missing_id' | 'external' | 'internal';

export type TldfResolutionState =
  | 'held_fragment_resolved'
  | 'held'
  | 'fragment_conflict'
  | 'fragment_not_found'
  | 'unheld_consolidation'
  | 'unheld_other';

export interface TldfLink {
  readonly kind: TldfLinkKind;
  readonly target_document_id?: string;
  readonly target_act_id?: number;
  readonly target_node_path?: string;
  readonly target_fragment?: string;
  readonly href?: string;
  readonly resolution?: TldfResolutionState;
}

export interface TldfMark {
  /** Stable occurrence key; equals the array index. */
  readonly ordinal: number;
  readonly kind: TldfMarkKind;
  /** DOCUMENT-level span over the folded clean text. */
  readonly span: TldfSpan;
  /** Present iff kind = 'reference'. */
  readonly link?: TldfLink;
}

export interface TldfDefect {
  readonly code: string;
  readonly count: number;
  readonly detail?: string;
  readonly first_owner_id?: string;
}

export interface TldfAccounting {
  readonly emitted_chars: number;
  readonly separator_chars: number;
  readonly empty_blocks_excluded?: number;
  readonly excluded_by_reason: Readonly<Record<string, number>>;
}

export interface TldfGeneration {
  readonly run_id: number;
  readonly body_sha256: string;
  readonly structure_parser_version: string;
  readonly content_parser_version: string;
}

export interface TldfEnvelope {
  readonly format: 'tldf';
  readonly format_version: '1.0';
  readonly compiler_version: string;
  readonly document_id: string;
  readonly generation: TldfGeneration;
  readonly text_sha256: string;
  readonly offset_unit: 'utf16_code_unit';
  readonly contains_non_bmp: boolean;
  readonly privacy_class: TldfPrivacyClass;
  readonly source_url: string;
  readonly shape: TldfShape;
  readonly accounting: TldfAccounting;
  readonly defects?: readonly TldfDefect[];
  readonly marks: readonly TldfMark[];
  readonly blocks: readonly TldfBlock[];
}

export interface TldfChunkIndexEntry {
  readonly chunk_index: number;
  /** Id of the FIRST block in the chunk's group. */
  readonly block_id: string;
  readonly block_count: number;
  /** Hull over the group: [first block start, last block end). */
  readonly span: TldfSpan;
}

/** Chunk 0 of a multi-row document: full head, blocks replaced by an index. */
export interface TldfManifestPayload extends Omit<TldfEnvelope, 'blocks'> {
  readonly physical: 'manifest';
  readonly chunks: readonly TldfChunkIndexEntry[];
}

/** Rows 1..N-1 of a multi-row document: minimal head + a block group. */
export interface TldfChunkPayload {
  readonly format: TldfEnvelope['format'];
  readonly format_version: TldfEnvelope['format_version'];
  readonly document_id: string;
  readonly generation: TldfGeneration;
  readonly privacy_class: TldfPrivacyClass;
  readonly text_sha256: string;
  readonly physical: 'chunk';
  readonly blocks: readonly TldfBlock[];
}

/** One `legal.document_render` row as the repo reads it. */
export interface TldfPhysicalRow {
  readonly chunkIndex: number;
  readonly chunkCount: number;
  /** NULL on chunk 0 (artifact or manifest), the group's first block id else. */
  readonly blockId: string | null;
  readonly payload: TldfEnvelope | TldfManifestPayload | TldfChunkPayload;
}
