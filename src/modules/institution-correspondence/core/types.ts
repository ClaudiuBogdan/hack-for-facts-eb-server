import { Type, type Static } from '@sinclair/typebox';

import { PUBLIC_DEBATE_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

export const PUBLIC_DEBATE_REQUEST_TYPE = PUBLIC_DEBATE_CAMPAIGN_KEY;
export const FUNKY_CITIZENS_NGO_IDENTITY = 'funky_citizens' as const;

export type InstitutionRequestType = typeof PUBLIC_DEBATE_REQUEST_TYPE;
export type SubmissionPath = 'platform_send' | 'self_send_cc';

export type ThreadPhase =
  | 'sending'
  | 'awaiting_reply'
  | 'reply_received_unreviewed'
  | 'manual_follow_up_needed'
  | 'resolved_positive'
  | 'resolved_negative'
  | 'closed_no_response'
  | 'failed';

export type ResolutionCode =
  | 'debate_announced'
  | 'already_scheduled'
  | 'request_refused'
  | 'wrong_contact'
  | 'auto_reply'
  | 'not_actionable'
  | 'other';

export type MessageDirection = 'outbound' | 'inbound';
export type MessageSource = 'platform_send' | 'self_send_cc' | 'institution_reply';

const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);
const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());

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
    direction: Type.Union([Type.Literal('outbound'), Type.Literal('inbound')]),
    source: Type.Union([
      Type.Literal('platform_send'),
      Type.Literal('self_send_cc'),
      Type.Literal('institution_reply'),
    ]),
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
    occurredAt: Type.String({ format: 'date-time' }),
    metadata: UnknownRecordSchema,
  },
  { additionalProperties: false }
);

export type CorrespondenceEntry = Static<typeof CorrespondenceEntrySchema>;

export const ThreadReviewSchema = Type.Object(
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
    notes: NullableStringSchema,
    reviewedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

export type ThreadReview = Static<typeof ThreadReviewSchema>;

export const CorrespondenceThreadRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    campaign: Type.String({ minLength: 1 }),
    campaignKey: NullableStringSchema,
    ownerUserId: NullableStringSchema,
    subject: Type.String({ minLength: 1 }),
    submissionPath: Type.Union([Type.Literal('platform_send'), Type.Literal('self_send_cc')]),
    institutionEmail: Type.String({ minLength: 1 }),
    ngoIdentity: Type.String({ minLength: 1 }),
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

export interface UnmatchedInboundMetadata {
  matchStatus: 'unmatched' | 'ambiguous' | 'matched';
  matchReason: string;
  rawMessage?: Record<string, unknown>;
  extractedThreadKey?: string | null;
  interactionKey?: string | null;
  candidateEntityCuis?: string[];
  duplicateInteractionCount?: number;
  duplicateResolution?: 'first_wins';
  matchedBy?: 'headers' | 'subject' | 'interaction_key';
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
