import { describe, expect, it } from 'vitest';

import { createMemoryCache } from '@/infra/cache/adapters/memory-cache.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('MemoryCache', () => {
  it('returns undefined for missing keys', async () => {
    const cache = createMemoryCache<string>({ maxEntries: 10, defaultTtlMs: 1000 });
    const result = await cache.get('missing');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it('stores and retrieves values', async () => {
    const cache = createMemoryCache<string>({ maxEntries: 10, defaultTtlMs: 1000 });
    await cache.set('key', 'value');
    const result = await cache.get('key');
    expect(result._unsafeUnwrap()).toBe('value');
  });

  it('stores and retrieves objects', async () => {
    const cache = createMemoryCache<{ name: string; age: number }>();
    const obj = { name: 'test', age: 25 };
    await cache.set('key', obj);
    const result = await cache.get('key');
    expect(result._unsafeUnwrap()).toEqual(obj);
  });

  it('respects TTL expiration', async () => {
    const cache = createMemoryCache<string>({ maxEntries: 10, defaultTtlMs: 50 });
    await cache.set('key', 'value');
    await sleep(100);
    const result = await cache.get('key');
    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it('allows custom TTL per set operation', async () => {
    const cache = createMemoryCache<string>({ maxEntries: 10, defaultTtlMs: 1000 });
    await cache.set('short', 'value', { ttlMs: 50 });
    await cache.set('long', 'value', { ttlMs: 5000 });

    await sleep(100);

    const shortResult = await cache.get('short');
    const longResult = await cache.get('long');

    expect(shortResult._unsafeUnwrap()).toBeUndefined();
    expect(longResult._unsafeUnwrap()).toBe('value');
  });

  it('evicts LRU entries when at capacity', async () => {
    const cache = createMemoryCache<string>({ maxEntries: 2, defaultTtlMs: 10000 });
    await cache.set('a', '1');
    await cache.set('b', '2');
    await cache.set('c', '3'); // Should evict 'a'

    expect((await cache.get('a'))._unsafeUnwrap()).toBeUndefined();
    expect((await cache.get('b'))._unsafeUnwrap()).toBe('2');
    expect((await cache.get('c'))._unsafeUnwrap()).toBe('3');
  });

  it('refreshes LRU order on get', async () => {
    const cache = createMemoryCache<string>({ maxEntries: 2, defaultTtlMs: 10000 });
    await cache.set('a', '1');
    await cache.set('b', '2');

    // Access 'a' to make it more recent than 'b'
    await cache.get('a');

    // This should evict 'b' (least recently used)
    await cache.set('c', '3');

    expect((await cache.get('a'))._unsafeUnwrap()).toBe('1');
    expect((await cache.get('b'))._unsafeUnwrap()).toBeUndefined();
    expect((await cache.get('c'))._unsafeUnwrap()).toBe('3');
  });

  it('deletes existing keys', async () => {
    const cache = createMemoryCache<string>();
    await cache.set('key', 'value');
    const deleted = await cache.delete('key');
    expect(deleted._unsafeUnwrap()).toBe(true);
    expect((await cache.get('key'))._unsafeUnwrap()).toBeUndefined();
  });

  it('returns false when deleting non-existent key', async () => {
    const cache = createMemoryCache<string>();
    const deleted = await cache.delete('nonexistent');
    expect(deleted._unsafeUnwrap()).toBe(false);
  });

  it('checks key existence with has()', async () => {
    const cache = createMemoryCache<string>({ defaultTtlMs: 1000 });
    await cache.set('key', 'value');

    expect((await cache.has('key'))._unsafeUnwrap()).toBe(true);
    expect((await cache.has('missing'))._unsafeUnwrap()).toBe(false);
  });

  it('has() returns false for expired keys', async () => {
    const cache = createMemoryCache<string>({ defaultTtlMs: 50 });
    await cache.set('key', 'value');

    expect((await cache.has('key'))._unsafeUnwrap()).toBe(true);
    await sleep(100);
    expect((await cache.has('key'))._unsafeUnwrap()).toBe(false);
  });

  it('clears entries by prefix', async () => {
    const cache = createMemoryCache<string>();
    await cache.set('analytics:a', '1');
    await cache.set('analytics:b', '2');
    await cache.set('datasets:c', '3');

    const cleared = await cache.clearByPrefix('analytics:');
    expect(cleared._unsafeUnwrap()).toBe(2);

    expect((await cache.get('analytics:a'))._unsafeUnwrap()).toBeUndefined();
    expect((await cache.get('analytics:b'))._unsafeUnwrap()).toBeUndefined();
    expect((await cache.get('datasets:c'))._unsafeUnwrap()).toBe('3');
  });

  it('clears all entries', async () => {
    const cache = createMemoryCache<string>();
    await cache.set('a', '1');
    await cache.set('b', '2');

    await cache.clear();

    expect((await cache.get('a'))._unsafeUnwrap()).toBeUndefined();
    expect((await cache.get('b'))._unsafeUnwrap()).toBeUndefined();
  });

  it('tracks cache statistics', async () => {
    const cache = createMemoryCache<string>();
    await cache.set('key', 'value');

    await cache.get('key'); // hit
    await cache.get('key'); // hit
    await cache.get('missing'); // miss

    const stats = await cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.size).toBe(1);
  });

  it('resets stats on clear', async () => {
    const cache = createMemoryCache<string>();
    await cache.set('key', 'value');
    await cache.get('key');
    await cache.get('missing');

    await cache.clear();

    const stats = await cache.stats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.size).toBe(0);
  });
});
