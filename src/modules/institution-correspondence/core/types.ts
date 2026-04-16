import { Type, type Static } from '@sinclair/typebox';

import { PUBLIC_DEBATE_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

export const PUBLIC_DEBATE_REQUEST_TYPE = PUBLIC_DEBATE_CAMPAIGN_KEY;
export const FUNKY_CITIZENS_NGO_IDENTITY = 'funky_citizens' as const;

const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);
const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
const IsoDateTimeStringSchema = Type.String({
  minLength: 1,
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})$',
});

export const SubmissionPathSchema = Type.Union([
  Type.Literal('platform_send'),
  Type.Literal('self_send_cc'),
]);

export type InstitutionRequestType = typeof PUBLIC_DEBATE_REQUEST_TYPE;
export type SubmissionPath = Static<typeof SubmissionPathSchema>;

export const ThreadPhaseSchema = Type.Union([
  Type.Literal('sending'),
  Type.Literal('awaiting_reply'),
  Type.Literal('reply_received_unreviewed'),
  Type.Literal('manual_follow_up_needed'),
  Type.Literal('resolved_positive'),
  Type.Literal('resolved_negative'),
  Type.Literal('closed_no_response'),
  Type.Literal('failed'),
]);

export type ThreadPhase = Static<typeof ThreadPhaseSchema>;

export const ResolutionCodeSchema = Type.Union([
  Type.Literal('debate_announced'),
  Type.Literal('already_scheduled'),
  Type.Literal('request_refused'),
  Type.Literal('wrong_contact'),
  Type.Literal('auto_reply'),
  Type.Literal('not_actionable'),
  Type.Literal('other'),
]);

export type ResolutionCode = Static<typeof ResolutionCodeSchema>;

export const MessageDirectionSchema = Type.Union([
  Type.Literal('outbound'),
  Type.Literal('inbound'),
]);

export type MessageDirection = Static<typeof MessageDirectionSchema>;

export const MessageSourceSchema = Type.Union([
  Type.Literal('platform_send'),
  Type.Literal('self_send_cc'),
  Type.Literal('institution_reply'),
]);

export type MessageSource = Static<typeof MessageSourceSchema>;

export const CorrespondenceAttachmentMetadataSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    filename: Type.String({ minLength: 1 }),
    contentType: Type.String({ minLength: 1 }),
    contentDisposition: NullableStringSchema,
    contentId: NullableStringSchema,
  },
  { additionalProperties: false }
);

export type CorrespondenceAttachmentMetadata = Static<
  typeof CorrespondenceAttachmentMetadataSchema
>;

export const CorrespondenceEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    campaignKey: NullableStringSchema,
    direction: MessageDirectionSchema,
    source: MessageSourceSchema,
    resendEmailId: NullableStringSchema,
    messageId: NullableStringSchema,
    fromAddress: Type.String({ minLength: 1 }),
    toAddresses: Type.Array(Type.String({ minLength: 1 })),
    ccAddresses: Type.Array(Type.String({ minLength: 1 })),
    bccAddresses: Type.Array(Type.String({ minLength: 1 })),
    subject: Type.String({ minLength: 1 }),
    textBody: NullableStringSchema,
    htmlBody: NullableStringSchema,
    headers: UnknownRecordSchema,
    attachments: Type.Array(CorrespondenceAttachmentMetadataSchema),
    occurredAt: IsoDateTimeStringSchema,
    metadata: UnknownRecordSchema,
  },
  { additionalProperties: false }
);

export type CorrespondenceEntry = Static<typeof CorrespondenceEntrySchema>;

export const ThreadReviewSchema = Type.Object(
  {
    basedOnEntryId: Type.String({ minLength: 1 }),
    resolutionCode: ResolutionCodeSchema,
    notes: NullableStringSchema,
    reviewedAt: IsoDateTimeStringSchema,
  },
  { additionalProperties: false }
);

export type ThreadReview = Static<typeof ThreadReviewSchema>;

export const CampaignAdminThreadStateSchema = Type.Union([
  Type.Literal('started'),
  Type.Literal('pending'),
  Type.Literal('resolved'),
]);

export type CampaignAdminThreadState = Static<typeof CampaignAdminThreadStateSchema>;

export const CampaignAdminThreadStateGroupSchema = Type.Union([
  Type.Literal('open'),
  Type.Literal('closed'),
]);

export type CampaignAdminThreadStateGroup = Static<typeof CampaignAdminThreadStateGroupSchema>;

export const CampaignAdminResponseStatusSchema = Type.Union([
  Type.Literal('registration_number_received'),
  Type.Literal('request_confirmed'),
  Type.Literal('request_denied'),
]);

export type CampaignAdminResponseStatus = Static<typeof CampaignAdminResponseStatusSchema>;

export const AdminResponseEventSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    responseDate: IsoDateTimeStringSchema,
    messageContent: Type.String({ minLength: 1 }),
    responseStatus: CampaignAdminResponseStatusSchema,
    actorUserId: Type.String({ minLength: 1 }),
    createdAt: IsoDateTimeStringSchema,
    source: Type.Literal('campaign_admin_api'),
  },
  { additionalProperties: false }
);

export type AdminResponseEvent = Static<typeof AdminResponseEventSchema>;

export const AdminWorkflowSchema = Type.Object(
  {
    currentResponseStatus: Type.Union([CampaignAdminResponseStatusSchema, Type.Null()]),
    responseEvents: Type.Array(AdminResponseEventSchema),
  },
  { additionalProperties: false }
);

export type AdminWorkflow = Static<typeof AdminWorkflowSchema>;

export const CorrespondenceThreadRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    campaign: Type.String({ minLength: 1 }),
    campaignKey: NullableStringSchema,
    ownerUserId: NullableStringSchema,
    subject: Type.String({ minLength: 1 }),
    submissionPath: SubmissionPathSchema,
    institutionEmail: Type.String({ minLength: 1 }),
    ngoIdentity: Type.String({ minLength: 1 }),
    requesterOrganizationName: NullableStringSchema,
    budgetPublicationDate: NullableStringSchema,
    consentCapturedAt: NullableStringSchema,
    contestationDeadlineAt: NullableStringSchema,
    captureAddress: NullableStringSchema,
    correspondence: Type.Array(CorrespondenceEntrySchema),
    latestReview: Type.Union([ThreadReviewSchema, Type.Null()]),
    adminWorkflow: Type.Optional(AdminWorkflowSchema),
    metadata: UnknownRecordSchema,
  },
  { additionalProperties: false }
);

export type CorrespondenceThreadRecord = Static<typeof CorrespondenceThreadRecordSchema>;

export interface ThreadRecord {
  id: string;
  entityCui: string;
  campaignKey: string | null;
  threadKey: string;
  phase: ThreadPhase;
  lastEmailAt: Date | null;
  lastReplyAt: Date | null;
  nextActionAt: Date | null;
  closedAt: Date | null;
  record: CorrespondenceThreadRecord;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReceivedEmailSnapshot {
  emailId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  messageId: string | null;
  attachments: CorrespondenceAttachmentMetadata[];
  createdAt: Date;
}

export interface SendPlatformRequestInput {
  ownerUserId: string;
  entityCui: string;
  institutionEmail: string;
  entityName?: string | null;
  requesterOrganizationName?: string | null;
  budgetPublicationDate?: string | null;
  consentCapturedAt?: string | null;
  metadata?: Readonly<Record<string, unknown>> | null;
}

export interface SendPlatformRequestOutput {
  created: boolean;
  thread: ThreadRecord;
}

export interface PendingReplyItem {
  thread: ThreadRecord;
  reply: CorrespondenceEntry;
}

export interface PendingReplyPage {
  items: PendingReplyItem[];
  totalCount: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

export interface ListPendingRepliesInput {
  limit: number;
  offset: number;
}

export interface ReviewReplyInput {
  threadId: string;
  basedOnEntryId: string;
  resolutionCode: ResolutionCode;
  reviewNotes?: string | null;
  reviewedAt?: Date;
}

export interface ReviewReplyOutput {
  thread: ThreadRecord;
  reply: CorrespondenceEntry;
}

export interface CampaignAdminThreadListCursor {
  updatedAt: string;
  id: string;
}

export interface CampaignAdminThreadPage {
  items: ThreadRecord[];
  totalCount: number;
  hasMore: boolean;
  nextCursor: CampaignAdminThreadListCursor | null;
  limit: number;
}

export interface ListCampaignAdminThreadsInput {
  campaignKey: string;
  stateGroup?: CampaignAdminThreadStateGroup;
  threadState?: CampaignAdminThreadState;
  responseStatus?: CampaignAdminResponseStatus;
  query?: string;
  entityCui?: string;
  updatedAtFrom?: Date;
  updatedAtTo?: Date;
  latestResponseAtFrom?: Date;
  latestResponseAtTo?: Date;
  cursor?: CampaignAdminThreadListCursor;
  limit: number;
}

export interface CampaignAdminThreadLookupInput {
  campaignKey: string;
  threadId: string;
}

export interface AppendCampaignAdminThreadResponseInput {
  campaignKey: string;
  threadId: string;
  actorUserId: string;
  expectedUpdatedAt: Date;
  responseDate: Date;
  messageContent: string;
  responseStatus: CampaignAdminResponseStatus;
}

export interface AppendCampaignAdminThreadResponseOutput {
  thread: ThreadRecord;
  createdResponseEventId: string;
}

export interface UnmatchedInboundMetadata {
  matchStatus: 'unmatched' | 'ambiguous' | 'matched';
  matchReason: string;
  rawMessage?: Record<string, unknown>;
  extractedThreadKey?: string | null;
  interactionKey?: string | null;
  candidateEntityCuis?: string[];
  duplicateInteractionCount?: number;
  duplicateResolution?: 'first_wins';
  matchedBy?: 'headers' | 'subject' | 'interaction_key' | 'recipient';
}

export const RESOLUTION_TO_PHASE: Record<ResolutionCode, ThreadPhase> = {
  debate_announced: 'resolved_positive',
  already_scheduled: 'resolved_positive',
  request_refused: 'resolved_negative',
  wrong_contact: 'manual_follow_up_needed',
  auto_reply: 'awaiting_reply',
  not_actionable: 'manual_follow_up_needed',
  other: 'manual_follow_up_needed',
};

export const REVIEWABLE_PHASE: ThreadPhase = 'reply_received_unreviewed';
