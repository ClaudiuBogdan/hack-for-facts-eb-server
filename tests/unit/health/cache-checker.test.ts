/**
 * Unit tests for cache health checker
 */

import { describe, it, expect } from 'vitest';

import { makeCacheHealthChecker } from '@/modules/health/shell/checkers/cache-checker.js';

import { makeFakeCachePort } from '../../fixtures/fakes.js';

describe('makeCacheHealthChecker', () => {
  describe('healthy cache', () => {
    it('returns healthy status when cache responds', async () => {
      const cache = makeFakeCachePort();
      const checker = makeCacheHealthChecker(cache);

      const result = await checker();

      expect(result.name).toBe('cache');
      expect(result.status).toBe('healthy');
      expect(result.critical).toBe(false);
      expect(result.latencyMs).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.message).toBeUndefined();
    });

    it('returns latency measurement', async () => {
      const cache = makeFakeCachePort({ delayMs: 10 });
      const checker = makeCacheHealthChecker(cache);

      const result = await checker();

      expect(result.status).toBe('healthy');
      expect(result.latencyMs).toBeGreaterThanOrEqual(10);
    });

    it('uses custom name', async () => {
      const cache = makeFakeCachePort();
      const checker = makeCacheHealthChecker(cache, { name: 'redis' });

      const result = await checker();

      expect(result.name).toBe('redis');
    });
  });

  describe('unhealthy cache', () => {
    it('returns unhealthy status when cache fails', async () => {
      const cache = makeFakeCachePort({
        failWithError: {
          type: 'ConnectionError',
          message: 'Redis connection refused',
        },
      });
      const checker = makeCacheHealthChecker(cache);

      const result = await checker();

      expect(result.name).toBe('cache');
      expect(result.status).toBe('unhealthy');
      expect(result.critical).toBe(false);
      expect(result.message).toBe('Redis connection refused');
      expect(result.latencyMs).toBeDefined();
    });

    it('returns unhealthy status when cache times out', async () => {
      // Create a cache that delays longer than the timeout
      const cache = makeFakeCachePort({ delayMs: 5000 });
      const checker = makeCacheHealthChecker(cache, {
        timeoutMs: 50, // Very short timeout for test
      });

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toContain('timed out');
      expect(result.latencyMs).toBeGreaterThanOrEqual(50);
      expect(result.latencyMs).toBeLessThan(5000); // Should not wait for full delay
    });

    it('handles timeout errors from cache', async () => {
      const cache = makeFakeCachePort({
        failWithError: {
          type: 'TimeoutError',
          message: 'Operation timed out',
        },
      });
      const checker = makeCacheHealthChecker(cache);

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toBe('Operation timed out');
    });
  });

  describe('timeout configuration', () => {
    it('uses default timeout of 3000ms', async () => {
      // This test verifies the default timeout doesn't trigger for fast queries
      const cache = makeFakeCachePort({ delayMs: 10 });
      const checker = makeCacheHealthChecker(cache);

      const result = await checker();

      expect(result.status).toBe('healthy');
    });

    it('respects custom timeout', async () => {
      const cache = makeFakeCachePort({ delayMs: 100 });
      const checker = makeCacheHealthChecker(cache, {
        timeoutMs: 50,
      });

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toContain('timed out after 50ms');
    });
  });

  describe('critical flag', () => {
    it('always marks result as non-critical', async () => {
      const healthyCache = makeFakeCachePort();
      const unhealthyCache = makeFakeCachePort({
        failWithError: { type: 'ConnectionError', message: 'Failed' },
      });

      const healthyResult = await makeCacheHealthChecker(healthyCache)();
      const unhealthyResult = await makeCacheHealthChecker(unhealthyCache)();

      expect(healthyResult.critical).toBe(false);
      expect(unhealthyResult.critical).toBe(false);
    });
  });

  describe('different error types', () => {
    it('handles ConnectionError', async () => {
      const cache = makeFakeCachePort({
        failWithError: {
          type: 'ConnectionError',
          message: 'ECONNREFUSED',
        },
      });
      const checker = makeCacheHealthChecker(cache);

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toBe('ECONNREFUSED');
    });

    it('handles SerializationError', async () => {
      const cache = makeFakeCachePort({
        failWithError: {
          type: 'SerializationError',
          message: 'JSON parse error',
        },
      });
      const checker = makeCacheHealthChecker(cache);

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toBe('JSON parse error');
    });

    it('handles generic exceptions', async () => {
      const cache = makeFakeCachePort();
      // Override has to throw a generic error
      cache.has = async () => {
        throw new Error('Unexpected error');
      };
      const checker = makeCacheHealthChecker(cache);

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toBe('Unexpected error');
    });

    it('handles non-Error exceptions', async () => {
      const cache = makeFakeCachePort();
      // Override has to throw a non-Error
      cache.has = async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Testing non-Error exception handling
        throw 'string error';
      };
      const checker = makeCacheHealthChecker(cache);

      const result = await checker();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toBe('Unknown cache error');
    });
  });
});
