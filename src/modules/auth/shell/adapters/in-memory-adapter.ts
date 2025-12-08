/**
 * In-Memory Authentication Adapter
 *
 * Implements AuthProvider for testing and development.
 * Allows configuring valid tokens and their associated user IDs.
 */

import { ok, err, type Result } from 'neverthrow';

import {
  createInvalidTokenError,
  createTokenExpiredError,
  type AuthError,
} from '../../core/errors.js';
import { toUserId, type AuthSession } from '../../core/types.js';

import type { AuthProvider } from '../../core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for creating an in-memory auth provider.
 */
export interface MakeInMemoryAuthProviderOptions {
  /**
   * Map of valid tokens to user IDs.
   * Key: token string, Value: user ID string
   */
  validTokens?: Map<string, string>;

  /**
   * Default token expiration (from now).
   * Default: 1 hour
   */
  tokenTTLMs?: number;

  /**
   * Tokens that should be treated as expired.
   */
  expiredTokens?: Set<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Default token TTL: 1 hour */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an in-memory auth provider for testing.
 *
 * @param options - Configuration options
 * @returns AuthProvider implementation
 *
 * @example
 * // Create provider with test users
 * const validTokens = new Map([
 *   ['test-token-1', 'user_123'],
 *   ['test-token-2', 'user_456'],
 * ]);
 *
 * const authProvider = makeInMemoryAuthProvider({ validTokens });
 *
 * // Valid token returns session
 * const result = await authProvider.verifyToken('test-token-1');
 * // result.value.userId === 'user_123'
 *
 * // Invalid token returns error
 * const invalid = await authProvider.verifyToken('unknown-token');
 * // invalid.error.type === 'InvalidTokenError'
 */
export const makeInMemoryAuthProvider = (
  options: MakeInMemoryAuthProviderOptions = {}
): AuthProvider => {
  const tokens = options.validTokens ?? new Map<string, string>();
  const expiredTokens = options.expiredTokens ?? new Set<string>();
  const tokenTTLMs = options.tokenTTLMs ?? DEFAULT_TOKEN_TTL_MS;

  return {
    verifyToken(token: string): Promise<Result<AuthSession, AuthError>> {
      // Check if token is expired
      if (expiredTokens.has(token)) {
        return Promise.resolve(err(createTokenExpiredError(new Date(Date.now() - 1000))));
      }

      // Look up token
      const userId = tokens.get(token);

      if (userId === undefined) {
        return Promise.resolve(err(createInvalidTokenError('Invalid or unknown token')));
      }

      // Create session
      const session: AuthSession = {
        userId: toUserId(userId),
        expiresAt: new Date(Date.now() + tokenTTLMs),
      };

      return Promise.resolve(ok(session));
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a test token for a user ID.
 * Useful for creating consistent test data.
 */
export const createTestToken = (userId: string): string => {
  return `test-token-${userId}`;
};

/**
 * Creates a pre-configured test auth provider with common test users.
 *
 * @returns Object containing the provider and test tokens
 *
 * @example
 * const { provider, tokens } = createTestAuthProvider();
 *
 * // Use tokens.user1 for a valid authenticated request
 * const result = await provider.verifyToken(tokens.user1);
 */
export const createTestAuthProvider = (): {
  provider: AuthProvider;
  tokens: {
    user1: string;
    user2: string;
    expired: string;
  };
  userIds: {
    user1: string;
    user2: string;
  };
} => {
  const userIds = {
    user1: 'user_test_1',
    user2: 'user_test_2',
  };

  const tokens = {
    user1: createTestToken(userIds.user1),
    user2: createTestToken(userIds.user2),
    expired: 'expired-token',
  };

  const validTokens = new Map([
    [tokens.user1, userIds.user1],
    [tokens.user2, userIds.user2],
    [tokens.expired, userIds.user1], // Token exists but is expired
  ]);

  const expiredTokens = new Set([tokens.expired]);

  const provider = makeInMemoryAuthProvider({ validTokens, expiredTokens });

  return { provider, tokens, userIds };
};
