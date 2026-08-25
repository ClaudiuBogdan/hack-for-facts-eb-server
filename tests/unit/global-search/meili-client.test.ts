/**
 * Kernel — Meili client `searchEntities` + the (non-exported) `mapHit`, tested
 * THROUGH the public client by stubbing global `fetch`.
 *
 * Asserts the request contract (`showRankingScore`, filter/facets/limit/offset
 * passthrough, NO `attributesToHighlight`), the degrade signal (any non-OK
 * response — including an `index_not_found` body — surfaces as `err`), and the
 * hit mapping (subtitle→snippet, _rankingScore→score, doc_type from the doc,
 * `attrs` = the WHOLE raw hit, tolerant of missing fields — including the
 * retired per-source doc shape, pinned through the live method).
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
      identifiers: ['42', 99, 'J12/345/2001'],
      roles: ['company', 'pnrr_entity'],
      is_active: true,
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
    // identifiers keeps every searchable form; cuis is the all-numeric subset so
    // a CUI-spine deep-link never receives an ONRC number. Non-strings dropped.
    expect(hit.identifiers).toEqual(['42', 'J12/345/2001']);
    expect(hit.cuis).toEqual(['42']);
    expect(hit.roles).toEqual(['company', 'pnrr_entity']);
    expect(hit.isActive).toBe(true);
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
// Retired-shape tolerance — mapHit through searchEntities
// ─────────────────────────────────────────────────────────────────────────────

describe('searchEntities — retired per-source doc shape tolerance', () => {
  // multiSearch and its suite were removed 2026-08-26 (zero production
  // callers after the companies-repo re-point). mapHit deliberately still
  // tolerates the retired shape (body, no doc_type, cuis) so a mispointed
  // index degrades to partial hits rather than throwing — pinned here through
  // the live method.
  it('maps a retired-shape doc: attrs carries the raw hit, docType falls back to the index uid', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        hits: [{ id: 'org:1', name: 'ACME', cui: '42', body: 'a body' }],
        estimatedTotalHits: 1,
      })
    );

    const res = await client.searchEntities('acme', 'organizations', { limit: 10 });
    const hit = res._unsafeUnwrap().hits[0]!;

    expect(hit.attrs['cui']).toBe('42');
    expect(hit.docType).toBe('organizations'); // no doc_type on the doc → index uid
    expect(hit.title).toBe('ACME'); // name fallback
    expect(hit.snippet).toBe('a body'); // body fallback when no subtitle
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
