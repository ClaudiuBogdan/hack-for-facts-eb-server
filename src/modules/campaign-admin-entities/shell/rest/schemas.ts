import { Type, type Static } from '@sinclair/typebox';

import {
  CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_STATUSES,
  CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_TYPES,
  CAMPAIGN_ADMIN_ENTITY_SORT_FIELDS,
} from '../../core/types.js';

export const ErrorResponseSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const CampaignKeyParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export type CampaignKeyParams = Static<typeof CampaignKeyParamsSchema>;

export const CampaignAdminEntityParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
    entityCui: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export type CampaignAdminEntityParams = Static<typeof CampaignAdminEntityParamsSchema>;

export const CampaignAdminEntitiesNotificationTypeSchema = Type.Union(
  CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_TYPES.map((value) => Type.Literal(value))
);

export const CampaignAdminEntitiesNotificationStatusSchema = Type.Union(
  CAMPAIGN_ADMIN_ENTITY_NOTIFICATION_STATUSES.map((value) => Type.Literal(value))
);

export const CampaignAdminEntitiesSortBySchema = Type.Union(
  CAMPAIGN_ADMIN_ENTITY_SORT_FIELDS.map((value) => Type.Literal(value))
);

export const CampaignAdminEntitiesSortOrderSchema = Type.Union([
  Type.Literal('asc'),
  Type.Literal('desc'),
]);

const CampaignAdminEntitiesDateCursorSchema = Type.Object(
  {
    sortBy: Type.Union([Type.Literal('latestInteractionAt'), Type.Literal('latestNotificationAt')]),
    sortOrder: CampaignAdminEntitiesSortOrderSchema,
    entityCui: Type.String({ minLength: 1 }),
    value: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false }
);

const CampaignAdminEntitiesNumericCursorSchema = Type.Object(
  {
    sortBy: Type.Union([
      Type.Literal('userCount'),
      Type.Literal('interactionCount'),
      Type.Literal('pendingReviewCount'),
      Type.Literal('notificationSubscriberCount'),
      Type.Literal('notificationOutboxCount'),
    ]),
    sortOrder: CampaignAdminEntitiesSortOrderSchema,
    entityCui: Type.String({ minLength: 1 }),
    value: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);

const CampaignAdminEntitiesStringCursorSchema = Type.Object(
  {
    sortBy: Type.Literal('entityCui'),
    sortOrder: CampaignAdminEntitiesSortOrderSchema,
    entityCui: Type.String({ minLength: 1 }),
    value: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const CampaignAdminEntitiesCursorSchema = Type.Union([
  CampaignAdminEntitiesStringCursorSchema,
  CampaignAdminEntitiesNumericCursorSchema,
  CampaignAdminEntitiesDateCursorSchema,
]);

export type CampaignAdminEntitiesCursor = Static<typeof CampaignAdminEntitiesCursorSchema>;

export const CampaignAdminEntitiesListQuerySchema = Type.Object(
  {
    query: Type.Optional(Type.String()),
    interactionId: Type.Optional(Type.String({ minLength: 1 })),
    hasPendingReviews: Type.Optional(Type.Boolean()),
    hasSubscribers: Type.Optional(Type.Boolean()),
    hasNotificationActivity: Type.Optional(Type.Boolean()),
    hasFailedNotifications: Type.Optional(Type.Boolean()),
    updatedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    updatedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
    latestNotificationType: Type.Optional(CampaignAdminEntitiesNotificationTypeSchema),
    latestNotificationStatus: Type.Optional(CampaignAdminEntitiesNotificationStatusSchema),
    sortBy: Type.Optional(CampaignAdminEntitiesSortBySchema),
    sortOrder: Type.Optional(CampaignAdminEntitiesSortOrderSchema),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false }
);

export type CampaignAdminEntitiesListQuery = Static<typeof CampaignAdminEntitiesListQuerySchema>;

export const CampaignAdminEntityDetailQuerySchema = Type.Object(
  {},
  { additionalProperties: false }
);

export type CampaignAdminEntityDetailQuery = Static<typeof CampaignAdminEntityDetailQuerySchema>;

export const CampaignAdminAvailableInteractionTypeSchema = Type.Object(
  {
    interactionId: Type.String({ minLength: 1 }),
    label: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    reviewable: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const CampaignAdminEntityListItemSchema = Type.Object(
  {
    entityCui: Type.String({ minLength: 1 }),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    userCount: Type.Integer({ minimum: 0 }),
    interactionCount: Type.Integer({ minimum: 0 }),
    pendingReviewCount: Type.Integer({ minimum: 0 }),
    notificationSubscriberCount: Type.Integer({ minimum: 0 }),
    notificationOutboxCount: Type.Integer({ minimum: 0 }),
    failedNotificationCount: Type.Integer({ minimum: 0 }),
    hasPendingReviews: Type.Boolean(),
    hasSubscribers: Type.Boolean(),
    hasNotificationActivity: Type.Boolean(),
    hasFailedNotifications: Type.Boolean(),
    latestInteractionAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    latestInteractionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    latestNotificationAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    latestNotificationType: Type.Union([CampaignAdminEntitiesNotificationTypeSchema, Type.Null()]),
    latestNotificationStatus: Type.Union([
      CampaignAdminEntitiesNotificationStatusSchema,
      Type.Null(),
    ]),
  },
  { additionalProperties: false }
);

export const CampaignAdminEntitiesListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(CampaignAdminEntityListItemSchema),
        page: Type.Object(
          {
            hasMore: Type.Boolean(),
            nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
            sortBy: CampaignAdminEntitiesSortBySchema,
            sortOrder: CampaignAdminEntitiesSortOrderSchema,
          },
          { additionalProperties: false }
        ),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignAdminEntityResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: CampaignAdminEntityListItemSchema,
  },
  { additionalProperties: false }
);

export const CampaignAdminEntitiesMetaSchema = Type.Object(
  {
    totalEntities: Type.Integer({ minimum: 0 }),
    entitiesWithPendingReviews: Type.Integer({ minimum: 0 }),
    entitiesWithSubscribers: Type.Integer({ minimum: 0 }),
    entitiesWithNotificationActivity: Type.Integer({ minimum: 0 }),
    entitiesWithFailedNotifications: Type.Integer({ minimum: 0 }),
    availableInteractionTypes: Type.Array(CampaignAdminAvailableInteractionTypeSchema),
  },
  { additionalProperties: false }
);

export const CampaignAdminEntitiesMetaResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: CampaignAdminEntitiesMetaSchema,
  },
  { additionalProperties: false }
);
