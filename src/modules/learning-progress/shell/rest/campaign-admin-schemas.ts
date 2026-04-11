import { Type, type Static } from '@sinclair/typebox';

import { ErrorResponseSchema } from './schemas.js';

export const CampaignKeyParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export type CampaignKeyParams = Static<typeof CampaignKeyParamsSchema>;

export const CampaignAdminSortBySchema = Type.Union([
  Type.Literal('reviewStatus'),
  Type.Literal('userId'),
  Type.Literal('organizationName'),
  Type.Literal('entity'),
  Type.Literal('updatedAt'),
  Type.Literal('riskFlagCount'),
  Type.Literal('threadPhase'),
  Type.Literal('interactionType'),
  Type.Literal('reviewedByUserId'),
]);

export const CampaignAdminSortOrderSchema = Type.Union([Type.Literal('asc'), Type.Literal('desc')]);

export const CampaignAdminCursorSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    sortBy: Type.Union([CampaignAdminSortBySchema, Type.Null()]),
    sortOrder: Type.Union([CampaignAdminSortOrderSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

export type CampaignAdminCursor = Static<typeof CampaignAdminCursorSchema>;

export const CampaignAdminListQuerySchema = Type.Object(
  {
    phase: Type.Optional(
      Type.Union([
        Type.Literal('idle'),
        Type.Literal('draft'),
        Type.Literal('pending'),
        Type.Literal('resolved'),
        Type.Literal('failed'),
      ])
    ),
    reviewStatus: Type.Optional(
      Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('rejected')])
    ),
    interactionId: Type.Optional(Type.String({ minLength: 1 })),
    lessonId: Type.Optional(Type.String({ minLength: 1 })),
    entityCui: Type.Optional(Type.String({ minLength: 1 })),
    scopeType: Type.Optional(Type.Union([Type.Literal('global'), Type.Literal('entity')])),
    payloadKind: Type.Optional(
      Type.Union([
        Type.Literal('choice'),
        Type.Literal('text'),
        Type.Literal('url'),
        Type.Literal('number'),
        Type.Literal('json'),
      ])
    ),
    submissionPath: Type.Optional(
      Type.Union([
        Type.Literal('request_platform'),
        Type.Literal('send_yourself'),
        Type.Literal('send_email'),
        Type.Literal('download_text'),
      ])
    ),
    userId: Type.Optional(Type.String({ minLength: 1 })),
    recordKey: Type.Optional(Type.String({ minLength: 1 })),
    recordKeyPrefix: Type.Optional(Type.String({ minLength: 16 })),
    submittedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    submittedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
    updatedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    updatedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
    hasInstitutionThread: Type.Optional(Type.Boolean()),
    threadPhase: Type.Optional(
      Type.Union([
        Type.Literal('sending'),
        Type.Literal('awaiting_reply'),
        Type.Literal('reply_received_unreviewed'),
        Type.Literal('manual_follow_up_needed'),
        Type.Literal('resolved_positive'),
        Type.Literal('resolved_negative'),
        Type.Literal('closed_no_response'),
        Type.Literal('failed'),
      ])
    ),
    sortBy: Type.Optional(CampaignAdminSortBySchema),
    sortOrder: Type.Optional(CampaignAdminSortOrderSchema),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false }
);

export type CampaignAdminListQuery = Static<typeof CampaignAdminListQuerySchema>;

export const CampaignAdminAvailableInteractionTypeSchema = Type.Object(
  {
    interactionId: Type.String({ minLength: 1 }),
    label: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const CampaignAdminReviewStatusCountsSchema = Type.Object(
  {
    pending: Type.Number({ minimum: 0 }),
    approved: Type.Number({ minimum: 0 }),
    rejected: Type.Number({ minimum: 0 }),
    notReviewed: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export const CampaignAdminPhaseCountsSchema = Type.Object(
  {
    idle: Type.Number({ minimum: 0 }),
    draft: Type.Number({ minimum: 0 }),
    pending: Type.Number({ minimum: 0 }),
    resolved: Type.Number({ minimum: 0 }),
    failed: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export const CampaignAdminThreadPhaseCountsSchema = Type.Object(
  {
    sending: Type.Number({ minimum: 0 }),
    awaiting_reply: Type.Number({ minimum: 0 }),
    reply_received_unreviewed: Type.Number({ minimum: 0 }),
    manual_follow_up_needed: Type.Number({ minimum: 0 }),
    resolved_positive: Type.Number({ minimum: 0 }),
    resolved_negative: Type.Number({ minimum: 0 }),
    closed_no_response: Type.Number({ minimum: 0 }),
    failed: Type.Number({ minimum: 0 }),
    none: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export const CampaignAdminStatsSchema = Type.Object(
  {
    total: Type.Number({ minimum: 0 }),
    riskFlagged: Type.Number({ minimum: 0 }),
    withInstitutionThread: Type.Number({ minimum: 0 }),
    reviewStatusCounts: CampaignAdminReviewStatusCountsSchema,
    phaseCounts: CampaignAdminPhaseCountsSchema,
    threadPhaseCounts: CampaignAdminThreadPhaseCountsSchema,
  },
  { additionalProperties: false }
);

const RiskFlagSchema = Type.Union([
  Type.Literal('invalid_institution_email'),
  Type.Literal('institution_email_mismatch'),
  Type.Literal('missing_official_email'),
  Type.Literal('institution_thread_failed'),
]);

const PendingReasonSchema = Type.Union([
  Type.Literal('invalid_institution_email'),
  Type.Literal('missing_official_email'),
  Type.Literal('institution_email_mismatch'),
  Type.Literal('institution_thread_failed'),
  Type.Literal('awaiting_manual_review'),
]);

const ReviewSourceSchema = Type.Union([
  Type.Literal('campaign_admin_api'),
  Type.Literal('learning_progress_admin_api'),
  Type.Literal('user_event_worker'),
]);

const CampaignAdminSubmissionPathSchema = Type.Union([
  Type.Literal('request_platform'),
  Type.Literal('send_yourself'),
  Type.Literal('send_email'),
  Type.Literal('download_text'),
]);

const CampaignAdminDocumentTypeSchema = Type.Union([
  Type.Literal('pdf'),
  Type.Literal('word'),
  Type.Literal('excel'),
  Type.Literal('webpage'),
  Type.Literal('graphics'),
  Type.Literal('other'),
]);

const CampaignAdminPublicationSourceTypeSchema = Type.Union([
  Type.Literal('website'),
  Type.Literal('press'),
  Type.Literal('social_media'),
  Type.Literal('other'),
]);

const CampaignAdminPublicationSourceSchema = Type.Object(
  {
    type: CampaignAdminPublicationSourceTypeSchema,
    url: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false }
);

const PublicDebateRequestPayloadSummarySchema = Type.Object(
  {
    kind: Type.Literal('public_debate_request'),
    institutionEmail: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    organizationName: Type.Union([Type.String(), Type.Null()]),
    submissionPath: Type.Union([CampaignAdminSubmissionPathSchema, Type.Null()]),
    isNgo: Type.Union([Type.Boolean(), Type.Null()]),
  },
  { additionalProperties: false }
);

const WebsiteUrlPayloadSummarySchema = Type.Object(
  {
    kind: Type.Literal('website_url'),
    websiteUrl: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false }
);

const BudgetDocumentPayloadSummarySchema = Type.Object(
  {
    kind: Type.Literal('budget_document'),
    documentUrl: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    documentTypes: Type.Array(CampaignAdminDocumentTypeSchema),
  },
  { additionalProperties: false }
);

const BudgetPublicationDatePayloadSummarySchema = Type.Object(
  {
    kind: Type.Literal('budget_publication_date'),
    publicationDate: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    sources: Type.Array(CampaignAdminPublicationSourceSchema),
  },
  { additionalProperties: false }
);

const BudgetStatusPayloadSummarySchema = Type.Object(
  {
    kind: Type.Literal('budget_status'),
    isPublished: Type.Union([
      Type.Literal('yes'),
      Type.Literal('no'),
      Type.Literal('dont_know'),
      Type.Null(),
    ]),
    budgetStage: Type.Union([Type.Literal('draft'), Type.Literal('approved'), Type.Null()]),
  },
  { additionalProperties: false }
);

const CityHallContactPayloadSummarySchema = Type.Object(
  {
    kind: Type.Literal('city_hall_contact'),
    email: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    phone: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false }
);

const ParticipationReportPayloadSummarySchema = Type.Object(
  {
    kind: Type.Literal('participation_report'),
    debateTookPlace: Type.Union([
      Type.Literal('yes'),
      Type.Literal('no'),
      Type.Literal('dont_know'),
      Type.Null(),
    ]),
    approximateAttendees: Type.Union([Type.Number(), Type.Null()]),
    citizensAllowedToSpeak: Type.Union([
      Type.Literal('yes'),
      Type.Literal('no'),
      Type.Literal('partially'),
      Type.Null(),
    ]),
    citizenInputsRecorded: Type.Union([
      Type.Literal('yes'),
      Type.Literal('no'),
      Type.Literal('dont_know'),
      Type.Null(),
    ]),
    observations: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false }
);

const ContestationPayloadSummarySchema = Type.Object(
  {
    kind: Type.Literal('contestation'),
    contestedItem: Type.Union([Type.String(), Type.Null()]),
    reasoning: Type.Union([Type.String(), Type.Null()]),
    impact: Type.Union([Type.String(), Type.Null()]),
    proposedChange: Type.Union([Type.String(), Type.Null()]),
    senderName: Type.Union([Type.String(), Type.Null()]),
    submissionPath: Type.Union([CampaignAdminSubmissionPathSchema, Type.Null()]),
    institutionEmail: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const CampaignAdminPayloadSummarySchema = Type.Union([
  PublicDebateRequestPayloadSummarySchema,
  WebsiteUrlPayloadSummarySchema,
  BudgetDocumentPayloadSummarySchema,
  BudgetPublicationDatePayloadSummarySchema,
  BudgetStatusPayloadSummarySchema,
  CityHallContactPayloadSummarySchema,
  ParticipationReportPayloadSummarySchema,
  ContestationPayloadSummarySchema,
]);

export const CampaignAdminInteractionListItemSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    campaignKey: Type.String({ minLength: 1 }),
    interactionId: Type.String({ minLength: 1 }),
    lessonId: Type.String({ minLength: 1 }),
    entityCui: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    entityName: Type.Union([Type.String(), Type.Null()]),
    scopeType: Type.Union([Type.Literal('global'), Type.Literal('entity')]),
    phase: Type.Union([
      Type.Literal('idle'),
      Type.Literal('draft'),
      Type.Literal('pending'),
      Type.Literal('resolved'),
      Type.Literal('failed'),
    ]),
    reviewStatus: Type.Union([
      Type.Literal('pending'),
      Type.Literal('approved'),
      Type.Literal('rejected'),
      Type.Null(),
    ]),
    pendingReason: Type.Union([PendingReasonSchema, Type.Null()]),
    submittedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
    reviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    reviewedByUserId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    reviewSource: Type.Union([ReviewSourceSchema, Type.Null()]),
    feedbackText: Type.Union([Type.String(), Type.Null()]),
    payloadKind: Type.Union([
      Type.Literal('choice'),
      Type.Literal('text'),
      Type.Literal('url'),
      Type.Literal('number'),
      Type.Literal('json'),
      Type.Null(),
    ]),
    payloadSummary: Type.Union([CampaignAdminPayloadSummarySchema, Type.Null()]),
    institutionEmail: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    websiteUrl: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    organizationName: Type.Union([Type.String(), Type.Null()]),
    interactionElementLink: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    submissionPath: Type.Union([CampaignAdminSubmissionPathSchema, Type.Null()]),
    isNgo: Type.Union([Type.Boolean(), Type.Null()]),
    riskFlags: Type.Array(RiskFlagSchema),
    threadId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    threadPhase: Type.Union([
      Type.Literal('sending'),
      Type.Literal('awaiting_reply'),
      Type.Literal('reply_received_unreviewed'),
      Type.Literal('manual_follow_up_needed'),
      Type.Literal('resolved_positive'),
      Type.Literal('resolved_negative'),
      Type.Literal('closed_no_response'),
      Type.Literal('failed'),
      Type.Null(),
    ]),
    lastEmailAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    lastReplyAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    nextActionAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    submittedEventCount: Type.Number({ minimum: 0 }),
    evaluatedEventCount: Type.Number({ minimum: 0 }),
    lastAuditAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  },
  { additionalProperties: false }
);

export const CampaignAdminMetaResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        availableInteractionTypes: Type.Array(CampaignAdminAvailableInteractionTypeSchema),
        stats: CampaignAdminStatsSchema,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignAdminListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(CampaignAdminInteractionListItemSchema),
        page: Type.Object(
          {
            limit: Type.Number({ minimum: 1, maximum: 100 }),
            hasMore: Type.Boolean(),
            nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
            sortBy: Type.Optional(CampaignAdminSortBySchema),
            sortOrder: Type.Optional(CampaignAdminSortOrderSchema),
          },
          { additionalProperties: false }
        ),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

const ApproveReviewDecisionSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    expectedUpdatedAt: Type.String({ format: 'date-time' }),
    status: Type.Literal('approved'),
    feedbackText: Type.Optional(Type.String({ minLength: 1 })),
    pendingReason: Type.Optional(Type.Never()),
  },
  { additionalProperties: false }
);

const RejectReviewDecisionSchema = Type.Object(
  {
    userId: Type.String({ minLength: 1 }),
    recordKey: Type.String({ minLength: 1 }),
    expectedUpdatedAt: Type.String({ format: 'date-time' }),
    status: Type.Literal('rejected'),
    feedbackText: Type.String({ minLength: 1 }),
    pendingReason: Type.Optional(Type.Never()),
  },
  { additionalProperties: false }
);

export const CampaignAdminReviewDecisionSchema = Type.Union([
  ApproveReviewDecisionSchema,
  RejectReviewDecisionSchema,
]);

export type CampaignAdminReviewDecisionBody = Static<typeof CampaignAdminReviewDecisionSchema>;

export const CampaignAdminSubmitReviewsBodySchema = Type.Object(
  {
    items: Type.Array(CampaignAdminReviewDecisionSchema, {
      minItems: 1,
      maxItems: 100,
    }),
  },
  { additionalProperties: false }
);

export type CampaignAdminSubmitReviewsBody = Static<typeof CampaignAdminSubmitReviewsBodySchema>;

export const CampaignAdminSubmitReviewsResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(CampaignAdminInteractionListItemSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export { ErrorResponseSchema };
