/**
 * Authentication Module - Port Interfaces
 *
 * Defines the abstract contracts that shell layer must implement.
 * Core depends ONLY on these interfaces, never on concrete implementations.
 */

import type { AuthError } from './errors.js';
import type { AuthSession } from './types.js';
import type { Result } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Auth Provider Port
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract interface for authentication providers.
 *
 * This is the PRIMARY abstraction that enables vendor migration.
 * Clerk, Auth0, Firebase Auth, or custom JWT can all implement this.
 *
 * @example
 * // Clerk implementation
 * const clerkProvider: AuthProvider = makeClerkAdapter(config);
 *
 * // Auth0 implementation (future)
 * const auth0Provider: AuthProvider = makeAuth0Adapter(config);
 */
export interface AuthProvider {
  /**
   * Verify a bearer token and extract session information.
   *
   * @param token - Raw bearer token (without 'Bearer ' prefix)
   * @returns AuthSession on success, AuthError on failure
   *
   * MUST:
   * - Validate token signature
   * - Check expiration
   * - Extract user ID from `sub` claim
   *
   * MUST NOT:
   * - Throw exceptions (return Result.err instead)
   * - Cache tokens (caching is caller's responsibility)
   *
   * Possible errors:
   * - InvalidTokenError: Token is malformed
   * - TokenExpiredError: Token has expired
   * - TokenSignatureError: Signature verification failed
   * - AuthProviderError: Provider communication failed
   */
  verifyToken(token: string): Promise<Result<AuthSession, AuthError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session Extractor Port
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts bearer token from transport-specific request.
 *
 * Different transports carry tokens differently:
 * - HTTP: Authorization header
 * - MCP: Session metadata or custom header
 *
 * @template T - Transport-specific request type
 */
export interface SessionExtractor<T> {
  /**
   * Extract bearer token from request.
   *
   * @param request - Transport-specific request object
   * @returns Token string if present, null if absent
   *
   * MUST:
   * - Return null for missing token (not error)
   * - Strip 'Bearer ' prefix if present
   * - Trim whitespace
   *
   * MUST NOT:
   * - Validate token (that's AuthProvider's job)
   * - Throw exceptions
   */
  extractToken(request: T): string | null;
}
