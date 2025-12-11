/**
 * No-op cache adapter for when caching is disabled.
 * All operations succeed but do nothing.
 */

import { ok } from 'neverthrow';

import type { CachePort, CacheSetOptions, CacheStats } from '../ports.js';

/**
 * Create a no-op cache that does nothing.
 * Useful for testing and when caching should be disabled.
 */
export const createNoopCache = <T>(): CachePort<T> => {
  return {
    get(_key: string) {
      return Promise.resolve(ok(undefined));
    },

    set(_key: string, _value: T, _options?: CacheSetOptions) {
      return Promise.resolve(ok(undefined));
    },

    delete(_key: string) {
      return Promise.resolve(ok(false));
    },

    has(_key: string) {
      return Promise.resolve(ok(false));
    },

    clearByPrefix(_prefix: string) {
      return Promise.resolve(ok(0));
    },

    clear() {
      return Promise.resolve(ok(undefined));
    },

    stats(): Promise<CacheStats> {
      return Promise.resolve({ hits: 0, misses: 0, size: 0 });
    },
  };
};
