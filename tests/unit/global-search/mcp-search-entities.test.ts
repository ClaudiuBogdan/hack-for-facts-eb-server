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

import { upstreamError } from '@/modules/shared/core/errors.js';
import { makeKernelMcpTools, type KernelMcpDeps } from '@/modules/shared/shell/mcp/tools.js';

import type { SearchHit } from '@/modules/shared/core/types.js';
import type { GlobalSearchDeps } from '@/modules/shared/core/usecases/global-search.js';
import type { KernelMcpTool } from '@/modules/shared/shell/mcp/types.js';

const makeHit = (over: Partial<SearchHit> = {}): SearchHit => ({
  id: 'company:42',
  docType: 'company',
  title: 'ACME SRL',
  snippet: null,
  score: 0.9,
  source: 'meili',
  // Raw hit attrs — carries `visibility` plus the nested whitelisted `attrs`.
  attrs: { visibility: 'public', attrs: { kind: 'srl', status: 'active' } },
  docId: 'company:42',
  docKey: '42',
  subtitle: 'CUI 42 · Cluj',
  countyName: 'Cluj',
  cuis: ['42'],
  ...over,
});

/**
 * Build the kernel MCP tools with `makeGlobalSearch` stubbed by injecting fake
 * globalSearchDeps. The handler calls `makeGlobalSearch(deps.globalSearchDeps, …)`
 * which forwards to `meiliClient.searchEntities` — so a fake meili client lets us
 * control the hits without a real engine.
 */
const buildTools = (
  meiliResult:
    | {
        hits: readonly SearchHit[];
        facetDistribution?: Record<string, Record<string, number>>;
        estimatedTotalHits?: number;
      }
    | 'err'
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
    meiliClient: { searchEntities } as never,
    searchRepo: { searchEntities: vi.fn(async () => ok([])) } as never,
    meiliIndexes: ['entities'],
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
      facetDistribution: { doc_type: { company: 1 } },
      estimatedTotalHits: 1,
    });
    const res = await getSearchTool(tools).handler({ query: 'acme' });

    expect(res.ok).toBe(true);
    expect(res.kind).toBe('entity_search');
    expect(res.query).toBe('acme');
    expect(res.items).toHaveLength(1);
    expect(res.meta).toEqual({
      engine: 'meili',
      estimatedTotalHits: 1,
      returned: 1,
      facets: [{ field: 'doc_type', value: 'company', count: 1 }],
    });
    expect(res.summary).toContain('acme');
  });

  it('summarizes a no-match search', async () => {
    const tools = buildTools({ hits: [] });
    const res = await getSearchTool(tools).handler({ query: 'zzz' });
    expect(res.ok).toBe(true);
    expect(res.items).toEqual([]);
    expect(res.summary).toBe('No entities matched "zzz".');
  });

  it('reports the usecase error as { ok:false }', async () => {
    // No index → degrade to searchRepo; force searchRepo to error → usecase err.
    const searchEntitiesRepo = vi.fn(async () => err(upstreamError('db down', 'pg')));
    const deps: KernelMcpDeps = {
      identityRepo: { searchByName: vi.fn(async () => ok([])) } as never,
      entity360Deps: {} as never,
      globalSearchDeps: {
        meiliClient: { searchEntities: vi.fn() } as never,
        searchRepo: { searchEntities: searchEntitiesRepo } as never,
        meiliIndexes: [],
      },
      clientBaseUrl: 'https://transparenta.eu',
    };
    const tool = getSearchTool(makeKernelMcpTools(deps));
    const res = await tool.handler({ query: 'acme' });

    expect(res.ok).toBe(false);
    expect(res.kind).toBe('entity_search');
    expect(res.error).toBeDefined();
  });
});

describe('search_entities — privacy whitelist (no visibility / no raw attrs leak)', () => {
  it('exposes the nested whitelisted attrs (kind) but NEVER visibility or the raw hit', async () => {
    const tools = buildTools({ hits: [makeHit()] });
    const res = await getSearchTool(tools).handler({ query: 'acme' });

    const item = res.items![0] as Record<string, unknown>;
    const attrs = item['attrs'] as Record<string, unknown>;

    // The nested whitelisted sub-object is exposed…
    expect(attrs).toEqual({ kind: 'srl', status: 'active' });
    expect(attrs['kind']).toBe('srl');

    // …but `visibility` appears NOWHERE in the item (not at top level, not in attrs).
    expect(item).not.toHaveProperty('visibility');
    expect(attrs).not.toHaveProperty('visibility');
    expect(JSON.stringify(res)).not.toContain('visibility');
  });

  it('exposes the entity display fields (docType, docKey, title, subtitle, county, cuis)', async () => {
    const tools = buildTools({ hits: [makeHit()] });
    const res = await getSearchTool(tools).handler({ query: 'acme' });

    const item = res.items![0] as Record<string, unknown>;
    expect(item['docType']).toBe('company');
    expect(item['docKey']).toBe('42');
    expect(item['docId']).toBe('company:42');
    expect(item['title']).toBe('ACME SRL');
    expect(item['subtitle']).toBe('CUI 42 · Cluj');
    expect(item['countyName']).toBe('Cluj');
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
  it('forwards docTypes / county / year / limit when valid', async () => {
    const searchEntities = vi.fn(async () =>
      ok({ hits: [], facetDistribution: {}, estimatedTotalHits: 0 })
    );
    const deps: KernelMcpDeps = {
      identityRepo: { searchByName: vi.fn(async () => ok([])) } as never,
      entity360Deps: {} as never,
      globalSearchDeps: {
        meiliClient: { searchEntities } as never,
        searchRepo: { searchEntities: vi.fn(async () => ok([])) } as never,
        meiliIndexes: ['entities'],
      },
      clientBaseUrl: 'https://transparenta.eu',
    };
    const tool = getSearchTool(makeKernelMcpTools(deps));
    await tool.handler({
      query: 'acme',
      docTypes: ['company', 7],
      county: 'Cluj',
      year: 2024,
      limit: 5,
    });

    // docTypes filters non-strings; the usecase receives ['company'] → meili filter.
    expect(searchEntities).toHaveBeenCalledWith('acme', 'entities', {
      filter: [
        'visibility = "public"',
        'doc_type IN ["company"]',
        'county_name = "Cluj"',
        'year = 2024',
      ],
      facets: ['doc_type'],
      limit: 5,
    });
  });
});
