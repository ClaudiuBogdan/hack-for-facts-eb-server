/**
 * Require Auth Use Case
 *
 * Checks if an authentication context is authenticated and returns the user ID.
 * Pure function - no I/O.
 */

import { ok, err, type Result } from 'neverthrow';

import { createAuthenticationRequiredError, type AuthError } from '../errors.js';
import { isAuthenticated, type AuthContext, type UserId } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Requires authentication and returns the user ID.
 *
 * Use this in resolvers/handlers that need an authenticated user.
 *
 * @param context - Authentication context to check
 * @returns Ok(userId) if authenticated, Err(AuthenticationRequiredError) if anonymous
 *
 * @example
 * // In a GraphQL resolver
 * const userIdResult = requireAuth(context.auth);
 * if (userIdResult.isErr()) {
 *   throw new AuthGraphQLError(userIdResult.error);
 * }
 * const userId = userIdResult.value;
 *
 * // Use userId to associate with user-generated data
 * await repo.createNotification({ userId, ...args });
 */
export function requireAuth(context: AuthContext): Result<UserId, AuthError> {
  if (!isAuthenticated(context)) {
    return err(createAuthenticationRequiredError());
  }
  return ok(context.userId);
}
