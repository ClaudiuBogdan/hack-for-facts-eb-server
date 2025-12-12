/**
 * JWT Authentication Adapter
 *
 * Pure JWT verification using the `jose` library.
 * No vendor SDK required - just standard JWT verification.
 *
 * Works with any JWT provider (Clerk, Auth0, Firebase, custom) that uses
 * standard RS256/ES256 signing.
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
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JWT key type (CryptoKey or Uint8Array from jose).
 * Using unknown to avoid global type dependency.
 */
export type JWTKey = unknown;

/**
 * JWT verification function type (from jose library).
 * We accept this as a dependency to avoid direct import.
 */
export type JWTVerifyFn = (
  jwt: string,
  key: JWTKey,
  options?: JWTVerifyOptions
) => Promise<JWTVerifyResult>;

/**
 * Subset of jose JWTVerifyOptions we use.
 */
export interface JWTVerifyOptions {
  /** Expected issuer */
  issuer?: string;
  /** Expected audience */
  audience?: string | string[];
  /** Clock tolerance in seconds */
  clockTolerance?: number;
}

/**
 * Subset of jose JWTVerifyResult we use.
 */
export interface JWTVerifyResult {
  payload: JWTPayload;
}

/**
 * JWT payload claims we extract.
 */
export interface JWTPayload {
  /** Subject (user ID) */
  sub?: string;
  /** Expiration timestamp (seconds since epoch) */
  exp?: number;
  /** Issued at timestamp */
  iat?: number;
  /** Issuer */
  iss?: string;
  /** Audience */
  aud?: string | string[];
  /**
   * Authorized party (Clerk).
   * Used to scope tokens to the intended client/application when `aud` is not present/usable.
   */
  azp?: string;
}

/**
 * Key import function type (from jose library).
 */
export type ImportSPKIFn = (
  spki: string,
  alg: string,
  options?: { extractable?: boolean }
) => Promise<JWTKey>;

/**
 * Options for creating a JWT auth adapter.
 */
export interface MakeJWTAdapterOptions {
  /**
   * The jwtVerify function from jose.
   * Import: import { jwtVerify } from 'jose';
   */
  jwtVerify: JWTVerifyFn;

  /**
   * The importSPKI function from jose.
   * Import: import { importSPKI } from 'jose';
   */
  importSPKI: ImportSPKIFn;

  /**
   * PEM-encoded public key for signature verification.
   * For Clerk, this is CLERK_JWT_KEY.
   *
   * Should start with "-----BEGIN PUBLIC KEY-----"
   */
  publicKeyPEM: string;

  /**
   * Algorithm used for signing (e.g., 'RS256', 'ES256').
   * Clerk uses RS256 by default.
   * @default 'RS256'
   */
  algorithm?: string;

  /**
   * Expected issuer (optional).
   * If provided, tokens with different issuer will be rejected.
   */
  issuer?: string;

  /**
   * Expected audience (optional).
   * If provided, tokens with different audience will be rejected.
   */
  audience?: string | string[];

  /**
   * Authorized parties (optional).
   * When set, the adapter enforces that the token contains an `azp` or `aud` matching one of
   * these values. This is especially important for providers (like Clerk) that use `azp` to
   * represent the authorized party.
   */
  authorizedParties?: string[];

  /**
   * Clock tolerance in seconds for expiration checks.
   * Helps with minor clock skew between servers.
   * @default 5
   */
  clockToleranceSeconds?: number;
}

const normalizeParty = (value: string): string => {
  return value.trim().replace(/\/$/, '');
};

const getTokenAuthorizedParties = (payload: JWTPayload): string[] => {
  const parties: string[] = [];

  if (typeof payload.azp === 'string' && payload.azp !== '') {
    parties.push(payload.azp);
  }

  const aud = payload.aud;
  if (typeof aud === 'string' && aud !== '') {
    parties.push(aud);
  } else if (Array.isArray(aud)) {
    for (const item of aud) {
      if (typeof item === 'string' && item !== '') {
        parties.push(item);
      }
    }
  }

  // Normalize and dedupe (treat trailing slashes as equivalent)
  return [...new Set(parties.map(normalizeParty))].filter((p) => p !== '');
};

// ─────────────────────────────────────────────────────────────────────────────
// Factory Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a JWT authentication adapter.
 *
 * Uses pure JWT verification with a PEM public key.
 * No vendor SDK required - works with any standard JWT.
 *
 * @param options - Configuration including jose functions and public key
 * @returns AuthProvider implementation
 *
 * @example
 * import { jwtVerify, importSPKI } from 'jose';
 *
 * const authProvider = makeJWTAdapter({
 *   jwtVerify,
 *   importSPKI,
 *   publicKeyPEM: process.env.CLERK_JWT_KEY!,
 *   algorithm: 'RS256',
 * });
 *
 * // Use in authenticate
 * const result = await authenticate({ authProvider }, { token });
 */
export const makeJWTAdapter = (options: MakeJWTAdapterOptions): AuthProvider => {
  const {
    jwtVerify,
    importSPKI,
    publicKeyPEM,
    algorithm = 'RS256',
    issuer,
    audience,
    authorizedParties,
    clockToleranceSeconds = 5,
  } = options;

  // Cache the imported key to avoid re-importing on every request
  let cachedKey: JWTKey;
  let keyImported = false;

  const getPublicKey = async (): Promise<JWTKey> => {
    if (keyImported) {
      return cachedKey;
    }

    try {
      cachedKey = await importSPKI(publicKeyPEM, algorithm);
      keyImported = true;
      return cachedKey;
    } catch (error) {
      throw new Error(
        `Failed to import public key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  };

  return {
    async verifyToken(token: string): Promise<Result<AuthSession, AuthError>> {
      try {
        // Get the public key (cached after first use)
        const publicKey = await getPublicKey();

        // Build verification options
        const verifyOptions: JWTVerifyOptions = {
          clockTolerance: clockToleranceSeconds,
        };

        if (issuer !== undefined) {
          verifyOptions.issuer = issuer;
        }

        if (audience !== undefined) {
          verifyOptions.audience = audience;
        }

        // Verify the JWT
        const { payload } = await jwtVerify(token, publicKey, verifyOptions);

        // Enforce authorized parties when configured (supports Clerk `azp` and standard `aud`)
        if (authorizedParties !== undefined && authorizedParties.length > 0) {
          const allowedSet = new Set(authorizedParties.map(normalizeParty).filter((p) => p !== ''));

          const tokenParties = getTokenAuthorizedParties(payload);
          if (tokenParties.length === 0) {
            return err(createInvalidTokenError('Token missing audience/authorized party claim'));
          }

          const isAllowed = tokenParties.some((p) => allowedSet.has(p));
          if (!isAllowed) {
            return err(createInvalidTokenError('Token audience/authorized party not allowed'));
          }
        }

        // Extract user ID from subject claim
        const userId = payload.sub;
        if (typeof userId !== 'string' || userId === '') {
          return err(createInvalidTokenError('Token missing subject (sub) claim'));
        }

        // Extract expiration
        const exp = payload.exp;
        if (typeof exp !== 'number') {
          return err(createInvalidTokenError('Token missing expiration (exp) claim'));
        }

        const expiresAt = new Date(exp * 1000);

        // Create session
        const session: AuthSession = {
          userId: toUserId(userId),
          expiresAt,
        };

        return ok(session);
      } catch (error) {
        // Map jose errors to our domain errors
        if (error instanceof Error) {
          const msg = error.message.toLowerCase();

          // Check for expiration errors
          if (msg.includes('expired') || msg.includes('"exp" claim')) {
            return err(createTokenExpiredError(new Date()));
          }

          // Check for signature errors
          if (
            msg.includes('signature') ||
            msg.includes('verification failed') ||
            msg.includes('invalid compact jws')
          ) {
            return err(createTokenSignatureError('Token signature verification failed'));
          }

          // Check for malformed token errors
          if (
            msg.includes('invalid') ||
            msg.includes('malformed') ||
            msg.includes('unexpected token')
          ) {
            return err(createInvalidTokenError(error.message));
          }

          // Provider/key errors
          if (msg.includes('key') || msg.includes('import')) {
            return err(createAuthProviderError(error.message, error));
          }
        }

        // Unknown errors
        const message =
          error instanceof Error ? error.message : 'Unknown error during token verification';
        return err(createAuthProviderError(message, error));
      }
    },
  };
};
