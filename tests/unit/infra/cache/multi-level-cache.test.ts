import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { createMultiLevelCache } from '@/infra/cache/adapters/multi-level-cache.js';
import { CacheError, type CachePort, type CacheStats } from '@/infra/cache/ports.js';

/**
 * Create a mock CachePort for testing.
 */
const createMockCache = <T>(): CachePort<T> & {
  _setGetResult: (result: Awaited<ReturnType<CachePort<T>['get']>>) => void;
  _setSetResult: (result: Awaited<ReturnType<CachePort<T>['set']>>) => void;
  _setDeleteResult: (result: Awaited<ReturnType<CachePort<T>['delete']>>) => void;
  _setHasResult: (result: Awaited<ReturnType<CachePort<T>['has']>>) => void;
  _setClearByPrefixResult: (result: Awaited<ReturnType<CachePort<T>['clearByPrefix']>>) => void;
  _setClearResult: (result: Awaited<ReturnType<CachePort<T>['clear']>>) => void;
  _setStatsResult: (result: CacheStats) => void;
} => {
  let getResult: Awaited<ReturnType<CachePort<T>['get']>> = ok(undefined);
  let setResult: Awaited<ReturnType<CachePort<T>['set']>> = ok(undefined);
  let deleteResult: Awaited<ReturnType<CachePort<T>['delete']>> = ok(false);
  let hasResult: Awaited<ReturnType<CachePort<T>['has']>> = ok(false);
  let clearByPrefixResult: Awaited<ReturnType<CachePort<T>['clearByPrefix']>> = ok(0);
  let clearResult: Awaited<ReturnType<CachePort<T>['clear']>> = ok(undefined);
  let statsResult: CacheStats = { hits: 0, misses: 0, size: 0 };

  return {
    get: vi.fn(() => Promise.resolve(getResult)),
    set: vi.fn(() => Promise.resolve(setResult)),
    delete: vi.fn(() => Promise.resolve(deleteResult)),
    has: vi.fn(() => Promise.resolve(hasResult)),
    clearByPrefix: vi.fn(() => Promise.resolve(clearByPrefixResult)),
    clear: vi.fn(() => Promise.resolve(clearResult)),
    stats: vi.fn(() => Promise.resolve(statsResult)),
    _setGetResult: (r) => {
      getResult = r;
    },
    _setSetResult: (r) => {
      setResult = r;
    },
    _setDeleteResult: (r) => {
      deleteResult = r;
    },
    _setHasResult: (r) => {
      hasResult = r;
    },
    _setClearByPrefixResult: (r) => {
      clearByPrefixResult = r;
    },
    _setClearResult: (r) => {
      clearResult = r;
    },
    _setStatsResult: (r) => {
      statsResult = r;
    },
  };
};

describe('MultiLevelCache', () => {
  describe('get', () => {
    it('returns L1 value when L1 hits (L2 not called)', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setGetResult(ok('l1-value'));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.get('key');

      expect(result._unsafeUnwrap()).toBe('l1-value');
      expect(l1.get).toHaveBeenCalledWith('key');
      expect(l2.get).not.toHaveBeenCalled();
    });

    it('returns L2 value when L1 misses', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setGetResult(ok(undefined));
      l2._setGetResult(ok('l2-value'));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.get('key');

      expect(result._unsafeUnwrap()).toBe('l2-value');
      expect(l1.get).toHaveBeenCalledWith('key');
      expect(l2.get).toHaveBeenCalledWith('key');
    });

    it('populates L1 on L2 hit', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setGetResult(ok(undefined));
      l2._setGetResult(ok('l2-value'));

      const cache = createMultiLevelCache({ l1, l2 });
      await cache.get('key');

      // Give time for fire-and-forget set
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(l1.set).toHaveBeenCalledWith('key', 'l2-value');
    });

    it('returns undefined when both miss', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setGetResult(ok(undefined));
      l2._setGetResult(ok(undefined));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.get('key');

      expect(result._unsafeUnwrap()).toBeUndefined();
    });

    it('falls through to L2 when L1 errors', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setGetResult(err(CacheError.connection('L1 error')));
      l2._setGetResult(ok('l2-value'));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.get('key');

      expect(result._unsafeUnwrap()).toBe('l2-value');
    });

    it('propagates L2 errors', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setGetResult(ok(undefined));
      l2._setGetResult(err(CacheError.connection('L2 error')));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.get('key');

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('ConnectionError');
      }
    });
  });

  describe('set', () => {
    it('writes to both L1 and L2', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();

      const cache = createMultiLevelCache({ l1, l2 });
      await cache.set('key', 'value', { ttlMs: 5000 });

      expect(l1.set).toHaveBeenCalledWith('key', 'value', { ttlMs: 5000 });
      expect(l2.set).toHaveBeenCalledWith('key', 'value', { ttlMs: 5000 });
    });

    it('propagates L2 errors', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l2._setSetResult(err(CacheError.connection('L2 error')));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.set('key', 'value');

      expect(result.isErr()).toBe(true);
    });

    it('propagates L1 errors when L2 succeeds', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setSetResult(err(CacheError.connection('L1 error')));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.set('key', 'value');

      expect(result.isErr()).toBe(true);
    });
  });

  describe('delete', () => {
    it('deletes from both L1 and L2', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setDeleteResult(ok(true));
      l2._setDeleteResult(ok(true));

      const cache = createMultiLevelCache({ l1, l2 });
      await cache.delete('key');

      expect(l1.delete).toHaveBeenCalledWith('key');
      expect(l2.delete).toHaveBeenCalledWith('key');
    });

    it('returns true if either had the key', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setDeleteResult(ok(false));
      l2._setDeleteResult(ok(true));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.delete('key');

      expect(result._unsafeUnwrap()).toBe(true);
    });

    it('returns true if L1 had the key but L2 did not', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setDeleteResult(ok(true));
      l2._setDeleteResult(ok(false));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.delete('key');

      expect(result._unsafeUnwrap()).toBe(true);
    });

    it('returns false if neither had the key', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setDeleteResult(ok(false));
      l2._setDeleteResult(ok(false));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.delete('key');

      expect(result._unsafeUnwrap()).toBe(false);
    });
  });

  describe('has', () => {
    it('returns true immediately if L1 has key', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setHasResult(ok(true));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.has('key');

      expect(result._unsafeUnwrap()).toBe(true);
      expect(l2.has).not.toHaveBeenCalled();
    });

    it('checks L2 if L1 returns false', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setHasResult(ok(false));
      l2._setHasResult(ok(true));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.has('key');

      expect(result._unsafeUnwrap()).toBe(true);
      expect(l2.has).toHaveBeenCalledWith('key');
    });

    it('returns false if neither has key', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setHasResult(ok(false));
      l2._setHasResult(ok(false));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.has('key');

      expect(result._unsafeUnwrap()).toBe(false);
    });
  });

  describe('clearByPrefix', () => {
    it('clears from both and returns combined count', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setClearByPrefixResult(ok(3));
      l2._setClearByPrefixResult(ok(5));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.clearByPrefix('prefix:');

      expect(result._unsafeUnwrap()).toBe(8);
      expect(l1.clearByPrefix).toHaveBeenCalledWith('prefix:');
      expect(l2.clearByPrefix).toHaveBeenCalledWith('prefix:');
    });

    it('propagates L2 errors', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l2._setClearByPrefixResult(err(CacheError.connection('L2 error')));

      const cache = createMultiLevelCache({ l1, l2 });
      const result = await cache.clearByPrefix('prefix:');

      expect(result.isErr()).toBe(true);
    });
  });

  describe('clear', () => {
    it('clears both caches', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();

      const cache = createMultiLevelCache({ l1, l2 });
      await cache.clear();

      expect(l1.clear).toHaveBeenCalled();
      expect(l2.clear).toHaveBeenCalled();
    });

    it('resets stats on clear', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l2._setStatsResult({ hits: 0, misses: 0, size: 0 });

      // Simulate some activity
      l1._setGetResult(ok('value'));
      const cache = createMultiLevelCache({ l1, l2 });
      await cache.get('key'); // L1 hit

      await cache.clear();

      const stats = await cache.stats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });
  });

  describe('stats', () => {
    it('returns combined hits and L2 size', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l2._setStatsResult({ hits: 10, misses: 5, size: 100 });

      // Simulate L1 hit
      l1._setGetResult(ok('value'));
      const cache = createMultiLevelCache({ l1, l2 });
      await cache.get('key1');

      // Simulate L2 hit (L1 miss)
      l1._setGetResult(ok(undefined));
      l2._setGetResult(ok('value'));
      await cache.get('key2');

      const stats = await cache.stats();

      expect(stats.hits).toBe(2); // 1 L1 hit + 1 L2 hit
      expect(stats.size).toBe(100); // L2 size
    });

    it('tracks misses correctly', async () => {
      const l1 = createMockCache<string>();
      const l2 = createMockCache<string>();
      l1._setGetResult(ok(undefined));
      l2._setGetResult(ok(undefined));
      l2._setStatsResult({ hits: 0, misses: 0, size: 0 });

      const cache = createMultiLevelCache({ l1, l2 });
      await cache.get('missing1');
      await cache.get('missing2');

      const stats = await cache.stats();

      expect(stats.misses).toBe(2);
    });
  });
});
