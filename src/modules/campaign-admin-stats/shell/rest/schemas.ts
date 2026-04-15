import { Type, type Static } from '@sinclair/typebox';

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

const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });

export const CampaignAdminStatsTopEntitiesSortBySchema = Type.Union([
  Type.Literal('interactionCount'),
  Type.Literal('userCount'),
  Type.Literal('pendingReviewCount'),
]);

export const CampaignAdminStatsTopEntitiesQuerySchema = Type.Object(
  {
    sortBy: CampaignAdminStatsTopEntitiesSortBySchema,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25, default: 10 })),
  },
  { additionalProperties: false }
);

export type CampaignAdminStatsTopEntitiesQuery = Static<
  typeof CampaignAdminStatsTopEntitiesQuerySchema
>;

const CoverageSchema = Type.Object(
  {
    hasClientTelemetry: Type.Boolean(),
    hasNotificationAttribution: Type.Boolean(),
  },
  { additionalProperties: false }
);

const UsersSchema = Type.Object(
  {
    totalUsers: NonNegativeIntegerSchema,
    usersWithPendingReviews: NonNegativeIntegerSchema,
  },
  { additionalProperties: false }
);

const ReviewStatusCountsSchema = Type.Object(
  {
    pending: NonNegativeIntegerSchema,
    approved: NonNegativeIntegerSchema,
    rejected: NonNegativeIntegerSchema,
    notReviewed: NonNegativeIntegerSchema,
  },
  { additionalProperties: false }
);

const PhaseCountsSchema = Type.Object(
  {
    idle: NonNegativeIntegerSchema,
    draft: NonNegativeIntegerSchema,
    pending: NonNegativeIntegerSchema,
    resolved: NonNegativeIntegerSchema,
    failed: NonNegativeIntegerSchema,
  },
  { additionalProperties: false }
);

const ThreadPhaseCountsSchema = Type.Object(
  {
    sending: NonNegativeIntegerSchema,
    awaitingReply: NonNegativeIntegerSchema,
    replyReceivedUnreviewed: NonNegativeIntegerSchema,
    manualFollowUpNeeded: NonNegativeIntegerSchema,
    resolvedPositive: NonNegativeIntegerSchema,
    resolvedNegative: NonNegativeIntegerSchema,
    closedNoResponse: NonNegativeIntegerSchema,
    failed: NonNegativeIntegerSchema,
    none: NonNegativeIntegerSchema,
  },
  { additionalProperties: false }
);

const InteractionsSchema = Type.Object(
  {
    totalInteractions: NonNegativeIntegerSchema,
    interactionsWithInstitutionThread: NonNegativeIntegerSchema,
    reviewStatusCounts: ReviewStatusCountsSchema,
    phaseCounts: PhaseCountsSchema,
    threadPhaseCounts: ThreadPhaseCountsSchema,
  },
  { additionalProperties: false }
);

const EntitiesSchema = Type.Object(
  {
    totalEntities: NonNegativeIntegerSchema,
    entitiesWithPendingReviews: NonNegativeIntegerSchema,
    entitiesWithSubscribers: NonNegativeIntegerSchema,
    entitiesWithNotificationActivity: NonNegativeIntegerSchema,
    entitiesWithFailedNotifications: NonNegativeIntegerSchema,
  },
  { additionalProperties: false }
);

const NotificationsSchema = Type.Object(
  {
    pendingDeliveryCount: NonNegativeIntegerSchema,
    failedDeliveryCount: NonNegativeIntegerSchema,
    deliveredCount: NonNegativeIntegerSchema,
    openedCount: NonNegativeIntegerSchema,
    clickedCount: NonNegativeIntegerSchema,
    suppressedCount: NonNegativeIntegerSchema,
  },
  { additionalProperties: false }
);

const InteractionsByTypeItemSchema = Type.Object(
  {
    interactionId: Type.String({ minLength: 1 }),
    label: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    total: NonNegativeIntegerSchema,
    pending: NonNegativeIntegerSchema,
    approved: NonNegativeIntegerSchema,
    rejected: NonNegativeIntegerSchema,
    notReviewed: NonNegativeIntegerSchema,
  },
  { additionalProperties: false }
);

export const CampaignAdminStatsInteractionsByTypeSchema = Type.Object(
  {
    items: Type.Array(InteractionsByTypeItemSchema),
  },
  { additionalProperties: false }
);

const TopEntityItemSchema = Type.Object(
  {
    entityCui: Type.String({ minLength: 1 }),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    interactionCount: NonNegativeIntegerSchema,
    userCount: NonNegativeIntegerSchema,
    pendingReviewCount: NonNegativeIntegerSchema,
  },
  { additionalProperties: false }
);

export const CampaignAdminStatsTopEntitiesSchema = Type.Object(
  {
    sortBy: CampaignAdminStatsTopEntitiesSortBySchema,
    limit: Type.Integer({ minimum: 1, maximum: 25 }),
    items: Type.Array(TopEntityItemSchema),
  },
  { additionalProperties: false }
);

export const CampaignAdminStatsOverviewSchema = Type.Object(
  {
    coverage: CoverageSchema,
    users: UsersSchema,
    interactions: InteractionsSchema,
    entities: EntitiesSchema,
    notifications: NotificationsSchema,
  },
  { additionalProperties: false }
);

export const CampaignAdminStatsOverviewResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: CampaignAdminStatsOverviewSchema,
  },
  { additionalProperties: false }
);

export const CampaignAdminStatsInteractionsByTypeResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: CampaignAdminStatsInteractionsByTypeSchema,
  },
  { additionalProperties: false }
);

export const CampaignAdminStatsTopEntitiesResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: CampaignAdminStatsTopEntitiesSchema,
  },
  { additionalProperties: false }
);
