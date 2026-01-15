import { Generated, ColumnType, JSONColumnType } from 'kysely';

// Helper for timestamps which can be strings or Dates depending on driver config
export type Timestamp = ColumnType<Date, Date | string, Date | string>;

// Short Links Table
export interface ShortLinks {
  id: Generated<string>; // BIGSERIAL -> string
  code: string;
  user_ids: string[];
  original_url: string;
  created_at: Generated<Timestamp>;
  access_count: Generated<number>;
  last_access_at: Timestamp | null;
  metadata: JSONColumnType<Record<string, unknown>> | null;
}

// Notifications Table
export interface Notifications {
  id: string; // UUID
  user_id: string;
  entity_cui: string | null;
  notification_type: string;
  is_active: Generated<boolean>;
  config: JSONColumnType<Record<string, unknown>> | null;
  hash: string;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

// Delivery status for outbox pattern
export type DeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'failed_transient'
  | 'failed_permanent'
  | 'suppressed'
  | 'skipped_unsubscribed'
  | 'skipped_no_email';

// Notification Deliveries Table (outbox pattern)
export interface NotificationDeliveries {
  id: Generated<string>; // UUID
  user_id: string;
  notification_id: string; // UUID
  period_key: string;
  delivery_key: string;
  status: Generated<DeliveryStatus>;
  unsubscribe_token: string | null; // FK to UnsubscribeTokens
  rendered_subject: string | null;
  rendered_html: string | null;
  rendered_text: string | null;
  content_hash: string | null;
  template_name: string | null;
  template_version: string | null;
  to_email: string | null;
  resend_email_id: string | null;
  last_error: string | null;
  attempt_count: Generated<number>;
  last_attempt_at: Timestamp | null;
  sent_at: Timestamp | null;
  metadata: JSONColumnType<Record<string, unknown>> | null;
  created_at: Generated<Timestamp>;
}

// Unsubscribe Tokens Table
export interface UnsubscribeTokens {
  token: string;
  user_id: string;
  notification_id: string; // UUID
  created_at: Generated<Timestamp>;
  expires_at: Generated<Timestamp>;
  used_at: Timestamp | null;
}

// Learning Progress Table
// Stores all learning progress events in a JSONB array per user.
// Events are immutable and append-only (semantically).
export interface LearningProgress {
  user_id: string;
  events: JSONColumnType<LearningProgressEventRow[]>;
  last_event_at: Timestamp | null;
  event_count: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

// Raw event structure stored in JSONB
// This matches the client's LearningProgressEvent type
export interface LearningProgressEventRow {
  eventId: string;
  occurredAt: string;
  clientId: string;
  type: string;
  payload: Record<string, unknown>;
}

// Resend Webhook Events Table
// Tracks webhook events for idempotent processing using svix-id
export interface ResendWebhookEvents {
  id: Generated<string>; // BIGSERIAL
  svix_id: string; // Unique event ID from svix-id header
  event_type: string; // email.sent, email.delivered, etc.
  resend_email_id: string; // Resend's email ID
  delivery_id: string | null; // Our delivery UUID from tags
  payload: JSONColumnType<Record<string, unknown>>;
  processed_at: Timestamp | null; // When processing completed
  created_at: Generated<Timestamp>;
}

// Database Schema Interface
// Note: Keys must be lowercase to match PostgreSQL's default identifier handling.
// PostgreSQL folds unquoted identifiers to lowercase, so CREATE TABLE Notifications
// creates a table named "notifications". Kysely quotes identifiers, so we must match.
export interface UserDatabase {
  shortlinks: ShortLinks;
  notifications: Notifications;
  notificationdeliveries: NotificationDeliveries;
  unsubscribetokens: UnsubscribeTokens;
  learningprogress: LearningProgress;
  resendwebhookevents: ResendWebhookEvents;
}
