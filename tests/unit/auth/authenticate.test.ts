/**
 * Tests for the authenticate use case.
 */

import { ok, err } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  authenticate,
  createInvalidTokenError,
  createTokenExpiredError,
  toUserId,
  isAuthenticated,
  ANONYMOUS_SESSION,
  type AuthProvider,
  type AuthSession,
  type AuthError,
} from '@/modules/auth/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const createFakeAuthProvider = (
  verifyFn: (token: string) => Promise<AuthSession | AuthError>
): AuthProvider => ({
  verifyToken: async (token: string) => {
    const result = await verifyFn(token);
    if ('userId' in result && result.userId !== null) {
      return ok(result);
    }
    return err(result as AuthError);
  },
});

const createValidSession = (userId = 'user_123'): AuthSession => ({
  userId: toUserId(userId),
  expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('authenticate', () => {
  describe('when token is null', () => {
    it('returns anonymous session', async () => {
      const authProvider = createFakeAuthProvider(async () =>
        createInvalidTokenError('Should not be called')
      );

      const result = await authenticate({ authProvider }, { token: null });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(ANONYMOUS_SESSION);
    });
  });

  describe('when token is empty string', () => {
    it('returns anonymous session', async () => {
      const authProvider = createFakeAuthProvider(async () =>
        createInvalidTokenError('Should not be called')
      );

      const result = await authenticate({ authProvider }, { token: '' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(ANONYMOUS_SESSION);
    });
  });

  describe('when token is valid', () => {
    it('returns authenticated session', async () => {
      const session = createValidSession('user_abc');
      const authProvider = createFakeAuthProvider(async () => session);

      const result = await authenticate({ authProvider }, { token: 'valid-token' });

      expect(result.isOk()).toBe(true);
      const authContext = result._unsafeUnwrap();
      expect(isAuthenticated(authContext)).toBe(true);
      if (isAuthenticated(authContext)) {
        expect(authContext.userId).toBe('user_abc');
      }
    });

    it('preserves the session expiration time', async () => {
      const expiresAt = new Date('2025-12-31T23:59:59.000Z');
      const session: AuthSession = {
        userId: toUserId('user_123'),
        expiresAt,
      };
      const authProvider = createFakeAuthProvider(async () => session);

      const result = await authenticate({ authProvider }, { token: 'valid-token' });

      expect(result.isOk()).toBe(true);
      const authContext = result._unsafeUnwrap();
      expect(isAuthenticated(authContext)).toBe(true);
      if (isAuthenticated(authContext)) {
        expect(authContext.expiresAt).toEqual(expiresAt);
      }
    });
  });

  describe('when token is invalid', () => {
    it('returns InvalidTokenError', async () => {
      const authProvider = createFakeAuthProvider(async () =>
        createInvalidTokenError('Token malformed')
      );

      const result = await authenticate({ authProvider }, { token: 'invalid-token' });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.type).toBe('InvalidTokenError');
      expect(error.message).toBe('Token malformed');
    });
  });

  describe('when token is expired', () => {
    it('returns TokenExpiredError', async () => {
      const expiredAt = new Date('2020-01-01T00:00:00.000Z');
      const authProvider = createFakeAuthProvider(async () => createTokenExpiredError(expiredAt));

      const result = await authenticate({ authProvider }, { token: 'expired-token' });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.type).toBe('TokenExpiredError');
      expect(error.message).toContain('expired');
    });
  });

  describe('provider integration', () => {
    it('passes the correct token to the provider', async () => {
      let receivedToken: string | null = null;
      const authProvider: AuthProvider = {
        verifyToken: async (token: string) => {
          receivedToken = token;
          return ok(createValidSession());
        },
      };

      await authenticate({ authProvider }, { token: 'my-secret-token' });

      expect(receivedToken).toBe('my-secret-token');
    });

    it('does not call provider when token is null', async () => {
      const verifyToken = vi.fn();
      const authProvider: AuthProvider = { verifyToken };

      await authenticate({ authProvider }, { token: null });

      expect(verifyToken).not.toHaveBeenCalled();
    });

    it('does not call provider when token is empty', async () => {
      const verifyToken = vi.fn();
      const authProvider: AuthProvider = { verifyToken };

      await authenticate({ authProvider }, { token: '' });

      expect(verifyToken).not.toHaveBeenCalled();
    });
  });

  describe('additional error types', () => {
    it('returns TokenSignatureError from provider', async () => {
      const authProvider: AuthProvider = {
        verifyToken: async () =>
          err({
            type: 'TokenSignatureError',
            message: 'Signature invalid',
          }),
      };

      const result = await authenticate({ authProvider }, { token: 'bad-sig-token' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('TokenSignatureError');
    });

    it('returns AuthProviderError from provider', async () => {
      const authProvider: AuthProvider = {
        verifyToken: async () =>
          err({
            type: 'AuthProviderError',
            message: 'Provider unavailable',
            retryable: true,
          }),
      };

      const result = await authenticate({ authProvider }, { token: 'any-token' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('AuthProviderError');
    });
  });
});
