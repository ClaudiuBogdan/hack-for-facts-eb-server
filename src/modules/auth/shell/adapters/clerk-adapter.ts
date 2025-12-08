/**
 * Clerk Authentication Adapter
 *
 * Implements AuthProvider using Clerk's @clerk/backend SDK.
 * This is the ONLY file that knows about Clerk.
 */

import { ok, err, type Result } from 'neverthrow';

import {
  createAuthProviderError,
  createInvalidTokenError,
  createTokenExpiredError,
  createTokenSignatureError,
  type AuthError,
} from '../../core/errors.js';
import { toUserId, type AuthSession } from '../../core/types.js';

import type { AuthProvider } from '../../core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Clerk Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clerk verifyToken function signature.
 * This allows us to accept the function from @clerk/backend without
 * directly depending on it in this file's imports.
 */
export type ClerkVerifyTokenFn = (
  token: string,
  options?: { jwtKey?: string; authorizedParties?: string[] }
) => Promise<ClerkJWTPayload>;

/**
 * Clerk JWT payload (subset of what we use).
 */
interface ClerkJWTPayload {
  /** User ID (subject claim) */
  sub: string;
  /** Expiration timestamp (seconds since epoch) */
  exp: number;
  /** Issued at timestamp (seconds since epoch) */
  iat: number;
}

/**
 * Options for creating a Clerk auth adapter.
 */
export interface MakeClerkAdapterOptions {
  /**
   * The verifyToken function from @clerk/backend.
   * Import: import { verifyToken } from '@clerk/backend';
   */
  verifyToken: ClerkVerifyTokenFn;

  /**
   * JWT public key for networkless verification.
   * If not provided, Clerk will make network calls to verify.
   */
  jwtKey?: string;

  /**
   * Authorized parties (client URLs) for token validation.
   * Prevents token theft across applications.
   */
  authorizedParties?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clerk error codes we handle specifically.
 */
const CLERK_ERROR_CODES = {
  TOKEN_EXPIRED: 'token-expired',
  TOKEN_INVALID: 'token-invalid',
  TOKEN_INVALID_SIGNATURE: 'token-invalid-signature',
  TOKEN_NOT_ACTIVE_YET: 'token-not-active-yet',
} as const;

/**
 * Checks if error is a Clerk error with a code.
 */
interface ClerkError {
  readonly code: string;
  readonly message?: string;
}

const isClerkError = (error: unknown): error is ClerkError => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as Record<string, unknown>)['code'] === 'string'
  );
};

/**
 * Checks if error message indicates token expiration.
 */
const isTokenExpiredError = (error: unknown): boolean => {
  if (isClerkError(error)) {
    return error.code === CLERK_ERROR_CODES.TOKEN_EXPIRED;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('expired') || msg.includes('exp claim');
  }
  return false;
};

/**
 * Checks if error message indicates invalid signature.
 */
const isTokenSignatureError = (error: unknown): boolean => {
  if (isClerkError(error)) {
    return error.code === CLERK_ERROR_CODES.TOKEN_INVALID_SIGNATURE;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('signature') || msg.includes('verification failed');
  }
  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Clerk authentication adapter.
 *
 * @param options - Configuration including the verifyToken function
 * @returns AuthProvider implementation
 *
 * @example
 * import { verifyToken } from '@clerk/backend';
 *
 * const authProvider = makeClerkAdapter({
 *   verifyToken,
 *   jwtKey: process.env.CLERK_JWT_KEY,
 *   authorizedParties: ['https://app.example.com'],
 * });
 */
export const makeClerkAdapter = (options: MakeClerkAdapterOptions): AuthProvider => {
  const { verifyToken, jwtKey, authorizedParties } = options;

  return {
    async verifyToken(token: string): Promise<Result<AuthSession, AuthError>> {
      try {
        // Build verification options
        const verifyOptions: { jwtKey?: string; authorizedParties?: string[] } = {};

        if (jwtKey !== undefined && jwtKey !== '') {
          verifyOptions.jwtKey = jwtKey;
        }

        if (authorizedParties !== undefined && authorizedParties.length > 0) {
          verifyOptions.authorizedParties = authorizedParties;
        }

        // Verify token with Clerk
        const payload = await verifyToken(
          token,
          Object.keys(verifyOptions).length > 0 ? verifyOptions : undefined
        );

        // Extract user ID from subject claim
        const userId = payload.sub;
        if (typeof userId !== 'string' || userId === '') {
          return err(createInvalidTokenError('Token missing subject claim'));
        }

        // Extract expiration
        const expiresAt = new Date(payload.exp * 1000);

        // Check if already expired (belt and suspenders - Clerk should catch this)
        if (expiresAt < new Date()) {
          return err(createTokenExpiredError(expiresAt));
        }

        // Create session
        const session: AuthSession = {
          userId: toUserId(userId),
          expiresAt,
        };

        return ok(session);
      } catch (error) {
        // Map Clerk errors to our domain errors
        if (isTokenExpiredError(error)) {
          return err(createTokenExpiredError(new Date()));
        }

        if (isTokenSignatureError(error)) {
          return err(createTokenSignatureError('Token signature verification failed'));
        }

        if (isClerkError(error)) {
          // Other Clerk errors are treated as invalid token
          return err(createInvalidTokenError(error.message ?? 'Invalid token'));
        }

        // Unknown errors are provider errors
        const message =
          error instanceof Error ? error.message : 'Unknown error during token verification';
        return err(createAuthProviderError(message, error));
      }
    },
  };
};
