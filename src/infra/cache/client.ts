/**
 * Cache client factory - creates and configures cache instances.
 */

import {
  createMemoryCache,
  createMultiLevelCache,
  createNoopCache,
  createRedisCache,
} from './adapters/index.js';
import { createKeyBuilder, type KeyBuilder } from './key-builder.js';
import { createSilentCache } from './wrappers/index.js';

import type { CachePort, SilentCachePort } from './ports.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

export type CacheBackend = 'disabled' | 'memory' | 'redis' | 'multi';

export interface CacheConfig {
  /** Cache backend to use */
  backend: CacheBackend;
  /** Default TTL in milliseconds. Default: 3600000 (1 hour) */
  defaultTtlMs: number;
  /** Max entries for memory cache. Default: 1000 */
  memoryMaxEntries: number;
  /** Max entries for L1 cache in multi-level mode. Default: 500 */
  l1MaxEntries: number;
  /** Redis connection URL (required if backend is 'redis' or 'multi') */
  redisUrl: string | undefined;
  /** Key prefix for all cache keys. Default: 'transparenta' */
  keyPrefix: string;
}

export interface CacheClient<T = unknown> {
  /** Silent cache port for application use */
  cache: SilentCachePort<T>;
  /** Key builder for generating cache keys */
  keyBuilder: KeyBuilder;
  /** Low-level cache port (for testing/advanced use) */
  rawCache: CachePort<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Detection
// ─────────────────────────────────────────────────────────────────────────────

export interface CacheEnv {
  cache_backend?: string;
  cache_default_ttl_ms?: string;
  cache_memory_max_entries?: string;
  cache_l1_max_entries?: string;
  redis_url?: string;
}

/**
 * Detect cache backend from environment.
 * - Explicit cache_backend takes precedence
 * - If redis_url is set, use Redis
 * - Otherwise, use memory
 */
export const detectBackend = (env: CacheEnv): CacheBackend => {
  if (env.cache_backend !== undefined && env.cache_backend !== '') {
    const backend = env.cache_backend.toLowerCase();
    if (
      backend === 'disabled' ||
      backend === 'memory' ||
      backend === 'redis' ||
      backend === 'multi'
    ) {
      return backend;
    }
  }

  if (env.redis_url !== undefined && env.redis_url !== '') {
    return 'redis';
  }

  return 'memory';
};

/**
 * Create cache configuration from environment variables.
 */
export const createCacheConfig = (env: CacheEnv): CacheConfig => {
  const backend = detectBackend(env);

  const defaultTtlMs =
    env.cache_default_ttl_ms !== undefined && env.cache_default_ttl_ms !== ''
      ? Number.parseInt(env.cache_default_ttl_ms, 10)
      : 3600000;

  const memoryMaxEntries =
    env.cache_memory_max_entries !== undefined && env.cache_memory_max_entries !== ''
      ? Number.parseInt(env.cache_memory_max_entries, 10)
      : 1000;

  const l1MaxEntries =
    env.cache_l1_max_entries !== undefined && env.cache_l1_max_entries !== ''
      ? Number.parseInt(env.cache_l1_max_entries, 10)
      : 500;

  return {
    backend,
    defaultTtlMs,
    memoryMaxEntries,
    l1MaxEntries,
    redisUrl: env.redis_url,
    keyPrefix: 'transparenta',
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Cache Initialization
// ─────────────────────────────────────────────────────────────────────────────

export interface InitCacheOptions {
  config: CacheConfig;
  logger: Logger;
}

/**
 * Initialize the cache infrastructure.
 * Returns a cache client with silent degradation.
 */
export const initCache = <T = unknown>(options: InitCacheOptions): CacheClient<T> => {
  const { config, logger } = options;

  const keyBuilder = createKeyBuilder({ globalPrefix: config.keyPrefix });

  let rawCache: CachePort<T>;

  switch (config.backend) {
    case 'disabled':
      logger.info('[Cache] Using NoOp cache (disabled)');
      rawCache = createNoopCache<T>();
      break;

    case 'redis':
      if (config.redisUrl === undefined || config.redisUrl === '') {
        logger.warn('[Cache] Redis URL not configured, falling back to memory cache');
        rawCache = createMemoryCache<T>({
          maxEntries: config.memoryMaxEntries,
          defaultTtlMs: config.defaultTtlMs,
        });
      } else {
        logger.info('[Cache] Using Redis cache');
        rawCache = createRedisCache<T>({
          url: config.redisUrl,
          keyPrefix: config.keyPrefix,
          defaultTtlMs: config.defaultTtlMs,
        });
      }
      break;

    case 'multi':
      if (config.redisUrl === undefined || config.redisUrl === '') {
        logger.warn('[Cache] Multi-level requested but no Redis URL, falling back to memory cache');
        rawCache = createMemoryCache<T>({
          maxEntries: config.memoryMaxEntries,
          defaultTtlMs: config.defaultTtlMs,
        });
      } else {
        logger.info(
          { l1MaxEntries: config.l1MaxEntries, defaultTtlMs: config.defaultTtlMs },
          '[Cache] Using multi-level cache (L1: memory, L2: Redis)'
        );
        const l1 = createMemoryCache<T>({
          maxEntries: config.l1MaxEntries,
          defaultTtlMs: config.defaultTtlMs,
        });
        const l2 = createRedisCache<T>({
          url: config.redisUrl,
          keyPrefix: config.keyPrefix,
          defaultTtlMs: config.defaultTtlMs,
        });
        rawCache = createMultiLevelCache({ l1, l2 });
      }
      break;

    case 'memory':
    default:
      logger.info(
        { maxEntries: config.memoryMaxEntries, defaultTtlMs: config.defaultTtlMs },
        '[Cache] Using in-memory LRU cache'
      );
      rawCache = createMemoryCache<T>({
        maxEntries: config.memoryMaxEntries,
        defaultTtlMs: config.defaultTtlMs,
      });
      break;
  }

  const cache = createSilentCache<T>(rawCache, { logger });

  return {
    cache,
    keyBuilder,
    rawCache,
  };
};
