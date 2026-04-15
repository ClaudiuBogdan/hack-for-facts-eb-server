import { Type, type Static } from '@sinclair/typebox';

const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);
const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());

export const ThreadIdParamsSchema = Type.Object(
  {
    threadId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false }
);

export type ThreadIdParams = Static<typeof ThreadIdParamsSchema>;

export const PendingRepliesQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 50 })),
    offset: Type.Optional(Type.Number({ minimum: 0, default: 0 })),
  },
  { additionalProperties: false }
);

export type PendingRepliesQuery = Static<typeof PendingRepliesQuerySchema>;

export const ReviewReplyBodySchema = Type.Object(
  {
    basedOnEntryId: Type.String({ minLength: 1 }),
    resolutionCode: Type.Union([
      Type.Literal('debate_announced'),
      Type.Literal('already_scheduled'),
      Type.Literal('request_refused'),
      Type.Literal('wrong_contact'),
      Type.Literal('auto_reply'),
      Type.Literal('not_actionable'),
      Type.Literal('other'),
    ]),
    reviewNotes: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: false }
);

export type ReviewReplyBody = Static<typeof ReviewReplyBodySchema>;

export const CorrespondenceAttachmentSchema = Type.Object(
  {
    id: Type.String(),
    filename: Type.String(),
    contentType: Type.String(),
    contentDisposition: NullableStringSchema,
    contentId: NullableStringSchema,
  },
  { additionalProperties: false }
);

export const CorrespondenceEntrySchema = Type.Object(
  {
    id: Type.String(),
    campaignKey: NullableStringSchema,
    direction: Type.String(),
    source: Type.String(),
    resendEmailId: NullableStringSchema,
    messageId: NullableStringSchema,
    fromAddress: Type.String(),
    toAddresses: Type.Array(Type.String()),
    ccAddresses: Type.Array(Type.String()),
    bccAddresses: Type.Array(Type.String()),
    subject: Type.String(),
    textBody: NullableStringSchema,
    htmlBody: NullableStringSchema,
    headers: UnknownRecordSchema,
    attachments: Type.Array(CorrespondenceAttachmentSchema),
    occurredAt: Type.String({ format: 'date-time' }),
    metadata: UnknownRecordSchema,
  },
  { additionalProperties: false }
);

export const ThreadReviewSchema = Type.Object(
  {
    basedOnEntryId: Type.String(),
    resolutionCode: Type.String(),
    notes: NullableStringSchema,
    reviewedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

export const ThreadRecordDataSchema = Type.Object(
  {
    version: Type.Literal(1),
    campaign: Type.String(),
    campaignKey: NullableStringSchema,
    ownerUserId: NullableStringSchema,
    subject: Type.String(),
    submissionPath: Type.String(),
    institutionEmail: Type.String(),
    ngoIdentity: Type.String(),
    requesterOrganizationName: NullableStringSchema,
    budgetPublicationDate: NullableStringSchema,
    consentCapturedAt: NullableStringSchema,
    contestationDeadlineAt: NullableStringSchema,
    captureAddress: NullableStringSchema,
    correspondence: Type.Array(CorrespondenceEntrySchema),
    latestReview: Type.Union([ThreadReviewSchema, Type.Null()]),
    metadata: UnknownRecordSchema,
  },
  { additionalProperties: false }
);

export const ThreadDataSchema = Type.Object(
  {
    id: Type.String(),
    entityCui: Type.String(),
    campaignKey: NullableStringSchema,
    threadKey: Type.String(),
    phase: Type.String(),
    lastEmailAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    lastReplyAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    nextActionAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    closedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    record: ThreadRecordDataSchema,
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

export const PendingReplyItemSchema = Type.Object(
  {
    thread: ThreadDataSchema,
    reply: CorrespondenceEntrySchema,
  },
  { additionalProperties: false }
);

export const PendingRepliesResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(PendingReplyItemSchema),
        page: Type.Object(
          {
            limit: Type.Number(),
            offset: Type.Number(),
            totalCount: Type.Number({ minimum: 0 }),
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

export const ReviewedReplyResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        thread: ThreadDataSchema,
        reply: CorrespondenceEntrySchema,
        notificationStatus: Type.Union([
          Type.Literal('queued'),
          Type.Literal('partial'),
          Type.Literal('none'),
          Type.Literal('failed'),
        ]),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const ErrorResponseSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.String(),
    message: Type.String(),
  },
  { additionalProperties: false }
);
