/**
 * In-memory LRU cache with TTL expiration.
 */

import { ok } from 'neverthrow';

import { deserialize, serialize } from '../serialization.js';

import type { CachePort, CacheSetOptions, CacheStats } from '../ports.js';

interface CacheEntry {
  /** Serialized value */
  value: string;
  /** Expiration timestamp (ms since epoch) */
  expiresAt: number;
}

export interface MemoryCacheOptions {
  /** Maximum number of entries. Default: 1000 */
  maxEntries?: number;
  /** Default TTL in milliseconds. Default: 3600000 (1 hour) */
  defaultTtlMs?: number;
}

/**
 * Create an in-memory LRU cache with TTL.
 */
export const createMemoryCache = <T>(options: MemoryCacheOptions = {}): CachePort<T> => {
  const maxEntries = options.maxEntries ?? 1000;
  const defaultTtlMs = options.defaultTtlMs ?? 3600000;

  // Map maintains insertion order, enabling LRU eviction
  const store = new Map<string, CacheEntry>();

  let hits = 0;
  let misses = 0;

  /**
   * Check if an entry is expired and remove it if so.
   */
  const isExpired = (entry: CacheEntry): boolean => {
    return Date.now() >= entry.expiresAt;
  };

  /**
   * Evict the least recently used entry.
   */
  const evictLru = (): void => {
    const lruKey = store.keys().next().value;
    if (lruKey !== undefined) {
      store.delete(lruKey);
    }
  };

  /**
   * Refresh LRU order by re-inserting the entry.
   */
  const refreshLru = (key: string, entry: CacheEntry): void => {
    store.delete(key);
    store.set(key, entry);
  };

  return {
    get(key: string) {
      const entry = store.get(key);

      if (entry === undefined) {
        misses++;
        return Promise.resolve(ok(undefined));
      }

      if (isExpired(entry)) {
        store.delete(key);
        misses++;
        return Promise.resolve(ok(undefined));
      }

      // Refresh LRU order
      refreshLru(key, entry);

      const result = deserialize(entry.value);
      if (!result.ok) {
        // Corrupted entry, remove it
        store.delete(key);
        misses++;
        return Promise.resolve(ok(undefined));
      }

      hits++;
      return Promise.resolve(ok(result.value as T));
    },

    set(key: string, value: T, setOptions?: CacheSetOptions) {
      const ttlMs = setOptions?.ttlMs ?? defaultTtlMs;

      // Remove existing entry if present (for LRU refresh)
      if (store.has(key)) {
        store.delete(key);
      } else if (store.size >= maxEntries) {
        evictLru();
      }

      store.set(key, {
        value: serialize(value),
        expiresAt: Date.now() + ttlMs,
      });

      return Promise.resolve(ok(undefined));
    },

    delete(key: string) {
      const existed = store.delete(key);
      return Promise.resolve(ok(existed));
    },

    has(key: string) {
      const entry = store.get(key);

      if (entry === undefined) {
        return Promise.resolve(ok(false));
      }

      if (isExpired(entry)) {
        store.delete(key);
        return Promise.resolve(ok(false));
      }

      return Promise.resolve(ok(true));
    },

    clearByPrefix(prefix: string) {
      let count = 0;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          store.delete(key);
          count++;
        }
      }
      return Promise.resolve(ok(count));
    },

    clear() {
      store.clear();
      hits = 0;
      misses = 0;
      return Promise.resolve(ok(undefined));
    },

    stats(): Promise<CacheStats> {
      return Promise.resolve({ hits, misses, size: store.size });
    },
  };
};
