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

export const CampaignNotificationStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('composing'),
  Type.Literal('sending'),
  Type.Literal('sent'),
  Type.Literal('delivered'),
  Type.Literal('webhook_timeout'),
  Type.Literal('failed_transient'),
  Type.Literal('failed_permanent'),
  Type.Literal('suppressed'),
  Type.Literal('skipped_unsubscribed'),
  Type.Literal('skipped_no_email'),
]);

export const CampaignNotificationEventTypeSchema = Type.Union([
  Type.Literal('thread_started'),
  Type.Literal('thread_failed'),
  Type.Literal('reply_received'),
  Type.Literal('reply_reviewed'),
]);

export const CampaignNotificationTriggerSourceSchema = Type.Union([
  Type.Literal('campaign_admin'),
  Type.Literal('user_event_worker'),
  Type.Literal('system'),
  Type.Literal('clerk_webhook'),
]);

export const CampaignNotificationSortBySchema = Type.Union([
  Type.Literal('createdAt'),
  Type.Literal('sentAt'),
  Type.Literal('status'),
  Type.Literal('attemptCount'),
]);

export const CampaignNotificationSortOrderSchema = Type.Union([
  Type.Literal('asc'),
  Type.Literal('desc'),
]);

export const CampaignNotificationListQuerySchema = Type.Object(
  {
    notificationType: Type.Optional(Type.String({ minLength: 1 })),
    templateId: Type.Optional(Type.String({ minLength: 1 })),
    userId: Type.Optional(Type.String({ minLength: 1 })),
    status: Type.Optional(CampaignNotificationStatusSchema),
    eventType: Type.Optional(CampaignNotificationEventTypeSchema),
    entityCui: Type.Optional(Type.String({ minLength: 1 })),
    threadId: Type.Optional(Type.String({ minLength: 1 })),
    source: Type.Optional(CampaignNotificationTriggerSourceSchema),
    sortBy: Type.Optional(CampaignNotificationSortBySchema),
    sortOrder: Type.Optional(CampaignNotificationSortOrderSchema),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false }
);

export type CampaignNotificationListQuery = Static<typeof CampaignNotificationListQuerySchema>;

export const CampaignNotificationSafeErrorCategorySchema = Type.Union([
  Type.Literal('skipped_unsubscribed'),
  Type.Literal('skipped_no_email'),
  Type.Literal('suppressed'),
  Type.Literal('webhook_timeout'),
  Type.Literal('compose_validation'),
  Type.Literal('render_error'),
  Type.Literal('email_lookup'),
  Type.Literal('send_retryable'),
  Type.Literal('send_permanent'),
  Type.Literal('provider_bounce'),
  Type.Literal('provider_suppressed'),
  Type.Literal('unknown'),
]);

export const CampaignNotificationSafeErrorSchema = Type.Object(
  {
    category: Type.Union([CampaignNotificationSafeErrorCategorySchema, Type.Null()]),
    code: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false }
);

const PublicDebateCampaignWelcomeProjectionSchema = Type.Object(
  {
    kind: Type.Literal('public_debate_campaign_welcome'),
    userId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    entityCui: Type.String({ minLength: 1 }),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    acceptedTermsAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    triggerSource: Type.Union([CampaignNotificationTriggerSourceSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

const PublicDebateEntitySubscriptionProjectionSchema = Type.Object(
  {
    kind: Type.Literal('public_debate_entity_subscription'),
    userId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    entityCui: Type.String({ minLength: 1 }),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    acceptedTermsAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    selectedEntitiesCount: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    triggerSource: Type.Union([CampaignNotificationTriggerSourceSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

const PublicDebateEntityUpdateProjectionSchema = Type.Object(
  {
    kind: Type.Literal('public_debate_entity_update'),
    userId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    entityCui: Type.String({ minLength: 1 }),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    threadId: Type.String({ minLength: 1 }),
    threadKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    eventType: Type.Union([CampaignNotificationEventTypeSchema, Type.Null()]),
    phase: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    replyEntryId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    basedOnEntryId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    resolutionCode: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    triggerSource: Type.Union([CampaignNotificationTriggerSourceSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

const PublicDebateAdminFailureProjectionSchema = Type.Object(
  {
    kind: Type.Literal('public_debate_admin_failure'),
    entityCui: Type.String({ minLength: 1 }),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    threadId: Type.String({ minLength: 1 }),
    phase: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const CampaignNotificationProjectionSchema = Type.Union([
  PublicDebateCampaignWelcomeProjectionSchema,
  PublicDebateEntitySubscriptionProjectionSchema,
  PublicDebateEntityUpdateProjectionSchema,
  PublicDebateAdminFailureProjectionSchema,
]);

export const CampaignNotificationListItemSchema = Type.Object(
  {
    outboxId: Type.String({ minLength: 1 }),
    campaignKey: Type.String({ minLength: 1 }),
    notificationType: Type.String({ minLength: 1 }),
    templateId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    templateName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    templateVersion: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    status: CampaignNotificationStatusSchema,
    createdAt: Type.String({ format: 'date-time' }),
    sentAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    attemptCount: Type.Number({ minimum: 0 }),
    safeError: CampaignNotificationSafeErrorSchema,
    projection: CampaignNotificationProjectionSchema,
  },
  { additionalProperties: false }
);

export const CampaignNotificationListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(CampaignNotificationListItemSchema),
        page: Type.Object(
          {
            nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
            hasMore: Type.Boolean(),
          },
          { additionalProperties: false }
        ),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTriggerFieldSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    required: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTriggerDescriptorSchema = Type.Object(
  {
    triggerId: Type.String({ minLength: 1 }),
    campaignKey: Type.String({ minLength: 1 }),
    templateId: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    inputFields: Type.Array(CampaignNotificationTriggerFieldSchema),
    targetKind: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTriggerListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(CampaignNotificationTriggerDescriptorSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTriggerResultSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('queued'), Type.Literal('skipped'), Type.Literal('partial')]),
    reason: Type.Optional(Type.String({ minLength: 1 })),
    createdOutboxIds: Type.Array(Type.String({ minLength: 1 })),
    reusedOutboxIds: Type.Array(Type.String({ minLength: 1 })),
    queuedOutboxIds: Type.Array(Type.String({ minLength: 1 })),
    enqueueFailedOutboxIds: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTriggerExecutionResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        triggerId: Type.String({ minLength: 1 }),
        campaignKey: Type.String({ minLength: 1 }),
        templateId: Type.String({ minLength: 1 }),
        result: CampaignNotificationTriggerResultSchema,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTemplateFieldSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    required: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTemplateDescriptorSchema = Type.Object(
  {
    templateId: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    requiredFields: Type.Array(CampaignNotificationTemplateFieldSchema),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTemplateListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(CampaignNotificationTemplateDescriptorSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTemplateIdParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
    templateId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export type CampaignNotificationTemplateIdParams = Static<
  typeof CampaignNotificationTemplateIdParamsSchema
>;

export const CampaignNotificationTemplatePreviewResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        templateId: Type.String({ minLength: 1 }),
        name: Type.String({ minLength: 1 }),
        version: Type.String({ minLength: 1 }),
        description: Type.String({ minLength: 1 }),
        requiredFields: Type.Array(CampaignNotificationTemplateFieldSchema),
        exampleSubject: Type.String({ minLength: 1 }),
        html: Type.String({ minLength: 1 }),
        text: Type.String(),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export type CampaignNotificationTemplateDescriptor = Static<
  typeof CampaignNotificationTemplateDescriptorSchema
>;
