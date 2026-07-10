/**
 * Kernel — Meili client `searchEntities` + the (non-exported) `mapHit`, tested
 * THROUGH the public client by stubbing global `fetch`.
 *
 * Asserts the request contract (`showRankingScore`, filter/facets/limit/offset
 * passthrough, NO `attributesToHighlight`), the degrade signal (any non-OK
 * response — including an `index_not_found` body — surfaces as `err`), and the
 * hit mapping (subtitle→snippet, _rankingScore→score, doc_type from the doc,
 * `attrs` = the WHOLE raw hit, tolerant of missing fields). A legacy
 * `multiSearch` test pins that mapHit still puts the whole hit in `attrs` so
 * companies-repo (which reads `hit.attrs['cui']`) never regresses.
 */

import { fromThrowable } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeMeiliClient } from '@/modules/shared/shell/clients/meili-client.js';

/** Result-based JSON parse (the codebase bans bare `JSON.parse`). */
const safeJsonParse = fromThrowable(JSON.parse);

const HOST = 'http://meili.test';
const KEY = 'search-key';

const client = makeMeiliClient({ host: HOST, apiKey: KEY });

/** Build a `fetch` Response-like object the client consumes (json + text). */
const jsonResponse = (body: unknown, ok = true, status = 200): Response =>
  ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const errorResponse = (status: number, text: string): Response =>
  ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  }) as unknown as Response;

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Parse the request body of the first fetch call. */
const firstBody = (): Record<string, unknown> => {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
  const parsed = safeJsonParse(init.body as string);
  expect(parsed.isOk()).toBe(true);
  return parsed._unsafeUnwrap() as Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Request contract
// ─────────────────────────────────────────────────────────────────────────────

describe('searchEntities — request contract', () => {
  it('targets the per-index search URL with the bearer key', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ hits: [] }));
    await client.searchEntities('acme', 'entities', { limit: 20 });

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe(`${HOST}/indexes/entities/search`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${KEY}`);
  });

  it('always sets showRankingScore:true and NEVER requests attributesToHighlight', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ hits: [] }));
    await client.searchEntities('acme', 'entities', { limit: 20 });

    const body = firstBody();
    expect(body['showRankingScore']).toBe(true);
    expect(body).not.toHaveProperty('attributesToHighlight');
  });

  it('passes filter / facets / limit / offset straight through', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ hits: [] }));
    const filter = ['visibility = "public"', 'doc_type IN ["company"]'];
    await client.searchEntities('acme', 'entities', {
      filter,
      facets: ['doc_type'],
      limit: 10,
      offset: 30,
    });

    const body = firstBody();
    expect(body['q']).toBe('acme');
    expect(body['filter']).toEqual(filter);
    expect(body['facets']).toEqual(['doc_type']);
    expect(body['limit']).toBe(10);
    expect(body['offset']).toBe(30);
  });

  it('omits filter / facets / offset from the body when not supplied', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ hits: [] }));
    await client.searchEntities('acme', 'entities', { limit: 20 });

    const body = firstBody();
    expect(body).not.toHaveProperty('filter');
    expect(body).not.toHaveProperty('facets');
    expect(body).not.toHaveProperty('offset');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Degrade signal — any non-OK response is an err
// ─────────────────────────────────────────────────────────────────────────────

describe('searchEntities — degrade signal', () => {
  it('surfaces a 503 as an Upstream err (not an empty ok)', async () => {
    fetchSpy.mockResolvedValue(errorResponse(503, 'service unavailable'));
    const res = await client.searchEntities('acme', 'entities', { limit: 20 });

    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('Upstream');
  });

  it('surfaces an index_not_found 404 body as an err (degrade — never silent empty)', async () => {
    fetchSpy.mockResolvedValue(
      errorResponse(404, '{"code":"index_not_found","message":"Index `entities` not found."}')
    );
    const res = await client.searchEntities('acme', 'entities', { limit: 20 });

    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('Upstream');
  });

  it('surfaces a thrown fetch (network/timeout) as an Upstream err', async () => {
    fetchSpy.mockRejectedValue(new Error('AbortError: timed out'));
    const res = await client.searchEntities('acme', 'entities', { limit: 20 });

    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('Upstream');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mapHit (through searchEntities)
// ─────────────────────────────────────────────────────────────────────────────

describe('searchEntities — mapHit', () => {
  it('maps subtitle→snippet, _rankingScore→score, doc_type from the doc, attrs = whole hit', async () => {
    const rawHit = {
      id: 'company:42',
      doc_id: 'company:42',
      doc_type: 'company',
      title: 'ACME SRL',
      subtitle: 'CUI 42 · Cluj',
      county_name: 'Cluj',
      url: 'https://example.test/acme',
      rank_boost: 12,
      cuis: ['42', 99, 'RO7'],
      year: 2024,
      _rankingScore: 0.87,
      visibility: 'public',
      attrs: { kind: 'srl', status: 'active' },
    };
    fetchSpy.mockResolvedValue(
      jsonResponse({
        hits: [rawHit],
        facetDistribution: { doc_type: { company: 1 } },
        estimatedTotalHits: 1,
      })
    );

    const res = await client.searchEntities('acme', 'entities', { limit: 20 });
    const hit = res._unsafeUnwrap().hits[0]!;

    expect(hit.id).toBe('company:42');
    expect(hit.docType).toBe('company');
    expect(hit.title).toBe('ACME SRL');
    expect(hit.snippet).toBe('CUI 42 · Cluj'); // subtitle preferred over body
    expect(hit.subtitle).toBe('CUI 42 · Cluj');
    expect(hit.score).toBe(0.87);
    expect(hit.source).toBe('meili');
    expect(hit.countyName).toBe('Cluj');
    expect(hit.url).toBe('https://example.test/acme');
    expect(hit.rankBoost).toBe(12);
    expect(hit.cuis).toEqual(['42', 'RO7']); // non-string cuis dropped
    expect(hit.year).toBe(2024);
    // `attrs` is the WHOLE raw hit (companies-repo + the MCP whitelist rely on it).
    expect(hit.attrs).toEqual(rawHit);
    expect(hit.attrs['visibility']).toBe('public');
    expect(hit.attrs['attrs']).toEqual({ kind: 'srl', status: 'active' });
  });

  it('passes the facet distribution + estimatedTotalHits through', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        hits: [],
        facetDistribution: { doc_type: { company: 5, bill: 3 } },
        estimatedTotalHits: 8,
      })
    );
    const res = await client.searchEntities('acme', 'entities', { limit: 20 });
    const value = res._unsafeUnwrap();
    expect(value.facetDistribution).toEqual({ doc_type: { company: 5, bill: 3 } });
    expect(value.estimatedTotalHits).toBe(8);
  });

  it('defaults facetDistribution to {} and estimatedTotalHits to hit count when absent', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ hits: [{ id: 'a' }, { id: 'b' }] }));
    const res = await client.searchEntities('acme', 'entities', { limit: 20 });
    const value = res._unsafeUnwrap();
    expect(value.facetDistribution).toEqual({});
    expect(value.estimatedTotalHits).toBe(2);
  });

  it('tolerates a hit missing every optional field (falls back to the doc-type defaults)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ hits: [{}] }));
    const res = await client.searchEntities('acme', 'entities', { limit: 20 });
    const hit = res._unsafeUnwrap().hits[0]!;

    expect(hit.id).toBe('');
    expect(hit.docType).toBe('entities'); // falls back to the index uid
    expect(hit.title).toBe('');
    expect(hit.snippet).toBeNull();
    expect(hit.score).toBeNull();
    expect(hit.attrs).toEqual({});
    expect(hit).not.toHaveProperty('subtitle');
    expect(hit).not.toHaveProperty('countyName');
    expect(hit).not.toHaveProperty('cuis');
  });

  it('coerces a numeric id to string and slices a long body into the snippet', async () => {
    const longBody = 'x'.repeat(500);
    fetchSpy.mockResolvedValue(
      jsonResponse({ hits: [{ id: 7, name: 'Fallback', body: longBody }] })
    );
    const res = await client.searchEntities('acme', 'entities', { limit: 20 });
    const hit = res._unsafeUnwrap().hits[0]!;

    expect(hit.id).toBe('7');
    expect(hit.title).toBe('Fallback'); // name → title fallback
    expect(hit.snippet).toBe('x'.repeat(200)); // body sliced to 200
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy multiSearch regression — companies-repo reads hit.attrs['cui']
// ─────────────────────────────────────────────────────────────────────────────

describe('multiSearch — mapHit keeps the whole hit in attrs (companies-repo contract)', () => {
  it('exposes the raw hit (incl. cui) under attrs so companies-repo can read it', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        results: [
          {
            indexUid: 'organizations',
            hits: [{ id: 'org:1', name: 'ACME', cui: '42' }],
            estimatedTotalHits: 1,
          },
        ],
      })
    );

    const res = await client.multiSearch('acme', ['organizations'], 10);
    const value = res._unsafeUnwrap();
    const hit = value[0]!.hits[0]!;

    expect(hit.attrs['cui']).toBe('42');
    expect(hit.docType).toBe('organizations'); // no doc_type on the legacy doc → index uid
    expect(value[0]!.totalHits).toBe(1);
  });

  it('returns ok([]) for no indexes without calling fetch', async () => {
    const res = await client.multiSearch('acme', [], 10);
    expect(res._unsafeUnwrap()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to per-index search when multi-search reports index_not_found', async () => {
    fetchSpy
      // 1) /multi-search → 404 index_not_found
      .mockResolvedValueOnce(errorResponse(404, '{"code":"index_not_found"}'))
      // 2) per-index /indexes/organizations/search → ok with a hit
      .mockResolvedValueOnce(
        jsonResponse({ hits: [{ id: 'org:1', cui: '42' }], estimatedTotalHits: 1 })
      )
      // 3) per-index /indexes/companies/search → non-OK → empty bucket (no throw)
      .mockResolvedValueOnce(errorResponse(500, 'boom'));

    const res = await client.multiSearch('acme', ['organizations', 'companies'], 5);
    const value = res._unsafeUnwrap();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(value).toHaveLength(2);
    expect(value[0]!.hits[0]!.attrs['cui']).toBe('42');
    expect(value[1]!.hits).toEqual([]); // failed index degrades to an empty bucket
  });

  it('surfaces a non-OK multi-search (not index_not_found) as an err', async () => {
    fetchSpy.mockResolvedValue(errorResponse(502, 'bad gateway'));
    const res = await client.multiSearch('acme', ['organizations'], 5);
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('Upstream');
  });

  it('surfaces a thrown multi-search fetch as an err', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const res = await client.multiSearch('acme', ['organizations'], 5);
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('Upstream');
  });

  it('returns an empty bucket (no throw) when a per-index fallback fetch throws', async () => {
    fetchSpy
      .mockResolvedValueOnce(errorResponse(404, 'index_not_found'))
      .mockRejectedValueOnce(new Error('per-index network drop'));

    const res = await client.multiSearch('acme', ['organizations'], 5);
    expect(res._unsafeUnwrap()).toEqual([{ index: 'organizations', hits: [], totalHits: 0 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// healthCheck
// ─────────────────────────────────────────────────────────────────────────────

describe('healthCheck', () => {
  it('returns ok when /health is 200', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({}));
    const res = await client.healthCheck();
    expect(res.isOk()).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`${HOST}/health`);
  });

  it('returns an err when /health is non-OK', async () => {
    fetchSpy.mockResolvedValue(errorResponse(503, 'down'));
    const res = await client.healthCheck();
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('Upstream');
  });

  it('returns an err when /health throws', async () => {
    fetchSpy.mockRejectedValue(new Error('unreachable'));
    const res = await client.healthCheck();
    expect(res.isErr()).toBe(true);
  });
});
