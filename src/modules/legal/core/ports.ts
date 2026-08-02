/**
 * Legal module — acts-area repository ports (plan §3.2–§3.5). **05-owned.**
 *
 * Four repos, all extending (or composing) `LegalRepoBase`:
 *  - `LegalActsRepo`     — list/detail/versions/summary (§3.2).
 *  - `LegalGraphRepo`    — citation/amendment graph (§3.3) — bounded, hub-guarded.
 *  - `LegalTreeRepo`     — intra-act structure, NO passage text (§3.4).
 *  - `LegalRetrievalRepo`— full-text + semantic RAG (§3.5) — HNSW bound-vector rule.
 *
 * Every method returns `Result<T, ApiError>`; reads `legal.*` only. The query
 * vector for semantic retrieval is embedded by the usecase (kernel synthetic
 * client, `search_query:` prefix) and passed in pre-computed — the repo binds it
 * as a `$n::vector` literal (the §3.5 HNSW-parameter rule).
 */

import type { LegalActRef, LegalRepoBase } from './repo-base.js';
import type {
  LegalAct,
  LegalActCard,
  LegalActSummary,
  LegalDocHit,
  LegalDocument,
  LegalExternalAct,
  LegalIncomingEdge,
  LegalNode,
  LegalReferenceEdge,
  LegalRelation,
  LegalSectionHit,
  LegalVersionProvenance,
} from './types.js';
import type { ApiError, CursorPage, FilterInput } from '@/modules/shared/index.js';
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

export interface LegalActsRepo extends LegalRepoBase {
  /** Paged acts list. Cursor sort tuple ALWAYS ends in `act_id` (non-unique sorts). */
  listActs(o: LegalActListOptions): Promise<Result<CursorPage<LegalAct>, ApiError>>;
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
  /** Outgoing: what this act cites (its canonical document's references). Bounded. */
  outgoingRefs(
    actId: string,
    relations: readonly LegalRelation[] | undefined,
    limit: number
  ): Promise<Result<readonly LegalReferenceEdge[], ApiError>>;
  /**
   * Incoming: what cites/amends/abrogates this act (+ the citing act). ALWAYS
   * limit-bounded (hub guard: Legea 47/1992 has 23,527 in-edges — §3.3).
   */
  incomingRefs(
    actId: string,
    relations: readonly LegalRelation[] | undefined,
    limit: number
  ): Promise<Result<readonly LegalIncomingEdge[], ApiError>>;
  externalAct(externalActId: string): Promise<Result<LegalExternalAct | null, ApiError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.4 LegalTreeRepo — intra-act structure (LG-4 context); NO passage text
// ─────────────────────────────────────────────────────────────────────────────

export interface LegalTreeRepo {
  nodeChildren(
    documentId: string,
    parentNodeId: string | null,
    depth: number
  ): Promise<Result<readonly LegalNode[], ApiError>>;
  nodeByPath(documentId: string, path: string): Promise<Result<LegalNode | null, ApiError>>;
  nodeByArticle(documentId: string, numberKey: string): Promise<Result<LegalNode | null, ApiError>>;
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
}
