/**
 * Authentication Module - Domain Types
 *
 * Provider-agnostic types for authentication.
 * These types define WHAT we need, not HOW it's implemented.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Branded Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Branded type for user identifiers.
 * The user ID comes from the auth provider (e.g., Clerk's `sub` claim).
 */
// eslint-disable-next-line @typescript-eslint/naming-convention -- __brand is the standard pattern for branded types in TypeScript
export type UserId = string & { readonly __brand: unique symbol };

/**
 * Type-safe constructor for UserId.
 */
export const toUserId = (id: string): UserId => id as UserId;

// ─────────────────────────────────────────────────────────────────────────────
// Session Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authenticated session.
 * Created after successful token verification.
 */
export interface AuthSession {
  /** User identifier from auth provider */
  readonly userId: UserId;
  /** Token expiration time */
  readonly expiresAt: Date;
}

/**
 * Anonymous session for unauthenticated requests.
 */
export interface AnonymousSession {
  /** No user identifier */
  readonly userId: null;
  /** Discriminator field */
  readonly isAnonymous: true;
}

/**
 * Authentication context available to all handlers.
 * Either authenticated or anonymous.
 */
export type AuthContext = AuthSession | AnonymousSession;

// ─────────────────────────────────────────────────────────────────────────────
// Type Guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if context represents an authenticated session.
 */
export const isAuthenticated = (ctx: AuthContext): ctx is AuthSession => {
  return ctx.userId !== null;
};

/**
 * Check if context represents an anonymous session.
 */
export const isAnonymous = (ctx: AuthContext): ctx is AnonymousSession => {
  return ctx.userId === null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default anonymous session.
 */
export const ANONYMOUS_SESSION: AnonymousSession = {
  userId: null,
  isAnonymous: true,
} as const;

/** Authorization header name (lowercase for HTTP headers) */
export const AUTH_HEADER = 'authorization' as const;

/** Bearer token prefix */
export const BEARER_PREFIX = 'Bearer ' as const;
