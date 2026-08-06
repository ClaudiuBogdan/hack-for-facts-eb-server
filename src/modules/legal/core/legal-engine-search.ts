/**
 * Engine-backed legal retrieval: run the legs, fuse them, hydrate from Postgres.
 *
 * The engine decides MEMBERSHIP and ORDER; Postgres supplies every value the
 * reader sees. That split is what keeps a stale index from inventing text.
 *
 * Three honesty rules are load-bearing here:
 *
 *  1. **No fallback.** Any engine failure returns `err`. Substituting a lexical
 *     SQL scan would answer a different question than the one asked, and the
 *     caller would have no way to tell.
 *  2. **A missing index is a degradation, not a silence.** If the sections
 *     index is not configured, the sections channel does not quietly vanish —
 *     the answer comes back `degraded` with a caveat naming what is missing.
 *     This is the live state today: the acts index exists, the sections one
 *     waits on the split-v2 re-projection.
 *  3. **Hits Postgres refuses to hydrate are COUNTED.** The database applies
 *     canonical-only serving, which the index does not know about; a hit that
 *     fails it must not be served, and dropping it silently would just shorten
 *     the page with nobody the wiser.
 */

import { ok, err, type Result } from 'neverthrow';

import { upstreamError, type ApiError } from '@/modules/shared/index.js';

import {
  parseSectionFusionKey,
  rrfFuse,
  sectionFusionKey,
  type FusionLeg,
} from './legal-search-fusion.js';

import type { LegalEngineFilter } from './legal-opensearch-query.js';
import type { LegalActsRepo, LegalRetrievalRepo, LegalSearchEngine } from './ports.js';
import type { LegalDocHit, LegalSectionHit } from './types.js';

/**
 * Per-leg over-fetch. Fusion needs more candidates than the page it returns,
 * or a document ranked 21st by BM25 and 1st by kNN could never surface. Named
 * and bounded rather than implicit — and capped so a large `limit` cannot turn
 * into an unbounded engine read.
 */
export const FUSION_FETCH_MULTIPLIER = 3;
export const FUSION_FETCH_CAP = 100;

export const SECTIONS_INDEX_MISSING_CAVEAT =
  'Căutarea în text (la nivel de articol) nu este disponibilă: indexul de secțiuni nu este încă publicat. Rezultatele de mai jos sunt la nivel de act.';
export const SEMANTIC_LEG_DOWN_CAVEAT =
  'Căutarea semantică nu este disponibilă momentan; rezultatele provin doar din potrivirea lexicală.';

export interface LegalEngineSearchDeps {
  readonly engine: LegalSearchEngine;
  readonly acts: LegalActsRepo;
  readonly retrieval: LegalRetrievalRepo;
  /**
   * Embeds the query for the vector leg. Absent = BM25-only BY CONFIGURATION
   * (a deployment statement); an embedder that is present but fails is a
   * runtime degradation, and the two are reported differently.
   */
  readonly embedQuery?: (q: string) => Promise<Result<readonly number[], ApiError>>;
}

export interface LegalEngineSearchRequest {
  readonly q: string;
  readonly filter: LegalEngineFilter;
  readonly channel: 'auto' | 'sections' | 'docs';
  readonly limit: number;
}

export interface LegalEngineSearchOutcome {
  readonly acts: readonly LegalDocHit[];
  readonly sections: readonly LegalSectionHit[];
  /** Real engine totals for the channels that ran; null for one that did not. */
  readonly actsTotal: number | null;
  readonly sectionsTotal: number | null;
  /** False when any leg reported a capped (lower-bound) count. */
  readonly totalsExhaustive: boolean;
  /** True when a leg the request wanted could not run. */
  readonly degraded: boolean;
  readonly caveats: readonly string[];
  /** Newest index build stamp behind the answer. */
  readonly asOf: string | null;
  /** Engine hits Postgres declined to hydrate — reported, never silent. */
  readonly unhydratedHits: number;
}

const fetchSize = (limit: number): number =>
  Math.min(Math.max(limit, 1) * FUSION_FETCH_MULTIPLIER, FUSION_FETCH_CAP);

export const searchWithEngine = async (
  deps: LegalEngineSearchDeps,
  request: LegalEngineSearchRequest
): Promise<Result<LegalEngineSearchOutcome, ApiError>> => {
  const wantDocs = request.channel === 'auto' || request.channel === 'docs';
  const wantSections = request.channel === 'auto' || request.channel === 'sections';
  const canDocs = wantDocs && deps.engine.canServeActs();
  const canSections = wantSections && deps.engine.canServeSections();

  if (!canDocs && !canSections) {
    // Nothing the request asked for can be answered. This is an error, not an
    // empty result: "no matches" and "no index" must never look alike.
    return err(
      upstreamError('legal search: no engine index serves the requested channel', 'opensearch')
    );
  }

  const caveats: string[] = [];
  let degraded = false;
  if (wantSections && !canSections) {
    caveats.push(SECTIONS_INDEX_MISSING_CAVEAT);
    degraded = true;
  }

  const size = fetchSize(request.limit);
  const window = { from: 0, size };

  // The vector leg is optional; its absence never blocks the lexical legs.
  let queryVector: readonly number[] | null = null;
  if (canSections && deps.embedQuery !== undefined) {
    const embedded = await deps.embedQuery(request.q);
    if (embedded.isErr()) {
      caveats.push(SEMANTIC_LEG_DOWN_CAVEAT);
      degraded = true;
    } else {
      queryVector = embedded.value;
    }
  }

  const [actsPage, sectionsBm25, sectionsKnn] = await Promise.all([
    canDocs ? deps.engine.searchActsBm25(request.q, request.filter, window) : null,
    canSections ? deps.engine.searchSectionsBm25(request.q, request.filter, window) : null,
    canSections && queryVector !== null
      ? deps.engine.searchSectionsKnn(queryVector, request.filter, size)
      : null,
  ]);

  // A failed leg fails the request. No lexical substitution, ever.
  for (const leg of [actsPage, sectionsBm25, sectionsKnn]) {
    if (leg?.isErr() === true) return err(leg.error);
  }

  const actsHits = actsPage?.isOk() === true ? actsPage.value : null;
  const bm25Hits = sectionsBm25?.isOk() === true ? sectionsBm25.value : null;
  const knnHits = sectionsKnn?.isOk() === true ? sectionsKnn.value : null;

  const stamps = [actsHits?.asOf, bm25Hits?.asOf, knnHits?.asOf].filter(
    (s): s is string => s !== undefined
  );
  const asOf = stamps.length === 0 ? null : (stamps.sort().at(-1) ?? null);
  const totalsExhaustive = [actsHits, bm25Hits].every(
    (page) => page === null || page.totalExhaustive
  );

  let unhydratedHits = 0;

  // ── acts channel ───────────────────────────────────────────────────────────
  const actHitsOut: LegalDocHit[] = [];
  if (actsHits !== null) {
    const fused = rrfFuse([{ leg: 'acts_bm25', keys: actsHits.hits.map((h) => h.documentId) }]);
    const byDocument = new Map(actsHits.hits.map((h) => [h.documentId, h]));
    const actIds = [
      ...new Set(actsHits.hits.map((h) => h.actId).filter((id): id is string => id !== null)),
    ];
    const [actRows, summaries] = await Promise.all([
      deps.acts.findActsByIds(actIds),
      deps.acts.summariesForDocuments(actsHits.hits.map((h) => h.documentId)),
    ]);
    if (actRows.isErr()) return err(actRows.error);
    if (summaries.isErr()) return err(summaries.error);
    const actById = new Map(actRows.value.map((a) => [a.actId, a]));

    for (const hit of fused.slice(0, request.limit)) {
      const engineActId = byDocument.get(hit.key)?.actId ?? null;
      const act = engineActId === null ? undefined : actById.get(engineActId);
      // Canonical-only serving: the index may still carry a document that is no
      // longer the act's canonical expression, and serving it would present
      // superseded text as the law.
      if (act?.canonicalDocumentId !== hit.key) {
        unhydratedHits += 1;
        continue;
      }
      actHitsOut.push({
        act,
        summary: summaries.value.get(hit.key) ?? null,
        score: hit.score,
        provenance: null,
      });
    }
  }

  // ── sections channel ───────────────────────────────────────────────────────
  const sectionHitsOut: LegalSectionHit[] = [];
  if (bm25Hits !== null || knnHits !== null) {
    const legs: FusionLeg[] = [];
    const snippetByKey = new Map<string, string>();
    const collect = (page: typeof bm25Hits, leg: string): void => {
      if (page === null) return;
      const keys: string[] = [];
      for (const hit of page.hits) {
        if (hit.sectionKey === null) continue;
        const key = sectionFusionKey(hit.documentId, hit.sectionKey);
        keys.push(key);
        if (hit.snippet !== null && !snippetByKey.has(key)) snippetByKey.set(key, hit.snippet);
      }
      legs.push({ leg, keys });
    };
    collect(bm25Hits, 'sections_bm25');
    collect(knnHits, 'sections_knn');

    const fused = rrfFuse(legs);
    const wanted = fused.slice(0, request.limit);
    const addresses = wanted.flatMap((hit) => {
      // The shared codec, never a second copy of the split: one encoding and
      // one decoder, or hydration quietly looks up a truncated address.
      const parsed = parseSectionFusionKey(hit.key);
      return parsed === null ? [] : [parsed];
    });
    const hydrated = await deps.retrieval.hydrateSections(addresses);
    if (hydrated.isErr()) return err(hydrated.error);

    for (const hit of wanted) {
      const row = hydrated.value.get(hit.key);
      if (row === undefined) {
        unhydratedHits += 1;
        continue;
      }
      // The engine's highlight beats the stored summary snippet: it shows WHERE
      // the query matched. Fall back to the grounded summary when there is none.
      const snippet = snippetByKey.get(hit.key) ?? row.snippet;
      sectionHitsOut.push({ ...row, snippet, score: hit.score });
    }
  }

  // §5.2-C provenance for the whole result set, in ONE batched statement.
  const actIds = [
    ...new Set([...actHitsOut.map((h) => h.act.actId), ...sectionHitsOut.map((h) => h.actId)]),
  ];
  const provenance = await deps.acts.versionProvenanceForActs(actIds);
  if (provenance.isErr()) return err(provenance.error);

  return ok({
    acts: actHitsOut.map((h) => ({
      ...h,
      provenance: provenance.value.get(h.act.actId) ?? null,
    })),
    sections: sectionHitsOut.map((h) => ({
      ...h,
      provenance: provenance.value.get(h.actId) ?? null,
    })),
    actsTotal: actsHits?.total ?? null,
    sectionsTotal: bm25Hits?.total ?? null,
    totalsExhaustive,
    degraded,
    caveats,
    asOf,
    unhydratedHits,
  });
};
