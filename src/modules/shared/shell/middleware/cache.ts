/**
 * Shared Kernel — in-process response cache (foundation §4.6, §5.5).
 *
 * TTL + LRU-ish (insertion-order eviction) Map cache for hot GET/aggregate
 * endpoints. Key = `<module>:<op>:<canonicalizeFilters(...)>`. Invalidation is
 * TTL-only on the request path (serving DB changes via loader runs, §14.11).
 */

export interface CacheConfig {
  readonly ttlMs: number;
  readonly maxEntries: number;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface KernelCache {
  /** Returns the cached value (caller casts) or undefined if absent/expired. */
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  invalidateByPrefix(prefix: string): void;
  /**
   * Read-through helper: returns the cached value, or computes it.
   *
   * `shouldCache` decides whether the COMPUTED value is worth storing; omitted
   * means "always", the historical behaviour. It exists because not every
   * returned value is a fact: a degraded search answer, or a failed `Result`,
   * would otherwise be pinned for the whole TTL and replayed to every caller
   * long after the underlying engine recovered.
   */
  wrap<T>(key: string, compute: () => Promise<T>, shouldCache?: (value: T) => boolean): Promise<T>;
}

export const createCache = (config: CacheConfig): KernelCache => {
  const store = new Map<string, Entry>();

  const interval = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of store) if (now >= e.expiresAt) store.delete(k);
  }, 60_000);
  if (typeof interval === 'object' && 'unref' in interval) interval.unref();

  const get = (key: string): unknown => {
    const e = store.get(key);
    if (e === undefined) return undefined;
    if (Date.now() >= e.expiresAt) {
      store.delete(key);
      return undefined;
    }
    // Refresh insertion order on hit (cheap LRU approximation).
    store.delete(key);
    store.set(key, e);
    return e.value;
  };

  const set = (key: string, value: unknown): void => {
    if (store.size >= config.maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { value, expiresAt: Date.now() + config.ttlMs });
  };

  return {
    get,
    set,
    invalidateByPrefix(prefix: string): void {
      for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
    },
    async wrap<T>(
      key: string,
      compute: () => Promise<T>,
      shouldCache?: (value: T) => boolean
    ): Promise<T> {
      const hit = get(key) as T | undefined;
      if (hit !== undefined) return hit;
      const value = await compute();
      if (shouldCache === undefined || shouldCache(value)) set(key, value);
      return value;
    },
  };
};
