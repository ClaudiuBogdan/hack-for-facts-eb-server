/**
 * Authentication Module - Domain Errors
 *
 * All authentication errors are discriminated unions with a 'type' field.
 * Follows neverthrow Result pattern - no thrown exceptions in core.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Token Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token is malformed or invalid.
 */
export interface InvalidTokenError {
  readonly type: 'InvalidTokenError';
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * Token has expired.
 */
export interface TokenExpiredError {
  readonly type: 'TokenExpiredError';
  readonly message: string;
  readonly expiredAt: Date;
}

/**
 * Token signature verification failed.
 */
export interface TokenSignatureError {
  readonly type: 'TokenSignatureError';
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authentication required but not provided.
 */
export interface AuthenticationRequiredError {
  readonly type: 'AuthenticationRequiredError';
  readonly message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auth provider communication failed.
 */
export interface AuthProviderError {
  readonly type: 'AuthProviderError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Union
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All possible authentication errors.
 */
export type AuthError =
  | InvalidTokenError
  | TokenExpiredError
  | TokenSignatureError
  | AuthenticationRequiredError
  | AuthProviderError;

// ─────────────────────────────────────────────────────────────────────────────
// Error Constructors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an InvalidTokenError.
 */
export const createInvalidTokenError = (message: string, cause?: unknown): InvalidTokenError => ({
  type: 'InvalidTokenError',
  message,
  cause,
});

/**
 * Creates a TokenExpiredError.
 */
export const createTokenExpiredError = (expiredAt: Date): TokenExpiredError => ({
  type: 'TokenExpiredError',
  message: `Token expired at ${expiredAt.toISOString()}`,
  expiredAt,
});

/**
 * Creates a TokenSignatureError.
 */
export const createTokenSignatureError = (message: string): TokenSignatureError => ({
  type: 'TokenSignatureError',
  message,
});

/**
 * Creates an AuthenticationRequiredError.
 */
export const createAuthenticationRequiredError = (): AuthenticationRequiredError => ({
  type: 'AuthenticationRequiredError',
  message: 'Authentication required',
});

/**
 * Creates an AuthProviderError.
 */
export const createAuthProviderError = (message: string, cause?: unknown): AuthProviderError => ({
  type: 'AuthProviderError',
  message,
  retryable: true,
  cause,
});

// ─────────────────────────────────────────────────────────────────────────────
// Error Mapping to HTTP Status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps auth errors to HTTP status codes.
 * Used by shell layer for response generation.
 */
export const AUTH_ERROR_HTTP_STATUS: Record<AuthError['type'], number> = {
  InvalidTokenError: 401,
  TokenExpiredError: 401,
  TokenSignatureError: 401,
  AuthenticationRequiredError: 401,
  AuthProviderError: 503,
} as const;

/**
 * Maps auth errors to GraphQL error codes.
 */
export const AUTH_ERROR_GQL_CODE: Record<AuthError['type'], string> = {
  InvalidTokenError: 'UNAUTHENTICATED',
  TokenExpiredError: 'UNAUTHENTICATED',
  TokenSignatureError: 'UNAUTHENTICATED',
  AuthenticationRequiredError: 'UNAUTHENTICATED',
  AuthProviderError: 'INTERNAL_SERVER_ERROR',
} as const;
