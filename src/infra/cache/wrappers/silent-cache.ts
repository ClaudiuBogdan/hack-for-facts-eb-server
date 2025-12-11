/**
 * Silent degradation wrapper for cache ports.
 * Errors are logged and swallowed - never propagated to callers.
 */

import type { CachePort, CacheSetOptions, CacheStats, SilentCachePort } from '../ports.js';
import type { Logger } from 'pino';

export interface SilentCacheOptions {
  /** Logger for recording cache errors */
  logger: Logger;
}

/**
 * Create a silent cache wrapper that swallows errors.
 * All cache failures are logged and treated as cache misses.
 */
export const createSilentCache = <T>(
  cache: CachePort<T>,
  options: SilentCacheOptions
): SilentCachePort<T> => {
  const { logger } = options;

  return {
    async get(key: string): Promise<T | undefined> {
      const result = await cache.get(key);

      if (result.isErr()) {
        logger.warn({ err: result.error, key }, `[Cache] Get failed: ${result.error.message}`);
        return undefined;
      }

      return result.value;
    },

    async set(key: string, value: T, setOptions?: CacheSetOptions): Promise<void> {
      const result = await cache.set(key, value, setOptions);

      if (result.isErr()) {
        logger.warn({ err: result.error, key }, `[Cache] Set failed: ${result.error.message}`);
      }
    },

    async delete(key: string): Promise<boolean> {
      const result = await cache.delete(key);

      if (result.isErr()) {
        logger.warn({ err: result.error, key }, `[Cache] Delete failed: ${result.error.message}`);
        return false;
      }

      return result.value;
    },

    async has(key: string): Promise<boolean> {
      const result = await cache.has(key);

      if (result.isErr()) {
        logger.warn({ err: result.error, key }, `[Cache] Has failed: ${result.error.message}`);
        return false;
      }

      return result.value;
    },

    async clearByPrefix(prefix: string): Promise<number> {
      const result = await cache.clearByPrefix(prefix);

      if (result.isErr()) {
        logger.warn(
          { err: result.error, prefix },
          `[Cache] ClearByPrefix failed: ${result.error.message}`
        );
        return 0;
      }

      return result.value;
    },

    async clear(): Promise<void> {
      const result = await cache.clear();

      if (result.isErr()) {
        logger.warn({ err: result.error }, `[Cache] Clear failed: ${result.error.message}`);
      }
    },

    async stats(): Promise<CacheStats> {
      return cache.stats();
    },
  };
};
