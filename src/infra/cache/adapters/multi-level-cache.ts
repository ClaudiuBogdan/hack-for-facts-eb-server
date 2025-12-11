/**
 * Multi-level cache adapter (L1: memory, L2: Redis).
 * Provides fast memory access with Redis persistence/sharing.
 */

import { ok } from 'neverthrow';

import type { CachePort, CacheSetOptions, CacheStats } from '../ports.js';
import type { Logger } from 'pino';

export interface MultiLevelCacheOptions<T> {
  /** L1 cache (memory) - fast, local */
  l1: CachePort<T>;
  /** L2 cache (Redis) - persistent, shared */
  l2: CachePort<T>;
  /** Optional logger for cache hit/miss tracking */
  logger?: Logger;
}

/**
 * Create a multi-level cache that checks L1 first, then L2.
 * On L2 hit, populates L1 for subsequent requests.
 */
export const createMultiLevelCache = <T>(options: MultiLevelCacheOptions<T>): CachePort<T> => {
  const { l1, l2, logger } = options;

  let l1Hits = 0;
  let l2Hits = 0;
  let misses = 0;

  return {
    async get(key: string) {
      // Check L1 first
      const l1Result = await l1.get(key);
      if (l1Result.isOk() && l1Result.value !== undefined) {
        l1Hits++;
        logger?.debug({ key, layer: 'L1', l1Hits, l2Hits, misses }, '[Cache] L1 HIT (memory)');
        return l1Result;
      }

      // L1 miss or error - check L2
      const l2Result = await l2.get(key);
      if (l2Result.isErr()) {
        logger?.warn({ key, error: l2Result.error }, '[Cache] L2 ERROR');
        return l2Result; // L2 error propagates
      }

      if (l2Result.value === undefined) {
        misses++;
        logger?.debug(
          { key, layer: 'MISS', l1Hits, l2Hits, misses },
          '[Cache] MISS (not in L1 or L2)'
        );
        return ok(undefined);
      }

      // L2 hit - populate L1 (fire and forget, ignore errors)
      l2Hits++;
      logger?.debug(
        { key, layer: 'L2', l1Hits, l2Hits, misses },
        '[Cache] L2 HIT (Redis) → promoting to L1'
      );
      void l1.set(key, l2Result.value);
      return l2Result;
    },

    async set(key: string, value: T, setOptions?: CacheSetOptions) {
      logger?.debug({ key, ttlMs: setOptions?.ttlMs }, '[Cache] SET → writing to L1 + L2');
      // Write to both in parallel
      const [l1Result, l2Result] = await Promise.all([
        l1.set(key, value, setOptions),
        l2.set(key, value, setOptions),
      ]);

      // Return L2 result (source of truth)
      if (l2Result.isErr()) {
        logger?.warn({ key, error: l2Result.error }, '[Cache] SET L2 failed');
        return l2Result;
      }
      if (l1Result.isErr()) {
        logger?.warn({ key, error: l1Result.error }, '[Cache] SET L1 failed');
        return l1Result;
      }
      logger?.debug({ key }, '[Cache] SET complete (L1 + L2)');
      return ok(undefined);
    },

    async delete(key: string) {
      logger?.debug({ key }, '[Cache] DELETE → removing from L1 + L2');
      const [l1Result, l2Result] = await Promise.all([l1.delete(key), l2.delete(key)]);

      if (l2Result.isErr()) return l2Result;
      if (l1Result.isErr()) return l1Result;

      // Return true if either had the key
      const deleted = l1Result.value || l2Result.value;
      logger?.debug({ key, deleted }, '[Cache] DELETE complete');
      return ok(deleted);
    },

    async has(key: string) {
      const l1Result = await l1.has(key);
      if (l1Result.isOk() && l1Result.value) {
        return ok(true);
      }
      return l2.has(key);
    },

    async clearByPrefix(prefix: string) {
      logger?.debug({ prefix }, '[Cache] CLEAR_BY_PREFIX → clearing L1 + L2');
      const [l1Result, l2Result] = await Promise.all([
        l1.clearByPrefix(prefix),
        l2.clearByPrefix(prefix),
      ]);

      if (l2Result.isErr()) return l2Result;
      if (l1Result.isErr()) return l1Result;

      const totalCleared = l1Result.value + l2Result.value;
      logger?.debug(
        { prefix, l1Cleared: l1Result.value, l2Cleared: l2Result.value, totalCleared },
        '[Cache] CLEAR_BY_PREFIX complete'
      );
      return ok(totalCleared);
    },

    async clear() {
      logger?.info('[Cache] CLEAR → clearing all entries from L1 + L2');
      const [l1Result, l2Result] = await Promise.all([l1.clear(), l2.clear()]);

      l1Hits = 0;
      l2Hits = 0;
      misses = 0;

      if (l2Result.isErr()) return l2Result;
      logger?.info('[Cache] CLEAR complete, stats reset');
      return l1Result;
    },

    async stats(): Promise<CacheStats> {
      const l2Stats = await l2.stats();
      const stats = {
        hits: l1Hits + l2Hits,
        misses,
        size: l2Stats.size,
      };
      logger?.debug(
        { l1Hits, l2Hits, totalHits: stats.hits, misses, size: stats.size },
        '[Cache] STATS'
      );
      return stats;
    },
  };
};
