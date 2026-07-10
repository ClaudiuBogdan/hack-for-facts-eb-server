/**
 * Integration — kernel `searchEntities` GraphQL resolver (foundation §6.2, T3).
 *
 * The kernel search deps (meiliClient / searchRepo / identityRepo / cache /
 * rateLimiter) are wired INSIDE `makeKernel` from config, not through the
 * `createApp` deps seam — so this drives the resolver via `makeKernelResolvers`
 * with fakes (the same seam the kernel uses), exercising the resolver-level
 * behaviors that the unit usecase test can't:
 *  - rate-limit (`rateLimiter.consume`) runs BEFORE `cache.wrap`;
 *  - exhaustion throws a GraphQLError with `extensions.code = 'RATE_LIMITED'`;
 *  - results are cached (a second identical call skips the usecase);
 *  - the cache key is a structured JSON signature (no `q="a|b"` collision).
 *
 * The SDL is asserted separately (it exposes facets/estimatedTotalHits/the new
 * SearchHit fields, and does NOT expose visibility/attrs on SearchHit).
 */

import { GraphQLError } from 'graphql';
import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  makeKernelResolvers,
  type KernelResolverDeps,
} from '@/modules/shared/shell/graphql/resolvers.js';
import { baseTypeDefs } from '@/modules/shared/shell/graphql/typedefs.js';

import type {
  FlowSummary,
  Organization,
  SourcePresence,
  Territory,
  SearchHit,
} from '@/modules/shared/core/types.js';
import type { GlobalSearchDeps } from '@/modules/shared/core/usecases/global-search.js';
import type { KernelCache } from '@/modules/shared/shell/middleware/cache.js';
import type {
  RateLimiter,
  RateLimitResult,
} from '@/modules/shared/shell/middleware/rate-limiter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

const makeHit = (over: Partial<SearchHit> = {}): SearchHit => ({
  id: 'company:1',
  docType: 'company',
  title: 'ACME SRL',
  snippet: null,
  score: 0.9,
  source: 'meili',
  attrs: { visibility: 'public' },
  ...over,
});

/** A cache that records calls and actually wraps (so we can assert call order + memoization). */
const makeRecordingCache = (): KernelCache & { wrapCalls: string[] } => {
  const store = new Map<string, unknown>();
  const wrapCalls: string[] = [];
  return {
    wrapCalls,
    get: (k) => store.get(k),
    set: (k, v) => store.set(k, v),
    invalidateByPrefix: () => undefined,
    async wrap<T>(key: string, compute: () => Promise<T>): Promise<T> {
      wrapCalls.push(key);
      if (store.has(key)) return store.get(key) as T;
      const v = await compute();
      store.set(key, v);
      return v;
    },
  };
};

const allow: RateLimitResult = { allowed: true, retryAfterMs: 0, remaining: 29 };
const deny: RateLimitResult = { allowed: false, retryAfterMs: 5000, remaining: 0 };

const makeDeps = (opts: {
  hits?: readonly SearchHit[];
  rateLimiter?: RateLimiter;
  cache?: KernelCache;
  searchSpy?: ReturnType<typeof vi.fn>;
}): { deps: KernelResolverDeps; cache: KernelCache } => {
  const searchEntities =
    opts.searchSpy ??
    vi.fn(async () =>
      ok({
        hits: opts.hits ?? [makeHit()],
        facetDistribution: {},
        estimatedTotalHits: (opts.hits ?? [makeHit()]).length,
      })
    );
  const globalSearchDeps: GlobalSearchDeps = {
    meiliClient: { searchEntities } as never,
    searchRepo: { searchEntities: vi.fn(async () => ok([])) } as never,
    meiliIndexes: ['entities'],
  };
  const cache = opts.cache ?? makeRecordingCache();
  const rateLimiter = opts.rateLimiter ?? { consume: () => allow };

  const deps = {
    entity360Deps: {} as never,
    globalSearchDeps,
    identityRepo: {} as never,
    flowsRepo: {} as never,
    searchRepo: {} as never,
    registry: {} as never,
    health: async () => 'ok',
    cache,
    rateLimiter,
  } as KernelResolverDeps;
  return { deps, cache };
};

interface SearchResolvers {
  Query: {
    searchEntities: (
      root: unknown,
      args: Record<string, unknown>,
      context: unknown
    ) => Promise<{ engine: string; hits: readonly SearchHit[]; estimatedTotalHits: number }>;
  };
}

const resolver = (deps: KernelResolverDeps): SearchResolvers['Query']['searchEntities'] =>
  (makeKernelResolvers(deps) as unknown as SearchResolvers).Query.searchEntities;

const ctx = (ip = '1.2.3.4'): unknown => ({ reply: { request: { ip } } });

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('searchEntities resolver — happy path', () => {
  it('returns the global-search result', async () => {
    const { deps } = makeDeps({ hits: [makeHit({ id: 'company:9' })] });
    const result = await resolver(deps)(null, { q: 'acme' }, ctx());

    expect(result.engine).toBe('meili');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.id).toBe('company:9');
    expect(result.estimatedTotalHits).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit BEFORE cache
// ─────────────────────────────────────────────────────────────────────────────

describe('searchEntities resolver — rate limiting', () => {
  it('consumes a token BEFORE wrapping the cache', async () => {
    const order: string[] = [];
    const cache = makeRecordingCache();
    const wrappedCache: KernelCache = {
      ...cache,
      async wrap(key, compute) {
        order.push('cache');
        return cache.wrap(key, compute);
      },
    };
    const rateLimiter: RateLimiter = {
      consume: () => {
        order.push('ratelimit');
        return allow;
      },
    };
    const { deps } = makeDeps({ rateLimiter, cache: wrappedCache });

    await resolver(deps)(null, { q: 'acme' }, ctx());
    expect(order).toEqual(['ratelimit', 'cache']);
  });

  it('throws RATE_LIMITED (and never touches the cache) when the bucket is empty', async () => {
    const cache = makeRecordingCache();
    const rateLimiter: RateLimiter = { consume: () => deny };
    const { deps } = makeDeps({ rateLimiter, cache });

    await expect(resolver(deps)(null, { q: 'acme' }, ctx())).rejects.toMatchObject({
      message: expect.stringContaining('Rate limit'),
    });
    try {
      await resolver(deps)(null, { q: 'acme' }, ctx());
    } catch (e) {
      expect(e).toBeInstanceOf(GraphQLError);
      const gqlErr = e as GraphQLError;
      expect(gqlErr.extensions['code']).toBe('RATE_LIMITED');
      expect(gqlErr.extensions['retryAfterMs']).toBe(5000);
    }
    expect(cache.wrapCalls).toEqual([]);
  });

  it('rate-limits per caller IP (distinct buckets per IP)', async () => {
    const seen: string[] = [];
    const rateLimiter: RateLimiter = {
      consume: (key) => {
        seen.push(key);
        return allow;
      },
    };
    const { deps } = makeDeps({ rateLimiter });
    await resolver(deps)(null, { q: 'acme' }, ctx('10.0.0.1'));
    await resolver(deps)(null, { q: 'acme' }, ctx('10.0.0.2'));
    expect(seen).toEqual(['searchEntities:10.0.0.1', 'searchEntities:10.0.0.2']);
  });

  it('falls back to an "anon" bucket when no IP is present', async () => {
    const seen: string[] = [];
    const rateLimiter: RateLimiter = {
      consume: (key) => {
        seen.push(key);
        return allow;
      },
    };
    const { deps } = makeDeps({ rateLimiter });
    await resolver(deps)(null, { q: 'acme' }, {});
    expect(seen).toEqual(['searchEntities:anon']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Caching + key shape
// ─────────────────────────────────────────────────────────────────────────────

describe('searchEntities resolver — caching', () => {
  it('memoizes identical args (usecase runs once)', async () => {
    const searchSpy = vi.fn(async () =>
      ok({ hits: [makeHit()], facetDistribution: {}, estimatedTotalHits: 1 })
    );
    const { deps } = makeDeps({ searchSpy });

    await resolver(deps)(null, { q: 'acme' }, ctx());
    await resolver(deps)(null, { q: 'acme' }, ctx());
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  it('uses a structured JSON cache key (q="a|b" no-types ≠ q="a", docTypes=["b"])', async () => {
    const cache = makeRecordingCache();
    const { deps } = makeDeps({ cache });

    await resolver(deps)(null, { q: 'a|b' }, ctx());
    await resolver(deps)(null, { q: 'a', docTypes: ['b'] }, ctx());

    const keys = cache.wrapCalls;
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain('"q":"a|b"');
    expect(keys[1]).toContain('"q":"a"');
  });

  it('produces the SAME cache key regardless of docTypes order (sorted)', async () => {
    const cache = makeRecordingCache();
    const { deps } = makeDeps({ cache });
    await resolver(deps)(null, { q: 'x', docTypes: ['bill', 'company'] }, ctx());
    await resolver(deps)(null, { q: 'x', docTypes: ['company', 'bill'] }, ctx());
    const keys = cache.wrapCalls;
    expect(keys[0]).toBe(keys[1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SDL contract
// ─────────────────────────────────────────────────────────────────────────────

describe('kernel base SDL — search types', () => {
  it('exposes facets, estimatedTotalHits, and the deprecated organizations on GlobalSearchResult', () => {
    expect(baseTypeDefs).toMatch(/facets:\s*\[SearchFacet!\]!/u);
    expect(baseTypeDefs).toMatch(/estimatedTotalHits:\s*Int!/u);
    expect(baseTypeDefs).toMatch(/organizations:\s*\[OrgNameMatch!\]!/u);
  });

  it('exposes the new SearchHit projection fields', () => {
    for (const field of [
      'docId',
      'docKey',
      'subtitle',
      'countyName',
      'url',
      'rankBoost',
      'cuis',
      'year',
    ]) {
      expect(baseTypeDefs).toContain(field);
    }
  });

  it('does NOT expose visibility or the raw attrs on SearchHit', () => {
    // Isolate the `type SearchHit { … }` block and assert the forbidden fields
    // are absent from it (attrs/visibility live elsewhere — Document.attrs etc.).
    const block = /type SearchHit \{([\s\S]*?)\}/u.exec(baseTypeDefs)?.[1] ?? '';
    expect(block).not.toMatch(/\battrs\b/u);
    expect(block).not.toMatch(/\bvisibility\b/u);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// entity / Entity field resolvers / health — the rest of the kernel resolver map
// (these ship in the same file as searchEntities; covered here so the shared
// resolver surface stays under the coverage gate).
// ─────────────────────────────────────────────────────────────────────────────

const ORG: Organization = {
  orgId: '500',
  cui: '4305857',
  registrationNumber: null,
  kind: 'public_entity',
  name: 'Municipiul Cluj-Napoca',
  normalizedName: 'municipiul cluj napoca',
  countyName: 'Cluj',
  localityName: 'Cluj-Napoca',
  sirutaCode: '54975',
  firstSeenSource: 'mfin',
  attrs: {},
};

const TERRITORY: Territory = {
  id: 1,
  territorialSirutaCode: '54975',
  sirutaCode: '54975',
  countySirutaCode: '54932',
  uatCode: null,
  name: 'Cluj-Napoca',
  countyCode: 'CJ',
  countyName: 'Cluj',
  region: 'Nord-Vest',
  population: 320000,
};

const flowSummary = (direction: 'in' | 'out'): FlowSummary => ({
  direction,
  count: direction === 'in' ? 3 : 1,
  totalAmountRon: '1000',
  minYear: 2020,
  maxYear: 2024,
  byFlowType: [],
  byYear: [],
});

const makeEntityDeps = (orgOrNull: Organization | null): KernelResolverDeps => {
  const identityRepo = {
    findByCui: vi.fn(async () => ok(orgOrNull)),
    getIdentifiers: vi.fn(async () => ok([])),
    territoryForCui: vi.fn(async () => ok(TERRITORY)),
  } as never;
  const flowsRepo = {
    getFlowSummary: vi.fn(async (_cui: string, dir: 'in' | 'out') => ok(flowSummary(dir))),
  } as never;
  const searchRepo = { countByCui: vi.fn(async () => ok(7)) } as never;
  const budgetPresence: SourcePresence = { source: 'budget', present: true, label: 'budget' };
  const registry = {
    list: () => [{ source: 'budget', presenceFor: async () => ok(budgetPresence) }],
  } as never;

  return {
    entity360Deps: { identityRepo, flowsRepo, searchRepo, registry },
    globalSearchDeps: {} as never,
    identityRepo,
    flowsRepo,
    searchRepo,
    registry,
    health: async () => ({ overall: 'healthy' }),
    cache: makeRecordingCache(),
    rateLimiter: { consume: () => allow },
  };
};

interface KernelMap {
  Query: {
    entity: (root: unknown, args: { cui: string }) => Promise<{ cui: string } | null>;
    health: () => Promise<unknown>;
  };
  Entity: {
    flowsIn: (p: { cui: string }) => Promise<FlowSummary>;
    flowsOut: (p: { cui: string }) => Promise<FlowSummary>;
    territory: (p: { cui: string }) => Promise<Territory | null>;
    documentCount: (p: { cui: string }) => Promise<number>;
    presence: (p: { cui: string }) => Promise<readonly SourcePresence[]>;
  };
}

describe('entity resolver', () => {
  it('returns the entity core for a valid CUI', async () => {
    const map = makeKernelResolvers(makeEntityDeps(ORG)) as unknown as KernelMap;
    const e = await map.Query.entity(null, { cui: '4305857' });
    expect(e?.cui).toBe('4305857');
  });

  it('returns null (not an error) for an invalid CUI format', async () => {
    const map = makeKernelResolvers(makeEntityDeps(ORG)) as unknown as KernelMap;
    const e = await map.Query.entity(null, { cui: 'not-a-cui' });
    expect(e).toBeNull();
  });

  it('resolves health via deps.health', async () => {
    const map = makeKernelResolvers(makeEntityDeps(ORG)) as unknown as KernelMap;
    expect(await map.Query.health()).toEqual({ overall: 'healthy' });
  });
});

describe('Entity field resolvers', () => {
  it('lazily resolves flowsIn / flowsOut / territory / documentCount / presence', async () => {
    const map = makeKernelResolvers(makeEntityDeps(ORG)) as unknown as KernelMap;
    const parent = { cui: '4305857' };

    expect((await map.Entity.flowsIn(parent)).direction).toBe('in');
    expect((await map.Entity.flowsOut(parent)).direction).toBe('out');
    expect(await map.Entity.territory(parent)).toMatchObject({ name: 'Cluj-Napoca' });
    expect(await map.Entity.documentCount(parent)).toBe(7);
    expect(await map.Entity.presence(parent)).toEqual([
      { source: 'budget', present: true, label: 'budget' },
    ]);
  });
});
