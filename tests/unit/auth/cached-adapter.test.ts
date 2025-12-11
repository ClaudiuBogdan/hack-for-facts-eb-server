/**
 * Tests for the cached authentication adapter.
 */

import { ok, err } from 'neverthrow';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
  makeCachedAuthProvider,
  makeCachedAuthProviderWithStats,
  createInvalidTokenError,
  toUserId,
  type AuthProvider,
  type AuthSession,
} from '@/modules/auth/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const createSession = (userId: string, expiresInMs = 3600000): AuthSession => ({
  userId: toUserId(userId),
  expiresAt: new Date(Date.now() + expiresInMs),
});

/** Simple hash function for testing (just returns the token reversed) */
const testHashToken = (token: string): Promise<string> => {
  return Promise.resolve(token.split('').reverse().join(''));
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('makeCachedAuthProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('cache behavior', () => {
    it('calls underlying provider on first request', async () => {
      const session = createSession('user_123');
      const verifyToken = vi.fn().mockResolvedValue(ok(session));
      const provider: AuthProvider = { verifyToken };

      const cached = makeCachedAuthProvider({
        provider,
        hashToken: testHashToken,
      });

      await cached.verifyToken('token-1');

      expect(verifyToken).toHaveBeenCalledTimes(1);
      expect(verifyToken).toHaveBeenCalledWith('token-1');
    });

    it('returns cached result on second request with same token', async () => {
      const session = createSession('user_123');
      const verifyToken = vi.fn().mockResolvedValue(ok(session));
      const provider: AuthProvider = { verifyToken };

      const cached = makeCachedAuthProvider({
        provider,
        hashToken: testHashToken,
      });

      await cached.verifyToken('token-1');
      const result = await cached.verifyToken('token-1');

      expect(verifyToken).toHaveBeenCalledTimes(1);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().userId).toBe('user_123');
    });

    it('calls provider for different tokens', async () => {
      const session1 = createSession('user_1');
      const session2 = createSession('user_2');
      const verifyToken = vi
        .fn()
        .mockResolvedValueOnce(ok(session1))
        .mockResolvedValueOnce(ok(session2));
      const provider: AuthProvider = { verifyToken };

      const cached = makeCachedAuthProvider({
        provider,
        hashToken: testHashToken,
      });

      await cached.verifyToken('token-1');
      await cached.verifyToken('token-2');

      expect(verifyToken).toHaveBeenCalledTimes(2);
    });
  });

  describe('cache expiration', () => {
    it('respects cache TTL', async () => {
      const session = createSession('user_123', 3600000); // 1 hour
      const verifyToken = vi.fn().mockResolvedValue(ok(session));
      const provider: AuthProvider = { verifyToken };

      const cached = makeCachedAuthProvider({
        provider,
        cacheTTLMs: 60000, // 1 minute
        hashToken: testHashToken,
      });

      // First call
      await cached.verifyToken('token-1');
      expect(verifyToken).toHaveBeenCalledTimes(1);

      // Advance time past cache TTL
      vi.advanceTimersByTime(61000);

      // Second call - should call provider again
      await cached.verifyToken('token-1');
      expect(verifyToken).toHaveBeenCalledTimes(2);
    });

    it('respects token expiration over cache TTL', async () => {
      const session = createSession('user_123', 30000); // 30 seconds
      const verifyToken = vi.fn().mockResolvedValue(ok(session));
      const provider: AuthProvider = { verifyToken };

      const cached = makeCachedAuthProvider({
        provider,
        cacheTTLMs: 300000, // 5 minutes (longer than token)
        hashToken: testHashToken,
      });

      // First call
      await cached.verifyToken('token-1');
      expect(verifyToken).toHaveBeenCalledTimes(1);

      // Advance time past token expiration
      vi.advanceTimersByTime(31000);

      // Second call - should call provider again
      await cached.verifyToken('token-1');
      expect(verifyToken).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('does not cache errors', async () => {
      const verifyToken = vi
        .fn()
        .mockResolvedValueOnce(err(createInvalidTokenError('Invalid')))
        .mockResolvedValueOnce(ok(createSession('user_123')));
      const provider: AuthProvider = { verifyToken };

      const cached = makeCachedAuthProvider({
        provider,
        hashToken: testHashToken,
      });

      // First call - error
      const result1 = await cached.verifyToken('token-1');
      expect(result1.isErr()).toBe(true);

      // Second call - should retry (not cached)
      const result2 = await cached.verifyToken('token-1');
      expect(result2.isOk()).toBe(true);

      expect(verifyToken).toHaveBeenCalledTimes(2);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entries when cache is full', async () => {
      const verifyToken = vi.fn().mockImplementation((token: string) => {
        return Promise.resolve(ok(createSession(`user_${token}`)));
      });
      const provider: AuthProvider = { verifyToken };

      const cached = makeCachedAuthProvider({
        provider,
        maxCacheSize: 2,
        hashToken: testHashToken,
      });

      // Fill cache
      await cached.verifyToken('token-1');
      await cached.verifyToken('token-2');
      expect(verifyToken).toHaveBeenCalledTimes(2);

      // Add third token (evicts token-1)
      await cached.verifyToken('token-3');
      expect(verifyToken).toHaveBeenCalledTimes(3);

      // token-2 should still be cached
      await cached.verifyToken('token-2');
      expect(verifyToken).toHaveBeenCalledTimes(3);

      // token-1 should be evicted
      await cached.verifyToken('token-1');
      expect(verifyToken).toHaveBeenCalledTimes(4);
    });
  });
});

describe('makeCachedAuthProviderWithStats', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tracks cache hits and misses', async () => {
    const session = createSession('user_123');
    const verifyToken = vi.fn().mockResolvedValue(ok(session));
    const provider: AuthProvider = { verifyToken };

    const cached = makeCachedAuthProviderWithStats({
      provider,
      hashToken: testHashToken,
    });

    // Initial stats
    expect(cached.getStats()).toEqual({
      size: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
    });

    // First call - miss
    await cached.verifyToken('token-1');
    expect(cached.getStats().misses).toBe(1);
    expect(cached.getStats().hits).toBe(0);
    expect(cached.getStats().size).toBe(1);

    // Second call - hit
    await cached.verifyToken('token-1');
    expect(cached.getStats().misses).toBe(1);
    expect(cached.getStats().hits).toBe(1);
    expect(cached.getStats().hitRate).toBe(50);
  });

  it('clearCache resets stats', async () => {
    const session = createSession('user_123');
    const verifyToken = vi.fn().mockResolvedValue(ok(session));
    const provider: AuthProvider = { verifyToken };

    const cached = makeCachedAuthProviderWithStats({
      provider,
      hashToken: testHashToken,
    });

    await cached.verifyToken('token-1');
    await cached.verifyToken('token-1');

    cached.clearCache();

    expect(cached.getStats()).toEqual({
      size: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
    });
  });
});
