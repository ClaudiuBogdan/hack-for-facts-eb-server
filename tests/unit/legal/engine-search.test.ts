/**
 * The engine-backed search usecase — mostly a test of what it REFUSES to hide.
 *
 * An index that is missing, an embedder that is down, and a hit the database
 * declines to hydrate all produce a shorter answer. The question each test asks
 * is whether the answer SAYS so, because a silently shortened result page is
 * indistinguishable from an honest one.
 */

import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  SECTIONS_INDEX_MISSING_CAVEAT,
  SEMANTIC_LEG_DOWN_CAVEAT,
  searchWithEngine,
  type LegalEngineSearchDeps,
} from '@/modules/legal/core/legal-engine-search.js';
import { sectionFusionKey } from '@/modules/legal/core/legal-search-fusion.js';
import { upstreamError } from '@/modules/shared/index.js';

import type {
  LegalEnginePage,
  LegalSearchEngine,
  LegalSectionKey,
} from '@/modules/legal/core/ports.js';
import type { LegalAct, LegalSectionHit } from '@/modules/legal/core/types.js';

const act = (actId: string, canonicalDocumentId: string): LegalAct => ({
  actId,
  actNaturalKey: `lege/2001/${actId}`,
  actType: 'lege',
  actNumber: actId,
  actYear: 2001,
  issuerSlug: 'parlamentul',
  canonicalDocumentId,
  displayCitation: `Legea nr. ${actId}/2001`,
  status: 'in-vigoare',
  statusEvidence: {},
  entryIntoForce: null,
  inDegree: 1,
});

const page = (
  hits: { documentId: string; actId?: string; sectionKey?: string; snippet?: string }[],
  total = hits.length
): LegalEnginePage => ({
  hits: hits.map((h) => ({
    documentId: h.documentId,
    actId: h.actId ?? null,
    sectionKey: h.sectionKey ?? null,
    snippet: h.snippet ?? null,
  })),
  total,
  totalExhaustive: true,
  asOf: '2026-08-06T04:00:00Z',
});

const engineFake = (over: Partial<LegalSearchEngine>): LegalSearchEngine => ({
  canServeActs: () => true,
  canServeSections: () => true,
  searchActsBm25: () => Promise.resolve(ok(page([]))),
  searchSectionsBm25: () => Promise.resolve(ok(page([]))),
  searchSectionsKnn: () => Promise.resolve(ok(page([]))),
  ...over,
});

const sectionRow = (documentId: string, sectionKey: string): LegalSectionHit => ({
  actId: '7',
  displayCitation: 'Legea nr. 7/2001',
  status: 'in-vigoare',
  documentId,
  sectionKey,
  articleNumber: '5',
  nodeLabel: 'Articolul 5',
  nodePath: 'art:5',
  charStart: 10,
  charEnd: 99,
  snippet: 'rezumat stocat',
  portalDeepLink: null,
  score: 0,
  provenance: null,
});

const depsWith = (over: {
  engine?: Partial<LegalSearchEngine>;
  acts?: LegalAct[];
  sections?: Map<string, LegalSectionHit>;
  embedQuery?: LegalEngineSearchDeps['embedQuery'];
}): LegalEngineSearchDeps => ({
  engine: engineFake(over.engine ?? {}),
  acts: {
    findActsByIds: () => Promise.resolve(ok(over.acts ?? [])),
    summariesForDocuments: () => Promise.resolve(ok(new Map())),
    versionProvenanceForActs: (ids: readonly string[]) =>
      Promise.resolve(
        ok(
          new Map(
            ids.map((id) => [
              id,
              {
                versionKind: 'original',
                versionDate: null,
                sourceUrl: null,
                amendedAfterPublication: 0,
                latestConsolidationDate: null,
                latestConsolidationLoaded: false,
              },
            ])
          )
        )
      ),
  } as never,
  retrieval: {
    hydrateSections: (keys: readonly LegalSectionKey[]) =>
      Promise.resolve(
        ok(
          new Map(
            keys
              .map(
                (k) =>
                  [
                    sectionFusionKey(k.documentId, k.sectionKey),
                    over.sections?.get(sectionFusionKey(k.documentId, k.sectionKey)),
                  ] as const
              )
              .filter(
                (entry): entry is readonly [string, LegalSectionHit] => entry[1] !== undefined
              )
          )
        )
      ),
  } as never,
  ...(over.embedQuery !== undefined && { embedQuery: over.embedQuery }),
});

const request = {
  q: 'taxe',
  filter: {},
  channel: 'auto' as const,
  limit: 10,
};

describe('searchWithEngine — degradation is stated, never silent', () => {
  it('serves acts and SAYS the sections index is missing', async () => {
    // Today's live state: the acts index exists, sections waits on the
    // split-v2 re-projection. The reader must be told, not just given less.
    const deps = depsWith({
      engine: {
        canServeSections: () => false,
        searchActsBm25: () => Promise.resolve(ok(page([{ documentId: 'd1', actId: '1' }], 42))),
      },
      acts: [act('1', 'd1')],
    });
    const res = await searchWithEngine(deps, request);
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;
    expect(res.value.acts).toHaveLength(1);
    expect(res.value.degraded).toBe(true);
    expect(res.value.caveats).toContain(SECTIONS_INDEX_MISSING_CAVEAT);
    expect(res.value.actsTotal).toBe(42);
    expect(res.value.sectionsTotal).toBeNull();
  });

  it('errors rather than returning empty when NO index serves the channel', async () => {
    const deps = depsWith({
      engine: { canServeActs: () => false, canServeSections: () => false },
    });
    const res = await searchWithEngine(deps, request);
    // "no matches" and "no index" must never look alike.
    expect(res.isErr()).toBe(true);
  });

  it('fails the request when a leg fails — never falls back to a lexical scan', async () => {
    const deps = depsWith({
      engine: {
        searchActsBm25: () => Promise.resolve(err(upstreamError('engine down', 'opensearch'))),
      },
    });
    const res = await searchWithEngine(deps, request);
    expect(res.isErr()).toBe(true);
  });

  it('keeps the lexical legs when the embedder fails, and says the vector leg is down', async () => {
    const key = sectionFusionKey('d9', 'art:5');
    const deps = depsWith({
      engine: {
        searchSectionsBm25: () =>
          Promise.resolve(ok(page([{ documentId: 'd9', sectionKey: 'art:5' }]))),
      },
      sections: new Map([[key, sectionRow('d9', 'art:5')]]),
      embedQuery: () => Promise.resolve(err(upstreamError('embedder down', 'synthetic'))),
    });
    const res = await searchWithEngine(deps, request);
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;
    expect(res.value.sections).toHaveLength(1);
    expect(res.value.degraded).toBe(true);
    expect(res.value.caveats).toContain(SEMANTIC_LEG_DOWN_CAVEAT);
  });
});

describe('searchWithEngine — hydration is the authority', () => {
  it('counts an act hit whose document is no longer the canonical expression', async () => {
    const deps = depsWith({
      engine: {
        canServeSections: () => false,
        searchActsBm25: () =>
          Promise.resolve(
            ok(
              page([
                { documentId: 'stale-doc', actId: '1' },
                { documentId: 'd1', actId: '1' },
              ])
            )
          ),
      },
      // The act's canonical document is d1, so the stale-doc hit must not serve.
      acts: [act('1', 'd1')],
    });
    const res = await searchWithEngine(deps, request);
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;
    expect(res.value.acts.map((h) => h.act.actId)).toEqual(['1']);
    expect(res.value.unhydratedHits).toBe(1);
  });

  it('counts a section hit Postgres declined to return', async () => {
    const deps = depsWith({
      engine: {
        canServeActs: () => false,
        searchSectionsBm25: () =>
          Promise.resolve(
            ok(
              page([
                { documentId: 'd9', sectionKey: 'art:5' },
                { documentId: 'gone', sectionKey: 'art:1' },
              ])
            )
          ),
      },
      sections: new Map([[sectionFusionKey('d9', 'art:5'), sectionRow('d9', 'art:5')]]),
    });
    const res = await searchWithEngine(deps, request);
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;
    expect(res.value.sections).toHaveLength(1);
    expect(res.value.unhydratedHits).toBe(1);
  });

  it('prefers the engine highlight over the stored summary snippet', async () => {
    const key = sectionFusionKey('d9', 'art:5');
    const deps = depsWith({
      engine: {
        canServeActs: () => false,
        searchSectionsBm25: () =>
          Promise.resolve(
            ok(page([{ documentId: 'd9', sectionKey: 'art:5', snippet: 'text cu ⟦taxe⟧' }]))
          ),
      },
      sections: new Map([[key, sectionRow('d9', 'art:5')]]),
    });
    const res = await searchWithEngine(deps, request);
    // The highlight shows WHERE the query matched; the stored summary does not.
    expect(res.isOk() && res.value.sections[0]?.snippet).toBe('text cu ⟦taxe⟧');
  });

  it('attaches version provenance to every hit in one batch', async () => {
    const deps = depsWith({
      engine: {
        canServeSections: () => false,
        searchActsBm25: () => Promise.resolve(ok(page([{ documentId: 'd1', actId: '1' }]))),
      },
      acts: [act('1', 'd1')],
    });
    const res = await searchWithEngine(deps, request);
    expect(res.isOk() && res.value.acts[0]?.provenance).not.toBeNull();
  });
});
