/**
 * Kernel — `makeGlobalSearch` usecase (foundation §4.5, §15.7).
 *
 * Locks the hybrid Meili-primary / reduced-outage contract:
 *  - empty/whitespace q and all-invalid docTypes short-circuit to empty WITHOUT
 *    touching either engine;
 *  - Meili `ok` → engine 'meili', facets flattened, deprecated org array empty;
 *  - Meili `err` OR no index configured → the OUTAGE path (D5): an all-digit
 *    query resolves one identity over the indexed spine, anything else returns
 *    no hits, and both are marked `degraded: true`;
 *  - a spine `err` surfaces as `err` (not a silent empty);
 *  - limit/offset clamping is asserted via the values handed to the spies.
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { upstreamError, type ApiError } from '@/modules/shared/core/errors.js';
import { SEARCH_ENTITY_DOC_TYPES, type SearchHit } from '@/modules/shared/core/types.js';
import {
  makeGlobalSearch,
  type GlobalSearchDeps,
} from '@/modules/shared/core/usecases/global-search.js';

import type { EntitiesSearchResult, MeiliClient } from '@/modules/shared/core/ports.js';

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

const meiliResult = (over: Partial<EntitiesSearchResult> = {}): EntitiesSearchResult => ({
  hits: [makeHit()],
  facetDistribution: {},
  estimatedTotalHits: 1,
  ...over,
});

interface Spies {
  meiliSearch: ReturnType<typeof vi.fn>;
}

const makeDeps = (opts: {
  meili?: Result<EntitiesSearchResult, ApiError>;
  meiliIndexes?: readonly string[];
}): { deps: GlobalSearchDeps; spies: Spies } => {
  const meiliSearch = vi.fn(async () => opts.meili ?? ok(meiliResult()));

  const meiliClient = { searchEntities: meiliSearch } as unknown as MeiliClient;

  const deps: GlobalSearchDeps = {
    meiliClient,
    meiliIndexes: opts.meiliIndexes ?? ['entities'],
  };
  return { deps, spies: { meiliSearch } };
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
      degraded: false,
      facets: [],
      estimatedTotalHits: 0,
    });
    expect(spies.meiliSearch).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only q as empty (no engine query)', async () => {
    const { deps, spies } = makeDeps({});
    const res = await makeGlobalSearch(deps, { q: '   \t ' });

    expect(res._unsafeUnwrap().hits).toEqual([]);
    expect(res._unsafeUnwrap().engine).toBe('meili');
    expect(spies.meiliSearch).not.toHaveBeenCalled();
  });

  it('short-circuits when docTypes is provided but ALL are invalid (no engine query)', async () => {
    const { deps, spies } = makeDeps({});
    const res = await makeGlobalSearch(deps, { q: 'acme', docTypes: ['nope', 'bad'] });

    expect(res._unsafeUnwrap()).toEqual({
      query: 'acme',
      hits: [],
      organizations: [],
      engine: 'meili',
      degraded: false,
      facets: [],
      estimatedTotalHits: 0,
    });
    expect(spies.meiliSearch).not.toHaveBeenCalled();
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

  it('rejects a malformed requested county instead of widening nationwide', async () => {
    const { deps, spies } = makeDeps({});
    const res = await makeGlobalSearch(deps, { q: 'acme', county: 'Cluj"] OR true' });

    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr()).toEqual({
      type: 'InvalidInput',
      message: 'county must be a canonical county name',
      field: 'county',
    });
    expect(spies.meiliSearch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Meili-primary path
// ─────────────────────────────────────────────────────────────────────────────

describe('makeGlobalSearch — Meili ok path', () => {
  it('returns engine "meili" with hits, flattened facets, and no legacy org scan', async () => {
    const hits = [makeHit({ id: 'company:1' }), makeHit({ id: 'bill:2', docType: 'bill' })];
    const { deps } = makeDeps({
      meili: ok(
        meiliResult({
          hits,
          facetDistribution: { doc_type: { company: 5, bill: 2 } },
          estimatedTotalHits: 7,
        })
      ),
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
    expect(value.organizations).toEqual([]);
  });

  it('passes q + filter + facets + clamped limit to the meili client', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, {
      q: 'acme',
      docTypes: ['company'],
      county: 'Cluj',
      isActive: true,
    });

    expect(spies.meiliSearch).toHaveBeenCalledWith('acme', 'entities', {
      filter: [
        'privacy_class = "public"',
        'doc_type IN ["company"]',
        'county_name = "Cluj"',
        'is_active = true',
      ],
      facets: ['doc_type'],
      limit: 20,
    });
  });

  it('keeps the deprecated `organizations` array empty', async () => {
    const { deps } = makeDeps({});
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

describe('makeGlobalSearch — the honest degrade (D5)', () => {
  const meiliDown = err(upstreamError('meili down', 'meilisearch'));

  it('marks a TEXT query degraded with no hits', async () => {
    const { deps } = makeDeps({ meili: meiliDown });

    const value = (await makeGlobalSearch(deps, { q: 'acme' }))._unsafeUnwrap();

    // The distinction the old shape could not express: "we could not look" is
    // not "no matches". Empty hits are only honest alongside degraded=true.
    expect(value.degraded).toBe(true);
    expect(value.engine).toBe('postgres');
    expect(value.hits).toEqual([]);
    expect(value.facets).toEqual([]);
    expect(value.organizations).toEqual([]);
    expect(value.estimatedTotalHits).toBe(0);
  });

  it('returns no hits for an ALL-DIGIT query either', async () => {
    // An exact-CUI lookup was implemented here twice and removed twice: this
    // surface must return what the INDEX would return, and the spine cannot
    // reproduce the palette's role-collapsed doc_type. Attempt 1 emitted the
    // spine `kind` (wrong for every dual-role identity); attempt 2 emitted
    // `organization`, which the palette reserves for public institutions and the
    // client renders as "Instituție" — labelling a private company an
    // institution. Serving nothing beats serving a confident wrong label.
    const { deps } = makeDeps({ meili: meiliDown });

    const value = (await makeGlobalSearch(deps, { q: '2816464' }))._unsafeUnwrap();

    expect(value.degraded).toBe(true);
    expect(value.hits).toEqual([]);
  });

  it('degrades the same way when no index is configured (never calls meili)', async () => {
    const { deps, spies } = makeDeps({ meiliIndexes: [] });

    const value = (await makeGlobalSearch(deps, { q: '2816464' }))._unsafeUnwrap();

    expect(value.degraded).toBe(true);
    expect(value.hits).toEqual([]);
    expect(spies.meiliSearch).not.toHaveBeenCalled();
  });

  it('never reads search.documents — the ILIKE scan cannot come back', async () => {
    // The degrade path has NO repo dependency at all now; `GlobalSearchDeps`
    // carries only the Meili client and the index list. A future fallback would
    // have to add a dep back, which this assertion makes visible.
    const { deps } = makeDeps({ meili: meiliDown });
    expect(Object.keys(deps).sort()).toEqual(['meiliClient', 'meiliIndexes']);
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

  it('does not paginate the degrade path — a clamped offset still yields nothing', async () => {
    // The old degrade path forwarded limit/offset to a pg query. There is no
    // query to forward to any more, so an offset can only mean "past the end".
    const { deps } = makeDeps({ meiliIndexes: [] });
    const value = (
      await makeGlobalSearch(deps, { q: '2816464', limit: 9999, offset: 99999 })
    )._unsafeUnwrap();

    expect(value.hits).toEqual([]);
    expect(value.degraded).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist pin when docTypes omitted (Codex final P1a — Meili/pg parity)
// ─────────────────────────────────────────────────────────────────────────────

describe('makeGlobalSearch — allowlist pin when docTypes omitted', () => {
  it('pins the FULL entity allowlist on the Meili filter (not just the privacy gate)', async () => {
    const { deps, spies } = makeDeps({});
    await makeGlobalSearch(deps, { q: 'acme' });

    const filter = (spies.meiliSearch.mock.calls[0]?.[2] as { filter: readonly string[] }).filter;
    expect(filter).toContain('privacy_class = "public"');
    const expectedIn = `doc_type IN [${SEARCH_ENTITY_DOC_TYPES.map((t) => `"${t}"`).join(', ')}]`;
    expect(filter).toContain(expectedIn);
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
    expect(payload['queryLength']).toBe(4);
    expect(payload).not.toHaveProperty('q');
  });
});
