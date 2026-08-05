/**
 * Legal module — usecases (plan §4). Framework-free, over the acts-area ports +
 * the kernel synthetic client / capability resolver. GraphQL + MCP call the SAME
 * usecase (tri-surface equivalence, §14.7). `Result`-returning; never throw.
 *
 * `searchLegal` is the one usecase that touches the kernel: it runs the identifier
 * router (citation parse → direct act), then embeds `q` (synthetic, `search_query:`
 * prefix) ONLY when the legal semantic capability is on, and routes to the section/
 * doc channels. Semantic OFF → `qVec=null` + the `"semantic search unavailable"`
 * caveat; the repo serves the ILIKE/trigram fallback. §5.2-C honesty caveats
 * (status badge + amendedAfterPublication) ride on every result.
 */

import { err, ok, type Result } from 'neverthrow';

import { parseCitation } from './citation.js';
import { LEGAL_ORIGINAL_TEXT_CAVEAT, amendmentCountPhrase } from './provenance.js';

import type {
  CursorPageRequest,
  LegalActsRepo,
  LegalGraphRepo,
  LegalOutlineOptions,
  LegalOutlineRepo,
  LegalRetrievalQuery,
  LegalRetrievalRepo,
} from './ports.js';
import type { LegalActRef, LegalRepoBase } from './repo-base.js';
import type {
  LegalAct,
  LegalActCard,
  LegalActStatus,
  LegalDocument,
  LegalExternalAct,
  LegalIncomingEdge,
  LegalOutlineEntry,
  LegalReferenceEdge,
  LegalRelation,
  LegalResolveDim,
  LegalSearchResult,
  LegalSortKey,
  LegalStatusEvent,
  LegalTimelineEntry,
  LegalVersionProvenance,
} from './types.js';
import type {
  ApiError,
  CapabilityResolver,
  CursorPage,
  FilterInput,
  ResolveHit,
  SyntheticClient,
} from '@/modules/shared/index.js';

const SORT_DB: Record<
  LegalSortKey,
  'in_degree' | 'act_year' | 'entry_into_force' | 'display_citation'
> = {
  in_degree: 'in_degree',
  act_year: 'act_year',
  entry_into_force: 'entry_into_force',
  display_citation: 'display_citation',
};

// ── acts list / detail ──────────────────────────────────────────────────────

export const listActs = (
  repo: LegalActsRepo,
  args: { filter: FilterInput; sort: LegalSortKey; dir: 'asc' | 'desc'; page: CursorPageRequest }
): Promise<Result<CursorPage<LegalAct>, ApiError>> =>
  repo.listActs({ filter: args.filter, sort: SORT_DB[args.sort], dir: args.dir, page: args.page });

export const getAct = (
  repo: LegalActsRepo,
  ref: LegalActRef
): Promise<Result<LegalActCard | null, ApiError>> => repo.getActCard(ref);

export const getActVersions = (
  repo: LegalActsRepo,
  actId: string
): Promise<Result<readonly LegalDocument[], ApiError>> => repo.listDocuments(actId);

// ── graph ────────────────────────────────────────────────────────────────────

export const getActLinksOut = (
  repo: LegalGraphRepo,
  actId: string,
  relations: readonly LegalRelation[] | undefined,
  limit: number
): Promise<Result<readonly LegalReferenceEdge[], ApiError>> =>
  repo.outgoingRefs(actId, relations, limit);

export const getActLinksIn = (
  repo: LegalGraphRepo,
  actId: string,
  relations: readonly LegalRelation[] | undefined,
  limit: number
): Promise<Result<readonly LegalIncomingEdge[], ApiError>> =>
  repo.incomingRefs(actId, relations, limit);

export const getExternalAct = (
  repo: LegalGraphRepo,
  externalActId: string
): Promise<Result<LegalExternalAct | null, ApiError>> => repo.externalAct(externalActId);

// ── timeline (base + graph): merge status events with amendment edges ──────────

export const getActTimeline = async (
  base: LegalRepoBase,
  graph: LegalGraphRepo,
  actId: string
): Promise<Result<readonly LegalTimelineEntry[], ApiError>> => {
  const [eventsRes, amendRes] = await Promise.all([
    base.getStatusEvents(actId),
    graph.incomingRefs(actId, ['modifica', 'completeaza', 'abroga'], 200),
  ]);
  if (eventsRes.isErr()) return err(eventsRes.error);
  if (amendRes.isErr()) return err(amendRes.error);

  const entries: LegalTimelineEntry[] = [];
  for (const e of eventsRes.value) {
    entries.push({
      kind: 'status_event',
      effectiveDate: e.effectiveDate,
      label: e.eventKind,
      eventSource: e.eventSource,
      relatedActId: e.sourceActId,
      evidence: e.evidence,
    });
  }
  for (const { edge, sourceAct } of amendRes.value) {
    entries.push({
      kind: 'amendment',
      effectiveDate: sourceAct?.entryIntoForce ?? null,
      label: `${edge.relation} de ${sourceAct?.displayCitation ?? edge.targetRaw}`,
      eventSource: null,
      relatedActId: sourceAct?.actId ?? null,
      evidence: null,
    });
  }
  // Stable sort by date (nulls last), then by kind for determinism.
  entries.sort((x, y) => {
    const dx = x.effectiveDate ?? '9999-12-31';
    const dy = y.effectiveDate ?? '9999-12-31';
    return dx < dy ? -1 : dx > dy ? 1 : x.kind.localeCompare(y.kind);
  });
  return ok(entries);
};

export const getStatusEvents = (
  base: LegalRepoBase,
  actId: string
): Promise<Result<readonly LegalStatusEvent[], ApiError>> => base.getStatusEvents(actId);

// ── outline (the one TOC authority) ─────────────────────────────────────────────

export const getDocumentOutline = (
  repo: LegalOutlineRepo,
  options: LegalOutlineOptions
): Promise<Result<CursorPage<LegalOutlineEntry>, ApiError>> => repo.outline(options);

export const getOutlineEntry = (
  repo: LegalOutlineRepo,
  documentId: string,
  path: string
): Promise<Result<LegalOutlineEntry | null, ApiError>> => repo.entryByPath(documentId, path);

// ── retrieval (RAG) ─────────────────────────────────────────────────────────────

export interface LegalSearchDeps {
  readonly retrieval: LegalRetrievalRepo;
  readonly acts: LegalActsRepo;
  readonly synthetic: SyntheticClient;
  readonly capabilities: CapabilityResolver;
  readonly embeddingModel: string;
  /** Module-local effective semantic gate (kernel slot AND hnsw readiness). */
  readonly semanticReady: boolean;
  readonly clientBaseUrl: string;
}

const SEMANTIC_CAVEAT = 'semantic search unavailable';
const QUERY_PREFIX = 'search_query: ';

/** True only when the kernel slot AND the module probe both allow semantic. */
export const effectiveSemantic = (deps: {
  capabilities: CapabilityResolver;
  hnswReady: boolean;
}): boolean => deps.capabilities.forDomain('legal').semantic && deps.hnswReady;

export const searchLegal = async (
  deps: LegalSearchDeps,
  query: LegalRetrievalQuery
): Promise<Result<LegalSearchResult, ApiError>> => {
  const caveats: string[] = [];

  // 1. Identifier router: a clean citation short-circuits to the act (no embeddings).
  const parsed = parseCitation(query.q);
  if (parsed !== null) {
    const ref: LegalActRef = { citation: query.q };
    const cardRes = await deps.acts.getActCard(ref);
    if (cardRes.isErr()) return err(cardRes.error);
    if (cardRes.value !== null) {
      const card = cardRes.value;
      caveats.push(honestyCaveat(card));
      caveats.push(LEGAL_ORIGINAL_TEXT_CAVEAT);
      const provRes = await deps.acts.versionProvenanceForActs([card.actId]);
      if (provRes.isErr()) return err(provRes.error);
      const provenance = provRes.value.get(card.actId) ?? null;
      return ok({
        acts: [{ act: stripCard(card), summary: card.summary, score: 1, provenance }],
        sections: [],
        caveats,
      });
    }
  }

  // 2. Embed the query (semantic) or fall back to lexical.
  let qVec: readonly number[] | null = null;
  if (deps.semanticReady) {
    const embedRes = await deps.synthetic.embed(`${QUERY_PREFIX}${query.q}`, deps.embeddingModel);
    if (embedRes.isErr()) {
      // Degrade, never error: the lexical path still serves.
      caveats.push(SEMANTIC_CAVEAT);
    } else {
      qVec = embedRes.value;
    }
  } else {
    caveats.push(SEMANTIC_CAVEAT);
  }

  // 3. Route channels (§4): sections for provision questions; docs for topical.
  const wantSections = query.channel === 'auto' || query.channel === 'sections';
  const wantDocs = query.channel === 'auto' || query.channel === 'docs';

  const [secRes, docRes] = await Promise.all([
    wantSections ? deps.retrieval.searchSections(qVec, query) : Promise.resolve(ok([])),
    wantDocs ? deps.retrieval.searchDocs(qVec, query) : Promise.resolve(ok([])),
  ]);
  if (secRes.isErr()) return err(secRes.error);
  if (docRes.isErr()) return err(docRes.error);

  // §5.2-C version provenance: ONE batched lookup for every act in the result set,
  // so no hit is served as current law without saying which version it is. The
  // status badge below is free from the hit row; this is the one extra statement.
  const actIds = [
    ...new Set([...docRes.value.map((d) => d.act.actId), ...secRes.value.map((s) => s.actId)]),
  ];
  const provRes = await deps.acts.versionProvenanceForActs(actIds);
  if (provRes.isErr()) return err(provRes.error);
  const provenanceOf = (actId: string): LegalVersionProvenance | null =>
    provRes.value.get(actId) ?? null;

  const sections = secRes.value.map((s) => ({
    ...s,
    portalDeepLink: portalLink(deps.clientBaseUrl, s.actId, s.sectionKey),
    provenance: provenanceOf(s.actId),
  }));
  const acts = docRes.value.map((d) => ({ ...d, provenance: provenanceOf(d.act.actId) }));

  // The corpus is published-form text only, so the whole result set carries one
  // version caveat; the per-act counts ride on each hit's own provenance.
  if (acts.length > 0 || sections.length > 0) caveats.push(LEGAL_ORIGINAL_TEXT_CAVEAT);

  // §5.2-C honesty: a status-badge caveat per distinct NON-current act in the
  // result set (in-vigoare needs no warning). Status rides on every hit, so this
  // is free (no per-act amendment query — that lives on the act card / its tool).
  const seen = new Set<string>();
  const warnIfHistorical = (actId: string, citation: string, status: LegalActStatus): void => {
    if (status === 'in-vigoare' || seen.has(actId)) return;
    seen.add(actId);
    caveats.push(`${citation}: status ${status} — verificați versiunea în vigoare.`);
  };
  for (const d of acts) warnIfHistorical(d.act.actId, d.act.displayCitation, d.act.status);
  for (const s of sections) warnIfHistorical(s.actId, s.displayCitation, s.status);

  return ok({ acts, sections, caveats });
};

const honestyCaveat = (card: LegalActCard): string =>
  `${card.displayCitation}: status ${card.status}; ${amendmentCountPhrase(card.amendedAfterPublication)}.`;

const portalLink = (base: string, actId: string, sectionKey: string): string =>
  `${base}/legal/acts/${actId}?section=${encodeURIComponent(sectionKey)}`;

/** Drop the card's extra fields back to a plain LegalAct (for the doc-hit shape). */
const stripCard = (card: LegalActCard): LegalAct => ({
  actId: card.actId,
  actNaturalKey: card.actNaturalKey,
  actType: card.actType,
  actNumber: card.actNumber,
  actYear: card.actYear,
  issuerSlug: card.issuerSlug,
  canonicalDocumentId: card.canonicalDocumentId,
  displayCitation: card.displayCitation,
  status: card.status,
  statusEvidence: card.statusEvidence,
  entryIntoForce: card.entryIntoForce,
  inDegree: card.inDegree,
});

// ── discovery / resolve ─────────────────────────────────────────────────────────

export interface ResolveLegalFiltersDeps {
  readonly base: LegalRepoBase;
  readonly acts: LegalActsRepo;
  /** Resolves issuer/domain/category/act_type/status distinct values. */
  readonly vocab: LegalVocabRepo;
}

/** A tiny repo for the closed-vocab + issuer distinct-value lookups (impl in shell). */
export interface LegalVocabRepo {
  resolveIssuers(q: string, limit: number): Promise<Result<readonly ResolveHit[], ApiError>>;
  resolveEnum(
    dim: 'domain' | 'category' | 'act_type' | 'status',
    q: string,
    limit: number
  ): Promise<Result<readonly ResolveHit[], ApiError>>;
}

export const resolveLegalFilters = async (
  deps: ResolveLegalFiltersDeps,
  dim: LegalResolveDim,
  q: string,
  limit: number
): Promise<Result<readonly ResolveHit[], ApiError>> => {
  if (dim === 'act') {
    const candidates = await deps.acts.resolveActCandidates({ citation: q });
    if (candidates.isErr()) return err(candidates.error);
    return ok(
      candidates.value.slice(0, limit).map((a): ResolveHit => ({
        kind: 'act',
        value: a.actId,
        label: a.displayCitation,
        hint: a.status,
      }))
    );
  }
  if (dim === 'issuer') return deps.vocab.resolveIssuers(q, limit);
  return deps.vocab.resolveEnum(dim, q, limit);
};
