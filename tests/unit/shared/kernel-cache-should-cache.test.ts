/**
 * The PRODUCTION kernel cache's `shouldCache` predicate.
 *
 * Why a separate suite: the integration test for the search resolver uses a
 * recording-cache fake that independently reimplements read-through. Those tests
 * would stay green even if `createCache.wrap` ignored the predicate entirely —
 * they prove the RESOLVER passes a correct predicate, not that the cache honours
 * it (codex review 2026-08-26). This exercises the real implementation.
 *
 * What it protects (SEARCH_LAYER_REVIEW_2026-08-25.md D5): a degraded search
 * answer and a failed `Result` are transients. Storing either pins it for the
 * whole TTL and replays it to every caller long after the engine recovered.
 */

import { describe, expect, it, vi } from 'vitest';

import { createCache } from '@/modules/shared/shell/middleware/cache.js';

const cache = (): ReturnType<typeof createCache> => createCache({ ttlMs: 60_000, maxEntries: 100 });

describe('KernelCache.wrap — shouldCache', () => {
  it('caches when the predicate is OMITTED (historical behaviour is unchanged)', async () => {
    const compute = vi.fn(async () => 'value');
    const c = cache();

    expect(await c.wrap('k', compute)).toBe('value');
    expect(await c.wrap('k', compute)).toBe('value');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does NOT store a value the predicate rejects — it recomputes', async () => {
    const compute = vi.fn(async () => 'transient');
    const c = cache();

    await c.wrap('k', compute, () => false);
    await c.wrap('k', compute, () => false);

    expect(compute).toHaveBeenCalledTimes(2);
    // And nothing was left behind for a later caller to pick up.
    expect(c.get('k')).toBeUndefined();
  });

  it('stores a value the predicate accepts', async () => {
    const compute = vi.fn(async () => 'fact');
    const c = cache();

    await c.wrap('k', compute, () => true);
    await c.wrap('k', compute, () => true);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(c.get('k')).toBe('fact');
  });

  it('recovers: a rejected value does not block a later accepted one', async () => {
    // The actual outage→recovery shape. If the first (degraded) answer were
    // stored, this second call would never run and the stale answer would be
    // served for the rest of the TTL.
    const c = cache();
    const values = ['degraded', 'healthy'];
    const compute = vi.fn(async () => values.shift() ?? 'exhausted');

    const first = await c.wrap('k', compute, (v) => v !== 'degraded');
    const second = await c.wrap('k', compute, (v) => v !== 'degraded');

    expect(first).toBe('degraded');
    expect(second).toBe('healthy');
    expect(c.get('k')).toBe('healthy');
  });

  it('passes the COMPUTED value to the predicate, not the key', async () => {
    const seen: unknown[] = [];
    const c = cache();
    await c.wrap(
      'some-key',
      async () => ({ degraded: true }),
      (v) => {
        seen.push(v);
        return false;
      }
    );

    expect(seen).toEqual([{ degraded: true }]);
  });

  it('never calls the predicate on a cache HIT (nothing to decide)', async () => {
    const c = cache();
    const shouldCache = vi.fn(() => true);
    await c.wrap('k', async () => 'v', shouldCache);
    await c.wrap('k', async () => 'v', shouldCache);

    expect(shouldCache).toHaveBeenCalledTimes(1);
  });
});
