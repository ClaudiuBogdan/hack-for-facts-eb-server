import { buildSchema, parse, validate } from 'graphql';
import { ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  makeKernelResolvers,
  type KernelResolverDeps,
} from '@/modules/shared/shell/graphql/resolvers.js';
import { baseTypeDefs } from '@/modules/shared/shell/graphql/typedefs.js';
import { createCache } from '@/modules/shared/shell/middleware/cache.js';
import { createRateLimiter } from '@/modules/shared/shell/middleware/rate-limiter.js';

interface Args {
  q: string;
  isUat?: boolean | null;
  entityTags?: string[] | null;
  excludeEntityTags?: string[] | null;
}
function fixture() {
  const searchEntities = vi.fn(async () =>
    ok({ hits: [], estimatedTotalHits: 0, facetDistribution: {} })
  );
  const deps = {
    globalSearchDeps: { meiliClient: { searchEntities }, meiliIndexes: ['entities'] },
    cache: createCache({ ttlMs: 60_000, maxEntries: 20 }),
    rateLimiter: createRateLimiter({ maxTokens: 100, windowMs: 60_000 }),
  } as unknown as KernelResolverDeps;
  const resolvers = makeKernelResolvers(deps) as {
    Query: { searchEntities: (root: unknown, args: Args, context: unknown) => Promise<unknown> };
  };
  return {
    calls: searchEntities,
    run: (args: Args) => resolvers.Query.searchEntities(null, args, {}),
  };
}

describe('GraphQL search metadata and cache', () => {
  it('accepts metadata filters and returns metadata fields in the public schema', () => {
    expect(
      validate(
        buildSchema(baseTypeDefs),
        parse(`query {
      searchEntities(q: "sibiu", isUat: true, entityTags: ["kind::uat"], excludeEntityTags: ["uat::county"]) {
        hits { id isUat entityTags }
      }
    }`)
      )
    ).toEqual([]);
  });
  it('separates true, false, tags and exclusions; null is unfiltered', async () => {
    const f = fixture();
    await f.run({ q: 'sibiu', isUat: true });
    await f.run({ q: 'sibiu', isUat: false });
    await f.run({ q: 'sibiu', entityTags: ['kind::uat'] });
    await f.run({ q: 'sibiu', excludeEntityTags: ['kind::uat'] });
    await f.run({ q: 'sibiu' });
    await f.run({ q: 'sibiu', isUat: null, entityTags: null, excludeEntityTags: null });
    expect(f.calls).toHaveBeenCalledTimes(5);
  });
  it('rejects oversized duplicates even when the canonical selection is cached', async () => {
    const f = fixture();
    await f.run({ q: 'sibiu', entityTags: ['kind::uat'] });
    await expect(
      f.run({ q: 'sibiu', entityTags: Array.from({ length: 101 }, () => 'kind::uat') })
    ).rejects.toThrow('100');
    expect(f.calls).toHaveBeenCalledTimes(1);
  });
});
