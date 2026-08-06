/**
 * Legal module — domain view-model types (plan §2.1). **05 OWNS this file**;
 * the `mo/` area (06) imports `LegalAct`/`LegalStatusEvent` from here and never
 * redefines them.
 *
 * Scalar discipline (foundation §14.1):
 *  - `act_id`/`node_id`/`external_act_id`/`event_id` are bigint → `string`.
 *  - **`act_documents.document_id` is `text`, NOT bigint** → every `documentId`
 *    and `*_embeddings.document_id` key is a plain `string` (never BigInt SDL).
 *  - money: none in legal (no numeric columns). dates: `'YYYY-MM-DD'` strings.
 *
 * Legal has **no PII** (acts are public law) — these view models are structurally
 * PII-free (§2.3). Two *quality* exclusions live in the repo layer, not the types:
 * `source_extraction_status='suspicious'` summaries (RAG-excluded) and
 * non-canonical documents (never served as the act text).
 */

import type { IsoDate } from '@/modules/shared/index.js';

/** Closed status vocabulary folded from `act_status_events` (NOTES §1). */
export type LegalActStatus =
  | 'in-vigoare'
  | 'modificat'
  | 'abrogat'
  | 'abrogat-partial'
  | 'suspendat'
  | 'iesit-din-vigoare'
  | 'necunoscut';

export const LEGAL_ACT_STATUSES: readonly LegalActStatus[] = [
  'in-vigoare',
  'modificat',
  'abrogat',
  'abrogat-partial',
  'suspendat',
  'iesit-din-vigoare',
  'necunoscut',
];

/** Citation→reference relation vocabulary (`act_references.relation`). */
export type LegalRelation =
  | 'modifica'
  | 'abroga'
  | 'completeaza'
  | 'suspenda'
  | 'aproba'
  | 'rectifica'
  | 'face-referire'
  | 'respinge';

export const LEGAL_RELATIONS: readonly LegalRelation[] = [
  'modifica',
  'abroga',
  'completeaza',
  'suspenda',
  'aproba',
  'rectifica',
  'face-referire',
  'respinge',
];

/** Relations that count as "amended after publication" for the §5.2-C badge. */
export const AMENDMENT_RELATIONS: readonly LegalRelation[] = ['modifica', 'completeaza'];

/** List sort keys (R1). Every sort tuple ends in `act_id` as the tiebreaker. */
export type LegalSortKey = 'in_degree' | 'act_year' | 'entry_into_force' | 'display_citation';
export const LEGAL_SORT_KEYS: readonly LegalSortKey[] = [
  'in_degree',
  'act_year',
  'entry_into_force',
  'display_citation',
];

/** Graph link direction (incoming = who cites/amends X; outgoing = what X cites). */
export type LegalLinkDirection = 'in' | 'out';

/** Retrieval routing channel (§4 multi-vector). `auto` runs the identifier router first. */
export type LegalRetrievalChannel = 'auto' | 'sections' | 'docs';

/** Discovery/resolve dimensions (R8 + the MCP discovery tool, §7.3). */
export type LegalResolveDim = 'act' | 'issuer' | 'domain' | 'category' | 'act_type' | 'status';
export const LEGAL_RESOLVE_DIMS: readonly LegalResolveDim[] = [
  'act',
  'issuer',
  'domain',
  'category',
  'act_type',
  'status',
];

// ─────────────────────────────────────────────────────────────────────────────
// Acts (the spine — 05-owned base type)
// ─────────────────────────────────────────────────────────────────────────────

/** `legal.acts` — the logical act. This is the `LegalAct` GraphQL base type (§9). */
export interface LegalAct {
  readonly actId: string; // bigint → string
  readonly actNaturalKey: string;
  readonly actType: string; // lege|oug|og|hotarare|ordin|decizie|decret|...
  readonly actNumber: string | null;
  readonly actYear: number | null;
  readonly issuerSlug: string | null;
  readonly canonicalDocumentId: string | null; // text id
  readonly displayCitation: string; // "Legea nr. 227/2015"
  readonly status: LegalActStatus;
  readonly statusEvidence: Record<string, unknown>; // jsonb: which signals fired
  readonly entryIntoForce: IsoDate | null;
  readonly inDegree: number; // incoming citation count
}

/** `legal.act_documents` — a document expression of an act (versions). */
export interface LegalDocument {
  readonly documentId: string; // TEXT id (never BigInt)
  readonly actId: string;
  readonly versionKind: string; // 'original'|'republicare'|'corp'|'stub-header'|'consolidare'
  readonly versionDate: IsoDate | null;
  readonly isCanonical: boolean;
  readonly den: string | null;
  readonly title: string | null;
  readonly issuerRaw: string | null;
  readonly publicationRaw: string | null;
  readonly entryIntoForce: IsoDate | null;
  readonly firstPublicationDate: IsoDate | null;
  readonly statusMarkers: readonly string[];
  readonly extractionStatus: string | null;
  readonly compatibilityTier: string | null;
  // act↔MO typed-column HINT (best-effort; the authoritative correlation is
  // `legal.mo_act_publications.act_id` — §13 #1). Populated on only 3 of 225k
  // documents today; a consumer must NOT treat these as the join key.
  readonly moPart: number | null;
  readonly moNumber: string | null;
  readonly moDate: IsoDate | null;
}

/** `legal.document_summaries` — the AI metadata projection (RAG-grounding source). */
export interface LegalActSummary {
  readonly documentId: string;
  readonly description: string | null;
  readonly summary: string | null;
  readonly plainLanguageSummary: string | null;
  readonly documentCategory: string | null; // lege|ordin|hotarare-de-guvern|...
  readonly domains: readonly string[]; // controlled 16-value vocab
  readonly affectedAudiences: readonly string[];
  readonly keywords: readonly string[];
  readonly keyDates: unknown; // jsonb (may be null)
  readonly penaltiesMentioned: boolean | null;
  readonly fiscalImpact: string | null;
  readonly confidence: number | null; // soft filter only
  readonly sourceExtractionStatus: string | null; // 'accepted' | 'suspicious'
}

/** `legal.act_citation_keys` — child identity (one act → many keys for joint orders). */
export interface LegalCitationKey {
  readonly actType: string;
  readonly actNumber: string;
  readonly actYear: number;
  readonly issuerSlug: string;
}

/** The detail card: act + canonical doc + summary + aliases + keys + honesty badge. */
export interface LegalActCard extends LegalAct {
  readonly canonical: LegalDocument | null;
  readonly summary: LegalActSummary | null;
  readonly aliases: readonly string[];
  readonly citationKeys: readonly LegalCitationKey[];
  readonly versionCount: number; // act_documents rows for this act
  readonly amendedAfterPublication: number; // incoming modifica/completeaza edges → §5.2-C
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph
// ─────────────────────────────────────────────────────────────────────────────

export interface LegalReferenceEdge {
  readonly sourceDocumentId: string; // text
  readonly refIndex: number;
  readonly relation: LegalRelation;
  readonly targetRaw: string;
  readonly targetClass: string;
  readonly targetActId: string | null; // resolved domestic act
  readonly targetExternalActId: string | null; // resolved external act
  readonly targetFragment: string | null; // 'art. 2, anexa 2' when sub-act
  readonly resolution: string; // 'unique'|'cluster'|'alias'|'ambiguous'|'unresolved'|'external'
  readonly confidence: number | null;
  readonly resolverVersion: string;
}

/** An incoming edge enriched with the citing act (for the "who amends X" path). */
export interface LegalIncomingEdge {
  readonly edge: LegalReferenceEdge;
  readonly sourceAct: LegalAct | null;
}

export interface LegalExternalAct {
  readonly externalActId: string;
  readonly identityKey: string; // 'eu_directiva:2004/37/CE'
  readonly displayCitation: string;
  readonly kind: string; // 'eu_directiva'|'eu_regulament'|'treaty'|'pre1989'|'other'
}

// ─────────────────────────────────────────────────────────────────────────────
// Status events (shared substrate — portal AND mo write rows; server reads both)
// ─────────────────────────────────────────────────────────────────────────────

/** The event source discriminator. 06 contributes `'monitorul-oficial'` rows. */
export type LegalEventSource = 'portal' | 'monitorul-oficial';

export interface LegalStatusEvent {
  readonly eventId: string;
  readonly actId: string;
  readonly eventKind: string; // abrogare-totala|modificare|promulgare|...
  readonly effectiveDate: IsoDate | null;
  readonly sourceActId: string | null;
  readonly evidence: Record<string, unknown>;
  readonly eventSource: LegalEventSource;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document outline (TOC over legal.document_nodes v2 — the ONE TOC authority)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One TOC entry. The stable key is `(documentId, path)` — NEVER a node id:
 * `document_nodes.node_id` is `generated always as identity` under a scoped
 * delete-then-insert lane, so ids are minted fresh on every recompile and must
 * not appear in URLs, cursors, or any served payload. `charStart`/`charEnd`
 * locate the entry inside the folded clean text (UTF-16 code units), which is
 * how the reader maps a TOC jump onto the render manifest's chunk spans.
 */
export interface LegalOutlineEntry {
  readonly documentId: string;
  readonly path: string;
  readonly nodeKind: string; // carte|parte|titlu|capitol|subcapitol|sectiune|articol|anexa|apendice
  readonly label: string | null; // 'Articolul 291'
  readonly numberKey: string | null; // '291', '291^1', 'IV'
  readonly numberSystem: string | null;
  /** unparsed/ambiguous numbering surfaces honestly, never as a fake number. */
  readonly numberStatus: string | null;
  /** Presentation depth from the fixed grammar rank — never parsed from path. */
  readonly depth: number;
  readonly orderIndex: number;
  readonly charStart: number | null;
  readonly charEnd: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Retrieval (RAG) result shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What version of an act a served text/summary actually is (§5.2-C honesty).
 * Read off the act's CANONICAL `act_documents` row + its incoming amendment
 * edges; rendered to Romanian by `core/provenance.ts`.
 *
 * `latestConsolidation*` is forward-compat: `version_kind='consolidare'` is 0
 * rows today, so it reads null/false and its clause is absent. It starts
 * populating itself the moment the consolidation-timeline lane loads rows — no
 * server change required.
 */
export interface LegalVersionProvenance {
  readonly versionKind: string; // canonical doc's version_kind ('' when no canonical doc)
  readonly versionDate: IsoDate | null;
  readonly amendedAfterPublication: number; // incoming modifica/completeaza edges
  /**
   * The document's `legislatie.just.ro` deep link — where a reader can see the
   * consolidated form. This is the ONLY link the note may carry: our own act page
   * serves the very text the note is warning about, so linking there is circular.
   */
  readonly sourceUrl: string | null;
  /** Newest `version_kind='consolidare'` row for the act, when one exists. */
  readonly latestConsolidationDate: IsoDate | null;
  /** False while that consolidation is only a timeline anchor (not fetched yet). */
  readonly latestConsolidationLoaded: boolean;
}

/** A provision-level retrieval hit (section_embeddings → parent doc/act/node). */
export interface LegalSectionHit {
  readonly actId: string;
  readonly displayCitation: string;
  readonly status: LegalActStatus;
  readonly documentId: string;
  readonly sectionKey: string; // 'art:291' | 'win:17'
  readonly articleNumber: string | null;
  readonly nodeLabel: string | null; // 'Articolul 291'
  readonly nodePath: string | null;
  readonly charStart: number | null; // forward-compat locator (NOT served text — §3.4)
  readonly charEnd: number | null;
  readonly snippet: string | null; // grounded snippet from document_summaries
  readonly portalDeepLink: string | null; // deep link to the portal node
  readonly score: number; // fused/cosine
  /** Which version this text is (§5.2-C); attached by the usecase, batched per result set. */
  readonly provenance: LegalVersionProvenance | null;
}

/** A doc-channel hit (topical "about X"): the act + its summary + score. */
export interface LegalDocHit {
  readonly act: LegalAct;
  readonly summary: LegalActSummary | null;
  readonly score: number;
  /** Which version this text is (§5.2-C); attached by the usecase, batched per result set. */
  readonly provenance: LegalVersionProvenance | null;
}

/** The hybrid search result (§5 R7 / MCP search_legal_acts). */
export interface LegalSearchResult {
  readonly acts: readonly LegalDocHit[];
  readonly sections: readonly LegalSectionHit[];
  readonly caveats: readonly string[]; // §5.2-C honesty + semantic-gate caveats
  /**
   * WHICH path answered. The two have different guarantees — the engine knows
   * real totals, the Postgres path only ever returns a bounded slice — so the
   * reader is told which one produced the list rather than left to assume.
   */
  readonly engine: 'opensearch' | 'postgres';
  /** Real match count per channel; null when that channel cannot count. */
  readonly actsTotal: number | null;
  readonly sectionsTotal: number | null;
  /** False when a total is a lower bound, or when the path cannot count at all. */
  readonly totalsExhaustive: boolean;
  /** True when a leg the request wanted could not run; `caveats` says which. */
  readonly degraded: boolean;
  /** Index build stamp behind the answer; null for the Postgres path. */
  readonly asOf: string | null;
}

/** A merged act timeline entry (status events + amendment edges, LG-2). */
export interface LegalTimelineEntry {
  readonly kind: 'status_event' | 'amendment';
  readonly effectiveDate: IsoDate | null;
  readonly label: string; // event_kind, or "modifica de {citation}"
  readonly eventSource: LegalEventSource | null;
  readonly relatedActId: string | null; // source_act_id (event) or citing act (edge)
  readonly evidence: Record<string, unknown> | null;
}

/** The honesty payload attached to every retrieval/search result (§5.2-C). */
export interface LegalActHonesty {
  readonly actId: string;
  readonly displayCitation: string;
  readonly status: LegalActStatus;
  readonly amendedAfterPublication: number;
}

/**
 * One incoming ANCHOR — a typographic link the portal itself asserts in a
 * citing document's text (`document_link_edges`, TLDF mark grain). This is a
 * DIFFERENT graph from `LegalReferenceEdge` (LLM-inferred normative
 * relations): the two disagree by construction, and both disagreements are
 * informative — an anchor proves the source page links here; a reference
 * edge claims a normative relation. Keys: `edgeId` pages, `(sourceDocumentId,
 * ordinal)` is the natural identity; `charStart`/`charEnd` locate the anchor
 * in the citing document's rendered text.
 */
export interface LegalIncomingAnchor {
  readonly edgeId: string; // bigint → string (keyset key; NOT a stable identity)
  readonly sourceDocumentId: string; // the citing document expression
  readonly sourceActId: string | null; // the citing act (joined via act_documents)
  readonly sourceNodePath: string | null;
  readonly ordinal: number;
  readonly linkText: string | null; // the anchor's own words on the source page
  readonly targetFragment: string | null; // 'art. 5' when the anchor is sub-act
  readonly targetNodePath: string | null; // resolved node in OUR corpus, when held
  readonly targetResolution: string | null;
  readonly charStart: number;
  readonly charEnd: number;
}

/** A page of incoming anchors plus the REAL total (never the page size). */
export interface LegalIncomingAnchorsPage {
  readonly items: readonly LegalIncomingAnchor[];
  readonly next: string | null;
  readonly totalCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document render (TLDF artifact serving over document_generations/document_render)
// ─────────────────────────────────────────────────────────────────────────────

/** `legal.document_generations.render_status` — the D1b promotion states. */
export type LegalRenderStatus = 'served' | 'content_unavailable' | 'superseded_pending';

/**
 * Render availability for one document expression: the `document_generations`
 * row plus the physical `chunk_count` read off render row 0. This is what
 * GraphQL serves (`LegalDocument.render`) so the act page can decide what to
 * offer WITHOUT paying for the artifact body — the body itself travels only
 * over the cacheable REST route.
 */
export interface LegalRenderInfo {
  readonly documentId: string;
  readonly renderStatus: LegalRenderStatus;
  readonly privacyClass: string; // 'public' | 'restricted' — property of the expression
  readonly runId: string; // bigint → string; names the raw structure run
  readonly textSha256: string;
  readonly compilerVersion: string;
  readonly compiledAt: string; // timestamptz ISO
  /** Physical chunk count from render row 0; null when no render rows exist. */
  readonly chunkCount: number | null;
}

/** One physical `legal.document_render` row, payload UNPARSED (jsonb object). */
export interface LegalRenderRow {
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly blockId: string | null;
  /** The stored TLDF physical payload — envelope, manifest, or chunk group. */
  readonly payload: Record<string, unknown>;
}

/**
 * What the REST base route serves: the complete TLDF envelope for a
 * single-chunk document, or the physical MANIFEST for a chunked one — never a
 * partial `blocks[]` that could pass for the whole document.
 */
export type LegalRenderPayloadKind = 'envelope' | 'manifest' | 'chunk';

export interface LegalRenderPayload {
  readonly kind: LegalRenderPayloadKind;
  readonly chunkIndex: number;
  readonly info: LegalRenderInfo;
  readonly tldf: Record<string, unknown>;
}

/**
 * Module-local render failures (beyond the kernel `ApiError` set — there is no
 * kernel 409/403 variant, so the REST shell maps these directly):
 *  - `render_not_found`      → 404: no generation row / no such chunk.
 *  - `render_restricted`     → 403: the expression exists but is not public
 *                               (the ACT's existence is already public; a 404
 *                               here would lie).
 *  - `render_unavailable`    → 409: we hold the document but no servable text
 *                               (`content_unavailable` | `superseded_pending`).
 *  - `render_inconsistent`   → 409: stored rows violate the physical-layout
 *                               invariants; a partial reading is never served.
 */
export type LegalRenderError =
  | { readonly reason: 'render_not_found'; readonly documentId: string }
  | { readonly reason: 'render_restricted'; readonly documentId: string }
  | {
      readonly reason: 'render_unavailable';
      readonly documentId: string;
      readonly renderStatus: Exclude<LegalRenderStatus, 'served'>;
    }
  | {
      readonly reason: 'render_inconsistent';
      readonly documentId: string;
      readonly detail: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Freshness note (no loader watermark for legal yet → interim TTL-only, §10)
// ─────────────────────────────────────────────────────────────────────────────

export const LEGAL_AS_OF_NOTE =
  "acts.status is a fold of status events as-of today; the API surfaces the current status and always attaches the 'amendedAfterPublication' + status badge. Future-dated abrogations are events, never current status.";
