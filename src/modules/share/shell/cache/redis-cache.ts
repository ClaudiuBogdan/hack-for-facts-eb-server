/**
 * Redis Cache Adapter for Short Links
 *
 * Provides caching for resolved short links using Redis.
 */

import type { ShortLinkCache } from '../../core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic Redis client interface.
 * Compatible with ioredis or node-redis.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

/**
 * Options for creating the Redis cache.
 */
export interface RedisShortLinkCacheOptions {
  /** Redis client instance */
  redis: RedisClient;
  /** Cache key prefix */
  keyPrefix?: string;
  /** TTL in seconds (0 = no expiry) */
  ttlSeconds: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redis-based short link cache.
 */
class RedisShortLinkCache implements ShortLinkCache {
  private readonly redis: RedisClient;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  constructor(options: RedisShortLinkCacheOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix ?? 'shortlink:';
    this.ttlSeconds = options.ttlSeconds;
  }

  async get(code: string): Promise<string | null> {
    const key = this.keyPrefix + code;
    try {
      return await this.redis.get(key);
    } catch {
      // Cache errors should not break functionality
      return null;
    }
  }

  async set(code: string, originalUrl: string): Promise<void> {
    const key = this.keyPrefix + code;
    try {
      if (this.ttlSeconds > 0) {
        // Set with TTL (EX = seconds)
        await this.redis.set(key, originalUrl, 'EX', this.ttlSeconds);
      } else {
        // Set without expiry
        await this.redis.set(key, originalUrl);
      }
    } catch {
      // Cache errors should not break functionality
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Redis-based short link cache.
 */
export const makeRedisShortLinkCache = (options: RedisShortLinkCacheOptions): ShortLinkCache => {
  return new RedisShortLinkCache(options);
};
