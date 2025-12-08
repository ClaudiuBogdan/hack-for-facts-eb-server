/**
 * Authenticate Use Case
 *
 * Verifies a token and creates an authentication context.
 * Pure function - all I/O through injected dependencies.
 */

import { ok, err, type Result } from 'neverthrow';

import { ANONYMOUS_SESSION, type AuthContext } from '../types.js';

import type { AuthError } from '../errors.js';
import type { AuthProvider } from '../ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dependencies for authenticate use case.
 */
export interface AuthenticateDeps {
  authProvider: AuthProvider;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input for authenticate use case.
 */
export interface AuthenticateInput {
  /** Bearer token (without 'Bearer ' prefix). Null for anonymous. */
  token: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authenticates a request based on provided token.
 *
 * Returns:
 * - AuthSession if token is valid
 * - AnonymousSession if no token provided
 * - AuthError if token is invalid/expired
 *
 * @example
 * const result = await authenticate(
 *   { authProvider },
 *   { token: 'eyJhbGciOiJSUzI1NiIs...' }
 * );
 *
 * if (result.isOk()) {
 *   if (isAuthenticated(result.value)) {
 *     console.log('User:', result.value.userId);
 *   } else {
 *     console.log('Anonymous request');
 *   }
 * }
 */
export async function authenticate(
  deps: AuthenticateDeps,
  input: AuthenticateInput
): Promise<Result<AuthContext, AuthError>> {
  const { authProvider } = deps;
  const { token } = input;

  // No token = anonymous session (not an error)
  if (token === null || token === '') {
    return ok(ANONYMOUS_SESSION);
  }

  // Verify token with provider
  const sessionResult = await authProvider.verifyToken(token);

  if (sessionResult.isErr()) {
    return err(sessionResult.error);
  }

  return ok(sessionResult.value);
}
