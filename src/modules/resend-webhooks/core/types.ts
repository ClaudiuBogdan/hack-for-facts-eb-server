import { Type, type Static } from '@sinclair/typebox';

export const ResendEmailEventTypeSchema = Type.Union([
  Type.Literal('email.sent'),
  Type.Literal('email.delivered'),
  Type.Literal('email.delivery_delayed'),
  Type.Literal('email.complained'),
  Type.Literal('email.bounced'),
  Type.Literal('email.opened'),
  Type.Literal('email.clicked'),
  Type.Literal('email.failed'),
  Type.Literal('email.scheduled'),
  Type.Literal('email.suppressed'),
  Type.Literal('email.received'),
]);

export type ResendEmailEventType = Static<typeof ResendEmailEventTypeSchema>;

export const WebhookTagSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    value: Type.String(),
  },
  { additionalProperties: true }
);

export type WebhookTag = Static<typeof WebhookTagSchema>;

export const ResendWebhookTagsSchema = Type.Union([
  Type.Array(WebhookTagSchema),
  Type.Record(Type.String(), Type.String()),
]);

export type ResendWebhookTags = Static<typeof ResendWebhookTagsSchema>;

const NullableStringSchema = Type.Union([Type.String(), Type.Null()]);

export const BounceDataSchema = Type.Object(
  {
    diagnosticCode: Type.Optional(Type.Array(Type.String())),
    message: Type.Optional(Type.String()),
    subType: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true }
);

export type BounceData = Static<typeof BounceDataSchema>;

export const ClickDataSchema = Type.Object(
  {
    ipAddress: Type.String({ minLength: 1 }),
    link: Type.String({ minLength: 1 }),
    timestamp: Type.String({ minLength: 1 }),
    userAgent: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true }
);

export type ClickData = Static<typeof ClickDataSchema>;

export const ReceivedAttachmentDataSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    filename: Type.String({ minLength: 1 }),
    content_type: Type.String({ minLength: 1 }),
    content_disposition: Type.Optional(NullableStringSchema),
    content_id: Type.Optional(NullableStringSchema),
  },
  { additionalProperties: true }
);

export type ReceivedAttachmentData = Static<typeof ReceivedAttachmentDataSchema>;

export const ResendEmailWebhookEventDataSchema = Type.Object(
  {
    email_id: Type.String({ minLength: 1 }),
    from: Type.String({ minLength: 1 }),
    to: Type.Array(Type.String({ minLength: 1 })),
    cc: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    bcc: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    message_id: Type.Optional(Type.String({ minLength: 1 })),
    attachments: Type.Optional(Type.Array(ReceivedAttachmentDataSchema)),
    subject: Type.String(),
    created_at: Type.String({ minLength: 1 }),
    broadcast_id: Type.Optional(Type.String({ minLength: 1 })),
    template_id: Type.Optional(Type.String({ minLength: 1 })),
    tags: Type.Optional(ResendWebhookTagsSchema),
    bounce: Type.Optional(BounceDataSchema),
    click: Type.Optional(ClickDataSchema),
    reason: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: true }
);

export type ResendEmailWebhookEventData = Static<typeof ResendEmailWebhookEventDataSchema>;

export const ResendEmailWebhookEventSchema = Type.Object(
  {
    type: ResendEmailEventTypeSchema,
    created_at: Type.String({ minLength: 1 }),
    data: ResendEmailWebhookEventDataSchema,
  },
  { additionalProperties: true }
);

export type ResendEmailWebhookEvent = Static<typeof ResendEmailWebhookEventSchema>;

export interface StoredResendEmailEvent {
  id: string;
  svixId: string;
  eventType: ResendEmailEventType;
  webhookReceivedAt: Date;
  eventCreatedAt: Date;
  emailId: string;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses?: string[];
  bccAddresses?: string[];
  messageId?: string | null;
  subject: string;
  emailCreatedAt: Date;
  broadcastId: string | null;
  templateId: string | null;
  tags: ResendWebhookTags | null;
  attachmentsJson?: Record<string, unknown>[] | null;
  bounceType: string | null;
  bounceSubType: string | null;
  bounceMessage: string | null;
  bounceDiagnosticCode: string[] | null;
  clickIpAddress: string | null;
  clickLink: string | null;
  clickTimestamp: Date | null;
  clickUserAgent: string | null;
  threadKey: string | null;
  metadata: Record<string, unknown>;
}

export interface ResendWebhookEmailEventInsert {
  svix_id: string;
  event_type: ResendEmailEventType;
  event_created_at: Date;
  email_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  message_id: string | null;
  subject: string;
  email_created_at: Date;
  broadcast_id: string | null;
  template_id: string | null;
  tags: string | null;
  attachments_json: string | null;
  bounce_type: string | null;
  bounce_sub_type: string | null;
  bounce_message: string | null;
  bounce_diagnostic_code: string[] | null;
  click_ip_address: string | null;
  click_link: string | null;
  click_timestamp: Date | null;
  click_user_agent: string | null;
  thread_key: string | null;
  metadata: Record<string, unknown>;
}
