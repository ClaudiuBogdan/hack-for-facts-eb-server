/**
 * Unit tests for resolve-short-link use case
 *
 * Tests cover:
 * - Resolving codes to URLs (cache hit)
 * - Resolving codes to URLs (cache miss)
 * - Not found handling
 * - Access stats updates
 * - Database error handling
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { resolveShortLink } from '@/modules/share/core/usecases/resolve-short-link.js';

import {
  makeFakeShortLinkRepo,
  makeFakeShortLinkCache,
  createTestShortLink,
} from '../../fixtures/fakes.js';

describe('resolveShortLink use case', () => {
  // Use fake timers to control async fire-and-forget operations
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('cache hit', () => {
    it('returns URL from cache when available', async () => {
      const repo = makeFakeShortLinkRepo();
      const cache = makeFakeShortLinkCache({
        entries: new Map([['ABC123DEF456GHIJ', 'https://transparenta.eu/cached']]),
      });

      const result = await resolveShortLink(
        { shortLinkRepo: repo, cache },
        { code: 'ABC123DEF456GHIJ' }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.url).toBe('https://transparenta.eu/cached');
      }
    });

    it('does not query database on cache hit', async () => {
      let dbCalled = false;
      const repo = {
        ...makeFakeShortLinkRepo(),
        getByCode: async () => {
          dbCalled = true;
          return makeFakeShortLinkRepo().getByCode('any');
        },
      };
      const cache = makeFakeShortLinkCache({
        entries: new Map([['ABC123DEF456GHIJ', 'https://transparenta.eu/cached']]),
      });

      const result = await resolveShortLink(
        { shortLinkRepo: repo, cache },
        { code: 'ABC123DEF456GHIJ' }
      );

      expect(result.isOk()).toBe(true);
      expect(dbCalled).toBe(false);
    });
  });

  describe('cache miss', () => {
    it('returns URL from database when not in cache', async () => {
      const existingLink = createTestShortLink({
        code: 'ABC123DEF456GHIJ',
        originalUrl: 'https://transparenta.eu/from-db',
      });
      const repo = makeFakeShortLinkRepo({ shortLinks: [existingLink] });
      const cache = makeFakeShortLinkCache(); // Empty cache

      const result = await resolveShortLink(
        { shortLinkRepo: repo, cache },
        { code: 'ABC123DEF456GHIJ' }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.url).toBe('https://transparenta.eu/from-db');
      }
    });

    it('populates cache after database lookup', async () => {
      const existingLink = createTestShortLink({
        code: 'ABC123DEF456GHIJ',
        originalUrl: 'https://transparenta.eu/from-db',
      });
      const repo = makeFakeShortLinkRepo({ shortLinks: [existingLink] });
      const cache = makeFakeShortLinkCache();

      await resolveShortLink({ shortLinkRepo: repo, cache }, { code: 'ABC123DEF456GHIJ' });

      // Advance timers to let fire-and-forget operations complete
      await vi.runAllTimersAsync();

      // Verify cache was populated
      const cachedUrl = await cache.get('ABC123DEF456GHIJ');
      expect(cachedUrl).toBe('https://transparenta.eu/from-db');
    });
  });

  describe('not found handling', () => {
    it('returns error when code not found in cache or database', async () => {
      const repo = makeFakeShortLinkRepo();
      const cache = makeFakeShortLinkCache();

      const result = await resolveShortLink(
        { shortLinkRepo: repo, cache },
        { code: 'NONEXISTENT12345' }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('ShortLinkNotFoundError');
        if (result.error.type === 'ShortLinkNotFoundError') {
          expect(result.error.code).toBe('NONEXISTENT12345');
        }
      }
    });
  });

  describe('access statistics', () => {
    it('increments access count on successful resolution', async () => {
      const existingLink = createTestShortLink({
        code: 'ABC123DEF456GHIJ',
        originalUrl: 'https://transparenta.eu/page',
        accessCount: 5,
      });
      const repo = makeFakeShortLinkRepo({ shortLinks: [existingLink] });
      const cache = makeFakeShortLinkCache();

      await resolveShortLink({ shortLinkRepo: repo, cache }, { code: 'ABC123DEF456GHIJ' });

      // Advance timers to let fire-and-forget operations complete
      await vi.runAllTimersAsync();

      // Verify stats were updated
      const linkResult = await repo.getByCode('ABC123DEF456GHIJ');
      expect(linkResult.isOk()).toBe(true);
      if (linkResult.isOk() && linkResult.value !== null) {
        expect(linkResult.value.accessCount).toBe(6);
        expect(linkResult.value.lastAccessAt).not.toBeNull();
      }
    });

    it('increments stats on cache hit too', async () => {
      const existingLink = createTestShortLink({
        code: 'ABC123DEF456GHIJ',
        originalUrl: 'https://transparenta.eu/page',
        accessCount: 10,
      });
      const repo = makeFakeShortLinkRepo({ shortLinks: [existingLink] });
      const cache = makeFakeShortLinkCache({
        entries: new Map([['ABC123DEF456GHIJ', 'https://transparenta.eu/page']]),
      });

      await resolveShortLink({ shortLinkRepo: repo, cache }, { code: 'ABC123DEF456GHIJ' });

      // Advance timers to let fire-and-forget operations complete
      await vi.runAllTimersAsync();

      // Stats should still be incremented even on cache hit
      const linkResult = await repo.getByCode('ABC123DEF456GHIJ');
      expect(linkResult.isOk()).toBe(true);
      if (linkResult.isOk() && linkResult.value !== null) {
        expect(linkResult.value.accessCount).toBe(11);
      }
    });
  });

  describe('database error handling', () => {
    it('propagates database errors on lookup failure', async () => {
      const repo = makeFakeShortLinkRepo({ simulateDbError: true });
      const cache = makeFakeShortLinkCache(); // Empty cache forces DB lookup

      const result = await resolveShortLink(
        { shortLinkRepo: repo, cache },
        { code: 'ABC123DEF456GHIJ' }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
      }
    });

    it('still returns URL when cache write fails', async () => {
      const existingLink = createTestShortLink({
        code: 'ABC123DEF456GHIJ',
        originalUrl: 'https://transparenta.eu/page',
      });
      const repo = makeFakeShortLinkRepo({ shortLinks: [existingLink] });

      // Create a cache that fails on set
      const failingCache = {
        get: async () => null,
        set: async () => {
          throw new Error('Cache write failed');
        },
      };

      const result = await resolveShortLink(
        { shortLinkRepo: repo, cache: failingCache },
        { code: 'ABC123DEF456GHIJ' }
      );

      // Should still succeed - cache errors are silently ignored
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.url).toBe('https://transparenta.eu/page');
      }
    });

    it('still returns URL when stats update fails', async () => {
      const existingLink = createTestShortLink({
        code: 'ABC123DEF456GHIJ',
        originalUrl: 'https://transparenta.eu/page',
      });

      // Create a repo that fails on stats update
      const failingStatsRepo = {
        ...makeFakeShortLinkRepo({ shortLinks: [existingLink] }),
        incrementAccessStats: async () => {
          throw new Error('Stats update failed');
        },
      };
      const cache = makeFakeShortLinkCache();

      const result = await resolveShortLink(
        { shortLinkRepo: failingStatsRepo, cache },
        { code: 'ABC123DEF456GHIJ' }
      );

      // Should still succeed - stats errors are silently ignored
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.url).toBe('https://transparenta.eu/page');
      }
    });
  });

  describe('noop cache', () => {
    it('works with noop cache (no caching)', async () => {
      const existingLink = createTestShortLink({
        code: 'ABC123DEF456GHIJ',
        originalUrl: 'https://transparenta.eu/page',
      });
      const repo = makeFakeShortLinkRepo({ shortLinks: [existingLink] });

      // Import and use the noopCache
      const { noopCache } = await import('@/modules/share/core/ports.js');

      const result = await resolveShortLink(
        { shortLinkRepo: repo, cache: noopCache },
        { code: 'ABC123DEF456GHIJ' }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.url).toBe('https://transparenta.eu/page');
      }
    });
  });
});
