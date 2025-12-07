/**
 * Multi-level cache adapter (L1: memory, L2: Redis).
 * Provides fast memory access with Redis persistence/sharing.
 */

import { ok } from 'neverthrow';

import type { CachePort, CacheSetOptions, CacheStats } from '../ports.js';

export interface MultiLevelCacheOptions<T> {
  /** L1 cache (memory) - fast, local */
  l1: CachePort<T>;
  /** L2 cache (Redis) - persistent, shared */
  l2: CachePort<T>;
}

/**
 * Create a multi-level cache that checks L1 first, then L2.
 * On L2 hit, populates L1 for subsequent requests.
 */
export const createMultiLevelCache = <T>(options: MultiLevelCacheOptions<T>): CachePort<T> => {
  const { l1, l2 } = options;

  let l1Hits = 0;
  let l2Hits = 0;
  let misses = 0;

  return {
    async get(key: string) {
      // Check L1 first
      const l1Result = await l1.get(key);
      if (l1Result.isOk() && l1Result.value !== undefined) {
        l1Hits++;
        return l1Result;
      }

      // L1 miss or error - check L2
      const l2Result = await l2.get(key);
      if (l2Result.isErr()) {
        return l2Result; // L2 error propagates
      }

      if (l2Result.value === undefined) {
        misses++;
        return ok(undefined);
      }

      // L2 hit - populate L1 (fire and forget, ignore errors)
      l2Hits++;
      void l1.set(key, l2Result.value);
      return l2Result;
    },

    async set(key: string, value: T, setOptions?: CacheSetOptions) {
      // Write to both in parallel
      const [l1Result, l2Result] = await Promise.all([
        l1.set(key, value, setOptions),
        l2.set(key, value, setOptions),
      ]);

      // Return L2 result (source of truth)
      if (l2Result.isErr()) return l2Result;
      if (l1Result.isErr()) return l1Result;
      return ok(undefined);
    },

    async delete(key: string) {
      const [l1Result, l2Result] = await Promise.all([l1.delete(key), l2.delete(key)]);

      if (l2Result.isErr()) return l2Result;
      if (l1Result.isErr()) return l1Result;

      // Return true if either had the key
      return ok(l1Result.value || l2Result.value);
    },

    async has(key: string) {
      const l1Result = await l1.has(key);
      if (l1Result.isOk() && l1Result.value) {
        return ok(true);
      }
      return l2.has(key);
    },

    async clearByPrefix(prefix: string) {
      const [l1Result, l2Result] = await Promise.all([
        l1.clearByPrefix(prefix),
        l2.clearByPrefix(prefix),
      ]);

      if (l2Result.isErr()) return l2Result;
      if (l1Result.isErr()) return l1Result;

      return ok(l1Result.value + l2Result.value);
    },

    async clear() {
      const [l1Result, l2Result] = await Promise.all([l1.clear(), l2.clear()]);

      l1Hits = 0;
      l2Hits = 0;
      misses = 0;

      if (l2Result.isErr()) return l2Result;
      return l1Result;
    },

    async stats(): Promise<CacheStats> {
      const l2Stats = await l2.stats();
      return {
        hits: l1Hits + l2Hits,
        misses,
        size: l2Stats.size,
      };
    },
  };
};
