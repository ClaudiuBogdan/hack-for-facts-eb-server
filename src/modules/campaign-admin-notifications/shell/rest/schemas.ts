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
  Type.Literal('campaign_admin_api'),
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

const PublicDebateAdminResponseProjectionSchema = Type.Object(
  {
    kind: Type.Literal('public_debate_admin_response'),
    userId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    entityCui: Type.String({ minLength: 1 }),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    threadId: Type.String({ minLength: 1 }),
    threadKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    responseEventId: Type.String({ minLength: 1 }),
    responseStatus: Type.String({ minLength: 1 }),
    recipientRole: Type.Union([Type.Literal('requester'), Type.Literal('subscriber')]),
    responseDate: Type.String({ minLength: 1 }),
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

const AdminReviewedInteractionProjectionSchema = Type.Object(
  {
    kind: Type.Literal('admin_reviewed_interaction'),
    userId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    entityCui: Type.String({ minLength: 1 }),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    recordKey: Type.String({ minLength: 1 }),
    interactionId: Type.String({ minLength: 1 }),
    interactionLabel: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    reviewStatus: Type.Union([Type.Literal('approved'), Type.Literal('rejected')]),
    reviewedAt: Type.String({ minLength: 1 }),
    hasFeedbackText: Type.Boolean(),
    nextStepCount: Type.Number({ minimum: 0 }),
    triggerSource: Type.Union([CampaignNotificationTriggerSourceSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

const WeeklyProgressDigestProjectionSchema = Type.Object(
  {
    kind: Type.Literal('weekly_progress_digest'),
    userId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    weekKey: Type.String({ minLength: 1 }),
    totalItemCount: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    actionNowCount: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    triggerSource: Type.Union([CampaignNotificationTriggerSourceSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

export const CampaignNotificationProjectionSchema = Type.Union([
  PublicDebateCampaignWelcomeProjectionSchema,
  PublicDebateEntitySubscriptionProjectionSchema,
  PublicDebateEntityUpdateProjectionSchema,
  PublicDebateAdminResponseProjectionSchema,
  PublicDebateAdminFailureProjectionSchema,
  AdminReviewedInteractionProjectionSchema,
  WeeklyProgressDigestProjectionSchema,
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
            totalCount: Type.Number({ minimum: 0 }),
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

export const CampaignNotificationMetaResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        pendingDeliveryCount: Type.Number({ minimum: 0 }),
        failedDeliveryCount: Type.Number({ minimum: 0 }),
        replyReceivedCount: Type.Number({ minimum: 0 }),
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

export const CampaignNotificationTriggerCapabilitiesSchema = Type.Object(
  {
    supportsSingleExecution: Type.Boolean(),
    supportsBulkExecution: Type.Boolean(),
    supportsDryRun: Type.Boolean(),
    defaultLimit: Type.Optional(Type.Number({ minimum: 1 })),
    maxLimit: Type.Optional(Type.Number({ minimum: 1 })),
    bulkInputFields: Type.Optional(Type.Array(CampaignNotificationTriggerFieldSchema)),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTriggerDescriptorSchema = Type.Object(
  {
    triggerId: Type.String({ minLength: 1 }),
    campaignKey: Type.String({ minLength: 1 }),
    familyId: Type.Optional(Type.String({ minLength: 1 })),
    templateId: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    inputFields: Type.Array(CampaignNotificationTriggerFieldSchema),
    targetKind: Type.String({ minLength: 1 }),
    capabilities: Type.Optional(CampaignNotificationTriggerCapabilitiesSchema),
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

export const CampaignNotificationTriggerLegacyResultSchema = Type.Object(
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

export const CampaignNotificationTriggerFamilySingleResultSchema = Type.Object(
  {
    kind: Type.Literal('family_single'),
    familyId: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal('queued'),
      Type.Literal('skipped'),
      Type.Literal('partial'),
      Type.Literal('delegated'),
    ]),
    reason: Type.String({ minLength: 1 }),
    delegateTarget: Type.Optional(Type.String({ minLength: 1 })),
    createdOutboxIds: Type.Array(Type.String({ minLength: 1 })),
    reusedOutboxIds: Type.Array(Type.String({ minLength: 1 })),
    queuedOutboxIds: Type.Array(Type.String({ minLength: 1 })),
    enqueueFailedOutboxIds: Type.Array(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTriggerExecutionResultSchema = Type.Union([
  CampaignNotificationTriggerLegacyResultSchema,
  CampaignNotificationTriggerFamilySingleResultSchema,
]);

export const CampaignNotificationTriggerExecutionResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        triggerId: Type.String({ minLength: 1 }),
        campaignKey: Type.String({ minLength: 1 }),
        templateId: Type.String({ minLength: 1 }),
        result: CampaignNotificationTriggerExecutionResultSchema,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTriggerBulkRequestSchema = Type.Object(
  {
    filters: Type.Object({}, { additionalProperties: true }),
    dryRun: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTriggerBulkResultSchema = Type.Object(
  {
    kind: Type.Literal('family_bulk'),
    familyId: Type.String({ minLength: 1 }),
    dryRun: Type.Boolean(),
    watermark: Type.String({ minLength: 1 }),
    limit: Type.Number({ minimum: 1 }),
    hasMoreCandidates: Type.Boolean(),
    candidateCount: Type.Number({ minimum: 0 }),
    plannedCount: Type.Number({ minimum: 0 }),
    eligibleCount: Type.Number({ minimum: 0 }),
    queuedCount: Type.Number({ minimum: 0 }),
    reusedCount: Type.Number({ minimum: 0 }),
    skippedCount: Type.Number({ minimum: 0 }),
    delegatedCount: Type.Number({ minimum: 0 }),
    ineligibleCount: Type.Number({ minimum: 0 }),
    notReplayableCount: Type.Number({ minimum: 0 }),
    staleCount: Type.Number({ minimum: 0 }),
    enqueueFailedCount: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export const CampaignNotificationTriggerBulkExecutionResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        triggerId: Type.String({ minLength: 1 }),
        campaignKey: Type.String({ minLength: 1 }),
        templateId: Type.String({ minLength: 1 }),
        result: CampaignNotificationTriggerBulkResultSchema,
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

export const CampaignNotificationRunnableTemplateDescriptorSchema = Type.Object(
  {
    runnableId: Type.String({ minLength: 1 }),
    campaignKey: Type.String({ minLength: 1 }),
    templateId: Type.String({ minLength: 1 }),
    templateVersion: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    targetKind: Type.String({ minLength: 1 }),
    selectors: Type.Array(CampaignNotificationTemplateFieldSchema),
    filters: Type.Array(CampaignNotificationTemplateFieldSchema),
    dryRunRequired: Type.Boolean(),
    maxPlanRowCount: Type.Number({ minimum: 1 }),
    defaultPageSize: Type.Number({ minimum: 1 }),
    maxPageSize: Type.Number({ minimum: 1 }),
  },
  { additionalProperties: false }
);

export const CampaignNotificationRunnableTemplateListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(CampaignNotificationRunnableTemplateDescriptorSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignNotificationRunnablePlanSummarySchema = Type.Object(
  {
    totalRowCount: Type.Number({ minimum: 0 }),
    willSendCount: Type.Number({ minimum: 0 }),
    alreadySentCount: Type.Number({ minimum: 0 }),
    alreadyPendingCount: Type.Number({ minimum: 0 }),
    ineligibleCount: Type.Number({ minimum: 0 }),
    missingDataCount: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export const CampaignNotificationRunnablePlanRowSchema = Type.Object(
  {
    rowKey: Type.String({ minLength: 1 }),
    userId: Type.String({ minLength: 1 }),
    entityCui: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    entityName: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    recordKey: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    interactionId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    interactionLabel: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    reviewStatus: Type.Union([Type.Literal('approved'), Type.Literal('rejected'), Type.Null()]),
    reviewedAt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    status: Type.Union([
      Type.Literal('will_send'),
      Type.Literal('already_sent'),
      Type.Literal('already_pending'),
      Type.Literal('ineligible'),
      Type.Literal('missing_data'),
    ]),
    reasonCode: Type.String({ minLength: 1 }),
    statusMessage: Type.String({ minLength: 1 }),
    hasExistingDelivery: Type.Boolean(),
    existingDeliveryStatus: Type.Union([
      CampaignNotificationStatusSchema,
      Type.String(),
      Type.Null(),
    ]),
    sendMode: Type.Union([Type.Literal('create'), Type.Literal('reuse_claimable'), Type.Null()]),
  },
  { additionalProperties: false }
);

export const CampaignNotificationRunnablePlanResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        planId: Type.String({ minLength: 1 }),
        runnableId: Type.String({ minLength: 1 }),
        templateId: Type.String({ minLength: 1 }),
        watermark: Type.String({ minLength: 1 }),
        summary: CampaignNotificationRunnablePlanSummarySchema,
        rows: Type.Array(CampaignNotificationRunnablePlanRowSchema),
        page: Type.Object(
          {
            totalCount: Type.Number({ minimum: 0 }),
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

export const CampaignNotificationRunnablePlanSendResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        planId: Type.String({ minLength: 1 }),
        runnableId: Type.String({ minLength: 1 }),
        templateId: Type.String({ minLength: 1 }),
        evaluatedCount: Type.Number({ minimum: 0 }),
        queuedCount: Type.Number({ minimum: 0 }),
        alreadySentCount: Type.Number({ minimum: 0 }),
        alreadyPendingCount: Type.Number({ minimum: 0 }),
        ineligibleCount: Type.Number({ minimum: 0 }),
        missingDataCount: Type.Number({ minimum: 0 }),
        enqueueFailedCount: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignNotificationRunnableIdParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
    runnableId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const CampaignNotificationPlanIdParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
    planId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const CampaignNotificationRunnablePlanReadQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false }
);

export type CampaignNotificationRunnableTemplateDescriptor = Static<
  typeof CampaignNotificationRunnableTemplateDescriptorSchema
>;
export type CampaignNotificationRunnableIdParams = Static<
  typeof CampaignNotificationRunnableIdParamsSchema
>;
export type CampaignNotificationPlanIdParams = Static<
  typeof CampaignNotificationPlanIdParamsSchema
>;
export type CampaignNotificationRunnablePlanReadQuery = Static<
  typeof CampaignNotificationRunnablePlanReadQuerySchema
>;
