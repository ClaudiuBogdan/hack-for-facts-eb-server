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
// Stores one row per user and per client-controlled record key.
export interface LearningProgress {
  user_id: string;
  record_key: string;
  record: JSONColumnType<LearningProgressRecordValueRow>;
  audit_events: JSONColumnType<LearningProgressAuditEventRow[]>;
  updated_seq: Generated<string>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface LearningProgressRecordValueRow {
  key: string;
  interactionId: string;
  lessonId: string;
  kind: 'quiz' | 'url' | 'text-input' | 'custom';
  scope: { type: 'global' } | { type: 'entity'; entityCui: string };
  completionRule:
    | { type: 'outcome'; outcome: 'correct' | 'incorrect' }
    | { type: 'resolved' }
    | { type: 'score-threshold'; minScore: number }
    | { type: 'component-flag'; flag: string };
  phase: 'idle' | 'draft' | 'pending' | 'resolved' | 'error';
  value:
    | { kind: 'choice'; choice: { selectedId: string | null } }
    | { kind: 'text'; text: { value: string } }
    | { kind: 'url'; url: { value: string } }
    | { kind: 'number'; number: { value: number | null } }
    | { kind: 'json'; json: { value: Record<string, unknown> } }
    | null;
  result: {
    outcome: 'correct' | 'incorrect' | null;
    score?: number | null;
    feedbackText?: string | null;
    response?: Record<string, unknown> | null;
    evaluatedAt?: string | null;
  } | null;
  updatedAt: string;
  submittedAt?: string | null;
}

export type LearningProgressAuditEventRow =
  | {
      id: string;
      recordKey: string;
      lessonId: string;
      interactionId: string;
      type: 'submitted';
      at: string;
      actor: 'user';
      value:
        | { kind: 'choice'; choice: { selectedId: string | null } }
        | { kind: 'text'; text: { value: string } }
        | { kind: 'url'; url: { value: string } }
        | { kind: 'number'; number: { value: number | null } }
        | { kind: 'json'; json: { value: Record<string, unknown> } };
      seq: string;
      sourceClientEventId: string;
      sourceClientId: string;
    }
  | {
      id: string;
      recordKey: string;
      lessonId: string;
      interactionId: string;
      type: 'evaluated';
      at: string;
      actor: 'system';
      phase: 'resolved' | 'error';
      result: {
        outcome: 'correct' | 'incorrect' | null;
        score?: number | null;
        feedbackText?: string | null;
        response?: Record<string, unknown> | null;
        evaluatedAt?: string | null;
      };
      seq: string;
      sourceClientEventId: string;
      sourceClientId: string;
    };

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

// Advanced Map Analytics Maps Table
export interface AdvancedMapAnalyticsMaps {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  visibility: 'private' | 'public';
  public_id: string | null;
  last_snapshot: JSONColumnType<Record<string, unknown>> | null;
  last_snapshot_id: string | null;
  snapshot_count: Generated<number>;
  public_view_count: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  deleted_at: Timestamp | null;
}

// Advanced Map Analytics Snapshots Table
export interface AdvancedMapAnalyticsSnapshots {
  id: string;
  map_id: string;
  title: string;
  description: string | null;
  snapshot: JSONColumnType<Record<string, unknown>>;
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
  advancedmapanalyticsmaps: AdvancedMapAnalyticsMaps;
  advancedmapanalyticssnapshots: AdvancedMapAnalyticsSnapshots;
}
