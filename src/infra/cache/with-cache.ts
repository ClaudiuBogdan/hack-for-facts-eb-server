/**
 * Decorator function for adding caching to repository methods.
 */

import type { CacheNamespace } from './key-builder.js';
import type { CacheSetOptions, SilentCachePort } from './ports.js';

export interface WithCacheOptions<TArgs extends unknown[]> {
  /** Cache namespace for key generation */
  namespace: CacheNamespace;
  /** TTL in milliseconds */
  ttlMs?: number;
  /** Function to generate cache key from method arguments */
  keyGenerator: (args: TArgs) => string;
}

/**
 * Wrap a function with caching.
 * On first call, executes the function and caches the result.
 * On subsequent calls with same key, returns cached result.
 *
 * @example
 * ```typescript
 * const cachedFn = withCache(
 *   repo.getData.bind(repo),
 *   cache,
 *   {
 *     namespace: CacheNamespace.ANALYTICS_EXECUTION,
 *     ttlMs: 3600000,
 *     keyGenerator: ([filter]) => keyBuilder.fromFilter(filter),
 *   }
 * );
 * ```
 */
export const withCache = <TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  cache: SilentCachePort<TResult>,
  options: WithCacheOptions<TArgs>
): ((...args: TArgs) => Promise<TResult>) => {
  const { ttlMs, keyGenerator } = options;

  return async (...args: TArgs): Promise<TResult> => {
    const key = keyGenerator(args);

    // Check cache first
    const cached = await cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Execute original function
    const result = await fn(...args);

    // Cache the result
    const setOptions: CacheSetOptions | undefined = ttlMs !== undefined ? { ttlMs } : undefined;
    await cache.set(key, result, setOptions);

    return result;
  };
};

/**
 * Wrap a function that returns a Result with caching.
 * Only successful results are cached.
 *
 * @example
 * ```typescript
 * const cachedFn = withCacheResult(
 *   repo.getData.bind(repo),
 *   cache,
 *   {
 *     namespace: CacheNamespace.ANALYTICS_EXECUTION,
 *     ttlMs: 3600000,
 *     keyGenerator: ([filter]) => keyBuilder.fromFilter(filter),
 *   }
 * );
 * ```
 */
export const withCacheResult = <TArgs extends unknown[], TValue>(
  fn: (...args: TArgs) => Promise<{ isOk(): boolean; value?: TValue }>,
  cache: SilentCachePort<TValue>,
  options: WithCacheOptions<TArgs>
): ((...args: TArgs) => Promise<{ isOk(): boolean; value?: TValue }>) => {
  const { ttlMs, keyGenerator } = options;

  return async (...args: TArgs) => {
    const key = keyGenerator(args);

    // Check cache first
    const cached = await cache.get(key);
    if (cached !== undefined) {
      // Return a successful result with the cached value
      return { isOk: () => true, value: cached };
    }

    // Execute original function
    const result = await fn(...args);

    // Cache only successful results
    if (result.isOk() && result.value !== undefined) {
      const setOptions: CacheSetOptions | undefined = ttlMs !== undefined ? { ttlMs } : undefined;
      await cache.set(key, result.value, setOptions);
    }

    return result;
  };
};
