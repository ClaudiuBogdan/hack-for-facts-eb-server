/**
 * Tests for the require-auth use case.
 */

import { describe, expect, it } from 'vitest';

import {
  requireAuth,
  toUserId,
  ANONYMOUS_SESSION,
  type AuthSession,
} from '@/modules/auth/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const createAuthSession = (userId = 'user_123'): AuthSession => ({
  userId: toUserId(userId),
  expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('requireAuth', () => {
  describe('when context is authenticated', () => {
    it('returns the user ID', () => {
      const session = createAuthSession('user_abc');

      const result = requireAuth(session);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe('user_abc');
    });

    it('preserves the original UserId type', () => {
      const userId = toUserId('user_xyz');
      const session: AuthSession = {
        userId,
        expiresAt: new Date(),
      };

      const result = requireAuth(session);

      expect(result.isOk()).toBe(true);
      // The returned value should be the same UserId instance
      expect(result._unsafeUnwrap()).toBe(userId);
    });
  });

  describe('when context is anonymous', () => {
    it('returns AuthenticationRequiredError', () => {
      const result = requireAuth(ANONYMOUS_SESSION);

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.type).toBe('AuthenticationRequiredError');
    });

    it('includes a helpful error message', () => {
      const result = requireAuth(ANONYMOUS_SESSION);

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.message).toContain('Authentication');
      expect(error.message).toContain('required');
    });
  });

  describe('type narrowing', () => {
    it('allows type-safe access after success check', () => {
      const session = createAuthSession('user_123');

      const result = requireAuth(session);

      if (result.isOk()) {
        // TypeScript should infer this as UserId
        const userId = result.value;
        expect(typeof userId).toBe('string');
        expect(userId).toBe('user_123');
      } else {
        // This branch should not be reached
        expect.fail('Expected result to be Ok');
      }
    });

    it('allows type-safe error access after failure check', () => {
      const result = requireAuth(ANONYMOUS_SESSION);

      if (result.isErr()) {
        // TypeScript should infer this as AuthError
        const error = result.error;
        expect(error.type).toBe('AuthenticationRequiredError');
      } else {
        // This branch should not be reached
        expect.fail('Expected result to be Err');
      }
    });
  });
});
