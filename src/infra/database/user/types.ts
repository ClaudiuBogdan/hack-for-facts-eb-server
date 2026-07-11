import { Generated, ColumnType, JSONColumnType } from 'kysely';

import type { DeliveryStatus } from '@/common/types/index.js';

// Helper for timestamps which can be strings or Dates depending on driver config
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
export type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type BigIntColumn = ColumnType<string, string | number, string | number>;

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

export interface CampaignNotificationRunPlans {
  id: Generated<string>;
  actor_user_id: string;
  campaign_key: string;
  runnable_id: string;
  template_id: string;
  template_version: string;
  payload_hash: string;
  watermark: string;
  summary_json: JSONColumnType<Record<string, unknown>>;
  rows_json: JSONColumnType<Record<string, unknown>[]>;
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
}

export interface UserDataAnonymizationAudit {
  id: Generated<string>;
  user_id_hash: string;
  anonymized_user_id: string;
  first_svix_id: string;
  latest_svix_id: string;
  clerk_event_type: string;
  clerk_event_timestamp: string;
  completed_at: Generated<Timestamp>;
  run_count: Generated<number>;
  summary: JSONColumnType<Record<string, unknown>>;
  created_at: Generated<Timestamp>;
}

export interface VPublicDebateCampaignUserTotal {
  campaign_key: string;
  total_users: string;
}

export interface VPublicDebateUatUserCounts {
  campaign_key: string;
  entity_cui: string;
  total_users: string;
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
    reviewedByUserId?: string;
    reviewSource?:
      | 'campaign_admin_api'
      | 'learning_progress_admin_api'
      | 'auto_review_reuse_match'
      | 'user_event_worker';
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
      actor: 'system' | 'admin';
      actorUserId?: string;
      actorPermission?: string;
      actorSource?:
        | 'campaign_admin_api'
        | 'learning_progress_admin_api'
        | 'auto_review_reuse_match'
        | 'user_event_worker';
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

export interface AdvancedMapDatasets {
  id: Generated<string>;
  public_id: string;
  user_id: string;
  title: string;
  description: string | null;
  markdown_text: string | null;
  unit: string | null;
  visibility: 'private' | 'unlisted' | 'public';
  row_count: Generated<number>;
  reference_count: Generated<number>;
  replaced_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
  deleted_at: Timestamp | null;
}

export interface AdvancedMapDatasetRows {
  dataset_id: string;
  siruta_code: string;
  value_number: string | null;
  value_json: JSONColumnType<Record<string, unknown> | null>;
}

// Agent conversations (docs/AGENT-MODULE-SPEC.md §2.6)
export interface AgentConversations {
  id: string; // useChat chat id (client-generated)
  user_id: string;
  title: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AgentMessages {
  id: string; // AI SDK UIMessage id
  conversation_id: string;
  role: string;
  parts: JSONColumnType<unknown[]>;
  created_at: Generated<Timestamp>;
}

// INS dataset requests (docs/USER-DATA-ANONYMIZATION.md)
export interface InsDatasetRequests {
  id: Generated<string>;
  dataset_code: string;
  siruta: string | null;
  contact_email: string | null;
  note: string | null;
  clerk_user_id: string | null;
  created_at: Generated<Timestamp>;
}

export type NotificationEventStatus =
  | 'pending'
  | 'resolving'
  | 'resolved'
  | 'conflicted'
  | 'failed';

export interface NotificationEvents {
  id: string;
  source: string;
  event_type: string;
  event_schema_version: number;
  occurrence_key: string;
  occurred_at: Timestamp;
  facts: JSONColumnType<
    Record<string, unknown>,
    Record<string, unknown> | string,
    Record<string, unknown> | string
  >;
  payload_hash: string;
  correlation_id: string | null;
  causation_id: string | null;
  stream_key: string | null;
  stream_sequence: number | null;
  status: Generated<NotificationEventStatus>;
  resolution_cursor: string | null;
  claim_token: string | null;
  claim_expires_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  resolved_at: Timestamp | null;
  retention_expires_at: Timestamp;
}

export interface NotificationSourceWatermarks {
  source_id: string;
  watermark: string | null;
  updated_at: GeneratedTimestamp;
}

export type NotificationSubscriptionState = 'active' | 'paused' | 'removed';

export interface NotificationSubscriptions {
  id: string;
  user_id: string;
  kind_id: string;
  subject_type: string;
  subject_id: string;
  config: JSONColumnType<
    Record<string, unknown>,
    Record<string, unknown> | string,
    Record<string, unknown> | string
  >;
  normalized_key: string;
  state: Generated<NotificationSubscriptionState>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  removed_at: Timestamp | null;
}

export interface NotificationGlobalPreferences {
  user_id: string;
  optional_enabled: Generated<boolean>;
  updated_at: GeneratedTimestamp;
}

export type NotificationChannel = 'inbox' | 'email';
export type NotificationCadence = 'immediate' | 'daily' | 'weekly' | 'off';

export interface NotificationChannelPreferences {
  user_id: string;
  channel: NotificationChannel;
  enabled: Generated<boolean>;
  cadence: Generated<NotificationCadence>;
  updated_at: GeneratedTimestamp;
}

export interface LogicalNotifications {
  id: string;
  event_id: string;
  kind_id: string;
  kind_version: number;
  user_id: string;
  eligibility_reason: string;
  locale: Generated<'ro'>;
  recipient_facts: JSONColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | string | null,
    Record<string, unknown> | string | null
  >;
  inbox_template_id: string;
  inbox_template_version: string;
  inbox_title: string;
  inbox_body: string;
  inbox_action_url: string | null;
  inbox_visible: Generated<boolean>;
  read_at: Timestamp | null;
  archived_at: Timestamp | null;
  stream_key: string | null;
  stream_sequence: number | null;
  created_at: GeneratedTimestamp;
  retention_expires_at: Timestamp;
}

export interface NotificationChannelDestinations {
  id: Generated<string>;
  user_id: string;
  channel: 'email';
  fingerprint: string;
  generation: number;
  is_current: Generated<boolean>;
  suppressed_at: Timestamp | null;
  suppression_reason: string | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export type NotificationDeliveryStatus =
  | 'pending_render'
  | 'scheduled'
  | 'ready'
  | 'sending'
  | 'retry_wait'
  | 'accepted'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'suppressed'
  | 'cancelled'
  | 'expired'
  | 'permanent_failed'
  | 'dead_letter'
  | 'unknown';

export interface NotificationDeliveries {
  id: string;
  delivery_key: string;
  logical_notification_id: string | null;
  digest_batch_id: string | null;
  kind_id: string;
  user_id: string;
  channel: 'email';
  destination_fingerprint: string | null;
  destination_generation: number | null;
  template_id: string | null;
  template_version: string | null;
  rendered_subject: string | null;
  rendered_html: string | null;
  rendered_text: string | null;
  content_hash: string | null;
  status: Generated<NotificationDeliveryStatus>;
  not_before: Timestamp | null;
  expires_at: Timestamp | null;
  stream_key: string | null;
  stream_sequence: number | null;
  attempt_count: Generated<number>;
  next_attempt_at: Timestamp | null;
  claim_token: string | null;
  claim_expires_at: Timestamp | null;
  provider_idempotency_key: string | null;
  provider_ref: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  sender_mode: Generated<'active' | 'shadow'>;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  accepted_at: Timestamp | null;
  terminal_at: Timestamp | null;
  retention_expires_at: Timestamp;
}

export type NotificationAttemptResult =
  | 'accepted'
  | 'transient_failure'
  | 'permanent_failure'
  | 'ambiguous';

export interface NotificationDeliveryAttempts {
  id: string;
  delivery_id: string;
  attempt_number: number;
  started_at: Timestamp;
  completed_at: Timestamp | null;
  provider_idempotency_key: string;
  request_correlation_id: string | null;
  destination_fingerprint: string | null;
  result: NotificationAttemptResult | null;
  error_code: string | null;
  error_message: string | null;
  provider_ref: string | null;
  latency_ms: number | null;
  retry_after_ms: number | null;
  created_at: GeneratedTimestamp;
}

export type NotificationDigestBatchStatus = 'open' | 'materializing' | 'rendered' | 'cancelled';

export interface NotificationDigestBatches {
  id: string;
  user_id: string;
  channel: 'email';
  cadence: 'daily' | 'weekly';
  window_start_utc: Timestamp;
  window_end_utc: Timestamp;
  dispatch_at_utc: Timestamp;
  status: Generated<NotificationDigestBatchStatus>;
  rendered_item_ids: JSONColumnType<
    string[] | null,
    string[] | string | null,
    string[] | string | null
  >;
  overflow_count: number | null;
  delivery_id: string | null;
  claim_token: string | null;
  claim_expires_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface NotificationDigestMembers {
  batch_id: string;
  logical_notification_id: string;
  created_at: GeneratedTimestamp;
}

export interface NotificationAuditLog {
  id: Generated<string>;
  occurred_at: Timestamp;
  action: string;
  actor: string;
  user_id: string | null;
  event_id: string | null;
  logical_notification_id: string | null;
  delivery_id: string | null;
  batch_id: string | null;
  subscription_id: string | null;
  reason: string | null;
  details: JSONColumnType<
    Record<string, unknown>,
    Record<string, unknown> | string,
    Record<string, unknown> | string
  >;
}

export interface UserDataRecords {
  record_id: string;
  owner_id: string;
  category: string;
  logical_key: string;
  target_type: string | null;
  target_id: string | null;
  schema_version: number;
  schema_hash: string;
  revision: BigIntColumn;
  status: 'active' | 'deleted';
  payload: JSONColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | string | null,
    Record<string, unknown> | string | null
  >;
  annotations: JSONColumnType<
    Record<string, Record<string, unknown>> | null,
    Record<string, Record<string, unknown>> | string | null,
    Record<string, Record<string, unknown>> | string | null
  >;
  last_event_seq: BigIntColumn;
  last_event_id: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: Timestamp | null;
  privacy_redacted_at: Timestamp | null;
}

export interface UserDataEvents {
  event_seq: BigIntColumn;
  event_id: string;
  record_id: string;
  owner_id: string;
  category: string;
  logical_key: string;
  target_type: string | null;
  target_id: string | null;
  revision: BigIntColumn;
  operation: 'create' | 'replace' | 'annotate' | 'delete' | 'restore' | 'migrate' | 'legacy_import';
  scope: 'payload' | 'annotation';
  annotation_namespace: string | null;
  schema_version: number;
  schema_hash: string;
  payload: JSONColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | string | null,
    Record<string, unknown> | string | null
  >;
  annotations: JSONColumnType<
    Record<string, Record<string, unknown>> | null,
    Record<string, Record<string, unknown>> | string | null,
    Record<string, Record<string, unknown>> | string | null
  >;
  actor_type: 'owner' | 'system' | 'admin';
  actor_id: string | null;
  actor_reason: string | null;
  provenance: 'live' | 'legacy';
  integrity: 'verified' | 'unverified';
  recorded_at: Timestamp;
  client_occurred_at: Timestamp | null;
  source_event_id: string | null;
  source_occurred_at: Timestamp | null;
  privacy_redacted_at: Timestamp | null;
}

export interface UserDataIdempotencyReceipts {
  requester_id: string;
  idempotency_key_hash: string;
  canonical_request_hash: string;
  event_id: string;
  event_seq: BigIntColumn;
  created_at: Timestamp;
  expires_at: Timestamp;
}

// Database Schema Interface
// Note: Keys must be lowercase to match PostgreSQL's default identifier handling.
// PostgreSQL folds unquoted identifiers to lowercase, so CREATE TABLE NotificationsOutbox
// creates a table named "notificationsoutbox". Kysely quotes identifiers, so we must match.
export interface UserDatabase {
  shortlinks: ShortLinks;
  notifications: Notifications;
  notificationsoutbox: NotificationOutbox;
  campaignnotificationrunplans: CampaignNotificationRunPlans;
  userdataanonymizationaudit: UserDataAnonymizationAudit;
  v_public_debate_campaign_user_total: VPublicDebateCampaignUserTotal;
  v_public_debate_uat_user_counts: VPublicDebateUatUserCounts;
  userinteractions: UserInteractionsTable;
  institutionemailthreads: InstitutionEmailThreads;
  resend_wh_emails: ResendWhEmails;
  advancedmapanalyticsmaps: AdvancedMapAnalyticsMaps;
  advancedmapanalyticssnapshots: AdvancedMapAnalyticsSnapshots;
  advancedmapdatasets: AdvancedMapDatasets;
  advancedmapdatasetrows: AdvancedMapDatasetRows;
  agentconversations: AgentConversations;
  agentmessages: AgentMessages;
  ins_dataset_requests: InsDatasetRequests;
  notification_events: NotificationEvents;
  notification_source_watermarks: NotificationSourceWatermarks;
  notification_subscriptions: NotificationSubscriptions;
  notification_global_preferences: NotificationGlobalPreferences;
  notification_channel_preferences: NotificationChannelPreferences;
  logical_notifications: LogicalNotifications;
  notification_channel_destinations: NotificationChannelDestinations;
  notification_deliveries: NotificationDeliveries;
  notification_delivery_attempts: NotificationDeliveryAttempts;
  notification_digest_batches: NotificationDigestBatches;
  notification_digest_members: NotificationDigestMembers;
  notification_audit_log: NotificationAuditLog;
  user_data_records: UserDataRecords;
  user_data_events: UserDataEvents;
  user_data_idempotency_receipts: UserDataIdempotencyReceipts;
}
