/**
 * Tests for the in-memory authentication adapter.
 */

import { describe, expect, it } from 'vitest';

import {
  makeInMemoryAuthProvider,
  createTestToken,
  createTestAuthProvider,
} from '@/modules/auth/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// makeInMemoryAuthProvider Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('makeInMemoryAuthProvider', () => {
  describe('with default options', () => {
    it('returns InvalidTokenError for any token', async () => {
      const provider = makeInMemoryAuthProvider();

      const result = await provider.verifyToken('any-token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('InvalidTokenError');
    });
  });

  describe('with valid tokens', () => {
    it('returns session for registered token', async () => {
      const validTokens = new Map([['token-123', 'user_abc']]);
      const provider = makeInMemoryAuthProvider({ validTokens });

      const result = await provider.verifyToken('token-123');

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().userId).toBe('user_abc');
    });

    it('returns different user IDs for different tokens', async () => {
      const validTokens = new Map([
        ['token-1', 'user_1'],
        ['token-2', 'user_2'],
      ]);
      const provider = makeInMemoryAuthProvider({ validTokens });

      const result1 = await provider.verifyToken('token-1');
      const result2 = await provider.verifyToken('token-2');

      expect(result1._unsafeUnwrap().userId).toBe('user_1');
      expect(result2._unsafeUnwrap().userId).toBe('user_2');
    });

    it('returns InvalidTokenError for unregistered token', async () => {
      const validTokens = new Map([['token-123', 'user_abc']]);
      const provider = makeInMemoryAuthProvider({ validTokens });

      const result = await provider.verifyToken('unknown-token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('InvalidTokenError');
    });
  });

  describe('with expired tokens', () => {
    it('returns TokenExpiredError for expired token', async () => {
      const validTokens = new Map([['expired-token', 'user_abc']]);
      const expiredTokens = new Set(['expired-token']);
      const provider = makeInMemoryAuthProvider({ validTokens, expiredTokens });

      const result = await provider.verifyToken('expired-token');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('TokenExpiredError');
    });

    it('checks expiration before validity', async () => {
      // Token is both valid and expired - should return expired error
      const validTokens = new Map([['token-123', 'user_abc']]);
      const expiredTokens = new Set(['token-123']);
      const provider = makeInMemoryAuthProvider({ validTokens, expiredTokens });

      const result = await provider.verifyToken('token-123');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('TokenExpiredError');
    });
  });

  describe('session expiration time', () => {
    it('sets default expiration to 1 hour from now', async () => {
      const validTokens = new Map([['token-123', 'user_abc']]);
      const provider = makeInMemoryAuthProvider({ validTokens });
      const beforeCall = Date.now();

      const result = await provider.verifyToken('token-123');

      const afterCall = Date.now();
      const session = result._unsafeUnwrap();
      const expirationTime = session.expiresAt.getTime();

      // Should be approximately 1 hour (3600000ms) from now
      expect(expirationTime).toBeGreaterThanOrEqual(beforeCall + 3600000 - 100);
      expect(expirationTime).toBeLessThanOrEqual(afterCall + 3600000 + 100);
    });

    it('uses custom TTL when provided', async () => {
      const validTokens = new Map([['token-123', 'user_abc']]);
      const tokenTTLMs = 5000; // 5 seconds
      const provider = makeInMemoryAuthProvider({ validTokens, tokenTTLMs });
      const beforeCall = Date.now();

      const result = await provider.verifyToken('token-123');

      const afterCall = Date.now();
      const session = result._unsafeUnwrap();
      const expirationTime = session.expiresAt.getTime();

      // Should be approximately 5 seconds from now
      expect(expirationTime).toBeGreaterThanOrEqual(beforeCall + 5000 - 100);
      expect(expirationTime).toBeLessThanOrEqual(afterCall + 5000 + 100);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTestToken Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('createTestToken', () => {
  it('creates deterministic token for user ID', () => {
    const token1 = createTestToken('user_123');
    const token2 = createTestToken('user_123');

    expect(token1).toBe(token2);
  });

  it('creates different tokens for different user IDs', () => {
    const token1 = createTestToken('user_1');
    const token2 = createTestToken('user_2');

    expect(token1).not.toBe(token2);
  });

  it('includes user ID in token string', () => {
    const token = createTestToken('user_abc');

    expect(token).toContain('user_abc');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createTestAuthProvider Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('createTestAuthProvider', () => {
  it('provides working provider with test tokens', async () => {
    const { provider, tokens } = createTestAuthProvider();

    const result = await provider.verifyToken(tokens.user1);

    expect(result.isOk()).toBe(true);
  });

  it('returns correct user IDs', async () => {
    const { provider, tokens, userIds } = createTestAuthProvider();

    const result1 = await provider.verifyToken(tokens.user1);
    const result2 = await provider.verifyToken(tokens.user2);

    expect(result1._unsafeUnwrap().userId).toBe(userIds.user1);
    expect(result2._unsafeUnwrap().userId).toBe(userIds.user2);
  });

  it('treats expired token as expired', async () => {
    const { provider, tokens } = createTestAuthProvider();

    const result = await provider.verifyToken(tokens.expired);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('TokenExpiredError');
  });

  it('rejects unknown tokens', async () => {
    const { provider } = createTestAuthProvider();

    const result = await provider.verifyToken('random-unknown-token');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('InvalidTokenError');
  });

  it('provides two distinct test users', () => {
    const { userIds } = createTestAuthProvider();

    expect(userIds.user1).not.toBe(userIds.user2);
  });
});
