import { Generated, ColumnType, JSONColumnType } from 'kysely';

import type { DeliveryStatus } from '@/common/types/index.js';

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

export type { DeliveryStatus } from '@/common/types/index.js';

// Notification Outbox Table (durable compose/send/audit records)
export interface NotificationOutbox {
  id: Generated<string>; // UUID
  user_id: string;
  notification_type: string;
  reference_id: string | null;
  scope_key: string;
  delivery_key: string;
  status: Generated<DeliveryStatus>;
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
  metadata: JSONColumnType<Record<string, unknown>>;
  created_at: Generated<Timestamp>;
}

// User Interactions Table
// Stores one row per user and per client-controlled record key.
export interface UserInteractionsTable {
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
  phase: 'idle' | 'draft' | 'pending' | 'resolved' | 'failed';
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
  review?: {
    status: 'pending' | 'approved' | 'rejected';
    reviewedAt: string | null;
    feedbackText?: string | null;
  } | null;
  sourceUrl?: string;
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
      phase: 'resolved' | 'failed';
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

export type InstitutionEmailThreadSubmissionPath = 'platform_send' | 'self_send_cc';

export type InstitutionEmailThreadPhase =
  | 'sending'
  | 'awaiting_reply'
  | 'reply_received_unreviewed'
  | 'manual_follow_up_needed'
  | 'resolved_positive'
  | 'resolved_negative'
  | 'closed_no_response'
  | 'failed';

export type InstitutionEmailResolutionCode =
  | 'debate_announced'
  | 'already_scheduled'
  | 'request_refused'
  | 'wrong_contact'
  | 'auto_reply'
  | 'not_actionable'
  | 'other';

export interface InstitutionEmailThreads {
  id: Generated<string>;
  entity_cui: string;
  campaign_key: string | null;
  thread_key: string;
  phase: string;
  last_email_at: Timestamp | null;
  last_reply_at: Timestamp | null;
  next_action_at: Timestamp | null;
  closed_at: Timestamp | null;
  record: JSONColumnType<
    Record<string, unknown>,
    Record<string, unknown> | string,
    Record<string, unknown> | string
  >;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ResendWhEmails {
  id: Generated<string>;
  svix_id: string;
  event_type: string;
  webhook_received_at: Generated<Timestamp>;
  event_created_at: Timestamp;
  email_id: string;
  from_address: string;
  to_addresses: string[];
  cc_addresses: Generated<string[]>;
  bcc_addresses: Generated<string[]>;
  message_id: string | null;
  subject: string;
  email_created_at: Timestamp;
  broadcast_id: string | null;
  template_id: string | null;
  tags: JSONColumnType<Record<string, unknown> | Record<string, unknown>[]> | null;
  attachments_json: JSONColumnType<Record<string, unknown>[]> | null;
  bounce_type: string | null;
  bounce_sub_type: string | null;
  bounce_message: string | null;
  bounce_diagnostic_code: string[] | null;
  click_ip_address: string | null;
  click_link: string | null;
  click_timestamp: Timestamp | null;
  click_user_agent: string | null;
  thread_key: string | null;
  metadata: JSONColumnType<
    Record<string, unknown>,
    Record<string, unknown> | string,
    Record<string, unknown> | string
  >;
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
// PostgreSQL folds unquoted identifiers to lowercase, so CREATE TABLE NotificationsOutbox
// creates a table named "notificationsoutbox". Kysely quotes identifiers, so we must match.
export interface UserDatabase {
  shortlinks: ShortLinks;
  notifications: Notifications;
  notificationsoutbox: NotificationOutbox;
  userinteractions: UserInteractionsTable;
  institutionemailthreads: InstitutionEmailThreads;
  resend_wh_emails: ResendWhEmails;
  advancedmapanalyticsmaps: AdvancedMapAnalyticsMaps;
  advancedmapanalyticssnapshots: AdvancedMapAnalyticsSnapshots;
}
