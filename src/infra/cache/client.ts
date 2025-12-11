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
  /** Redis password for authentication */
  redisPassword: string | undefined;
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

/**
 * Environment variables for cache configuration.
 * Supports both UPPER_CASE (process.env) and lower_case formats.
 */
export type CacheEnv = Record<string, string | undefined>;

/**
 * Detect cache backend from environment.
 * - Explicit cache_backend takes precedence
 * - If redis_url is set, use Redis
 * - Otherwise, use memory
 */
export const detectBackend = (env: CacheEnv): CacheBackend => {
  const backendValue = env['CACHE_BACKEND'] ?? env['cache_backend'];
  if (backendValue !== undefined && backendValue !== '') {
    const backend = backendValue.toLowerCase();
    if (
      backend === 'disabled' ||
      backend === 'memory' ||
      backend === 'redis' ||
      backend === 'multi'
    ) {
      return backend;
    }
  }

  const redisUrl = env['REDIS_URL'] ?? env['redis_url'];
  if (redisUrl !== undefined && redisUrl !== '') {
    return 'redis';
  }

  return 'memory';
};

// ─────────────────────────────────────────────────────────────────────────────
// Configuration Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** 60 days in milliseconds */
const DEFAULT_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 5,184,000,000 ms
/** Default max entries for memory cache */
const DEFAULT_MEMORY_MAX_ENTRIES = 1000;
/** Default max entries for L1 cache in multi-level mode */
const DEFAULT_L1_MAX_ENTRIES = 500;

/**
 * Safely parse an integer from a string, returning the default if invalid.
 */
const parseConfigInt = (value: string | undefined, defaultValue: number): number => {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
};

/**
 * Create cache configuration from environment variables.
 */
export const createCacheConfig = (env: CacheEnv): CacheConfig => {
  const backend = detectBackend(env);

  const ttlValue = env['CACHE_DEFAULT_TTL_MS'] ?? env['cache_default_ttl_ms'];
  const defaultTtlMs = parseConfigInt(ttlValue, DEFAULT_TTL_MS);

  const memoryValue = env['CACHE_MEMORY_MAX_ENTRIES'] ?? env['cache_memory_max_entries'];
  const memoryMaxEntries = parseConfigInt(memoryValue, DEFAULT_MEMORY_MAX_ENTRIES);

  const l1Value = env['CACHE_L1_MAX_ENTRIES'] ?? env['cache_l1_max_entries'];
  const l1MaxEntries = parseConfigInt(l1Value, DEFAULT_L1_MAX_ENTRIES);

  const redisUrl = env['REDIS_URL'] ?? env['redis_url'];
  const redisPassword = env['REDIS_PASSWORD'] ?? env['redis_password'];
  const keyPrefix = env['REDIS_PREFIX'] ?? env['redis_prefix'] ?? 'transparenta';

  return {
    backend,
    defaultTtlMs,
    memoryMaxEntries,
    l1MaxEntries,
    redisUrl,
    redisPassword,
    keyPrefix,
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
          ...(config.redisPassword !== undefined && { password: config.redisPassword }),
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
          {
            l1MaxEntries: config.l1MaxEntries,
            defaultTtlMs: config.defaultTtlMs,
            redisUrl: config.redisUrl.replace(/\/\/.*@/, '//<redacted>@'),
          },
          '[Cache] Using multi-level cache (L1: memory, L2: Redis)'
        );
        const l1 = createMemoryCache<T>({
          maxEntries: config.l1MaxEntries,
          defaultTtlMs: config.defaultTtlMs,
        });
        const l2 = createRedisCache<T>({
          url: config.redisUrl,
          ...(config.redisPassword !== undefined && { password: config.redisPassword }),
          keyPrefix: config.keyPrefix,
          defaultTtlMs: config.defaultTtlMs,
        });
        rawCache = createMultiLevelCache({ l1, l2, logger });
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
