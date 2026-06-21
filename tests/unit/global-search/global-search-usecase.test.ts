/**
 * Kernel — `makeGlobalSearch` usecase (foundation §4.5, §15.7).
 *
 * Locks the hybrid Meili-primary / pg-fallback contract:
 *  - empty/whitespace q and all-invalid docTypes short-circuit to empty WITHOUT
 *    touching either engine;
 *  - Meili `ok` → engine 'meili', facets flattened, orgs from identityRepo;
 *  - Meili `err` OR no index configured → degrade to searchRepo (engine 'postgres');
 *  - a searchRepo `err` on the degrade path surfaces as `err` (not a silent empty);
 *  - limit/offset clamping is asserted via the values handed to the spies.
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { upstreamError, databaseError, type ApiError } from '@/modules/shared/core/errors.js';
import { SEARCH_ENTITY_DOC_TYPES, type OrgNameMatch, type SearchHit } from '@/modules/shared/core/types.js';
import {
  makeGlobalSearch,
  type GlobalSearchDeps,
} from '@/modules/shared/core/usecases/global-search.js';

import type {
  EntitiesSearchResult,
  IdentityRepo,
  MeiliClient,
  SearchRepo,
} from '@/modules/shared/core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────────────

const makeHit = (over: Partial<SearchHit> = {}): SearchHit => ({
  id: 'company:123',
  docType: 'company',
  title: 'ACME SRL',
  snippet: null,
  score: 0.9,
  source: 'meili',
  attrs: {},
  ...over,
});

const makeOrg = (over: Partial<OrgNameMatch> = {}): OrgNameMatch => ({
  orgId: '1',
  cui: '123',
  name: 'ACME SRL',
  normalizedName: 'acme srl',
  countyName: 'Cluj',
  kind: 'company',
  score: 0.8,
  ...over,
});

const meiliResult = (over: Partial<EntitiesSearchResult> = {}): EntitiesSearchResult => ({
  hits: [makeHit()],
  facetDistribution: {},
  estimatedTotalHits: 1,
  ...over,
});

interface Spies {
  meiliSearch: ReturnType<typeof vi.fn>;
  repoSearch: ReturnType<typeof vi.fn>;
  byName: ReturnType<typeof vi.fn>;
}

const makeDeps = (opts: {
  meili?: Result<EntitiesSearchResult, ApiError>;
  repo?: Result<readonly SearchHit[], ApiError>;
  orgs?: Result<readonly OrgNameMatch[], ApiError>;
  meiliIndexes?: readonly string[];
}): { deps: GlobalSearchDeps; spies: Spies } => {
  const meiliSearch = vi.fn(async () => opts.meili ?? ok(meiliResult()));
  const repoSearch = vi.fn(async () => opts.repo ?? ok([makeHit({ source: 'postgres' })]));
  const byName = vi.fn(async () => opts.orgs ?? ok([makeOrg()]));

  const meiliClient = { searchEntities: meiliSearch } as unknown as MeiliClient;
  const searchRepo = { searchEntities: repoSearch } as unknown as SearchRepo;
  const identityRepo = { searchByName: byName } as unknown as IdentityRepo;

  const deps: GlobalSearchDeps = {
    meiliClient,
    searchRepo,
    identityRepo,
    meiliIndexes: opts.meiliIndexes ?? ['entities'],
  };
  return { deps, spies: { meiliSearch, repoSearch, byName } };
};

// ─────────────────────────────────────────────────────────────────────────────
// Short-circuit guards (no engine query)
// ─────────────────────────────────────────────────────────────────────────────

describe('makeGlobalSearch — short-circuit guards', () => {
  it('returns an empty meili result for an empty q WITHOUT calling any engine', async () => {
    const { deps, spies } = makeDeps({});
    const res = await makeGlobalSearch(deps, { q: '' });

    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toEqual({
      query: '',
      hits: [],
      organizations: [],
      engine: 'meili',
      facets: [],
      estimatedTotalHits: 0,
    });
    expect(spies.meiliSearch).not.toHaveBeenCalled();
    expect(spies.repoSearch).not.toHaveBeenCalled();
    expect(spies.byName).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only q as empty (no engine query)', async () => {
    const { deps, spies } = makeDeps({});
    const res = await makeGlobalSearch(deps, { q: '   \t ' });

    expect(res._unsafeUnwrap().hits).toEqual([]);
    expect(res._unsafeUnwrap().engine).toBe('meili');
    expect(spies.meiliSearch).not.toHaveBeenCalled();
    expect(spies.repoSearch).not.toHaveBeenCalled();
  });

  it('short-circuits when docTypes is provided but ALL are invalid (no engine query)', async () => {
    const { deps, spies } = makeDeps({});
    const res = await makeGlobalSearch(deps, { q: 'acme', docTypes: ['nope', 'bad'] });

    expect(res._unsafeUnwrap()).toEqual({
      query: 'acme',
      hits: [],
      organizations: [],
      engine: 'meili',
      facets: [],
      estimatedTotalHits: 0,
    });
    expect(spies.meiliSearch).not.toHaveBeenCalled();
    expect(spies.repoSearch).not.toHaveBeenCalled();
    expect(spies.byName).not.toHaveBeenCalled();
  });

  it('does NOT short-circuit when docTypes is omitted (queries the engine)', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, { q: 'acme' });
    expect(spies.meiliSearch).toHaveBeenCalledTimes(1);
  });

  it('queries the engine when at least one requested docType is valid', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, { q: 'acme', docTypes: ['company', 'nope'] });
    expect(spies.meiliSearch).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Meili-primary path
// ─────────────────────────────────────────────────────────────────────────────

describe('makeGlobalSearch — Meili ok path', () => {
  it('returns engine "meili" with hits, flattened facets, and orgs from identityRepo', async () => {
    const hits = [makeHit({ id: 'company:1' }), makeHit({ id: 'bill:2', docType: 'bill' })];
    const { deps, spies } = makeDeps({
      meili: ok(
        meiliResult({
          hits,
          facetDistribution: { doc_type: { company: 5, bill: 2 } },
          estimatedTotalHits: 7,
        })
      ),
      orgs: ok([makeOrg({ orgId: '99' })]),
    });

    const res = await makeGlobalSearch(deps, { q: 'acme' });
    const value = res._unsafeUnwrap();

    expect(value.engine).toBe('meili');
    expect(value.hits).toEqual(hits);
    expect(value.estimatedTotalHits).toBe(7);
    expect(value.facets).toEqual([
      { field: 'doc_type', value: 'company', count: 5 },
      { field: 'doc_type', value: 'bill', count: 2 },
    ]);
    expect(value.organizations).toEqual([makeOrg({ orgId: '99' })]);
    expect(spies.repoSearch).not.toHaveBeenCalled();
  });

  it('passes q + filter + facets + clamped limit to the meili client', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, { q: 'acme', docTypes: ['company'], county: 'Cluj', year: 2024 });

    expect(spies.meiliSearch).toHaveBeenCalledWith('acme', 'entities', {
      filter: [
        'visibility = "public"',
        'doc_type IN ["company"]',
        'county_name = "Cluj"',
        'year = 2024',
      ],
      facets: ['doc_type'],
      limit: 20,
    });
  });

  it('keeps an empty `organizations` array when the org name match errors', async () => {
    const { deps } = makeDeps({ orgs: err(databaseError('orgs down')) });
    const res = await makeGlobalSearch(deps, { q: 'acme' });
    expect(res._unsafeUnwrap().organizations).toEqual([]);
    expect(res._unsafeUnwrap().engine).toBe('meili');
  });

  it('uses the first configured meili index as the search index', async () => {
    const { deps, spies } = makeDeps({ meiliIndexes: ['custom_entities', 'other'] });
    await makeGlobalSearch(deps, { q: 'acme' });
    expect(spies.meiliSearch).toHaveBeenCalledWith('acme', 'custom_entities', expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Degrade-to-postgres path
// ─────────────────────────────────────────────────────────────────────────────

describe('makeGlobalSearch — degrade to postgres', () => {
  it('degrades to searchRepo (engine "postgres", no facets) when Meili errors', async () => {
    const pgHits = [makeHit({ source: 'postgres', id: 'company:7' })];
    const { deps, spies } = makeDeps({
      meili: err(upstreamError('meili down', 'meilisearch')),
      repo: ok(pgHits),
    });

    const res = await makeGlobalSearch(deps, { q: 'acme' });
    const value = res._unsafeUnwrap();

    expect(value.engine).toBe('postgres');
    expect(value.hits).toEqual(pgHits);
    expect(value.facets).toEqual([]);
    expect(value.estimatedTotalHits).toBe(pgHits.length);
    expect(spies.repoSearch).toHaveBeenCalledTimes(1);
  });

  it('goes straight to postgres (never calls meili) when no index is configured', async () => {
    const { deps, spies } = makeDeps({ meiliIndexes: [], repo: ok([makeHit({ source: 'postgres' })]) });

    const res = await makeGlobalSearch(deps, { q: 'acme' });

    expect(res._unsafeUnwrap().engine).toBe('postgres');
    expect(spies.meiliSearch).not.toHaveBeenCalled();
    expect(spies.repoSearch).toHaveBeenCalledTimes(1);
  });

  it('forwards the SAME validated filter args to searchRepo on the degrade path', async () => {
    const { deps, spies } = makeDeps({
      meiliIndexes: [],
      repo: ok([]),
    });
    await makeGlobalSearch(deps, {
      q: 'acme',
      docTypes: ['company', 'nope'],
      county: 'Cluj',
      year: 2024,
    });

    expect(spies.repoSearch).toHaveBeenCalledWith('acme', {
      docTypes: ['company'],
      county: 'Cluj',
      year: 2024,
      limit: 20,
    });
  });

  it('returns `err` (NOT an empty ok) when searchRepo errors on the degrade path', async () => {
    const { deps } = makeDeps({
      meili: err(upstreamError('meili down', 'meilisearch')),
      repo: err(databaseError('search.documents exploded')),
    });

    const res = await makeGlobalSearch(deps, { q: 'acme' });

    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().type).toBe('Database');
  });

  it('still returns orgs from identityRepo on the degrade path', async () => {
    const { deps } = makeDeps({
      meili: err(upstreamError('meili down', 'meilisearch')),
      repo: ok([]),
      orgs: ok([makeOrg({ orgId: '42' })]),
    });
    const res = await makeGlobalSearch(deps, { q: 'acme' });
    expect(res._unsafeUnwrap().organizations).toEqual([makeOrg({ orgId: '42' })]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Limit / offset clamping (asserted through the spies)
// ─────────────────────────────────────────────────────────────────────────────

describe('makeGlobalSearch — limit/offset clamping', () => {
  it('defaults limit to 20 and omits offset when none is given', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, { q: 'acme' });
    const opts = spies.meiliSearch.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts['limit']).toBe(20);
    expect(opts).not.toHaveProperty('offset');
  });

  it('clamps an over-large limit down to 50', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, { q: 'acme', limit: 9999 });
    expect((spies.meiliSearch.mock.calls[0]?.[2] as Record<string, unknown>)['limit']).toBe(50);
  });

  it('clamps a zero/negative limit up to 1', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, { q: 'acme', limit: 0 });
    expect((spies.meiliSearch.mock.calls[0]?.[2] as Record<string, unknown>)['limit']).toBe(1);

    spies.meiliSearch.mockClear();
    await makeGlobalSearch(deps, { q: 'acme', limit: -5 });
    expect((spies.meiliSearch.mock.calls[0]?.[2] as Record<string, unknown>)['limit']).toBe(1);
  });

  it('forwards a positive offset and clamps it to 1000', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, { q: 'acme', offset: 25 });
    expect((spies.meiliSearch.mock.calls[0]?.[2] as Record<string, unknown>)['offset']).toBe(25);

    spies.meiliSearch.mockClear();
    await makeGlobalSearch(deps, { q: 'acme', offset: 99999 });
    expect((spies.meiliSearch.mock.calls[0]?.[2] as Record<string, unknown>)['offset']).toBe(1000);
  });

  it('omits offset when it is 0 or negative (forwarded only when > 0)', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, { q: 'acme', offset: 0 });
    expect(spies.meiliSearch.mock.calls[0]?.[2] as Record<string, unknown>).not.toHaveProperty(
      'offset'
    );

    spies.meiliSearch.mockClear();
    await makeGlobalSearch(deps, { q: 'acme', offset: -10 });
    expect(spies.meiliSearch.mock.calls[0]?.[2] as Record<string, unknown>).not.toHaveProperty(
      'offset'
    );
  });

  it('clamps the same limit/offset on the pg degrade path', async () => {
    const { deps, spies } = makeDeps({ meiliIndexes: [], repo: ok([]) });
    await makeGlobalSearch(deps, { q: 'acme', limit: 9999, offset: 99999 });
    expect(spies.repoSearch).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ limit: 50, offset: 1000 })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist pin when docTypes omitted (Codex final P1a — Meili/pg parity)
// ─────────────────────────────────────────────────────────────────────────────

describe('makeGlobalSearch — allowlist pin when docTypes omitted', () => {
  it('pins the FULL entity allowlist on the Meili filter (not just visibility)', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, { q: 'acme' });

    const filter = (spies.meiliSearch.mock.calls[0]?.[2] as { filter: readonly string[] }).filter;
    expect(filter).toContain('visibility = "public"');
    const expectedIn = `doc_type IN [${SEARCH_ENTITY_DOC_TYPES.map((t) => `"${t}"`).join(', ')}]`;
    expect(filter).toContain(expectedIn);
  });

  it('forwards the full allowlist to the pg fallback too (engines stay symmetric)', async () => {
    const { deps, spies } = makeDeps({ meiliIndexes: [], repo: ok([]) });
    await makeGlobalSearch(deps, { q: 'acme' });
    expect(spies.repoSearch).toHaveBeenCalledWith(
      'acme',
      expect.objectContaining({ docTypes: [...SEARCH_ENTITY_DOC_TYPES] })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Logger contract (one non-throwing line per search)
// ─────────────────────────────────────────────────────────────────────────────

describe('makeGlobalSearch — logger', () => {
  it('emits one structured log line and never throws when the logger throws', async () => {
    const info = vi.fn((_obj: unknown, _msg?: string) => {
      throw new Error('logger blew up');
    });
    const { deps } = makeDeps({});
    const withLogger: GlobalSearchDeps = { ...deps, logger: { info } };

    const res = await makeGlobalSearch(withLogger, { q: 'acme' });

    expect(res.isOk()).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    const payload = info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['engine']).toBe('meili');
    expect(payload['component']).toBe('kernel.globalSearch');
  });
});
