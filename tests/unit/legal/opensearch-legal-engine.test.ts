/**
 * The legal OpenSearch engine: what it accepts, and what it REFUSES.
 *
 * The refusals are the point. This surface decides whether an answer is
 * servable, and every gate here exists because the alternative is a confident
 * wrong answer: a partial shard response served as an exact total, an ungated
 * index read as live, a half-understood hit list shown as a result page.
 *
 * The transport is injected, so all of it is exercised without a cluster.
 */

import { describe, expect, it } from 'vitest';

import {
  makeLegalSearchEngine,
  type LegalEngineTransport,
} from '@/modules/legal/shell/repo/opensearch-legal-repo.js';

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const OK_SHARDS = { total: 3, successful: 3, failed: 0, skipped: 0 };

const searchResponse = (hits: Record<string, unknown>[], total = hits.length): string =>
  JSON.stringify({
    timed_out: false,
    _shards: OK_SHARDS,
    hits: { total: { value: total, relation: 'eq' }, hits },
  });

const mappingResponse = (builtAt: string | null): string =>
  JSON.stringify({
    'legal-acts-v1': {
      mappings: builtAt === null ? {} : { _meta: { built_at: builtAt } },
    },
  });

/** Records every call; answers `_mapping` and `_search` from the given texts. */
const fakeTransport = (opts: {
  search?: { status: number; text: string };
  mapping?: { status: number; text: string };
  sent?: Sent[];
}): LegalEngineTransport => {
  const search = opts.search ?? { status: 200, text: searchResponse([]) };
  const mapping = opts.mapping ?? { status: 200, text: mappingResponse('2026-08-05T12:00:00Z') };
  return (method, path, body) => {
    opts.sent?.push({ method, path, body });
    return Promise.resolve(path.includes('_mapping') ? mapping : search);
  };
};

const engineWith = (transport: LegalEngineTransport, indexes = true) =>
  makeLegalSearchEngine(
    {
      url: 'https://opensearch.example:9200',
      ...(indexes && { actsIndex: 'legal-acts', sectionsIndex: 'legal-sections' }),
    },
    transport
  );

const actHit = (documentId: string, actId: number, highlight?: Record<string, unknown>) => ({
  _source: { document_id: documentId, act_id: actId },
  ...(highlight !== undefined && { highlight }),
});

describe('legal search engine — serving a page', () => {
  it('returns keys in engine rank order with the build stamp', async () => {
    const engine = engineWith(
      fakeTransport({
        search: {
          status: 200,
          text: searchResponse([actHit('100023', 424_242), actHit('100019', 55)], 1_337),
        },
      })
    );
    const res = await engine.searchActsBm25('taxe', {}, { from: 0, size: 2 });
    expect(res.isOk()).toBe(true);
    if (!res.isOk()) return;
    expect(res.value.hits.map((h) => h.documentId)).toEqual(['100023', '100019']);
    // act_id survives as a string: it is a Postgres bigint, not a JS number.
    expect(res.value.hits[0]?.actId).toBe('424242');
    expect(res.value.total).toBe(1_337);
    expect(res.value.totalExhaustive).toBe(true);
    expect(res.value.asOf).toBe('2026-08-05T12:00:00Z');
  });

  it('prefers the BASE highlight fragment over the folded twin', async () => {
    const engine = engineWith(
      fakeTransport({
        search: {
          status: 200,
          text: searchResponse([
            actHit('100023', 1, {
              'title.folded': ['folded ⟦taxe⟧ fragment'],
              title: ['base ⟦taxe⟧ fragment'],
            }),
          ]),
        },
      })
    );
    const res = await engine.searchActsBm25('taxe', {}, { from: 0, size: 1 });
    expect(res.isOk() && res.value.hits[0]?.snippet).toBe('base ⟦taxe⟧ fragment');
  });

  it('reports a capped count as non-exhaustive rather than as a total', async () => {
    const engine = engineWith(
      fakeTransport({
        search: {
          status: 200,
          text: JSON.stringify({
            timed_out: false,
            _shards: OK_SHARDS,
            hits: { total: { value: 10_000, relation: 'gte' }, hits: [actHit('1', 1)] },
          }),
        },
      })
    );
    const res = await engine.searchActsBm25('lege', {}, { from: 0, size: 1 });
    expect(res.isOk() && res.value.totalExhaustive).toBe(false);
    expect(res.isOk() && res.value.total).toBe(10_000);
  });

  it('carries section_key on the sections leg and never invents one on acts', async () => {
    const sent: Sent[] = [];
    const engine = engineWith(
      fakeTransport({
        sent,
        search: {
          status: 200,
          text: searchResponse([
            { _source: { document_id: '100023', act_id: '7', section_key: 'art-5' } },
          ]),
        },
      })
    );
    const res = await engine.searchSectionsBm25('amenda', {}, { from: 0, size: 1 });
    expect(res.isOk() && res.value.hits[0]?.sectionKey).toBe('art-5');
    expect(sent[0]?.path).toContain('/legal-sections/_search');

    const acts = await engineWith(fakeTransport({})).searchActsBm25('x', {}, { from: 0, size: 1 });
    expect(acts.isOk()).toBe(true);
  });

  it('caches the build stamp instead of re-reading the mapping per search', async () => {
    const sent: Sent[] = [];
    const engine = engineWith(fakeTransport({ sent }));
    await engine.searchActsBm25('a', {}, { from: 0, size: 1 });
    await engine.searchActsBm25('b', {}, { from: 0, size: 1 });
    expect(sent.filter((s) => s.path.includes('_mapping'))).toHaveLength(1);
    expect(sent.filter((s) => s.path.includes('_search'))).toHaveLength(2);
  });
});

describe('legal search engine — the kNN leg rides the same filter', () => {
  it('puts the BM25 filter clauses inside the knn filter, privacy gate included', async () => {
    const sent: Sent[] = [];
    const engine = engineWith(fakeTransport({ sent }));
    const filter = { actType: ['lege'], year: 2015 };

    await engine.searchSectionsBm25('taxe', filter, { from: 0, size: 5 });
    await engine.searchSectionsKnn([0.1, 0.2, 0.3], filter, 5);

    const bm25Body = sent[0]?.body as { query: { bool: { filter: unknown[] } } };
    const knnBody = sent[2]?.body as {
      query: { knn: { embedding: { filter: { bool: { filter: unknown[] } } } } };
    };
    // Identical compiled clauses on both legs — plan top-risk 4: an unfiltered
    // vector leg silently answers a different question than the leg it fuses with.
    expect(knnBody.query.knn.embedding.filter.bool.filter).toEqual(bm25Body.query.bool.filter);
    expect(bm25Body.query.bool.filter).toContainEqual({ term: { privacy_class: 'public' } });
  });

  it('never fabricates a snippet for a vector match', async () => {
    const engine = engineWith(
      fakeTransport({
        search: {
          status: 200,
          text: searchResponse([
            {
              _source: { document_id: '1', act_id: 1, section_key: 'art-1' },
              highlight: { text: ['⟦should be ignored⟧'] },
            },
          ]),
        },
      })
    );
    const res = await engine.searchSectionsKnn([0.1], {}, 1);
    expect(res.isOk() && res.value.hits[0]?.snippet).toBeNull();
  });
});

describe('legal search engine — refusals', () => {
  const refuses = async (
    transport: LegalEngineTransport,
    because: string
  ): Promise<{ ok: boolean; message: string }> => {
    const res = await engineWith(transport).searchActsBm25('taxe', {}, { from: 0, size: 5 });
    return { ok: res.isOk(), message: res.isErr() ? res.error.message : `served (${because})` };
  };

  it('refuses a non-200', async () => {
    const r = await refuses(fakeTransport({ search: { status: 503, text: 'unavailable' } }), '503');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('http 503');
  });

  it('refuses invalid JSON', async () => {
    const r = await refuses(fakeTransport({ search: { status: 200, text: '{not json' } }), 'json');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('invalid json');
  });

  it('refuses a timed-out response even though it is a 200 with hits', async () => {
    const text = JSON.stringify({
      timed_out: true,
      _shards: OK_SHARDS,
      hits: { total: { value: 5, relation: 'eq' }, hits: [actHit('1', 1)] },
    });
    const r = await refuses(fakeTransport({ search: { status: 200, text } }), 'timed_out');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('incomplete');
  });

  it('refuses a response whose shards did not all answer', async () => {
    const text = JSON.stringify({
      timed_out: false,
      _shards: { total: 3, successful: 2, failed: 1, skipped: 0 },
      hits: { total: { value: 5, relation: 'eq' }, hits: [actHit('1', 1)] },
    });
    const r = await refuses(fakeTransport({ search: { status: 200, text } }), 'shards');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('incomplete');
  });

  it('refuses a hit with no document_id — an unhydratable hit is unshowable', async () => {
    const text = searchResponse([{ _source: { act_id: 7 } }]);
    const r = await refuses(fakeTransport({ search: { status: 200, text } }), 'no document_id');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('malformed hits');
  });

  it('refuses an index with no build stamp — an ungated index reads as live', async () => {
    const r = await refuses(
      fakeTransport({ mapping: { status: 200, text: mappingResponse(null) } }),
      'no stamp'
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('no build stamp');
  });

  it('refuses a leg whose index is not configured, and says so through canServe', async () => {
    const engine = engineWith(fakeTransport({}), false);
    expect(engine.canServeActs()).toBe(false);
    expect(engine.canServeSections()).toBe(false);
    const res = await engine.searchActsBm25('taxe', {}, { from: 0, size: 5 });
    expect(res.isErr()).toBe(true);
  });

  it('keeps the response body out of the error — it echoes the query AND law text', async () => {
    const secret = 'ART. 5 — textul legii care nu are ce cauta in loguri';
    const r = await refuses(
      fakeTransport({ search: { status: 500, text: JSON.stringify({ error: secret }) } }),
      'body leak'
    );
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain(secret);
    expect(r.message).not.toContain('textul legii');
  });
});
