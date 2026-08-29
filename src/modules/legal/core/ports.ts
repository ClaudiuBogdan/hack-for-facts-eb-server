/**
 * Legal module — acts-area repository ports (plan §3.2–§3.5). **05-owned.**
 *
 * Four repos, all extending (or composing) `LegalRepoBase`:
 *  - `LegalActsRepo`     — list/detail/versions/summary (§3.2).
 *  - `LegalGraphRepo`    — citation/amendment graph (§3.3) — bounded, hub-guarded.
 *  - `LegalOutlineRepo`  — the document TOC over `document_nodes` v2 (§3.4).
 *  - `LegalRetrievalRepo`— full-text + semantic RAG (§3.5) — HNSW bound-vector rule.
 *
 * Every method returns `Result<T, ApiError>`; reads `legal.*` only. The query
 * vector for semantic retrieval is embedded by the usecase (kernel synthetic
 * client, `search_query:` prefix) and passed in pre-computed — the repo binds it
 * as a `$n::vector` literal (the §3.5 HNSW-parameter rule).
 */

import type { LegalEngineFilter, LegalEngineWindow } from './legal-opensearch-query.js';
import type { LegalActRef, LegalRepoBase } from './repo-base.js';
import type {
  LegalAct,
  LegalActCard,
  LegalActSummary,
  LegalCountBucket,
  LegalCountDimension,
  LegalDocHit,
  LegalDocument,
  LegalEventSource,
  LegalExternalAct,
  LegalIncomingAnchorsPage,
  LegalIncomingEdge,
  LegalOutlineEntry,
  LegalRecentChange,
  LegalReferenceEdge,
  LegalRelation,
  LegalRenderInfo,
  LegalRenderRow,
  LegalSectionHit,
  LegalVersionProvenance,
} from './types.js';
import type { ApiError, CursorPage, FilterInput, IsoDate } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/** A first/after cursor page request (the kernel cursor envelope binds the fhash). */
export interface CursorPageRequest {
  readonly first: number;
  readonly after?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.2 LegalActsRepo — acts list/detail
// ─────────────────────────────────────────────────────────────────────────────

export interface LegalActListOptions {
  readonly filter: FilterInput;
  readonly sort: 'in_degree' | 'act_year' | 'entry_into_force' | 'display_citation';
  readonly dir: 'asc' | 'desc';
  readonly page: CursorPageRequest;
}

/**
 * The global status-event feed filter. `since`/`until` are INCLUSIVE
 * `effective_date` bounds — a date window therefore excludes undated events
 * (SQL comparison semantics, stated rather than papered over). `kinds` narrows
 * `event_kind`: OMIT it for all kinds; an explicit empty (or blank-only) list
 * is REJECTED as invalidInput — one API must not read `[]` as "everything"
 * here while kernel filters read `in: []` as "nothing". `eventSource` scopes
 * to one pipeline ('portal' | 'monitorul-oficial'). `undatedOnly` serves ONLY
 * the null-`effective_date` events (25.2% of the table, measured 2026-08) —
 * they trail the default feed and NO date window can reach them; combining it
 * with `since`/`until` is rejected (the intersection is empty by construction).
 */
export interface LegalRecentChangesFilter {
  readonly since?: IsoDate;
  readonly until?: IsoDate;
  readonly kinds?: readonly string[];
  readonly eventSource?: LegalEventSource;
  readonly undatedOnly?: boolean;
}

export interface LegalRecentChangesQuery extends LegalRecentChangesFilter {
  readonly page: CursorPageRequest;
}

export interface LegalActsRepo extends LegalRepoBase {
  /** Paged acts list. Cursor sort tuple ALWAYS ends in `act_id` (non-unique sorts). */
  listActs(o: LegalActListOptions): Promise<Result<CursorPage<LegalAct>, ApiError>>;
  /** Filtered COUNT over the same FROM/conditions as `listActs`. Resolved lazily — only when a connection's totalCount is actually selected. */
  countActs(filter: FilterInput): Promise<Result<number, ApiError>>;
  /**
   * Grouped act counts for the landing grid / facets — ONE statement instead of
   * one round-trip per cell. Same FROM + kernel conditions as `listActs` (the
   * filter must behave identically). `domain` unnests the CANONICAL document
   * summary's `text[]` — the same rows the `domain` filter compiles against —
   * so a cell's count always equals the filtered list behind it; domains
   * asserted only by non-canonical versions are deliberately not counted, and
   * a multi-domain act counts once per domain (distinct per bucket).
   * Partition contract: `status`/`act_type` PARTITION the corpus; `issuer`/
   * `year` are disjoint but omit value-less acts; `domain` OVERLAPS (~2.26
   * domains per summarized act, measured 2026-08 — buckets sum above the act
   * total). Keys are the RAW DB vocabulary — for the OPEN `act_type` (256
   * live values vs 18 filter-accepted, measured 2026-08) most keys are NOT
   * valid filter values. Counts are facet-SCOPED to the filter: a bucket
   * equals its filtered list only when the grouped dimension is unconstrained
   * in the filter. NULL group keys are omitted. Ordered count desc; returns
   * the FULL vocabulary — the serving cap (topN) lives in the usecase, which
   * reports the truncation.
   */
  countActsBy(
    dim: LegalCountDimension,
    filter: FilterInput
  ): Promise<Result<readonly LegalCountBucket[], ApiError>>;
  /**
   * The GLOBAL date-ordered status-event feed ("Modificări"):
   * `act_status_events` joined to `acts` for display identity, keyset-paged on
   * `(effective_date desc nulls last, event_id desc)` — undated events sort
   * last and stay reachable (the acts-list null-section rule).
   */
  listRecentChanges(
    q: LegalRecentChangesQuery
  ): Promise<Result<CursorPage<LegalRecentChange>, ApiError>>;
  /** Filtered COUNT over the same FROM/conditions as `listRecentChanges`. Lazy — only when totalCount is selected. */
  countRecentChanges(filter: LegalRecentChangesFilter): Promise<Result<number, ApiError>>;
  /** Detail card: act + canonical doc + summary + aliases + keys + amendedAfter. */
  getActCard(ref: LegalActRef): Promise<Result<LegalActCard | null, ApiError>>;
  getCanonicalDocument(actId: string): Promise<Result<LegalDocument | null, ApiError>>;
  /** The version cluster (all act_documents for one act). */
  listDocuments(actId: string): Promise<Result<readonly LegalDocument[], ApiError>>;
  getSummary(documentId: string): Promise<Result<LegalActSummary | null, ApiError>>;
  /** Incoming modifica/completeaza count — the §5.2-C honesty badge. */
  countAmendmentsAfter(actId: string): Promise<Result<number, ApiError>>;
  /**
   * Version provenance for many acts in ONE statement: canonical `version_kind`/
   * `version_date` + the amendment count + the newest `consolidare` row (0 rows
   * today — the lookup is what makes the forward-compat clause free). Batched
   * because every search hit needs it; measured 67ms warm for the 50 most-cited
   * acts in the corpus (the worst case) — re-validate if the corpus grows.
   */
  versionProvenanceForActs(
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalVersionProvenance>, ApiError>>;
  /**
   * Provenance for ONE document — the node/tree surface, where the answer is
   * that document's own expression, not necessarily the act's canonical one.
   */
  versionProvenanceForDocument(
    documentId: string
  ): Promise<Result<LegalVersionProvenance | null, ApiError>>;
  // ── batched lazy resolvers (GraphQL fan-out; avoid N+1) ──
  /** Canonical document for many acts (act-card lazy field batching). */
  canonicalDocumentsForActs(
    actIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalDocument>, ApiError>>;
  /** Summaries by document id (act-card + doc-hit lazy field batching). */
  summariesForDocuments(
    documentIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalActSummary>, ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.3 LegalGraphRepo — citation/amendment graph (LG-1, LG-2)
// ─────────────────────────────────────────────────────────────────────────────

export interface LegalGraphRepo {
  /**
   * Outgoing: what this act cites (its canonical document's references),
   * keyset-paged on the `act_references` PK `(source_document_id, ref_index)`.
   * For OUT the source document is the act's ONE canonical doc, so the first
   * component is constant and the visible order stays today's `ref_index asc`;
   * the tuple is unique by PK either way. Page cap 199 — the +1 probe must
   * stay inside the 200-row physical hub guard. totalCount is deliberately
   * never reported (act-detail.md §9.1: a bounded read must not claim a hub's
   * fan-out); the CURSOR is what makes the rest reachable.
   */
  outgoingRefs(
    actId: string,
    relations: readonly LegalRelation[] | undefined,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<LegalReferenceEdge>, ApiError>>;
  /**
   * Incoming: what cites/amends/abrogates this act (+ the citing act), keyset-
   * paged on the SAME PK tuple. For IN, `ref_index` alone ties across
   * thousands of citing documents (the pre-cursor `ref_index asc` order was
   * NON-DETERMINISTIC under those ties), so `(source_document_id, ref_index)`
   * is what makes deep pages stable — edges arrive grouped by citing document.
   * Hub guard: Legea 47/1992 has 26,277 in-edges; every page is bounded and
   * the cursor reaches all of them.
   */
  incomingRefs(
    actId: string,
    relations: readonly LegalRelation[] | undefined,
    page: CursorPageRequest
  ): Promise<Result<CursorPage<LegalIncomingEdge>, ApiError>>;
  externalAct(externalActId: string): Promise<Result<LegalExternalAct | null, ApiError>>;
  /**
   * Incoming ANCHORS — the portal's own typographic link graph
   * (`document_link_edges`, `link_kind='act'`, public rows), keyset-paged on
   * `(target_act_id, edge_id)` with the REAL total from a count query (the
   * page-size-as-total bug is documented in act-detail.md §9.1 — never
   * reshipped). A separate surface from `incomingRefs` by design: anchors are
   * source assertions, references are LLM inferences, and they disagree
   * informatively.
   */
  incomingAnchors(
    actId: string,
    page: CursorPageRequest
  ): Promise<Result<LegalIncomingAnchorsPage, ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.4 LegalOutlineRepo — the document TOC (one authority: document_nodes v2)
// ─────────────────────────────────────────────────────────────────────────────

export interface LegalOutlineOptions {
  readonly documentId: string;
  /** TOC indent budget (core/outline.ts grammar ranks). */
  readonly maxDepth: number;
  readonly page: CursorPageRequest;
}

export interface LegalOutlineRepo {
  /**
   * Heading rows only (`role IS NULL` + outline kinds), ordered by
   * `order_index`, keyset-paged. The one TOC authority — the reader never
   * derives structure from render blocks.
   */
  outline(options: LegalOutlineOptions): Promise<Result<CursorPage<LegalOutlineEntry>, ApiError>>;
  /**
   * Resolve ONE node by its stable `(document_id, path)` key. There is
   * deliberately no `entryByArticle(documentId, numberKey)` sibling: article
   * numbers restart inside annexes, so 5,303 documents hold 32,484 duplicate
   * (document_id, number_key) article groups and no single-row answer is
   * honest. `path` is the identity.
   */
  entryByPath(
    documentId: string,
    path: string
  ): Promise<Result<LegalOutlineEntry | null, ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// LegalRenderRepo — the TLDF artifact tables (document_generations + document_render)
// ─────────────────────────────────────────────────────────────────────────────

export interface LegalRenderRepo {
  /**
   * Availability for one document: the generation row + row-0 `chunk_count`.
   * Returns null when no generation row exists. NO privacy/status gating here —
   * the usecase gates so 403/409 stay distinguishable from 404.
   */
  renderInfo(documentId: string): Promise<Result<LegalRenderInfo | null, ApiError>>;
  /** Batched availability (GraphQL `LegalDocument.render` over a version list). */
  renderInfoForDocuments(
    documentIds: readonly string[]
  ): Promise<Result<ReadonlyMap<string, LegalRenderInfo>, ApiError>>;
  /**
   * One physical row (payload unparsed); null when the row does not exist
   * FOR THIS GENERATION — the runId bind makes a recompile-race row from
   * another generation indistinguishable from a missing row (409 upstream)
   * instead of a silently mixed body.
   */
  renderRow(
    documentId: string,
    runId: string,
    chunkIndex: number
  ): Promise<Result<LegalRenderRow | null, ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.5 LegalRetrievalRepo — full-text + semantic (LG-4, the RAG layer)
// ─────────────────────────────────────────────────────────────────────────────

export interface LegalRetrievalQuery {
  readonly q: string;
  readonly filter: FilterInput; // status/domain/category/type/year pre-filter
  readonly channel: 'auto' | 'sections' | 'docs';
  readonly includeHistorical: boolean; // §5.2-C: abrogated excluded unless true
  readonly limit: number; // ≤ 50
}

export interface LegalRetrievalRepo {
  /**
   * Section channel (provision-level RAG): section_embeddings → parent doc/act/
   * node. HNSW when `qVec` provided; ILIKE/trigram fallback when `qVec` is null
   * (semantic gate off). `qVec` is bound as a `$n::vector` literal (§3.5 rule).
   */
  searchSections(
    qVec: readonly number[] | null,
    q: LegalRetrievalQuery
  ): Promise<Result<readonly LegalSectionHit[], ApiError>>;
  /** Doc channel (topical "about X"): document_embeddings → act + summary + score. */
  searchDocs(
    qVec: readonly number[] | null,
    q: LegalRetrievalQuery
  ): Promise<Result<readonly LegalDocHit[], ApiError>>;
  /**
   * Hydrate ENGINE-selected section keys (OpenSearch answers keys-only, so every
   * value the reader sees still comes from Postgres).
   *
   * This applies the SAME serving gates the SQL paths do — canonical-document
   * only, and no `suspicious` summary — so a key the engine surfaced but the
   * database refuses is ABSENT from the returned map rather than served. The
   * caller counts what it asked for versus what came back; a silent drop would
   * shorten a result page with no one the wiser.
   *
   * Keyed by `sectionFusionKey(documentId, sectionKey)` — the one encoding
   * shared by the engine legs, the fusion and this lookup.
   */
  hydrateSections(
    keys: readonly LegalSectionKey[]
  ): Promise<Result<ReadonlyMap<string, LegalSectionHit>, ApiError>>;
}

/** One section address as the engine emits it. */
export interface LegalSectionKey {
  readonly documentId: string;
  readonly sectionKey: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// LegalSearchEngine — the OpenSearch port (implemented in shell/repo)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One engine hit. Keys only — `snippet` is the sole display string the engine
 * is allowed to produce, because a highlight fragment cannot be rebuilt from
 * Postgres. Everything else the reader sees is hydrated from the database.
 */
export interface LegalEngineHit {
  readonly documentId: string;
  readonly actId: string | null;
  readonly sectionKey: string | null;
  readonly snippet: string | null;
}

export interface LegalEnginePage {
  /** Hits in ENGINE RANK ORDER (best first) — the fusion depends on it. */
  readonly hits: readonly LegalEngineHit[];
  readonly total: number;
  /** False when the engine capped the count and reported a lower bound. */
  readonly totalExhaustive: boolean;
  /** Index build stamp (`_meta.built_at`) — an index without one is refused. */
  readonly asOf: string;
}

/**
 * The search engine as the USECASE sees it. The port lives in core so the
 * usecase can depend on it without importing the shell; the transport that
 * implements it is `shell/repo/opensearch-legal-repo.ts`.
 *
 * Every method returns `err` on any engine trouble and the caller must NOT
 * substitute a lexical SQL scan for it — that silent substitution answers a
 * different question than the one asked.
 */
export interface LegalSearchEngine {
  canServeActs(): boolean;
  canServeSections(): boolean;
  searchActsBm25(
    q: string,
    filter: LegalEngineFilter,
    window: LegalEngineWindow
  ): Promise<Result<LegalEnginePage, ApiError>>;
  searchSectionsBm25(
    q: string,
    filter: LegalEngineFilter,
    window: LegalEngineWindow
  ): Promise<Result<LegalEnginePage, ApiError>>;
  /**
   * The vector leg. It rides the SAME compiled filter as the BM25 leg (the
   * query module guarantees this) — an unfiltered kNN leg would answer a
   * different question than the leg it is fused with.
   */
  searchSectionsKnn(
    queryVector: readonly number[],
    filter: LegalEngineFilter,
    size: number
  ): Promise<Result<LegalEnginePage, ApiError>>;
}
