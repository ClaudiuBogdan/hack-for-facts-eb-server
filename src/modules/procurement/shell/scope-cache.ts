/**
 * Procurement module — in-process TTL cache for the NON-entity scope aggregates.
 *
 * Why it is mandatory. The client fires ONE multi-root `ProcurementAggregates`
 * document that asks for all five aggregates at once. On the empty (platform-wide)
 * scope those cost, measured live: stats 1.6s, topAuthorities 1.4s, topSuppliers
 * 1.9s, categoryBreakdown 3.6s, spendOverTime 2.0s. graphql-js resolves root fields
 * concurrently, but five concurrent multi-second scans of an 8–9M-row matview per
 * page view is not something the shared pool should absorb.
 *
 * The key space is bounded BY CONSTRUCTION: only scopes with no `authorityCui` /
 * `supplierCui` are cached (empty + 45 CPV divisions) × grain-set × month-window ×
 * topN. Entity-scoped requests are index-fast and stay live.
 *
 * The gate's `refreshed_at` is part of every key, so a matview refresh invalidates
 * the whole cache without any explicit bust.
 */

export const SCOPE_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

export interface ScopeCache {
  /**
   * Resolve `key` from cache, or run `load` and memoize it. Concurrent callers for
   * the same key share ONE in-flight promise (a stampede on the empty scope would
   * otherwise fire five identical scans). A rejected load is never cached.
   */
  through<V>(key: string, load: () => Promise<V>): Promise<V>;
  /** Test seam. */
  size(): number;
}

export const makeScopeCache = (
  ttlMs: number = SCOPE_CACHE_TTL_MS,
  now: () => number = Date.now
): ScopeCache => {
  const entries = new Map<string, Entry<unknown>>();
  const inFlight = new Map<string, Promise<unknown>>();

  const evictIfFull = (): void => {
    if (entries.size < MAX_ENTRIES) return;
    // Bounded key space makes this defensive; drop the oldest insertion.
    const oldest = entries.keys().next();
    if (oldest.done !== true) entries.delete(oldest.value);
  };

  return {
    async through<V>(key: string, load: () => Promise<V>): Promise<V> {
      const hit = entries.get(key);
      if (hit !== undefined && hit.expiresAt > now()) return hit.value as V;
      if (hit !== undefined) entries.delete(key);

      const pending = inFlight.get(key);
      if (pending !== undefined) return pending as Promise<V>;

      const promise = load()
        .then((value) => {
          evictIfFull();
          entries.set(key, { value, expiresAt: now() + ttlMs });
          return value;
        })
        .finally(() => {
          inFlight.delete(key);
        });
      inFlight.set(key, promise);
      return promise;
    },
    size: () => entries.size,
  };
};
