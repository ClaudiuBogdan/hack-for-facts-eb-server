/**
 * Cache adapters - backend implementations.
 */

export { createNoopCache } from './noop-cache.js';
export { createMemoryCache, type MemoryCacheOptions } from './memory-cache.js';
export {
  createRedisCache,
  createRedisCacheWithClient,
  createRedisCacheFromClient,
  type RedisCacheOptions,
} from './redis-cache.js';
export { createMultiLevelCache, type MultiLevelCacheOptions } from './multi-level-cache.js';
