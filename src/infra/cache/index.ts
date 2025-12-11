/**
 * Cache Infrastructure
 *
 * A pluggable caching layer with silent degradation.
 * Cache failures never cause request failures.
 *
 * @example
 * ```typescript
 * import { initCache, createCacheConfig, CacheNamespace, withCache } from '@/infra/cache';
 *
 * // Initialize cache
 * const cacheConfig = createCacheConfig(process.env);
 * const { cache, keyBuilder } = initCache({ config: cacheConfig, logger });
 *
 * // Use with decorator pattern
 * const cachedFn = withCache(
 *   repo.getData.bind(repo),
 *   cache,
 *   {
 *     namespace: CacheNamespace.ANALYTICS_EXECUTION,
 *     ttlMs: 3600000,
 *     keyGenerator: ([filter]) => keyBuilder.fromFilter(CacheNamespace.ANALYTICS_EXECUTION, filter),
 *   }
 * );
 *
 * // Or use explicitly
 * const key = keyBuilder.fromFilter(CacheNamespace.DATASETS, filter);
 * const cached = await cache.get(key);
 * if (cached === undefined) {
 *   const data = await fetchData();
 *   await cache.set(key, data);
 * }
 * ```
 */

// Ports (interfaces)
export type {
  CachePort,
  SilentCachePort,
  CacheError,
  CacheSetOptions,
  CacheStats,
} from './ports.js';
export { CacheError as CacheErrorFactory } from './ports.js';

// Key generation
export {
  CacheNamespace,
  createKeyBuilder,
  type KeyBuilder,
  type KeyBuilderOptions,
} from './key-builder.js';

// Serialization
export { serialize, deserialize } from './serialization.js';

// Adapters
export {
  createNoopCache,
  createMemoryCache,
  createRedisCache,
  createRedisCacheWithClient,
  createRedisCacheFromClient,
  createMultiLevelCache,
  type MemoryCacheOptions,
  type RedisCacheOptions,
  type MultiLevelCacheOptions,
} from './adapters/index.js';

// Wrappers
export { createSilentCache, type SilentCacheOptions } from './wrappers/index.js';

// Decorator
export { withCache, withCacheResult, type WithCacheOptions } from './with-cache.js';

// Client factory
export {
  initCache,
  createCacheConfig,
  detectBackend,
  type CacheBackend,
  type CacheConfig,
  type CacheClient,
  type CacheEnv,
  type InitCacheOptions,
} from './client.js';
