/**
 * Cache health checker
 *
 * Verifies cache connectivity by checking for a non-existent key.
 * Returns unhealthy if the cache operation fails or times out.
 * Marked as non-critical since the application can operate without cache.
 */

import type { HealthChecker } from '../../core/ports.js';
import type { HealthCheckResult } from '../../core/types.js';
import type { CachePort } from '@/infra/cache/index.js';

/** Default timeout for cache health check in milliseconds */
const DEFAULT_TIMEOUT_MS = 3000;

/** Key used for health check probes */
const HEALTH_CHECK_KEY = 'health:probe';

export interface CacheHealthCheckerOptions {
  /** Name to identify this cache in health check results (default: 'cache') */
  name?: string;
  /** Timeout in milliseconds (default: 3000) */
  timeoutMs?: number;
}

/**
 * Creates a health checker for a cache client.
 *
 * Uses the low-level CachePort (not SilentCachePort) to detect failures.
 * The checker attempts to check for a key's existence - if the operation
 * fails or times out, the cache is considered unhealthy.
 *
 * @param cache - Low-level cache port (CachePort, not SilentCachePort)
 * @param options - Checker configuration
 * @returns HealthChecker function
 *
 * @example
 * ```typescript
 * const cacheChecker = makeCacheHealthChecker(rawCache, { name: 'redis' });
 * const result = await cacheChecker();
 * // { name: 'redis', status: 'healthy', latencyMs: 2, critical: false }
 * ```
 */
export const makeCacheHealthChecker = (
  cache: CachePort,
  options: CacheHealthCheckerOptions = {}
): HealthChecker => {
  const { name = 'cache', timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  return async (): Promise<HealthCheckResult> => {
    const startTime = Date.now();

    try {
      // Create a promise that rejects after timeout
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`Cache health check timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
      });

      // Check for a non-existent key - we just care that the operation succeeds
      const checkPromise = cache.has(HEALTH_CHECK_KEY);

      const result = await Promise.race([checkPromise, timeoutPromise]);

      const latencyMs = Date.now() - startTime;

      // Result is a neverthrow Result type
      if (result.isErr()) {
        return {
          name,
          status: 'unhealthy',
          message: result.error.message,
          latencyMs,
          critical: false, // Cache is non-critical
        };
      }

      return {
        name,
        status: 'healthy',
        latencyMs,
        critical: false, // Cache is non-critical
      };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : 'Unknown cache error';

      return {
        name,
        status: 'unhealthy',
        message,
        latencyMs,
        critical: false, // Cache is non-critical
      };
    }
  };
};
