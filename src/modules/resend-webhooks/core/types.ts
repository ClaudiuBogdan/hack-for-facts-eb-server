export type ResendEmailEventType =
  | 'email.sent'
  | 'email.delivered'
  | 'email.delivery_delayed'
  | 'email.complained'
  | 'email.bounced'
  | 'email.opened'
  | 'email.clicked'
  | 'email.failed'
  | 'email.scheduled'
  | 'email.suppressed'
  | 'email.received';

export interface WebhookTag {
  name: string;
  value: string;
}

export type ResendWebhookTags = WebhookTag[] | Record<string, string>;

export interface BounceData {
  diagnosticCode?: string[];
  message?: string;
  subType: string;
  type: string;
}

export interface ClickData {
  ipAddress: string;
  link: string;
  timestamp: string;
  userAgent: string;
}

export interface ResendEmailWebhookEventData {
  email_id: string;
  from: string;
  to: string[];
  subject: string;
  created_at: string;
  broadcast_id?: string;
  template_id?: string;
  tags?: ResendWebhookTags;
  bounce?: BounceData;
  click?: ClickData;
  reason?: string;
  error?: string;
}

export interface ResendEmailWebhookEvent {
  type: ResendEmailEventType;
  created_at: string;
  data: ResendEmailWebhookEventData;
}

export interface StoredResendEmailEvent {
  id: string;
  svixId: string;
  eventType: ResendEmailEventType;
  webhookReceivedAt: Date;
  eventCreatedAt: Date;
  emailId: string;
  fromAddress: string;
  toAddresses: string[];
  subject: string;
  emailCreatedAt: Date;
  broadcastId: string | null;
  templateId: string | null;
  tags: ResendWebhookTags | null;
  bounceType: string | null;
  bounceSubType: string | null;
  bounceMessage: string | null;
  bounceDiagnosticCode: string[] | null;
  clickIpAddress: string | null;
  clickLink: string | null;
  clickTimestamp: Date | null;
  clickUserAgent: string | null;
  threadKey: string | null;
}

export interface ResendWebhookEmailEventInsert {
  svix_id: string;
  event_type: ResendEmailEventType;
  event_created_at: Date;
  email_id: string;
  from_address: string;
  to_addresses: string[];
  subject: string;
  email_created_at: Date;
  broadcast_id: string | null;
  template_id: string | null;
  tags: string | null;
  bounce_type: string | null;
  bounce_sub_type: string | null;
  bounce_message: string | null;
  bounce_diagnostic_code: string[] | null;
  click_ip_address: string | null;
  click_link: string | null;
  click_timestamp: Date | null;
  click_user_agent: string | null;
  thread_key: string | null;
}
