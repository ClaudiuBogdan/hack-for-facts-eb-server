/**
 * Notifications Module - Domain Errors
 *
 * All errors are discriminated unions with a 'type' field for easy matching.
 */

import type { NotificationType } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Infrastructure Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Database-related error.
 */
export interface DatabaseError {
  readonly type: 'DatabaseError';
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notification not found error.
 */
export interface NotificationNotFoundError {
  readonly type: 'NotificationNotFoundError';
  readonly message: string;
  readonly id: string;
}

/**
 * User doesn't own the notification.
 */
export interface NotificationForbiddenError {
  readonly type: 'NotificationForbiddenError';
  readonly message: string;
  readonly userId: string;
  readonly notificationId: string;
}

/**
 * Invalid notification configuration.
 */
export interface InvalidConfigError {
  readonly type: 'InvalidConfigError';
  readonly message: string;
  readonly notificationType: NotificationType;
  readonly details?: unknown;
}

/**
 * Newsletter type requires an entity.
 */
export interface EntityRequiredError {
  readonly type: 'EntityRequiredError';
  readonly message: string;
  readonly notificationType: NotificationType;
}

/**
 * Alert type requires a configuration.
 */
export interface ConfigRequiredError {
  readonly type: 'ConfigRequiredError';
  readonly message: string;
  readonly notificationType: NotificationType;
}

/**
 * Unsubscribe token not found.
 */
export interface TokenNotFoundError {
  readonly type: 'TokenNotFoundError';
  readonly message: string;
  readonly token: string;
}

/**
 * Token is expired or already used.
 */
export interface TokenInvalidError {
  readonly type: 'TokenInvalidError';
  readonly message: string;
  readonly token: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Union
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All possible notification module errors.
 */
export type NotificationError =
  | DatabaseError
  | NotificationNotFoundError
  | NotificationForbiddenError
  | InvalidConfigError
  | EntityRequiredError
  | ConfigRequiredError
  | TokenNotFoundError
  | TokenInvalidError;

// ─────────────────────────────────────────────────────────────────────────────
// Error Constructors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a DatabaseError.
 */
export const createDatabaseError = (message: string, cause?: unknown): DatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable: true,
  cause,
});

/**
 * Creates a NotificationNotFoundError.
 */
export const createNotificationNotFoundError = (id: string): NotificationNotFoundError => ({
  type: 'NotificationNotFoundError',
  message: `Notification with ID '${id}' not found`,
  id,
});

/**
 * Creates a NotificationForbiddenError.
 */
export const createNotificationForbiddenError = (
  userId: string,
  notificationId: string
): NotificationForbiddenError => ({
  type: 'NotificationForbiddenError',
  message: `User '${userId}' does not have permission to access notification '${notificationId}'`,
  userId,
  notificationId,
});

/**
 * Creates an InvalidConfigError.
 */
export const createInvalidConfigError = (
  notificationType: NotificationType,
  message: string,
  details?: unknown
): InvalidConfigError => ({
  type: 'InvalidConfigError',
  message,
  notificationType,
  details,
});

/**
 * Creates an EntityRequiredError.
 */
export const createEntityRequiredError = (
  notificationType: NotificationType
): EntityRequiredError => ({
  type: 'EntityRequiredError',
  message: `Notification type '${notificationType}' requires an entityCui`,
  notificationType,
});

/**
 * Creates a ConfigRequiredError.
 */
export const createConfigRequiredError = (
  notificationType: NotificationType
): ConfigRequiredError => ({
  type: 'ConfigRequiredError',
  message: `Notification type '${notificationType}' requires a configuration`,
  notificationType,
});

/**
 * Creates a TokenNotFoundError.
 */
export const createTokenNotFoundError = (token: string): TokenNotFoundError => ({
  type: 'TokenNotFoundError',
  message: 'Unsubscribe token not found',
  token,
});

/**
 * Creates a TokenInvalidError.
 */
export const createTokenInvalidError = (token: string): TokenInvalidError => ({
  type: 'TokenInvalidError',
  message: 'Token is expired or has already been used',
  token,
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Status Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps error types to HTTP status codes.
 */
export const NOTIFICATION_ERROR_HTTP_STATUS: Record<NotificationError['type'], number> = {
  DatabaseError: 500,
  NotificationNotFoundError: 404,
  NotificationForbiddenError: 403,
  InvalidConfigError: 400,
  EntityRequiredError: 400,
  ConfigRequiredError: 400,
  TokenNotFoundError: 404,
  TokenInvalidError: 400,
};

/**
 * Gets HTTP status code for an error.
 */
export const getHttpStatusForError = (error: NotificationError): number => {
  return NOTIFICATION_ERROR_HTTP_STATUS[error.type];
};
