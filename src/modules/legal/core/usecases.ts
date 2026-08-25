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

import {
  invalidInput,
  type ApiError,
  type CapabilityResolver,
  type CursorPage,
  type FilterInput,
  type ResolveHit,
  type SyntheticClient,
} from '@/modules/shared/index.js';

import { parseCitation } from './citation.js';
import { LEGAL_LIVE_STATUSES, toEngineFilter } from './legal-engine-filter.js';
import { searchWithEngine } from './legal-engine-search.js';
import { LEGAL_ORIGINAL_TEXT_CAVEAT, amendmentCountPhrase } from './provenance.js';

import type {
  CursorPageRequest,
  LegalActsRepo,
  LegalGraphRepo,
  LegalOutlineOptions,
  LegalOutlineRepo,
  LegalRecentChangesFilter,
  LegalRecentChangesQuery,
  LegalRenderRepo,
  LegalRetrievalQuery,
  LegalRetrievalRepo,
  LegalSearchEngine,
} from './ports.js';
import type { LegalActRef, LegalRepoBase } from './repo-base.js';
import type {
  LegalAct,
  LegalActCard,
  LegalActCountsResult,
  LegalActStatus,
  LegalCountDimension,
  LegalDocHit,
  LegalDocument,
  LegalEventSource,
  LegalExternalAct,
  LegalIncomingEdge,
  LegalOutlineEntry,
  LegalRecentChange,
  LegalReferenceEdge,
  LegalRelation,
  LegalRenderError,
  LegalRenderInfo,
  LegalRenderPayload,
  LegalRenderPayloadKind,
  LegalSectionHit,
  LegalResolveDim,
  LegalSearchResult,
  LegalSortKey,
  LegalStatusEvent,
  LegalTimelineEntry,
  LegalVersionProvenance,
} from './types.js';

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
  page: CursorPageRequest
): Promise<Result<CursorPage<LegalReferenceEdge>, ApiError>> =>
  repo.outgoingRefs(actId, relations, page);

export const getActLinksIn = (
  repo: LegalGraphRepo,
  actId: string,
  relations: readonly LegalRelation[] | undefined,
  page: CursorPageRequest
): Promise<Result<CursorPage<LegalIncomingEdge>, ApiError>> =>
  repo.incomingRefs(actId, relations, page);

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
    // 199, not 200: the paged repo probes first+1 inside the 200-row physical
    // hub guard, so the max single page narrows by one row. The timeline is a
    // bounded merge either way; it deliberately reads one page, no cursor walk.
    graph.incomingRefs(actId, ['modifica', 'completeaza', 'abroga'], { first: 199 }),
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
  for (const { edge, sourceAct } of amendRes.value.items) {
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

// ── grouped counts + the global change feed ─────────────────────────────────

/**
 * The topN cap (the procurement `TOPN_DEFAULT`/`TOPN_MAX` pattern). Without it
 * ISSUER answers 6,005 buckets — 1.8 MB of GraphQL and twice that over MCP —
 * while the tail is unusable (5,036 buckets count <= 3; the top 20 carry 71.6%,
 * measured 2026-08). The default of 20 serves DOMAIN (16) and STATUS (7)
 * complete; YEAR is a histogram whose FULL span (~1832–2027, ≈200 buckets)
 * must stay requestable, so it gets its own ceiling (re-validate if the span
 * grows).
 */
export const LEGAL_COUNTS_TOPN_DEFAULT = 20;
export const LEGAL_COUNTS_TOPN_MAX = 100;
export const LEGAL_COUNTS_TOPN_YEAR_MAX = 300;

const countsTopNMaxFor = (dim: LegalCountDimension): number =>
  dim === 'year' ? LEGAL_COUNTS_TOPN_YEAR_MAX : LEGAL_COUNTS_TOPN_MAX;

const normalizeCountsTopN = (
  topN: number | undefined,
  maxTopN: number
): Result<number, ApiError> => {
  if (topN === undefined) return ok(LEGAL_COUNTS_TOPN_DEFAULT);
  if (!Number.isInteger(topN) || topN < 1 || topN > maxTopN) {
    return err(invalidInput(`topN must be an integer from 1 to ${String(maxTopN)}`, 'topN'));
  }
  return ok(topN);
};

export const countLegalActs = async (
  repo: LegalActsRepo,
  dim: LegalCountDimension,
  filter: FilterInput,
  topN?: number
): Promise<Result<LegalActCountsResult, ApiError>> => {
  const n = normalizeCountsTopN(topN, countsTopNMaxFor(dim));
  if (n.isErr()) return err(n.error);
  const res = await repo.countActsBy(dim, filter);
  if (res.isErr()) return err(res.error);
  const served = res.value.slice(0, n.value);
  const tail = res.value.slice(n.value);
  // The cap is real, so the truncation is SERVED, never silent: the flag plus
  // the tail's exact remainder (keeps a partition dimension summable).
  return ok({
    buckets: served,
    bucketsTruncated: tail.length > 0,
    otherCount: tail.reduce((sum, b) => sum + b.count, 0),
  });
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

const checkFeedDate = (
  value: string | undefined,
  field: 'since' | 'until'
): Result<string | undefined, ApiError> => {
  if (value === undefined) return ok(undefined);
  // Format AND calendar validity. The round-trip guards V8's lenient parse:
  // '2026-02-31' does NOT parse to NaN — it ROLLS OVER to March 3rd (measured
  // on Node 26) — so `Number.isNaN` alone would let a bad day through to fail
  // later as a 500 off the `::date` bind. A valid ISO date-only string parses
  // as UTC midnight, so its toISOString date part equals the input exactly.
  const t = Date.parse(value);
  if (
    !ISO_DATE_RE.test(value) ||
    Number.isNaN(t) ||
    new Date(t).toISOString().slice(0, 10) !== value
  ) {
    return err(invalidInput(`'${field}' must be a valid YYYY-MM-DD date`, field));
  }
  return ok(value);
};

const LEGAL_EVENT_SOURCES: readonly LegalEventSource[] = ['portal', 'monitorul-oficial'];

/**
 * Canonicalize the feed filter so every surface (GraphQL, MCP) and every
 * consumer of it (the SQL conditions AND the cursor fhash) sees ONE form:
 * dates validated, kinds trimmed/deduped/sorted, eventSource membership
 * checked. Idempotent — normalizing a normalized filter is a no-op, which is
 * what lets the repo and the resolver both derive the same fhash without
 * drifting.
 *
 * An explicit empty (or blank-only) `kinds` is REJECTED, never widened: kernel
 * filters read `in: []` as "match nothing", so silently reading `[]` as "match
 * everything" here would give one API two opposite emptinesses — and a UI
 * binding a text input to `kinds` would serve the entire corpus the moment the
 * user typed a space.
 */
export const normalizeRecentChangesFilter = (
  f: LegalRecentChangesFilter
): Result<LegalRecentChangesFilter, ApiError> => {
  const since = checkFeedDate(f.since, 'since');
  if (since.isErr()) return err(since.error);
  const until = checkFeedDate(f.until, 'until');
  if (until.isErr()) return err(until.error);
  let kinds: readonly string[] | undefined;
  if (f.kinds !== undefined) {
    const cleaned = [...new Set(f.kinds.map((k) => k.trim()).filter((k) => k !== ''))].sort();
    if (cleaned.length === 0) {
      return err(
        invalidInput("'kinds' must name at least one event kind; omit it for all kinds", 'kinds')
      );
    }
    kinds = cleaned;
  }
  if (f.eventSource !== undefined && !LEGAL_EVENT_SOURCES.includes(f.eventSource)) {
    return err(
      invalidInput(`'eventSource' must be one of ${LEGAL_EVENT_SOURCES.join(', ')}`, 'eventSource')
    );
  }
  const undatedOnly = f.undatedOnly === true;
  if (undatedOnly && (since.value !== undefined || until.value !== undefined)) {
    // Undated events fail every date comparison, so the intersection is empty
    // by construction — refuse it instead of serving a confident zero.
    return err(
      invalidInput("'undatedOnly' cannot be combined with 'since'/'until'", 'undatedOnly')
    );
  }
  return ok({
    ...(since.value !== undefined && { since: since.value }),
    ...(until.value !== undefined && { until: until.value }),
    ...(kinds !== undefined && { kinds }),
    ...(f.eventSource !== undefined && { eventSource: f.eventSource }),
    ...(undatedOnly && { undatedOnly: true }),
  });
};

export const getRecentChanges = async (
  repo: LegalActsRepo,
  q: LegalRecentChangesQuery
): Promise<Result<CursorPage<LegalRecentChange>, ApiError>> => {
  const norm = normalizeRecentChangesFilter(q);
  if (norm.isErr()) return err(norm.error);
  return repo.listRecentChanges({ ...norm.value, page: q.page });
};

export const countRecentChanges = async (
  repo: LegalActsRepo,
  filter: LegalRecentChangesFilter
): Promise<Result<number, ApiError>> => {
  const norm = normalizeRecentChangesFilter(filter);
  if (norm.isErr()) return err(norm.error);
  return repo.countRecentChanges(norm.value);
};

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

// ── document render (the TLDF artifact, served over REST) ───────────────────────

/**
 * One read path for both REST routes: the base route is `chunkIndex=0` (the
 * complete envelope for a single-chunk document, the physical MANIFEST for a
 * chunked one), `/chunks/:i` is any physical row. Gating order matters:
 * not-found (404) → unavailable (409, no servable text) → inconsistent (409,
 * rows missing under a served generation) → restricted (403). Restricted is
 * checked LAST because the expression-level privacy class lives on the render
 * rows: it is only a trustworthy answer once the rows are known to exist. A
 * restricted expression answers 403, never 404 — its act's existence is
 * already public, and only a `served` + `public` generation ever reaches a
 * payload read.
 *
 * The payload's physical marker is re-checked against its position (row 0 of a
 * chunked doc must be a manifest, a chunked row must be a chunk group, a
 * single-row doc must be a plain envelope): the DDL binds identity fields but
 * cannot express cross-row layout, so a violation here is served as
 * `render_inconsistent` (409) — never a partial or mislabeled reading.
 */
export const getDocumentRenderChunk = async (
  repo: LegalRenderRepo,
  documentId: string,
  chunkIndex: number
): Promise<Result<LegalRenderPayload, LegalRenderError | ApiError>> => {
  const infoRes = await repo.renderInfo(documentId);
  if (infoRes.isErr()) return err(infoRes.error);
  const info = infoRes.value;
  if (info === null) return err({ reason: 'render_not_found', documentId });
  if (info.renderStatus !== 'served') {
    return err({ reason: 'render_unavailable', documentId, renderStatus: info.renderStatus });
  }
  if (info.chunkCount === null) {
    return err({
      reason: 'render_inconsistent',
      documentId,
      detail: 'generation is served but no render rows exist',
    });
  }
  if (info.privacyClass !== 'public') return err({ reason: 'render_restricted', documentId });
  if (chunkIndex >= info.chunkCount) {
    // The chunk RESOURCE does not exist — same class as an unknown document.
    return err({ reason: 'render_not_found', documentId });
  }

  const rowRes = await repo.renderRow(documentId, chunkIndex);
  if (rowRes.isErr()) return err(rowRes.error);
  const row = rowRes.value;
  if (row === null) {
    return err({
      reason: 'render_inconsistent',
      documentId,
      detail: `chunk ${String(chunkIndex)} missing while chunk_count=${String(info.chunkCount)}`,
    });
  }
  if (row.chunkCount !== info.chunkCount) {
    return err({
      reason: 'render_inconsistent',
      documentId,
      detail: `row chunk_count ${String(row.chunkCount)} != ${String(info.chunkCount)}`,
    });
  }

  const physical = row.payload['physical'];
  const kind: LegalRenderPayloadKind | null =
    chunkIndex > 0
      ? physical === 'chunk'
        ? 'chunk'
        : null
      : info.chunkCount === 1
        ? physical === undefined
          ? 'envelope'
          : null
        : physical === 'manifest'
          ? 'manifest'
          : null;
  if (kind === null) {
    return err({
      reason: 'render_inconsistent',
      documentId,
      detail: `chunk ${String(chunkIndex)} carries physical=${String(physical)} under chunk_count=${String(info.chunkCount)}`,
    });
  }
  return ok({ kind, chunkIndex, info, tldf: row.payload });
};

/** The base render read: the logical artifact (envelope) or its manifest. */
export const getDocumentRender = (
  repo: LegalRenderRepo,
  documentId: string
): Promise<Result<LegalRenderPayload, LegalRenderError | ApiError>> =>
  getDocumentRenderChunk(repo, documentId, 0);

/** Batched availability for the GraphQL `LegalDocument.render` field. */
export const getRenderInfoForDocuments = (
  repo: LegalRenderRepo,
  documentIds: readonly string[]
): Promise<Result<ReadonlyMap<string, LegalRenderInfo>, ApiError>> =>
  repo.renderInfoForDocuments(documentIds);

// ── retrieval (RAG) ─────────────────────────────────────────────────────────────

export interface LegalSearchDeps {
  readonly retrieval: LegalRetrievalRepo;
  /**
   * The search engine. Absent (or serving no index) means this deployment has
   * not been cut over yet and the Postgres path answers — a DEPLOYMENT state,
   * reported as `engine: 'postgres'`, never a silent per-request substitution
   * for an engine that failed.
   */
  readonly engine?: LegalSearchEngine;
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

/**
 * The citation shortcut answers with ONE act, from Postgres, before any filter
 * is compiled. That is only safe when the caller asked a question the shortcut
 * can actually answer: no filter to honour, and a channel that wants acts.
 * Anything else goes down the normal path.
 */
const citationShortcutAllowed = (query: LegalRetrievalQuery): boolean => {
  if (query.channel === 'sections') return false;
  return !Object.entries(query.filter).some(
    ([field, value]) => field !== 'q' && value !== undefined
  );
};

export const searchLegal = async (
  deps: LegalSearchDeps,
  query: LegalRetrievalQuery
): Promise<Result<LegalSearchResult, ApiError>> => {
  const caveats: string[] = [];

  // 1. Identifier router: a clean citation short-circuits to the act (no
  //    embeddings) — but ONLY when the shortcut cannot change the question.
  //    It answers from Postgres before any filter is translated, so taking it
  //    with a filter set, or on the sections channel, silently returns an act
  //    the caller may have excluded, on a channel they did not ask for, and
  //    labels it `totalsExhaustive: true`. When the shortcut is not allowed the
  //    query falls through to ordinary retrieval, which applies everything.
  const parsed = parseCitation(query.q);
  if (parsed !== null && citationShortcutAllowed(query)) {
    const ref: LegalActRef = { citation: query.q };
    const cardRes = await deps.acts.getActCard(ref);
    if (cardRes.isErr()) return err(cardRes.error);
    // The historical gate still applies to the resolved act: an identifier is
    // not a request for law that is no longer in force.
    const card =
      cardRes.value !== null &&
      (query.includeHistorical || LEGAL_LIVE_STATUSES.includes(cardRes.value.status))
        ? cardRes.value
        : null;
    if (card !== null) {
      caveats.push(honestyCaveat(card));
      caveats.push(LEGAL_ORIGINAL_TEXT_CAVEAT);
      const provRes = await deps.acts.versionProvenanceForActs([card.actId]);
      if (provRes.isErr()) return err(provRes.error);
      const provenance = provRes.value.get(card.actId) ?? null;
      return ok({
        acts: [{ act: stripCard(card), summary: card.summary, score: 1, provenance }],
        sections: [],
        caveats,
        // An identifier lookup: exactly one act, found by name, no retrieval.
        engine: 'postgres',
        actsTotal: 1,
        sectionsTotal: null,
        totalsExhaustive: true,
        degraded: false,
        asOf: null,
        unhydratedHits: 0,
      });
    }
  }

  // 2. The engine path, when this deployment has an index. It either answers
  //    or fails — it never silently hands the question to the lexical scan.
  if (deps.engine !== undefined && (deps.engine.canServeActs() || deps.engine.canServeSections())) {
    const translated = toEngineFilter(query.filter, query.includeHistorical);
    if (translated.unsupported.length > 0) {
      // Serving a partly-understood filter would answer a broader question
      // than the one asked, under the narrower label the caller chose.
      return err(
        invalidInput(
          `legal search: the engine cannot express ${translated.unsupported.join(', ')}`,
          'filter'
        )
      );
    }
    const outcome = await searchWithEngine(
      {
        engine: deps.engine,
        acts: deps.acts,
        retrieval: deps.retrieval,
        ...(deps.semanticReady && {
          embedQuery: (text: string) =>
            deps.synthetic.embed(`${QUERY_PREFIX}${text}`, deps.embeddingModel),
        }),
      },
      {
        q: query.q,
        filter: translated.filter,
        channel: query.channel,
        limit: query.limit,
      }
    );
    if (outcome.isErr()) return err(outcome.error);

    const engineCaveats = [...caveats, ...outcome.value.caveats];
    const sections = outcome.value.sections.map((s) => ({
      ...s,
      portalDeepLink: portalLink(deps.clientBaseUrl, s.actId, s.sectionKey),
    }));
    if (outcome.value.acts.length > 0 || sections.length > 0) {
      engineCaveats.push(LEGAL_ORIGINAL_TEXT_CAVEAT);
    }
    engineCaveats.push(...historicalCaveats(outcome.value.acts, sections));
    return ok({
      acts: outcome.value.acts,
      sections,
      caveats: engineCaveats,
      engine: 'opensearch',
      actsTotal: outcome.value.actsTotal,
      sectionsTotal: outcome.value.sectionsTotal,
      totalsExhaustive: outcome.value.totalsExhaustive,
      degraded: outcome.value.degraded,
      asOf: outcome.value.asOf,
      // Engine hits Postgres refused: the page is SHORTER than the ranking.
      unhydratedHits: outcome.value.unhydratedHits,
    });
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

  caveats.push(...historicalCaveats(acts, sections));

  return ok({
    acts,
    sections,
    caveats,
    engine: 'postgres',
    // The Postgres path returns a bounded slice and never counts the corpus,
    // so it reports no total rather than passing the page size off as one.
    actsTotal: null,
    sectionsTotal: null,
    totalsExhaustive: false,
    // The lexical fallback IS a degraded answer: it ran because the semantic
    // gate was off or the embedder failed, and `caveats` already says so.
    degraded: qVec === null,
    asOf: null,
    // The lexical path selects and hydrates in one query; nothing is dropped
    // between an engine's ranking and the database.
    unhydratedHits: 0,
  });
};

/**
 * §5.2-C honesty: one status caveat per distinct NON-current act in the result
 * set (`in-vigoare` needs no warning). Status rides on every hit, so this costs
 * no query. Shared by both retrieval paths — the warning a reader gets must not
 * depend on which engine answered.
 */
const historicalCaveats = (
  acts: readonly LegalDocHit[],
  sections: readonly LegalSectionHit[]
): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const warn = (actId: string, citation: string, status: LegalActStatus): void => {
    if (status === 'in-vigoare' || seen.has(actId)) return;
    seen.add(actId);
    out.push(`${citation}: status ${status} — verificați versiunea în vigoare.`);
  };
  for (const d of acts) warn(d.act.actId, d.act.displayCitation, d.act.status);
  for (const s of sections) warn(s.actId, s.displayCitation, s.status);
  return out;
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
