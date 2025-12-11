interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LruCache<K, V> {
  private readonly store: Map<K, CacheEntry<V>>;
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(options: { max: number; ttlMs: number }) {
    this.max = options.max;
    this.ttlMs = options.ttlMs;
    this.store = new Map();
  }

  get(key: K): V | undefined {
    const now = Date.now();
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;

    if (entry.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }

    // Refresh LRU order
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.max) {
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) {
        this.store.delete(lruKey);
      }
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}
