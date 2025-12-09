/**
 * Notifications Module - Public API
 *
 * This module provides notification subscriptions for entity newsletters
 * (periodic budget reports) and series alerts (threshold-based alerts).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

export type {
  NotificationType,
  AlertOperator,
  AlertCondition,
  AnalyticsSeriesAlertConfig,
  StaticSeriesAlertConfig,
  NotificationConfig,
  Notification,
  NotificationDelivery,
  UnsubscribeToken,
  NotificationTypeConfig,
} from './core/types.js';

export {
  // Constants
  DEFAULT_DELIVERIES_LIMIT,
  MAX_DELIVERIES_LIMIT,
  UNSUBSCRIBE_TOKEN_EXPIRY_DAYS,
  NEWSLETTER_TYPES,
  ALERT_TYPES,
  NOTIFICATION_TYPE_CONFIGS,
  // Type guards
  isNewsletterType,
  isAlertType,
  // Pure functions
  generateNotificationHash,
  generatePeriodKey,
  generateDeliveryKey,
} from './core/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Errors
// ─────────────────────────────────────────────────────────────────────────────

export type {
  NotificationError,
  DatabaseError,
  NotificationNotFoundError,
  NotificationForbiddenError,
  InvalidConfigError,
  EntityRequiredError,
  ConfigRequiredError,
  TokenNotFoundError,
  TokenInvalidError,
} from './core/errors.js';

export {
  // Error constructors
  createDatabaseError,
  createNotificationNotFoundError,
  createNotificationForbiddenError,
  createInvalidConfigError,
  createEntityRequiredError,
  createConfigRequiredError,
  createTokenNotFoundError,
  createTokenInvalidError,
  // HTTP status mapping
  NOTIFICATION_ERROR_HTTP_STATUS,
  getHttpStatusForError,
} from './core/errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Ports (Repository Interfaces)
// ─────────────────────────────────────────────────────────────────────────────

export type {
  Hasher,
  NotificationsRepository,
  DeliveriesRepository,
  UnsubscribeTokensRepository,
  CreateNotificationInput,
  UpdateNotificationRepoInput,
} from './core/ports.js';

// ─────────────────────────────────────────────────────────────────────────────
// Core Validation
// ─────────────────────────────────────────────────────────────────────────────

export {
  isAnalyticsAlertConfig,
  isStaticAlertConfig,
  validateConditions,
  validateNewsletterEntity,
  validateAnalyticsAlertConfig,
  validateStaticAlertConfig,
  validateConfigForNotificationType,
} from './core/validation.js';

// ─────────────────────────────────────────────────────────────────────────────
// Use Cases
// ─────────────────────────────────────────────────────────────────────────────

export { subscribe, type SubscribeDeps, type SubscribeInput } from './core/usecases/subscribe.js';

export {
  updateNotification,
  type UpdateNotificationDeps,
  type UpdateNotificationInput,
} from './core/usecases/update-notification.js';

export {
  listUserNotifications,
  listEntityNotifications,
  type ListNotificationsDeps,
  type ListUserNotificationsInput,
  type ListEntityNotificationsInput,
} from './core/usecases/list-notifications.js';

export {
  deleteNotification,
  type DeleteNotificationDeps,
  type DeleteNotificationInput,
} from './core/usecases/delete-notification.js';

export {
  unsubscribeViaToken,
  type UnsubscribeViaTokenDeps,
  type UnsubscribeViaTokenInput,
  type UnsubscribeViaTokenResult,
} from './core/usecases/unsubscribe-via-token.js';

export {
  listDeliveries,
  type ListDeliveriesDeps,
  type ListDeliveriesInput,
} from './core/usecases/list-deliveries.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Repository Implementations
// ─────────────────────────────────────────────────────────────────────────────

export {
  makeNotificationsRepo,
  type NotificationsRepoOptions,
} from './shell/repo/notifications-repo.js';
export { makeDeliveriesRepo, type DeliveriesRepoOptions } from './shell/repo/deliveries-repo.js';
export { makeTokensRepo, type TokensRepoOptions } from './shell/repo/tokens-repo.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - Crypto
// ─────────────────────────────────────────────────────────────────────────────

export { sha256Hasher } from './shell/crypto/hasher.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - REST Routes
// ─────────────────────────────────────────────────────────────────────────────

export { makeNotificationRoutes, type MakeNotificationRoutesDeps } from './shell/rest/routes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shell - REST Schemas (TypeBox)
// ─────────────────────────────────────────────────────────────────────────────

export {
  // Request body schemas
  SubscribeBodySchema,
  NewsletterBodySchema,
  AnalyticsAlertBodySchema,
  StaticAlertBodySchema,
  UpdateNotificationBodySchema,
  // URL param schemas
  NotificationIdParamsSchema,
  EntityCuiParamsSchema,
  UnsubscribeTokenParamsSchema,
  // Query param schemas
  DeliveriesQuerySchema,
  // Response schemas
  NotificationResponseSchema,
  NotificationListResponseSchema,
  DeliveryListResponseSchema,
  MessageResponseSchema,
  ErrorResponseSchema,
  // Derived types
  type SubscribeBody,
  type UpdateNotificationBody,
  type NotificationIdParams,
  type EntityCuiParams,
  type UnsubscribeTokenParams,
  type DeliveriesQuery,
} from './shell/rest/schemas.js';
