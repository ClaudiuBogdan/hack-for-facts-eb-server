import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { CacheError, type CachePort, type CacheStats } from '@/infra/cache/ports.js';
import { createSilentCache } from '@/infra/cache/wrappers/silent-cache.js';

const createMockLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => createMockLogger()),
  level: 'info',
  silent: vi.fn(),
});

const createMockCache = <T>(): CachePort<T> & {
  _setGetResult: (result: ReturnType<CachePort<T>['get']>) => void;
  _setSetResult: (result: ReturnType<CachePort<T>['set']>) => void;
  _setDeleteResult: (result: ReturnType<CachePort<T>['delete']>) => void;
  _setHasResult: (result: ReturnType<CachePort<T>['has']>) => void;
  _setClearByPrefixResult: (result: ReturnType<CachePort<T>['clearByPrefix']>) => void;
  _setClearResult: (result: ReturnType<CachePort<T>['clear']>) => void;
} => {
  let getResult: ReturnType<CachePort<T>['get']> = Promise.resolve(ok(undefined));
  let setResult: ReturnType<CachePort<T>['set']> = Promise.resolve(ok(undefined));
  let deleteResult: ReturnType<CachePort<T>['delete']> = Promise.resolve(ok(false));
  let hasResult: ReturnType<CachePort<T>['has']> = Promise.resolve(ok(false));
  let clearByPrefixResult: ReturnType<CachePort<T>['clearByPrefix']> = Promise.resolve(ok(0));
  let clearResult: ReturnType<CachePort<T>['clear']> = Promise.resolve(ok(undefined));

  return {
    get: vi.fn(() => getResult),
    set: vi.fn(() => setResult),
    delete: vi.fn(() => deleteResult),
    has: vi.fn(() => hasResult),
    clearByPrefix: vi.fn(() => clearByPrefixResult),
    clear: vi.fn(() => clearResult),
    stats: vi.fn(() => Promise.resolve({ hits: 0, misses: 0, size: 0 } as CacheStats)),
    _setGetResult: (r) => {
      getResult = r;
    },
    _setSetResult: (r) => {
      setResult = r;
    },
    _setDeleteResult: (r) => {
      deleteResult = r;
    },
    _setHasResult: (r) => {
      hasResult = r;
    },
    _setClearByPrefixResult: (r) => {
      clearByPrefixResult = r;
    },
    _setClearResult: (r) => {
      clearResult = r;
    },
  };
};

describe('SilentCache', () => {
  describe('get', () => {
    it('returns value when cache succeeds', async () => {
      const mockCache = createMockCache<string>();
      mockCache._setGetResult(Promise.resolve(ok('cached-value')));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      const result = await silentCache.get('key');

      expect(result).toBe('cached-value');
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('returns undefined and logs warning when cache fails', async () => {
      const mockCache = createMockCache<string>();
      mockCache._setGetResult(Promise.resolve(err(CacheError.connection('Connection failed'))));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      const result = await silentCache.get('key');

      expect(result).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'key' }),
        expect.stringContaining('Get failed')
      );
    });
  });

  describe('set', () => {
    it('succeeds silently when cache works', async () => {
      const mockCache = createMockCache<string>();
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      await silentCache.set('key', 'value');

      expect(mockCache.set).toHaveBeenCalledWith('key', 'value', undefined);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs warning and continues when cache fails', async () => {
      const mockCache = createMockCache<string>();
      mockCache._setSetResult(Promise.resolve(err(CacheError.timeout('Timeout'))));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      // Should not throw
      await silentCache.set('key', 'value');

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'key' }),
        expect.stringContaining('Set failed')
      );
    });
  });

  describe('delete', () => {
    it('returns true when key existed', async () => {
      const mockCache = createMockCache<string>();
      mockCache._setDeleteResult(Promise.resolve(ok(true)));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      const result = await silentCache.delete('key');

      expect(result).toBe(true);
    });

    it('returns false when cache fails', async () => {
      const mockCache = createMockCache<string>();
      mockCache._setDeleteResult(Promise.resolve(err(CacheError.connection('Error'))));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      const result = await silentCache.delete('key');

      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('has', () => {
    it('returns true when key exists', async () => {
      const mockCache = createMockCache<string>();
      mockCache._setHasResult(Promise.resolve(ok(true)));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      const result = await silentCache.has('key');

      expect(result).toBe(true);
    });

    it('returns false when cache fails', async () => {
      const mockCache = createMockCache<string>();
      mockCache._setHasResult(Promise.resolve(err(CacheError.serialization('Error'))));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      const result = await silentCache.has('key');

      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('clearByPrefix', () => {
    it('returns count when successful', async () => {
      const mockCache = createMockCache<string>();
      mockCache._setClearByPrefixResult(Promise.resolve(ok(5)));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      const result = await silentCache.clearByPrefix('prefix:');

      expect(result).toBe(5);
    });

    it('returns 0 when cache fails', async () => {
      const mockCache = createMockCache<string>();
      mockCache._setClearByPrefixResult(Promise.resolve(err(CacheError.connection('Error'))));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      const result = await silentCache.clearByPrefix('prefix:');

      expect(result).toBe(0);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('succeeds silently when cache works', async () => {
      const mockCache = createMockCache<string>();
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      await silentCache.clear();

      expect(mockCache.clear).toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('logs warning when cache fails', async () => {
      const mockCache = createMockCache<string>();
      mockCache._setClearResult(Promise.resolve(err(CacheError.timeout('Error'))));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      await silentCache.clear();

      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('stats', () => {
    it('returns stats from underlying cache', async () => {
      const mockCache = createMockCache<string>();
      const expectedStats = { hits: 10, misses: 5, size: 100 };
      mockCache.stats = vi.fn(() => Promise.resolve(expectedStats));
      const logger = createMockLogger();
      const silentCache = createSilentCache(mockCache, { logger: logger as never });

      const result = await silentCache.stats();

      expect(result).toEqual(expectedStats);
    });
  });
});
