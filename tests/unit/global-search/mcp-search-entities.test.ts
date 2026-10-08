/**
 * Kernel MCP — the `search_entities` tool (foundation §6.3, §7.4).
 *
 * Drives the tool handler from `makeKernelMcpTools` with a stubbed global-search
 * usecase (via fake kernel deps). The privacy-critical assertion: each item
 * exposes ONLY the nested whitelisted `attrs` sub-object — never the raw
 * `SearchHit.attrs` (which carries `visibility`). Also pins the structured
 * envelope (`ok/kind/query/items/meta/summary`) and that the kernel still ships
 * `resolve_entity` + `get_entity_snapshot` unchanged.
 */

import { ok, err } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { serviceUnavailable, upstreamError } from '@/modules/shared/core/errors.js';
import { makeKernelMcpTools, type KernelMcpDeps } from '@/modules/shared/shell/mcp/tools.js';

import {
  ACME_NOW,
  CONTROL_A,
  SCOPE_A,
  SCOPE_B,
  recordingCompanies,
  staleCompanyHit,
} from './search-fixtures.js';

import type { SearchHit } from '@/modules/shared/core/types.js';
import type { GlobalSearchDeps } from '@/modules/shared/core/usecases/global-search.js';
import type { KernelMcpTool } from '@/modules/shared/shell/mcp/types.js';

/** An institution identity (CUI 42, no company parent): its own display fields stay. */
const makeHit = (over: Partial<SearchHit> = {}): SearchHit => ({
  id: 'organization:42',
  docType: 'organization',
  title: 'PRIMARIA ACME',
  snippet: null,
  score: 0.9,
  source: 'meili',
  // Raw hit attrs — carries `visibility` plus the nested whitelisted `attrs`.
  attrs: { visibility: 'public', attrs: { kind: 'primarie', status: 'active' } },
  docId: 'organization:42',
  docKey: '42',
  subtitle: 'CUI 42 · Cluj',
  countyName: 'Bihor',
  cuis: ['42'],
  ...over,
});

/**
 * Build the kernel MCP tools with `makeGlobalSearch` stubbed by injecting fake
 * globalSearchDeps. The handler calls `makeGlobalSearch(deps.globalSearchDeps, …)`
 * which forwards to `meiliClient.searchEntities` — so a fake meili client lets us
 * control the hits without a real engine. The control witnesses generation A
 * and the company port answers scope A (or what `companies` says).
 */
const buildTools = (
  meiliResult:
    | {
        hits: readonly SearchHit[];
        facetDistribution?: Record<string, Record<string, number>>;
        estimatedTotalHits?: number;
      }
    | 'err',
  companies: Parameters<typeof recordingCompanies>[0] = {}
): readonly KernelMcpTool[] => {
  const searchEntities = vi.fn(async () =>
    meiliResult === 'err'
      ? err(upstreamError('meili down', 'meilisearch'))
      : ok({
          hits: meiliResult.hits,
          facetDistribution: meiliResult.facetDistribution ?? {},
          estimatedTotalHits: meiliResult.estimatedTotalHits ?? meiliResult.hits.length,
        })
  );
  const searchByName = vi.fn(async () => ok([]));

  const globalSearchDeps: GlobalSearchDeps = {
    meiliClient: { searchEntities, readGenerationControl: async () => ok(CONTROL_A) } as never,
    meiliIndexes: ['entities'],
    companySearch: recordingCompanies(companies).port,
  };

  const deps: KernelMcpDeps = {
    identityRepo: { searchByName } as never,
    entity360Deps: {} as never,
    globalSearchDeps,
    clientBaseUrl: 'https://transparenta.eu',
  };
  return makeKernelMcpTools(deps);
};

const getSearchTool = (tools: readonly KernelMcpTool[]): KernelMcpTool => {
  const tool = tools.find((t) => t.name === 'search_entities');
  expect(tool).toBeDefined();
  return tool!;
};

/**
 * The search tool over an engine that answers each candidate offset from
 * `pages` (an absent offset is an empty page), with a witnessed generation A
 * and a recording company port.
 */
const pagedTool = (
  pages: Readonly<Record<number, readonly SearchHit[]>>,
  estimatedTotalHits: number,
  companies: Parameters<typeof recordingCompanies>[0] = {}
) => {
  const searchEntities = vi.fn(async (_q: string, _index: string, opts: { offset?: number }) =>
    ok({ hits: pages[opts.offset ?? 0] ?? [], facetDistribution: {}, estimatedTotalHits })
  );
  const recorder = recordingCompanies(companies);
  const tool = getSearchTool(
    makeKernelMcpTools({
      identityRepo: {} as never,
      entity360Deps: {} as never,
      globalSearchDeps: {
        meiliClient: {
          searchEntities,
          readGenerationControl: async () => ok(CONTROL_A),
        } as never,
        meiliIndexes: ['entities'],
        companySearch: recorder.port,
      },
      clientBaseUrl: 'https://transparenta.eu',
    })
  );
  return { tool, searchEntities, companies: recorder };
};

const nextOffsetOf = (res: { meta?: unknown }): number | null =>
  (res.meta as { continuation: { nextOffset: number | null } }).continuation.nextOffset;

/**
 * The page-specific summary of an empty later page without a next offset
 * (literal). It never claims the candidates exhausted: a null continuation is
 * also the API's offset bound.
 */
const NO_FURTHER_LATER_PAGE = (query: string): string =>
  `No entities are shown for "${query}" on this later page, and this tool offers no further page for this request. Earlier pages may have shown matches; this is not a claim that the query matched nothing.`;

describe('kernel MCP — tool registration', () => {
  it('ships resolve_entity, get_entity_snapshot and search_entities', () => {
    const tools = buildTools({ hits: [] });
    expect(tools.map((t) => t.name)).toEqual([
      'resolve_entity',
      'get_entity_snapshot',
      'search_entities',
    ]);
  });
});

describe('search_entities — structured envelope', () => {
  it('returns ok/kind/query/items/meta/summary', async () => {
    const tools = buildTools({
      hits: [makeHit()],
      facetDistribution: { doc_type: { organization: 1 } },
      estimatedTotalHits: 1,
    });
    const res = await getSearchTool(tools).handler({ query: 'acme' });

    expect(res.ok).toBe(true);
    expect(res.kind).toBe('entity_search');
    expect(res.query).toBe('acme');
    expect(res.items).toHaveLength(1);
    expect(res.meta).toEqual({
      engine: 'meili',
      // An MCP caller relays this envelope as fact, so it must be able to tell
      // "nothing matched" from "we could not look" (D5).
      degraded: false,
      estimatedTotalHits: 1,
      returned: 1,
      facets: [{ field: 'doc_type', value: 'organization', count: 1 }],
      generation: {
        generationId: 'entities_build_1759600000000_ab12cd',
        registryScopeKey: 'onrc:published:42:3:17',
      },
      companyScope: 'onrc:published:42:3:17',
      companyContribution: 'current',
      companyContributionReason: null,
      continuation: { candidatesReturned: 1, nextOffset: null },
    });
    expect(res.summary).toContain('acme');
  });

  it('serves the witnessed Meili company contribution without database reads', async () => {
    const tools = buildTools(
      { hits: [staleCompanyHit()] },
      { parents: { '123': { kind: 'company', values: ACME_NOW } } }
    );
    const res = await getSearchTool(tools).handler({ query: 'acme' });
    expect(res.items).toEqual([
      {
        docType: 'company',
        docKey: '123',
        docId: 'company:123',
        title: 'ACME OLD SRL',
        subtitle: 'SRL, Bihor',
        countyName: 'Bihor',
        url: '/companii/123',
        cuis: ['123'],
        isUat: null,
        entityTags: [],
        company: {
          registryState: 'in_edition',
          name: 'ACME OLD SRL',
          nameSource: 'onrc_edition',
          legalForm: 'SRL',
          countyCode: 'BH',
          countyName: 'Bihor',
          active: false,
          identifiers: ['J05/1/1999'],
        },
      },
    ]);
    expect(JSON.stringify(res)).not.toContain('radiat');
  });

  it('applies the same final check eagerly: a refused answer is never serialized', async () => {
    const tools = buildTools(
      { hits: [makeHit()] },
      {
        confirm: () =>
          err(
            serviceUnavailable('the access of the served identities could not be rechecked; retry')
          ),
      }
    );
    const res = await getSearchTool(tools).handler({ query: 'acme' });
    expect(res).toEqual({
      ok: false,
      kind: 'entity_search',
      error: 'the access of the served identities could not be rechecked; retry',
    });
  });

  it('never states "No entities matched" when the company part is not current', async () => {
    const tools = buildTools({ hits: [] }, { scopes: [{ scopeKey: SCOPE_B, published: true }] });
    const res = await getSearchTool(tools).handler({ query: 'acme' });
    expect(res.items).toEqual([]);
    expect(res.meta).toMatchObject({
      companyScope: SCOPE_B,
      companyContribution: 'unavailable',
      companyContributionReason: 'generation_scope_stale',
    });
    expect(res.summary).not.toContain('No entities matched');
    expect(res.summary).toContain('UNAVAILABLE (generation_scope_stale)');
    expect(res.summary).toContain('NOT evidence that no such company exists');
  });

  it('a page whose candidates were all withheld points at the next candidate page', async () => {
    const tools = buildTools(
      { hits: [makeHit()], estimatedTotalHits: 30 },
      { parents: { '42': { kind: 'private' } } }
    );
    const res = await getSearchTool(tools).handler({ query: 'acme', limit: 1 });
    expect(res.items).toEqual([]);
    expect(res.meta).toMatchObject({
      companyScope: SCOPE_A,
      continuation: { candidatesReturned: 1, nextOffset: 1 },
    });
    expect(res.summary).toBe(
      'No entities are shown for "acme" on this page. More candidates may follow: call again with offset 1.'
    );
  });

  it('the advertised continuation is consumable through an admitted page to an empty later page', async () => {
    // Page 1: one private candidate (withheld). Page 2: a public institution.
    // Page 3: no candidate (a short page: no further page is offered).
    const { tool, searchEntities, companies } = pagedTool(
      {
        0: [makeHit()],
        1: [
          makeHit({
            id: 'organization:43',
            docId: 'organization:43',
            docKey: '43',
            title: 'PRIMARIA BETA',
            cuis: ['43'],
          }),
        ],
      },
      2,
      { parents: { '42': { kind: 'private' } } }
    );
    // The input shape advertises the bounded offset.
    expect(Object.keys(tool.inputShape)).toContain('offset');

    const first = await tool.handler({ query: 'acme', limit: 1 });
    expect(first.items).toEqual([]);
    expect(first.summary).toBe(
      'No entities are shown for "acme" on this page. More candidates may follow: call again with offset 1.'
    );
    const next = nextOffsetOf(first);
    expect(next).toBe(1);

    const second = await tool.handler({ query: 'acme', limit: 1, offset: next });
    expect(second.items).toMatchObject([{ docKey: '43', title: 'PRIMARIA BETA' }]);
    expect(second.summary).toBe(
      '1 of ~2 matches for "acme" (engine: meili). More candidates may follow: call again with offset 2.'
    );

    const third = await tool.handler({ query: 'acme', limit: 1, offset: nextOffsetOf(second) });
    expect(searchEntities.mock.calls.map((call) => call[2].offset)).toEqual([undefined, 1, 2]);
    expect(third.items).toEqual([]);
    expect(third.meta).toMatchObject({
      companyContribution: 'current',
      continuation: { candidatesReturned: 0, nextOffset: null },
    });
    // The empty later page describes itself: it never negates page 2's match.
    expect(third.summary).toBe(NO_FURTHER_LATER_PAGE('acme'));
    expect(third.summary).not.toContain('No entities matched');
    // Every page ran its final check.
    expect(companies.confirmations).toEqual([]);
    expect(companies.accessReads).toBeGreaterThan(1);
  });

  it('summarizes a no-match search', async () => {
    const tools = buildTools({ hits: [] });
    const res = await getSearchTool(tools).handler({ query: 'zzz' });
    expect(res.ok).toBe(true);
    expect(res.items).toEqual([]);
    expect(res.summary).toBe('No entities matched "zzz".');
  });

  it('reports a usecase error as { ok:false }', async () => {
    // A malformed county is the remaining error the usecase raises: the degrade
    // path itself no longer errors, it returns `degraded: true` with no hits.
    const tools = buildTools({ hits: [] });
    const res = await getSearchTool(tools).handler({
      query: 'acme',
      county: 'Cluj"] OR true',
    });

    expect(res.ok).toBe(false);
    expect(res.kind).toBe('entity_search');
    expect(res.error).toBeDefined();
  });

  it('tells a DEGRADED caller that empty is not "no matches"', async () => {
    // An LLM relays this sentence to a user as fact. During an outage
    // "No entities matched" is simply false.
    const tools = buildTools('err');
    const res = await getSearchTool(tools).handler({ query: 'acme' });

    expect(res.ok).toBe(true);
    expect(res.items).toEqual([]);
    expect((res.meta as { degraded: boolean }).degraded).toBe(true);
    expect(res.summary).toContain('DEGRADED');
    expect(res.summary).not.toContain('No entities matched');
    // The outage path runs no lookup at all; the text must not promise the
    // exact-CUI fallback that was removed on 2026-08-26.
    expect(res.summary).toContain('was not looked up at all');
    expect(res.summary).not.toMatch(/only an exact|resolved as an exact/u);
  });
});

describe('search_entities — an empty page states only what that page shows', () => {
  it('the reviewed reproduction: an admitted page, then an empty page at its offset', async () => {
    // A public institution at offset 0; nothing at offset 1; one estimated hit throughout.
    const { tool, searchEntities, companies } = pagedTool({ 0: [makeHit()] }, 1);
    const first = await tool.handler({ query: 'acme', limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.summary).toBe(
      '1 of ~1 matches for "acme" (engine: meili). More candidates may follow: call again with offset 1.'
    );
    const second = await tool.handler({ query: 'acme', limit: 1, offset: nextOffsetOf(first) });
    expect(searchEntities.mock.calls.map((call) => call[2].offset)).toEqual([undefined, 1]);
    expect(second.items).toEqual([]);
    expect(second.meta).toMatchObject({
      companyContribution: 'current',
      continuation: { candidatesReturned: 0, nextOffset: null },
    });
    expect(second.summary).toBe(NO_FURTHER_LATER_PAGE('acme'));
    expect(second.summary).not.toContain('No entities matched');
    expect(companies.confirmations).toEqual([]);
    expect(companies.accessReads).toBeGreaterThan(1);
  });

  it('a full but withheld page at the offset bound never claims the candidates exhausted', async () => {
    // Offset 1000 (the API bound), limit 50: the engine returns a FULL page of 50
    // candidates out of ~2000, all currently private, so nothing is visible. The
    // continuation is null only because offset 1050 exceeds the bound.
    const keys = Array.from({ length: 50 }, (_, i) => String(5000 + i));
    const candidates = keys.map((key) =>
      makeHit({ id: `organization:${key}`, docId: `organization:${key}`, docKey: key, cuis: [key] })
    );
    const { tool, searchEntities, companies } = pagedTool({ 1000: candidates }, 2000, {
      parents: Object.fromEntries(keys.map((key) => [key, { kind: 'private' as const }])),
    });
    const res = await tool.handler({ query: 'acme', limit: 50, offset: 1000 });
    expect(searchEntities.mock.calls.map((call) => call[2].offset)).toEqual([1000]);
    expect(res.ok).toBe(true);
    expect(res.items).toEqual([]);
    expect(res.meta).toMatchObject({
      estimatedTotalHits: 2000,
      returned: 0,
      companyScope: SCOPE_A,
      companyContribution: 'current',
      companyContributionReason: null,
      continuation: { candidatesReturned: 50, nextOffset: null },
    });
    // The final check ran and passed (nothing served).
    expect(companies.confirmations).toEqual([]);
    expect(companies.accessReads).toBeGreaterThan(1);
    expect(res.summary).toBe(NO_FURTHER_LATER_PAGE('acme'));
    expect(res.summary).not.toMatch(/exhausted|No entities matched/u);
  });

  it('the initial page keeps the genuine no-match claim (offset omitted or 0)', async () => {
    for (const args of [{ query: 'zzz' }, { query: 'zzz', offset: 0 }]) {
      const { tool } = pagedTool({}, 0);
      const res = await tool.handler(args);
      expect(res.items).toEqual([]);
      expect(res.meta).toMatchObject({
        companyContribution: 'current',
        continuation: { candidatesReturned: 0, nextOffset: null },
      });
      expect(res.summary).toBe('No entities matched "zzz".');
    }
  });

  it('a withheld later page still points at the next candidate page', async () => {
    const { tool } = pagedTool({ 1: [makeHit()] }, 30, {
      parents: { '42': { kind: 'private' } },
    });
    const res = await tool.handler({ query: 'acme', limit: 1, offset: 1 });
    expect(res.items).toEqual([]);
    expect(res.summary).toBe(
      'No entities are shown for "acme" on this later page. More candidates may follow: call again with offset 2.'
    );
  });

  it('a non-current company part keeps its warning on an empty later page', async () => {
    const { tool } = pagedTool({}, 0, {
      scopes: [{ scopeKey: SCOPE_B, published: true }],
    });
    const res = await tool.handler({ query: 'acme', limit: 1, offset: 1 });
    expect(res.meta).toMatchObject({
      companyContribution: 'unavailable',
      companyContributionReason: 'generation_scope_stale',
    });
    expect(res.summary).toBe(
      `${NO_FURTHER_LATER_PAGE('acme')} The company part of this search is UNAVAILABLE (generation_scope_stale): company results may be missing, so this is NOT evidence that no such company exists.`
    );
    expect(res.summary).not.toContain('No entities matched');
  });

  it('an unavailable company part on an empty initial page is never a no-match', async () => {
    const { tool } = pagedTool({}, 0, { failHydrate: true });
    const res = await tool.handler({ query: 'acme' });
    expect(res.meta).toMatchObject({
      companyContribution: 'unavailable',
      companyContributionReason: 'company_check_unavailable',
    });
    expect(res.summary).toBe(
      'No entities are shown for "acme" on this page. The company part of this search is UNAVAILABLE (company_check_unavailable): company results may be missing, so this is NOT evidence that no such company exists.'
    );
  });
});

describe('search_entities — privacy whitelist (no visibility / no raw attrs leak)', () => {
  it('exposes the nested whitelisted attrs (kind) but NEVER visibility or the raw hit', async () => {
    const tools = buildTools({ hits: [makeHit()] });
    const res = await getSearchTool(tools).handler({ query: 'acme' });

    const item = res.items![0] as Record<string, unknown>;
    const attrs = item['attrs'] as Record<string, unknown>;

    // The nested whitelisted sub-object is exposed…
    expect(attrs).toEqual({ kind: 'primarie', status: 'active' });
    expect(attrs['kind']).toBe('primarie');

    // …but `visibility` appears NOWHERE in the item (not at top level, not in attrs).
    expect(item).not.toHaveProperty('visibility');
    expect(attrs).not.toHaveProperty('visibility');
    expect(JSON.stringify(res)).not.toContain('visibility');
  });

  it('exposes the entity display fields (docType, docKey, title, subtitle, county, cuis)', async () => {
    const tools = buildTools({ hits: [makeHit()] });
    const res = await getSearchTool(tools).handler({ query: 'acme' });

    const item = res.items![0] as Record<string, unknown>;
    expect(item['docType']).toBe('organization');
    expect(item['docKey']).toBe('42');
    expect(item['docId']).toBe('organization:42');
    expect(item['title']).toBe('PRIMARIA ACME');
    expect(item['subtitle']).toBe('CUI 42 · Cluj');
    expect(item['countyName']).toBe('Bihor');
    expect(item['cuis']).toEqual(['42']);
  });

  it('omits attrs entirely when the hit has no nested attrs object', async () => {
    const tools = buildTools({ hits: [makeHit({ attrs: { visibility: 'public' } })] });
    const res = await getSearchTool(tools).handler({ query: 'acme' });

    const item = res.items![0] as Record<string, unknown>;
    expect(item).not.toHaveProperty('attrs');
    expect(JSON.stringify(res)).not.toContain('visibility');
  });

  it('omits attrs when the nested attrs object is empty', async () => {
    const tools = buildTools({ hits: [makeHit({ attrs: { visibility: 'public', attrs: {} } })] });
    const res = await getSearchTool(tools).handler({ query: 'acme' });
    const item = res.items![0] as Record<string, unknown>;
    expect(item).not.toHaveProperty('attrs');
  });
});

describe('search_entities — arg coercion', () => {
  it('forwards docTypes / county / isActive / limit when valid', async () => {
    const searchEntities = vi.fn(async () =>
      ok({ hits: [], facetDistribution: {}, estimatedTotalHits: 0 })
    );
    const deps: KernelMcpDeps = {
      identityRepo: { searchByName: vi.fn(async () => ok([])) } as never,
      entity360Deps: {} as never,
      globalSearchDeps: {
        meiliClient: { searchEntities } as never,
        meiliIndexes: ['entities'],
      },
      clientBaseUrl: 'https://transparenta.eu',
    };
    const tool = getSearchTool(makeKernelMcpTools(deps));
    await tool.handler({
      query: 'acme',
      docTypes: ['company', 7],
      county: 'Cluj',
      isActive: true,
      limit: 5,
    });

    // docTypes filters non-strings; the usecase receives ['company'] → meili filter.
    expect(searchEntities).toHaveBeenCalledWith('acme', 'entities', {
      policy: 'baseline',
      filter: [
        'privacy_class = "public"',
        'doc_type IN ["company"]',
        'county_name = "Cluj"',
        'is_active = true',
      ],
      facets: ['doc_type'],
      limit: 5,
    });
  });
});

it('serves INS matrix catalog results through the shared search tool', async () => {
  const tool = getSearchTool(
    buildTools({
      hits: [
        makeHit({
          docType: 'ins_dataset',
          docKey: 'POP107D',
          cuis: [],
          url: '/statistici/seturi/POP107D',
          roles: [],
        }),
      ],
    })
  );
  const result = await tool.handler({ query: 'populatie', docTypes: ['ins_dataset'] });
  expect(result).toMatchObject({
    ok: true,
    items: [
      {
        docType: 'ins_dataset',
        docKey: 'POP107D',
        url: '/statistici/seturi/POP107D',
      },
    ],
  });
});
