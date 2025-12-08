/**
 * Unit tests for cache client configuration
 */

import { describe, expect, it } from 'vitest';

import { createCacheConfig, detectBackend, type CacheEnv } from '@/infra/cache/index.js';

describe('Cache Client', () => {
  describe('detectBackend', () => {
    it('returns "memory" when no env vars are set', () => {
      const backend = detectBackend({});
      expect(backend).toBe('memory');
    });

    it('returns explicit CACHE_BACKEND value', () => {
      expect(detectBackend({ CACHE_BACKEND: 'disabled' })).toBe('disabled');
      expect(detectBackend({ CACHE_BACKEND: 'memory' })).toBe('memory');
      expect(detectBackend({ CACHE_BACKEND: 'redis' })).toBe('redis');
      expect(detectBackend({ CACHE_BACKEND: 'multi' })).toBe('multi');
    });

    it('is case-insensitive for CACHE_BACKEND', () => {
      expect(detectBackend({ CACHE_BACKEND: 'REDIS' })).toBe('redis');
      expect(detectBackend({ CACHE_BACKEND: 'Multi' })).toBe('multi');
    });

    it('returns "redis" when REDIS_URL is set and no explicit backend', () => {
      const backend = detectBackend({ REDIS_URL: 'redis://localhost:6379' });
      expect(backend).toBe('redis');
    });

    it('prefers explicit CACHE_BACKEND over REDIS_URL detection', () => {
      const backend = detectBackend({
        CACHE_BACKEND: 'memory',
        REDIS_URL: 'redis://localhost:6379',
      });
      expect(backend).toBe('memory');
    });

    it('ignores invalid CACHE_BACKEND values and falls back to detection', () => {
      const backend = detectBackend({
        CACHE_BACKEND: 'invalid',
        REDIS_URL: 'redis://localhost:6379',
      });
      expect(backend).toBe('redis');
    });
  });

  describe('createCacheConfig', () => {
    const DEFAULT_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
    const DEFAULT_MEMORY_MAX_ENTRIES = 1000;
    const DEFAULT_L1_MAX_ENTRIES = 500;

    it('returns default values when env is empty', () => {
      const config = createCacheConfig({});

      expect(config.backend).toBe('memory');
      expect(config.defaultTtlMs).toBe(DEFAULT_TTL_MS);
      expect(config.memoryMaxEntries).toBe(DEFAULT_MEMORY_MAX_ENTRIES);
      expect(config.l1MaxEntries).toBe(DEFAULT_L1_MAX_ENTRIES);
      expect(config.redisUrl).toBeUndefined();
      expect(config.keyPrefix).toBe('transparenta');
    });

    it('parses valid numeric environment variables', () => {
      const env: CacheEnv = {
        CACHE_DEFAULT_TTL_MS: '7200000',
        CACHE_MEMORY_MAX_ENTRIES: '2000',
        CACHE_L1_MAX_ENTRIES: '750',
      };

      const config = createCacheConfig(env);

      expect(config.defaultTtlMs).toBe(7200000);
      expect(config.memoryMaxEntries).toBe(2000);
      expect(config.l1MaxEntries).toBe(750);
    });

    it('falls back to defaults for invalid (NaN) numeric values', () => {
      const env: CacheEnv = {
        CACHE_DEFAULT_TTL_MS: 'invalid',
        CACHE_MEMORY_MAX_ENTRIES: 'abc',
        CACHE_L1_MAX_ENTRIES: 'not-a-number',
      };

      const config = createCacheConfig(env);

      expect(config.defaultTtlMs).toBe(DEFAULT_TTL_MS);
      expect(config.memoryMaxEntries).toBe(DEFAULT_MEMORY_MAX_ENTRIES);
      expect(config.l1MaxEntries).toBe(DEFAULT_L1_MAX_ENTRIES);
    });

    it('falls back to defaults for empty string values', () => {
      const env: CacheEnv = {
        CACHE_DEFAULT_TTL_MS: '',
        CACHE_MEMORY_MAX_ENTRIES: '',
        CACHE_L1_MAX_ENTRIES: '',
      };

      const config = createCacheConfig(env);

      expect(config.defaultTtlMs).toBe(DEFAULT_TTL_MS);
      expect(config.memoryMaxEntries).toBe(DEFAULT_MEMORY_MAX_ENTRIES);
      expect(config.l1MaxEntries).toBe(DEFAULT_L1_MAX_ENTRIES);
    });

    it('parses leading numeric values (parseInt behavior)', () => {
      // Note: parseInt('123abc') returns 123, which is valid behavior
      const env: CacheEnv = {
        CACHE_DEFAULT_TTL_MS: '123abc',
        CACHE_MEMORY_MAX_ENTRIES: '500xyz',
      };

      const config = createCacheConfig(env);

      expect(config.defaultTtlMs).toBe(123);
      expect(config.memoryMaxEntries).toBe(500);
    });

    it('supports lowercase environment variable names', () => {
      const env: CacheEnv = {
        cache_default_ttl_ms: '5000',
        cache_memory_max_entries: '100',
        cache_l1_max_entries: '50',
        cache_backend: 'memory',
        redis_url: 'redis://localhost:6379',
      };

      const config = createCacheConfig(env);

      expect(config.defaultTtlMs).toBe(5000);
      expect(config.memoryMaxEntries).toBe(100);
      expect(config.l1MaxEntries).toBe(50);
      expect(config.backend).toBe('memory');
      expect(config.redisUrl).toBe('redis://localhost:6379');
    });

    it('prefers UPPER_CASE over lower_case env vars', () => {
      const env: CacheEnv = {
        CACHE_DEFAULT_TTL_MS: '9000',
        cache_default_ttl_ms: '1000',
      };

      const config = createCacheConfig(env);

      expect(config.defaultTtlMs).toBe(9000);
    });

    it('includes redisUrl when provided', () => {
      const env: CacheEnv = {
        REDIS_URL: 'redis://localhost:6379',
      };

      const config = createCacheConfig(env);

      expect(config.redisUrl).toBe('redis://localhost:6379');
      expect(config.backend).toBe('redis');
    });
  });
});
