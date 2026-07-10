/**
 * Legal — `searchLegal` usecase routing (mocked ports). Covers:
 *  - identifier router: a clean citation short-circuits to the act card (NO embed);
 *  - semantic OFF → qVec=null + "semantic search unavailable" caveat (lexical path);
 *  - semantic ON → embeds with the `search_query:` prefix, passes the vector down;
 *  - channel routing (sections vs docs vs auto).
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { searchLegal, type LegalSearchDeps } from '@/modules/legal/core/usecases.js';
import {
  upstreamError,
  type ApiError,
  type CapabilityResolver,
  type SyntheticClient,
} from '@/modules/shared/index.js';

import type { LegalActsRepo, LegalRetrievalRepo } from '@/modules/legal/core/ports.js';
import type { LegalActCard, LegalDocHit, LegalSectionHit } from '@/modules/legal/core/types.js';

const card: LegalActCard = {
  actId: '66150',
  actNaturalKey: 'lege:227:2015:',
  actType: 'lege',
  actNumber: '227',
  actYear: 2015,
  issuerSlug: 'parlamentul',
  canonicalDocumentId: '171282',
  displayCitation: 'Legea nr. 227/2015',
  status: 'abrogat-partial',
  statusEvidence: {},
  entryIntoForce: '2015-09-10',
  inDegree: 2621,
  canonical: null,
  summary: null,
  aliases: ['codul fiscal'],
  citationKeys: [],
  versionCount: 2,
  amendedAfterPublication: 295,
};

const capabilities = (semantic: boolean): CapabilityResolver => ({
  engines: { meili: true, opensearch: true },
  forDomain: () => ({ semantic }),
});

const makeDeps = (over: {
  semanticReady?: boolean;
  getActCard?: LegalActsRepo['getActCard'];
  searchSections?: LegalRetrievalRepo['searchSections'];
  searchDocs?: LegalRetrievalRepo['searchDocs'];
  embed?: SyntheticClient['embed'];
}): LegalSearchDeps => {
  const sections: readonly LegalSectionHit[] = [];
  const docs: readonly LegalDocHit[] = [];
  return {
    retrieval: {
      searchSections:
        over.searchSections ??
        (async (): Promise<Result<readonly LegalSectionHit[], ApiError>> => ok(sections)),
      searchDocs:
        over.searchDocs ??
        (async (): Promise<Result<readonly LegalDocHit[], ApiError>> => ok(docs)),
    },
    acts: {
      getActCard:
        over.getActCard ?? (async (): Promise<Result<LegalActCard | null, ApiError>> => ok(null)),
    } as unknown as LegalActsRepo,
    synthetic: {
      embed:
        over.embed ??
        (async (): Promise<Result<readonly number[], ApiError>> => ok([0.1, 0.2, 0.3])),
    } as unknown as SyntheticClient,
    capabilities: capabilities(over.semanticReady ?? true),
    embeddingModel: 'nomic-embed-text-v1.5',
    semanticReady: over.semanticReady ?? true,
    clientBaseUrl: 'https://transparenta.eu',
  };
};

describe('searchLegal — identifier router', () => {
  it('a clean citation short-circuits to the act card (no embed call)', async () => {
    const embed = vi.fn();
    const deps = makeDeps({
      getActCard: async () => ok(card),
      embed: embed,
    });
    const res = await searchLegal(deps, {
      q: 'legea 227/2015',
      filter: {},
      channel: 'auto',
      includeHistorical: false,
      limit: 5,
    });
    expect(res.isOk()).toBe(true);
    const out = res._unsafeUnwrap();
    expect(out.acts).toHaveLength(1);
    expect(out.acts[0]?.act.actId).toBe('66150');
    expect(out.caveats[0]).toContain('modificat de 295 acte');
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('searchLegal — semantic gating', () => {
  it('semantic OFF → null vector + caveat (lexical path)', async () => {
    const searchDocs = vi.fn(async () => ok([] as LegalDocHit[]));
    const deps = makeDeps({ semanticReady: false, searchDocs: searchDocs });
    const res = await searchLegal(deps, {
      q: 'cota de TVA',
      filter: {},
      channel: 'docs',
      includeHistorical: false,
      limit: 5,
    });
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap().caveats).toContain('semantic search unavailable');
    // the repo was called with a null vector (lexical fallback)
    expect(searchDocs).toHaveBeenCalledWith(null, expect.anything());
  });

  it('semantic ON → embeds with the search_query: prefix and passes the vector', async () => {
    const embed = vi.fn(async () => ok([0.5, 0.6]));
    const searchSections = vi.fn(async () => ok([] as LegalSectionHit[]));
    const deps = makeDeps({
      semanticReady: true,
      embed: embed,
      searchSections: searchSections,
    });
    await searchLegal(deps, {
      q: 'cota de TVA',
      filter: {},
      channel: 'sections',
      includeHistorical: false,
      limit: 5,
    });
    expect(embed).toHaveBeenCalledWith('search_query: cota de TVA', 'nomic-embed-text-v1.5');
    expect(searchSections).toHaveBeenCalledWith([0.5, 0.6], expect.anything());
  });

  it('embed failure degrades to lexical + caveat (never errors)', async () => {
    const searchDocs = vi.fn(async () => ok([] as LegalDocHit[]));
    const deps = makeDeps({
      semanticReady: true,
      embed: async () => err(upstreamError('synthetic down', 'synthetic')),
      searchDocs: searchDocs,
    });
    const res = await searchLegal(deps, {
      q: 'cota de TVA',
      filter: {},
      channel: 'docs',
      includeHistorical: false,
      limit: 5,
    });
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap().caveats).toContain('semantic search unavailable');
    // lexical fallback ran with a null vector
    expect(searchDocs).toHaveBeenCalledWith(null, expect.anything());
  });
});

describe('searchLegal — channel routing', () => {
  it('channel=sections only queries sections', async () => {
    const searchSections = vi.fn(async () => ok([] as LegalSectionHit[]));
    const searchDocs = vi.fn(async () => ok([] as LegalDocHit[]));
    const deps = makeDeps({
      searchSections: searchSections,
      searchDocs: searchDocs,
    });
    await searchLegal(deps, {
      q: 'tva',
      filter: {},
      channel: 'sections',
      includeHistorical: false,
      limit: 5,
    });
    expect(searchSections).toHaveBeenCalled();
    expect(searchDocs).not.toHaveBeenCalled();
  });
});
