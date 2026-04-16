import { Type, type Static } from '@sinclair/typebox';

import {
  CampaignAdminResponseStatusSchema,
  CampaignAdminThreadStateGroupSchema,
  CampaignAdminThreadStateSchema,
  CorrespondenceAttachmentMetadataSchema,
} from '../../core/types.js';

const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);
const NullableDateTimeSchema = Type.Union([Type.String({ format: 'date-time' }), Type.Null()]);

export const ErrorResponseSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const CampaignAdminInstitutionThreadParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
    threadId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false }
);

export type CampaignAdminInstitutionThreadParams = Static<
  typeof CampaignAdminInstitutionThreadParamsSchema
>;

export const CampaignKeyParamsSchema = Type.Object(
  {
    campaignKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export type CampaignKeyParams = Static<typeof CampaignKeyParamsSchema>;

export const CampaignAdminInstitutionThreadCursorSchema = Type.Object(
  {
    updatedAt: Type.String({ format: 'date-time' }),
    id: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false }
);

export type CampaignAdminInstitutionThreadCursor = Static<
  typeof CampaignAdminInstitutionThreadCursorSchema
>;

export const CampaignAdminInstitutionThreadsListQuerySchema = Type.Object(
  {
    stateGroup: Type.Optional(CampaignAdminThreadStateGroupSchema),
    threadState: Type.Optional(CampaignAdminThreadStateSchema),
    responseStatus: Type.Optional(CampaignAdminResponseStatusSchema),
    query: Type.Optional(Type.String()),
    entityCui: Type.Optional(Type.String({ minLength: 1 })),
    updatedAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    updatedAtTo: Type.Optional(Type.String({ format: 'date-time' })),
    latestResponseAtFrom: Type.Optional(Type.String({ format: 'date-time' })),
    latestResponseAtTo: Type.Optional(Type.String({ format: 'date-time' })),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false }
);

export type CampaignAdminInstitutionThreadsListQuery = Static<
  typeof CampaignAdminInstitutionThreadsListQuerySchema
>;

export const CampaignAdminThreadResponseEventSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    responseDate: Type.String({ format: 'date-time' }),
    messageContent: Type.String({ minLength: 1 }),
    responseStatus: CampaignAdminResponseStatusSchema,
    actorUserId: Type.String({ minLength: 1 }),
    createdAt: Type.String({ format: 'date-time' }),
    source: Type.Literal('campaign_admin_api'),
  },
  { additionalProperties: false }
);

export const CampaignAdminThreadCorrespondenceEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    direction: Type.Union([Type.Literal('outbound'), Type.Literal('inbound')]),
    source: Type.Union([
      Type.Literal('platform_send'),
      Type.Literal('self_send_cc'),
      Type.Literal('institution_reply'),
    ]),
    fromAddress: Type.String({ minLength: 1 }),
    subject: Type.String({ minLength: 1 }),
    textBody: NullableStringSchema,
    attachments: Type.Array(CorrespondenceAttachmentMetadataSchema),
    occurredAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

export const CampaignAdminInstitutionThreadListItemSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    entityCui: Type.String({ minLength: 1 }),
    entityName: NullableStringSchema,
    campaignKey: Type.String({ minLength: 1 }),
    submissionPath: Type.Literal('platform_send'),
    ownerUserId: NullableStringSchema,
    institutionEmail: Type.String({ minLength: 1 }),
    subject: Type.String({ minLength: 1 }),
    threadState: CampaignAdminThreadStateSchema,
    currentResponseStatus: Type.Union([CampaignAdminResponseStatusSchema, Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
    latestResponseAt: NullableDateTimeSchema,
    responseEventCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export const CampaignAdminInstitutionThreadDetailSchema = Type.Object(
  {
    ...CampaignAdminInstitutionThreadListItemSchema.properties,
    requesterOrganizationName: NullableStringSchema,
    budgetPublicationDate: NullableStringSchema,
    consentCapturedAt: NullableStringSchema,
    contestationDeadlineAt: NullableStringSchema,
    responseEvents: Type.Array(CampaignAdminThreadResponseEventSchema),
    correspondence: Type.Array(CampaignAdminThreadCorrespondenceEntrySchema),
  },
  { additionalProperties: false }
);

export const CampaignAdminInstitutionThreadsListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        items: Type.Array(CampaignAdminInstitutionThreadListItemSchema),
        page: Type.Object(
          {
            limit: Type.Integer({ minimum: 1 }),
            totalCount: Type.Integer({ minimum: 0 }),
            hasMore: Type.Boolean(),
            nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
            sortBy: Type.Literal('updatedAt'),
            sortOrder: Type.Literal('desc'),
          },
          { additionalProperties: false }
        ),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const CampaignAdminInstitutionThreadDetailResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: CampaignAdminInstitutionThreadDetailSchema,
  },
  { additionalProperties: false }
);

export const CampaignAdminInstitutionThreadResponseBodySchema = Type.Object(
  {
    expectedUpdatedAt: Type.String({ format: 'date-time' }),
    responseDate: Type.String({ format: 'date-time' }),
    messageContent: Type.String({ minLength: 1 }),
    responseStatus: CampaignAdminResponseStatusSchema,
  },
  { additionalProperties: false }
);

export type CampaignAdminInstitutionThreadResponseBody = Static<
  typeof CampaignAdminInstitutionThreadResponseBodySchema
>;

export const CampaignAdminInstitutionThreadResponseCreateResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        ...CampaignAdminInstitutionThreadDetailSchema.properties,
        createdResponseEventId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
