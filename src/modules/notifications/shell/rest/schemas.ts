/**
 * Notifications REST API - TypeBox Schemas
 *
 * Request/response validation schemas for the REST API.
 * These are shell-layer concerns, separate from core domain types.
 */

import { Type, type Static } from '@sinclair/typebox';

// ─────────────────────────────────────────────────────────────────────────────
// Alert Configuration Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alert operator schema.
 */
export const AlertOperatorSchema = Type.Union([
  Type.Literal('gt'),
  Type.Literal('gte'),
  Type.Literal('lt'),
  Type.Literal('lte'),
  Type.Literal('eq'),
]);

/**
 * Alert condition schema.
 */
export const AlertConditionSchema = Type.Object({
  operator: AlertOperatorSchema,
  threshold: Type.Number(),
  unit: Type.String({ minLength: 1, maxLength: 32 }),
});

/**
 * Analytics series alert config schema.
 */
export const AnalyticsSeriesAlertConfigSchema = Type.Object({
  title: Type.Optional(Type.String({ maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  conditions: Type.Array(AlertConditionSchema),
  filter: Type.Record(Type.String(), Type.Unknown()), // AnalyticsFilter is complex, validated separately
});

/**
 * Static series alert config schema.
 */
export const StaticSeriesAlertConfigSchema = Type.Object({
  title: Type.Optional(Type.String({ maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  conditions: Type.Array(AlertConditionSchema),
  datasetId: Type.String({ minLength: 1 }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Request Body Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Newsletter subscription body schema.
 */
export const NewsletterBodySchema = Type.Object({
  notificationType: Type.Union([
    Type.Literal('newsletter_entity_monthly'),
    Type.Literal('newsletter_entity_quarterly'),
    Type.Literal('newsletter_entity_yearly'),
  ]),
  entityCui: Type.String({ minLength: 1 }),
  config: Type.Optional(Type.Null()),
});

/**
 * Analytics alert subscription body schema.
 */
export const AnalyticsAlertBodySchema = Type.Object({
  notificationType: Type.Literal('alert_series_analytics'),
  entityCui: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  config: AnalyticsSeriesAlertConfigSchema,
});

/**
 * Static alert subscription body schema.
 */
export const StaticAlertBodySchema = Type.Object({
  notificationType: Type.Literal('alert_series_static'),
  entityCui: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  config: StaticSeriesAlertConfigSchema,
});

/**
 * Unified subscription body schema - accepts any notification type.
 * This is the main schema for POST /api/v1/notifications
 */
export const SubscribeBodySchema = Type.Union([
  NewsletterBodySchema,
  AnalyticsAlertBodySchema,
  StaticAlertBodySchema,
]);

export type SubscribeBody = Static<typeof SubscribeBodySchema>;

/**
 * Update notification body schema.
 */
export const UpdateNotificationBodySchema = Type.Object({
  isActive: Type.Optional(Type.Boolean()),
  config: Type.Optional(Type.Unknown()),
});

export type UpdateNotificationBody = Static<typeof UpdateNotificationBodySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// URL Parameter Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notification ID params schema.
 */
export const NotificationIdParamsSchema = Type.Object({
  id: Type.String({ format: 'uuid' }),
});

export type NotificationIdParams = Static<typeof NotificationIdParamsSchema>;

/**
 * Entity CUI params schema.
 */
export const EntityCuiParamsSchema = Type.Object({
  cui: Type.String({ minLength: 1 }),
});

export type EntityCuiParams = Static<typeof EntityCuiParamsSchema>;

/**
 * Unsubscribe token params schema.
 */
export const UnsubscribeTokenParamsSchema = Type.Object({
  token: Type.String({ minLength: 64, maxLength: 64 }),
});

export type UnsubscribeTokenParams = Static<typeof UnsubscribeTokenParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Query Parameter Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deliveries query params schema.
 */
export const DeliveriesQuerySchema = Type.Object({
  limit: Type.Optional(Type.String()),
  offset: Type.Optional(Type.String()),
});

export type DeliveriesQuery = Static<typeof DeliveriesQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Response Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notification data schema (unwrapped).
 */
export const NotificationDataSchema = Type.Object({
  id: Type.String(),
  userId: Type.String(),
  entityCui: Type.Union([Type.String(), Type.Null()]),
  notificationType: Type.String(),
  isActive: Type.Boolean(),
  config: Type.Unknown(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

/**
 * Delivery data schema (unwrapped).
 */
export const DeliveryDataSchema = Type.Object({
  id: Type.String(),
  notificationId: Type.String(),
  periodKey: Type.String(),
  sentAt: Type.String(),
  metadata: Type.Unknown(),
});

/**
 * Single notification response (wrapped).
 */
export const NotificationResponseSchema = Type.Object({
  ok: Type.Literal(true),
  data: NotificationDataSchema,
});

/**
 * Notification list response (wrapped).
 */
export const NotificationListResponseSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Array(NotificationDataSchema),
});

/**
 * Delivery list response (wrapped).
 */
export const DeliveryListResponseSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Array(DeliveryDataSchema),
});

/**
 * Message response (wrapped).
 */
export const MessageResponseSchema = Type.Object({
  ok: Type.Literal(true),
  data: Type.Object({ message: Type.String() }),
});

/**
 * Error response (wrapped).
 */
export const ErrorResponseSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String(),
  message: Type.String(),
});

/**
 * Simple success response (no data payload).
 * Used for DELETE operations.
 */
export const OkResponseSchema = Type.Object({
  ok: Type.Literal(true),
});
