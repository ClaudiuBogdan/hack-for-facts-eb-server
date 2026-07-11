-- Short links for sharing client-approved URLs
CREATE TABLE IF NOT EXISTS ShortLinks (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  user_ids TEXT[] NOT NULL,
  original_url TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_shortlinks_user_ids ON ShortLinks USING GIN(user_ids);
CREATE INDEX IF NOT EXISTS idx_shortlinks_created_at ON ShortLinks(created_at);

-- Notifications: User notification preferences
CREATE TABLE IF NOT EXISTS Notifications (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity_cui VARCHAR(20) NULL, -- Reference to main DB Entities (nullable for global notifications)
  notification_type VARCHAR(50) NOT NULL, -- 'newsletter_entity_monthly', etc.
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  -- Configuration (newsletters, alerts, custom queries)
  config JSONB,

  -- Hash for uniqueness: hash(user_id, notification_type, entity_cui, config)
  hash TEXT UNIQUE NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_active ON Notifications(user_id) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_notifications_entity ON Notifications(entity_cui) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_notifications_type_active ON Notifications(notification_type) WHERE is_active = TRUE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_global_unsubscribe_user
ON Notifications(user_id, notification_type)
WHERE notification_type = 'global_unsubscribe';
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_funky_global_user
ON Notifications(user_id, notification_type)
WHERE notification_type = 'funky:notification:global';
CREATE INDEX IF NOT EXISTS idx_notifications_funky_global_active_type_user
ON Notifications(notification_type, user_id)
WHERE notification_type = 'funky:notification:global'
  AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_notifications_funky_entity_active_type_entity_user
ON Notifications(notification_type, entity_cui, user_id)
WHERE notification_type = 'funky:notification:entity_updates'
  AND is_active = TRUE
  AND entity_cui IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_global_unsubscribe_type_user
ON Notifications(notification_type, user_id)
WHERE notification_type = 'global_unsubscribe';

-- NotificationsOutbox: Durable sent/queued/audited notification records
-- Status lifecycle: pending → sending → sent → delivered (via webhook)
--                        ↘ failed_transient (retryable)
--                        ↘ failed_permanent (no retry)
--                        ↘ suppressed (from webhook)
--                        ↘ skipped_unsubscribed
--                        ↘ skipped_no_email
CREATE TABLE IF NOT EXISTS NotificationsOutbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  reference_id TEXT NULL,

  -- Scope identifier for notifications with the same scope
  scope_key TEXT NOT NULL, -- e.g. '2025-01', '2025-Q1', 'funky:delivery:welcome'

  -- Composite deduplication key: notification-specific durable unique key
  delivery_key TEXT UNIQUE NOT NULL,

  -- Delivery status (outbox pattern)
  status VARCHAR(32) NOT NULL DEFAULT 'pending',

  -- Rendered email content (persisted for retry safety)
  rendered_subject TEXT,
  rendered_html TEXT,
  rendered_text TEXT,
  content_hash TEXT, -- Hash of rendered content for change detection
  template_name TEXT,
  template_version TEXT,

  -- Snapshot of email used at send time
  to_email TEXT,

  -- Provider integration
  resend_email_id TEXT, -- ID returned by Resend API or mock sender equivalent

  -- Error tracking
  last_error TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,

  -- Timestamps
  sent_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Status check constraint for valid values
ALTER TABLE NotificationsOutbox
DROP CONSTRAINT IF EXISTS notification_outbox_status_check;
ALTER TABLE NotificationsOutbox
ADD CONSTRAINT notification_outbox_status_check
CHECK (status IN (
  'pending', 'composing', 'sending', 'sent', 'delivered', 'webhook_timeout',
  'failed_transient', 'failed_permanent',
  'suppressed', 'skipped_unsubscribed', 'skipped_no_email'
));

CREATE INDEX IF NOT EXISTS idx_notification_outbox_user_scope
ON NotificationsOutbox(user_id, scope_key);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_created_at
ON NotificationsOutbox(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_reference
ON NotificationsOutbox(notification_type, reference_id)
WHERE reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_outbox_scope_type_reference
ON NotificationsOutbox(scope_key, notification_type, reference_id)
WHERE reference_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_outbox_user_sent_at_desc
ON NotificationsOutbox(user_id, sent_at DESC, created_at DESC)
WHERE sent_at IS NOT NULL;

-- Index for querying pending/failed deliveries (for worker processing)
CREATE INDEX IF NOT EXISTS idx_notification_outbox_status_pending
ON NotificationsOutbox(status) WHERE status IN ('pending', 'failed_transient');

-- Index for finding stuck 'sending' records (for sweeper)
CREATE INDEX IF NOT EXISTS idx_notification_outbox_sending_stuck
ON NotificationsOutbox(last_attempt_at) WHERE status = 'sending';

-- Index for provider email ID lookup (webhook processing)
CREATE INDEX IF NOT EXISTS idx_notification_outbox_resend_email_id
ON NotificationsOutbox(resend_email_id) WHERE resend_email_id IS NOT NULL;

COMMENT ON TABLE Notifications IS
'User-owned notification preferences and subscriptions. Sent or queued notification records live in NotificationsOutbox.';

COMMENT ON TABLE NotificationsOutbox IS
'Durable notification outbox used for deduplication, compose/send lifecycle, audit, and recovery.';

-- UserDataAnonymizationAudit: idempotent, non-PII audit trail for Clerk user deletion handling
CREATE TABLE IF NOT EXISTS UserDataAnonymizationAudit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id_hash TEXT NOT NULL UNIQUE,
  anonymized_user_id TEXT NOT NULL,
  first_svix_id TEXT NOT NULL,
  latest_svix_id TEXT NOT NULL,
  clerk_event_type TEXT NOT NULL,
  clerk_event_timestamp BIGINT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_count INT NOT NULL DEFAULT 1,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_data_anonymization_audit_completed_at
ON UserDataAnonymizationAudit(completed_at DESC);

COMMENT ON TABLE UserDataAnonymizationAudit IS
'Non-PII audit trail for Clerk user.deleted anonymization runs. user_id_hash is a one-way SHA-256 of the Clerk user ID.';

-- CampaignNotificationRunPlans: short-lived stored dry-run snapshots for
-- campaign-admin runnable notification sends.
CREATE TABLE IF NOT EXISTS CampaignNotificationRunPlans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id TEXT NOT NULL,
  campaign_key TEXT NOT NULL,
  runnable_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  watermark TEXT NOT NULL,
  summary_json JSONB NOT NULL,
  rows_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_campaign_notification_run_plans_actor_created
ON CampaignNotificationRunPlans(actor_user_id, campaign_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_notification_run_plans_expires_at
ON CampaignNotificationRunPlans(expires_at)
WHERE consumed_at IS NULL;

COMMENT ON TABLE CampaignNotificationRunPlans IS
'Short-lived stored dry-run plans for template-first campaign admin notification sends.';

-- Public debate campaign analytics views
CREATE OR REPLACE VIEW v_public_debate_campaign_user_total AS
WITH globally_unsubscribed_users AS (
  SELECT DISTINCT n.user_id
  FROM Notifications AS n
  WHERE n.notification_type = 'global_unsubscribe'
    AND (
      n.is_active = FALSE
      OR n.config->'channels'->>'email' = 'false'
    )
)
SELECT
  'funky'::TEXT AS campaign_key,
  COUNT(DISTINCT n.user_id) AS total_users
FROM Notifications AS n
LEFT JOIN globally_unsubscribed_users AS gu ON gu.user_id = n.user_id
WHERE n.notification_type = 'funky:notification:global'
  AND n.is_active = TRUE
  AND gu.user_id IS NULL;

CREATE OR REPLACE VIEW v_public_debate_uat_user_counts AS
WITH active_public_debate_global_users AS (
  SELECT DISTINCT n.user_id
  FROM Notifications AS n
  WHERE n.notification_type = 'funky:notification:global'
    AND n.is_active = TRUE
),
globally_unsubscribed_users AS (
  SELECT DISTINCT n.user_id
  FROM Notifications AS n
  WHERE n.notification_type = 'global_unsubscribe'
    AND (
      n.is_active = FALSE
      OR n.config->'channels'->>'email' = 'false'
    )
)
SELECT
  'funky'::TEXT AS campaign_key,
  n.entity_cui,
  COUNT(DISTINCT n.user_id) AS total_users
FROM Notifications AS n
INNER JOIN active_public_debate_global_users AS g ON g.user_id = n.user_id
LEFT JOIN globally_unsubscribed_users AS gu ON gu.user_id = n.user_id
WHERE n.notification_type = 'funky:notification:entity_updates'
  AND n.is_active = TRUE
  AND n.entity_cui IS NOT NULL
  AND gu.user_id IS NULL
GROUP BY n.entity_cui;

COMMENT ON VIEW v_public_debate_campaign_user_total IS
'Distinct active public debate campaign users, excluding globally unsubscribed users.';

COMMENT ON VIEW v_public_debate_uat_user_counts IS
'Distinct active public debate users per UAT/entity, excluding globally unsubscribed users.';

-- UserInteractions: generic record storage for learning and challenge state.
-- Clean cut from the old per-user event array model.
DROP TABLE IF EXISTS UserInteractions;
DROP TABLE IF EXISTS LearningProgress;
DROP SEQUENCE IF EXISTS userinteractions_updated_seq;
DROP SEQUENCE IF EXISTS learningprogress_updated_seq;

CREATE SEQUENCE userinteractions_updated_seq;

CREATE TABLE UserInteractions (
  user_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  record JSONB NOT NULL,
  audit_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_seq BIGINT NOT NULL DEFAULT nextval('userinteractions_updated_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, record_key)
);

CREATE INDEX IF NOT EXISTS idx_userinteractions_user_updated_seq
ON UserInteractions(user_id, updated_seq);

CREATE INDEX IF NOT EXISTS idx_userinteractions_user_record_key_prefix
ON UserInteractions(user_id, record_key text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_userinteractions_record_key_prefix
ON UserInteractions(record_key text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_userinteractions_review_pending_updated_at
ON UserInteractions(updated_at DESC, user_id, record_key)
WHERE record->>'phase' = 'pending';

CREATE INDEX IF NOT EXISTS idx_userinteractions_review_status_updated_at
ON UserInteractions (
  ((record->'review'->>'status')),
  updated_at DESC,
  user_id,
  record_key
)
WHERE record ? 'review';

CREATE INDEX IF NOT EXISTS idx_userinteractions_funky_review_updated_at
ON UserInteractions(updated_at DESC, user_id, record_key)
WHERE record->>'interactionId' IN (
  'funky:interaction:public_debate_request',
  'funky:interaction:city_hall_website',
  'funky:interaction:budget_document',
  'funky:interaction:budget_publication_date',
  'funky:interaction:budget_status',
  'funky:interaction:city_hall_contact',
  'funky:interaction:funky_participation',
  'funky:interaction:budget_contestation'
);

CREATE INDEX IF NOT EXISTS idx_userinteractions_funky_review_entity_updated_at
ON UserInteractions(
  ((record->'scope'->>'entityCui')),
  updated_at DESC,
  user_id,
  record_key
)
WHERE record->>'interactionId' IN (
    'funky:interaction:public_debate_request',
    'funky:interaction:city_hall_website',
    'funky:interaction:budget_document',
    'funky:interaction:budget_publication_date',
    'funky:interaction:budget_status',
    'funky:interaction:city_hall_contact',
    'funky:interaction:funky_participation',
    'funky:interaction:budget_contestation'
  )
  AND record->'scope'->>'type' = 'entity';

CREATE INDEX IF NOT EXISTS idx_userinteractions_funky_review_submission_path_updated_at
ON UserInteractions(
  ((record->'value'->'json'->'value'->>'submissionPath')),
  updated_at DESC,
  user_id,
  record_key
)
WHERE record->>'interactionId' IN (
    'funky:interaction:public_debate_request',
    'funky:interaction:budget_contestation'
  )
  AND record->'value'->>'kind' = 'json';

-- InstitutionEmailThreads: generic correspondence thread aggregates.
-- Valid phase values are enforced in application code to keep campaigns flexible.
CREATE TABLE IF NOT EXISTS InstitutionEmailThreads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_cui VARCHAR(20) NOT NULL,
  campaign_key TEXT NULL,
  thread_key TEXT NOT NULL,
  phase TEXT NOT NULL,
  last_email_at TIMESTAMPTZ NULL,
  last_reply_at TIMESTAMPTZ NULL,
  next_action_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_institution_email_threads_thread_key_unique
ON InstitutionEmailThreads(thread_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_institution_email_threads_platform_send_active_unique
ON InstitutionEmailThreads(entity_cui, campaign_key)
WHERE record->>'submissionPath' = 'platform_send'
  AND phase <> 'failed'
  AND campaign_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_institution_email_threads_self_send_interaction_unique
ON InstitutionEmailThreads(
  entity_cui,
  campaign_key,
  (record->'metadata'->>'interactionKey')
)
WHERE record->>'submissionPath' = 'self_send_cc'
  AND campaign_key IS NOT NULL
  AND record->'metadata'->>'interactionKey' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_entity_campaign_recent
ON InstitutionEmailThreads(entity_cui, campaign_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_phase
ON InstitutionEmailThreads(phase, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_pending_reply
ON InstitutionEmailThreads(last_reply_at DESC)
WHERE phase = 'reply_received_unreviewed' AND last_reply_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_next_action_at
ON InstitutionEmailThreads(next_action_at)
WHERE next_action_at IS NOT NULL;

-- resend_wh_emails: generic shared Resend email event store
CREATE TABLE IF NOT EXISTS resend_wh_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  svix_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  webhook_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_created_at TIMESTAMPTZ NOT NULL,
  email_id TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_addresses TEXT[] NOT NULL,
  cc_addresses TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  bcc_addresses TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  message_id TEXT NULL,
  subject TEXT NOT NULL,
  email_created_at TIMESTAMPTZ NOT NULL,
  broadcast_id TEXT NULL,
  template_id TEXT NULL,
  tags JSONB NULL,
  attachments_json JSONB NULL,
  bounce_type TEXT NULL,
  bounce_sub_type TEXT NULL,
  bounce_message TEXT NULL,
  bounce_diagnostic_code TEXT[] NULL,
  click_ip_address TEXT NULL,
  click_link TEXT NULL,
  click_timestamp TIMESTAMPTZ NULL,
  click_user_agent TEXT NULL,
  thread_key TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resend_wh_emails_svix_id_unique ON resend_wh_emails(svix_id);
CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_email_id ON resend_wh_emails(email_id);
CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_event_type ON resend_wh_emails(event_type);
CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_webhook_received_at ON resend_wh_emails(webhook_received_at);
CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_from_address ON resend_wh_emails(from_address);
CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_message_id
ON resend_wh_emails(message_id)
WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_thread_key ON resend_wh_emails(thread_key) WHERE thread_key IS NOT NULL;

-- AdvancedMapAnalyticsMaps: User-owned map analytics projects with latest snapshot cache
CREATE TABLE IF NOT EXISTS AdvancedMapAnalyticsMaps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  public_id TEXT UNIQUE,
  last_snapshot JSONB NULL,
  last_snapshot_id TEXT NULL,
  snapshot_count INT NOT NULL DEFAULT 0,
  public_view_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

ALTER TABLE AdvancedMapAnalyticsMaps
ADD COLUMN IF NOT EXISTS public_view_count INT NOT NULL DEFAULT 0;

UPDATE AdvancedMapAnalyticsMaps
SET public_view_count = 0
WHERE public_view_count IS NULL;

ALTER TABLE AdvancedMapAnalyticsMaps
ALTER COLUMN public_view_count SET DEFAULT 0;

ALTER TABLE AdvancedMapAnalyticsMaps
ALTER COLUMN public_view_count SET NOT NULL;

ALTER TABLE AdvancedMapAnalyticsMaps
DROP CONSTRAINT IF EXISTS advanced_map_analytics_maps_visibility_check;
ALTER TABLE AdvancedMapAnalyticsMaps
ADD CONSTRAINT advanced_map_analytics_maps_visibility_check
CHECK (visibility IN ('private', 'public'));

ALTER TABLE AdvancedMapAnalyticsMaps
DROP CONSTRAINT IF EXISTS advanced_map_analytics_maps_snapshot_count_check;
ALTER TABLE AdvancedMapAnalyticsMaps
ADD CONSTRAINT advanced_map_analytics_maps_snapshot_count_check
CHECK (snapshot_count >= 0);

ALTER TABLE AdvancedMapAnalyticsMaps
DROP CONSTRAINT IF EXISTS advanced_map_analytics_maps_public_view_count_check;
ALTER TABLE AdvancedMapAnalyticsMaps
ADD CONSTRAINT advanced_map_analytics_maps_public_view_count_check
CHECK (public_view_count >= 0);

CREATE INDEX IF NOT EXISTS idx_advanced_map_analytics_maps_user_updated
ON AdvancedMapAnalyticsMaps(user_id, updated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_advanced_map_analytics_maps_public_id
ON AdvancedMapAnalyticsMaps(public_id)
WHERE public_id IS NOT NULL AND deleted_at IS NULL;

-- AdvancedMapAnalyticsSnapshots: append-only immutable snapshots
CREATE TABLE IF NOT EXISTS AdvancedMapAnalyticsSnapshots (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES AdvancedMapAnalyticsMaps(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advanced_map_analytics_snapshots_map_created_at
ON AdvancedMapAnalyticsSnapshots(map_id, created_at DESC);

-- AdvancedMapDatasets: uploaded analytic datasets used by advanced map analytics
CREATE TABLE IF NOT EXISTS AdvancedMapDatasets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id UUID NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  title VARCHAR(255) NOT NULL,
  description VARCHAR(2000) NULL,
  markdown_text TEXT NULL,
  unit VARCHAR(100) NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  row_count INT NOT NULL DEFAULT 0,
  reference_count INT NOT NULL DEFAULT 0,
  replaced_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT advanced_map_datasets_visibility_check
    CHECK (visibility IN ('private', 'unlisted', 'public')),
  CONSTRAINT advanced_map_datasets_row_count_check
    CHECK (row_count >= 0),
  CONSTRAINT advanced_map_datasets_reference_count_check
    CHECK (reference_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_advanced_map_datasets_user_updated
ON AdvancedMapDatasets(user_id, updated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_advanced_map_datasets_public_visibility_updated
ON AdvancedMapDatasets(visibility, updated_at DESC)
WHERE deleted_at IS NULL;

-- AdvancedMapDatasetRows: number/json row values keyed by UAT SIRUTA
CREATE TABLE IF NOT EXISTS AdvancedMapDatasetRows (
  dataset_id UUID NOT NULL REFERENCES AdvancedMapDatasets(id) ON DELETE CASCADE,
  siruta_code VARCHAR(20) NOT NULL,
  value_number NUMERIC NULL,
  value_json JSONB NULL,
  CONSTRAINT advanced_map_dataset_rows_value_presence_check
    CHECK (value_number IS NOT NULL OR value_json IS NOT NULL),
  PRIMARY KEY (dataset_id, siruta_code)
);

CREATE OR REPLACE FUNCTION is_valid_advanced_map_dataset_row_payload(payload JSONB)
RETURNS BOOLEAN AS $$
  SELECT
    payload IS NULL OR (
      jsonb_typeof(payload) = 'object'
      AND payload ?& ARRAY['type', 'value']
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_object_keys(payload) AS top_key(key)
        WHERE top_key.key NOT IN ('type', 'value')
      )
      AND jsonb_typeof(payload->'type') = 'string'
      AND CASE payload->>'type'
        WHEN 'text' THEN
          jsonb_typeof(payload->'value') = 'object'
          AND (payload->'value') ? 'text'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_object_keys(payload->'value') AS text_key(key)
            WHERE text_key.key <> 'text'
          )
          AND jsonb_typeof(payload->'value'->'text') = 'string'
          AND btrim(payload->'value'->>'text') <> ''
        WHEN 'markdown' THEN
          jsonb_typeof(payload->'value') = 'object'
          AND (payload->'value') ? 'markdown'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_object_keys(payload->'value') AS markdown_key(key)
            WHERE markdown_key.key <> 'markdown'
          )
          AND jsonb_typeof(payload->'value'->'markdown') = 'string'
          AND btrim(payload->'value'->>'markdown') <> ''
        WHEN 'link' THEN
          jsonb_typeof(payload->'value') = 'object'
          AND (payload->'value') ? 'url'
          AND (payload->'value') ? 'label'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_object_keys(payload->'value') AS link_key(key)
            WHERE link_key.key NOT IN ('url', 'label')
          )
          AND jsonb_typeof(payload->'value'->'url') = 'string'
          AND btrim(payload->'value'->>'url') ~* '^https?://'
          AND (
            payload->'value'->'label' = 'null'::jsonb
            OR jsonb_typeof(payload->'value'->'label') = 'string'
          )
        ELSE FALSE
      END
    );
$$ LANGUAGE sql IMMUTABLE;
ALTER TABLE AdvancedMapDatasetRows
ADD CONSTRAINT advanced_map_dataset_rows_value_json_payload_check
CHECK (is_valid_advanced_map_dataset_row_payload(value_json));

CREATE INDEX IF NOT EXISTS idx_advanced_map_dataset_rows_dataset
ON AdvancedMapDatasetRows(dataset_id);

-- Agent conversations (docs/AGENT-MODULE-SPEC.md §2.6). Chat threads for the
-- in-app AI agent; user_id is the Clerk user id. Messages store the AI SDK
-- UIMessage parts verbatim (JSONB) so threads re-hydrate useChat losslessly.
CREATE TABLE IF NOT EXISTS AgentConversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_user
ON AgentConversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS AgentMessages (
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES AgentConversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  parts JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation
ON AgentMessages(conversation_id, created_at);

-- INS dataset requests: users asking for a CATALOG_ONLY dataset to be loaded,
-- optionally scoped to a territory. Anonymous submissions are allowed, so both
-- contact_email and clerk_user_id are nullable. Both are anonymized on Clerk
-- user.deleted (see docs/USER-DATA-ANONYMIZATION.md).
CREATE TABLE IF NOT EXISTS ins_dataset_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_code TEXT NOT NULL,
  siruta TEXT,
  contact_email TEXT,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 1000),
  clerk_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ins_dataset_requests_dataset_code
ON ins_dataset_requests(dataset_code);

CREATE INDEX IF NOT EXISTS idx_ins_dataset_requests_created_at
ON ins_dataset_requests(created_at DESC);

-- Supports the Clerk user.deleted anonymization lookup. Partial: anonymous rows
-- store no clerk_user_id and are never matched.
CREATE INDEX IF NOT EXISTS idx_ins_dataset_requests_clerk_user_id
ON ins_dataset_requests(clerk_user_id)
WHERE clerk_user_id IS NOT NULL;

-- Notification platform: durable events, user controls, inbox snapshots,
-- external delivery state, digest materialization, and redacted audit history.
CREATE TABLE IF NOT EXISTS notification_events (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_schema_version INT NOT NULL,
  occurrence_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  facts JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  stream_key TEXT,
  stream_sequence BIGINT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','resolving','resolved','conflicted','failed')),
  resolution_cursor TEXT,
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  retention_expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (source, event_type, occurrence_key)
);

CREATE INDEX IF NOT EXISTS idx_np_events_unresolved
ON notification_events(created_at)
WHERE status IN ('pending','resolving');

CREATE INDEX IF NOT EXISTS idx_np_events_correlation
ON notification_events(correlation_id)
WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_source_watermarks (
  source_id TEXT PRIMARY KEY,
  watermark TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  normalized_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  UNIQUE (user_id, kind_id, normalized_key)
);

CREATE INDEX IF NOT EXISTS idx_np_subs_fanout
ON notification_subscriptions(kind_id, subject_type, subject_id, id)
WHERE state = 'active';

CREATE INDEX IF NOT EXISTS idx_np_subs_user
ON notification_subscriptions(user_id, state);

CREATE TABLE IF NOT EXISTS notification_global_preferences (
  user_id TEXT PRIMARY KEY,
  optional_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_channel_preferences (
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('inbox','email')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cadence TEXT NOT NULL DEFAULT 'immediate'
    CHECK (cadence IN ('immediate','daily','weekly','off')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel)
);

CREATE TABLE IF NOT EXISTS logical_notifications (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES notification_events(id),
  kind_id TEXT NOT NULL,
  kind_version INT NOT NULL,
  user_id TEXT NOT NULL,
  eligibility_reason TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'ro',
  recipient_facts JSONB,
  inbox_template_id TEXT NOT NULL,
  inbox_template_version TEXT NOT NULL,
  inbox_title TEXT NOT NULL,
  inbox_body TEXT NOT NULL,
  inbox_action_url TEXT,
  inbox_visible BOOLEAN NOT NULL DEFAULT TRUE,
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  stream_key TEXT,
  stream_sequence BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retention_expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (event_id, kind_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_np_logical_inbox_cursor
ON logical_notifications(user_id, created_at DESC, id DESC)
WHERE inbox_visible;

CREATE INDEX IF NOT EXISTS idx_np_logical_unread
ON logical_notifications(user_id)
WHERE read_at IS NULL AND archived_at IS NULL AND inbox_visible;

CREATE INDEX IF NOT EXISTS idx_np_logical_event
ON logical_notifications(event_id);

-- Fingerprint + generation only. Plaintext destinations are never persisted.
CREATE TABLE IF NOT EXISTS notification_channel_destinations (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  fingerprint TEXT NOT NULL,
  generation INT NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  suppressed_at TIMESTAMPTZ,
  suppression_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, fingerprint)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_np_dest_current
ON notification_channel_destinations(user_id, channel)
WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_np_dest_fingerprint
ON notification_channel_destinations(channel, fingerprint);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY,
  delivery_key TEXT NOT NULL UNIQUE,
  logical_notification_id UUID REFERENCES logical_notifications(id),
  digest_batch_id UUID,
  kind_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  destination_fingerprint TEXT,
  destination_generation INT,
  template_id TEXT,
  template_version TEXT,
  rendered_subject TEXT,
  rendered_html TEXT,
  rendered_text TEXT,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending_render' CHECK (status IN (
    'pending_render','scheduled','ready','sending','retry_wait','accepted','delivered',
    'bounced','complained','suppressed','cancelled','expired','permanent_failed','dead_letter','unknown'
  )),
  not_before TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  stream_key TEXT,
  stream_sequence BIGINT,
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  provider_idempotency_key TEXT,
  provider_ref TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  sender_mode TEXT NOT NULL DEFAULT 'active' CHECK (sender_mode IN ('active','shadow')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  retention_expires_at TIMESTAMPTZ NOT NULL,
  CHECK ((logical_notification_id IS NULL) <> (digest_batch_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_np_deliv_due
ON notification_deliveries(COALESCE(next_attempt_at, not_before, created_at))
WHERE status IN ('ready','retry_wait','scheduled') AND sender_mode = 'active';

CREATE INDEX IF NOT EXISTS idx_np_deliv_render
ON notification_deliveries(created_at)
WHERE status = 'pending_render';

CREATE INDEX IF NOT EXISTS idx_np_deliv_stuck
ON notification_deliveries(claim_expires_at)
WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS idx_np_deliv_stream
ON notification_deliveries(user_id, channel, stream_key, stream_sequence)
WHERE stream_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_np_deliv_logical
ON notification_deliveries(logical_notification_id, delivery_key)
WHERE logical_notification_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_np_deliv_shadow
ON notification_deliveries(kind_id, delivery_key)
WHERE sender_mode = 'shadow';

CREATE INDEX IF NOT EXISTS idx_np_deliv_dead
ON notification_deliveries(status, terminal_at)
WHERE status IN ('dead_letter','unknown','permanent_failed');

CREATE INDEX IF NOT EXISTS idx_np_deliv_user_pending
ON notification_deliveries(user_id)
WHERE status IN ('pending_render','scheduled','ready','sending','retry_wait');

CREATE INDEX IF NOT EXISTS idx_np_deliv_provider_ref
ON notification_deliveries(provider_ref)
WHERE provider_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_np_deliv_expiry
ON notification_deliveries(expires_at)
WHERE expires_at IS NOT NULL AND status IN ('pending_render','scheduled','ready','retry_wait');

CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES notification_deliveries(id),
  attempt_number INT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  provider_idempotency_key TEXT NOT NULL,
  request_correlation_id TEXT,
  destination_fingerprint TEXT,
  result TEXT CHECK (result IN ('accepted','transient_failure','permanent_failure','ambiguous')),
  error_code TEXT,
  error_message TEXT,
  provider_ref TEXT,
  latency_ms INT,
  retry_after_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_np_attempts_retention
ON notification_delivery_attempts(created_at);

CREATE TABLE IF NOT EXISTS notification_digest_batches (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly')),
  window_start_utc TIMESTAMPTZ NOT NULL,
  window_end_utc TIMESTAMPTZ NOT NULL,
  dispatch_at_utc TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','materializing','rendered','cancelled')),
  rendered_item_ids JSONB,
  overflow_count INT,
  delivery_id UUID,
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel, cadence, window_start_utc)
);

CREATE INDEX IF NOT EXISTS idx_np_digest_due
ON notification_digest_batches(dispatch_at_utc)
WHERE status = 'open';

CREATE TABLE IF NOT EXISTS notification_digest_members (
  batch_id UUID NOT NULL REFERENCES notification_digest_batches(id),
  logical_notification_id UUID NOT NULL REFERENCES logical_notifications(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, logical_notification_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_digest_batch_id_fkey'
  ) THEN
    ALTER TABLE notification_deliveries
      ADD CONSTRAINT notification_deliveries_digest_batch_id_fkey
      FOREIGN KEY (digest_batch_id) REFERENCES notification_digest_batches(id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS notification_audit_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  user_id TEXT,
  event_id UUID,
  logical_notification_id UUID,
  delivery_id UUID,
  batch_id UUID,
  subscription_id UUID,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_np_audit_event
ON notification_audit_log(event_id)
WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_np_audit_delivery
ON notification_audit_log(delivery_id)
WHERE delivery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_np_audit_user_time
ON notification_audit_log(user_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_np_audit_action_time
ON notification_audit_log(action, occurred_at);

-- User Data Store v2 persistence. Mirrors the user-data migration.

CREATE TABLE IF NOT EXISTS user_data_records (
  record_id           UUID PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  category            TEXT NOT NULL,
  logical_key         TEXT NOT NULL,
  target_type         TEXT,
  target_id           TEXT,
  schema_version      INTEGER NOT NULL,
  schema_hash         TEXT NOT NULL,
  revision            BIGINT NOT NULL CHECK (revision > 0),
  status              TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  payload             JSONB,
  annotations         JSONB,
  last_event_seq      BIGINT NOT NULL,
  last_event_id       UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL,
  deleted_at          TIMESTAMPTZ,
  privacy_redacted_at TIMESTAMPTZ,
  CONSTRAINT user_data_records_identity UNIQUE (owner_id, category, logical_key),
  CONSTRAINT user_data_records_lifecycle CHECK (
    (status = 'active' AND payload IS NOT NULL AND jsonb_typeof(payload) = 'object' AND deleted_at IS NULL)
    OR
    (status = 'deleted' AND payload IS NULL AND annotations IS NULL AND deleted_at IS NOT NULL)
  ),
  CONSTRAINT user_data_records_target CHECK ((target_type IS NULL) = (target_id IS NULL)),
  CONSTRAINT user_data_records_annotations CHECK (annotations IS NULL OR jsonb_typeof(annotations) = 'object'),
  CONSTRAINT user_data_records_payload_size CHECK (payload IS NULL OR pg_column_size(payload) <= 65536)
);

CREATE INDEX IF NOT EXISTS user_data_records_sync_idx
ON user_data_records (owner_id, last_event_seq);

CREATE INDEX IF NOT EXISTS user_data_records_list_idx
ON user_data_records (owner_id, category, record_id);

CREATE INDEX IF NOT EXISTS user_data_records_target_idx
ON user_data_records (owner_id, category, target_type, target_id)
WHERE target_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_data_records_funky_interaction_id_idx
ON user_data_records ((payload->>'interactionId'))
WHERE category = 'funky.interaction';

CREATE INDEX IF NOT EXISTS user_data_records_funky_phase_idx
ON user_data_records ((payload->>'phase'))
WHERE category = 'funky.interaction';

CREATE SEQUENCE IF NOT EXISTS user_data_event_seq;

CREATE TABLE IF NOT EXISTS user_data_events (
  event_seq            BIGINT PRIMARY KEY,
  event_id             UUID NOT NULL UNIQUE,
  record_id            UUID NOT NULL REFERENCES user_data_records (record_id),
  owner_id             TEXT NOT NULL,
  category             TEXT NOT NULL,
  logical_key          TEXT NOT NULL,
  target_type          TEXT,
  target_id            TEXT,
  revision             BIGINT NOT NULL,
  operation            TEXT NOT NULL CHECK (operation IN ('create','replace','annotate','delete','restore','migrate','legacy_import')),
  scope                TEXT NOT NULL CHECK (scope IN ('payload','annotation')),
  annotation_namespace TEXT,
  schema_version       INTEGER NOT NULL,
  schema_hash          TEXT NOT NULL,
  payload              JSONB,
  annotations          JSONB,
  actor_type           TEXT NOT NULL CHECK (actor_type IN ('owner','system','admin')),
  actor_id             TEXT,
  actor_reason         TEXT,
  provenance           TEXT NOT NULL CHECK (provenance IN ('live','legacy')),
  integrity            TEXT NOT NULL CHECK (integrity IN ('verified','unverified')),
  recorded_at          TIMESTAMPTZ NOT NULL,
  client_occurred_at   TIMESTAMPTZ,
  source_event_id      TEXT,
  source_occurred_at   TIMESTAMPTZ,
  privacy_redacted_at  TIMESTAMPTZ,
  CONSTRAINT user_data_events_record_revision UNIQUE (record_id, revision),
  CONSTRAINT user_data_events_annotate_ns CHECK ((scope = 'annotation') = (annotation_namespace IS NOT NULL)),
  CONSTRAINT user_data_events_admin_attrib CHECK (actor_type <> 'admin' OR (actor_id IS NOT NULL AND actor_reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS user_data_events_owner_idx
ON user_data_events (owner_id, event_seq);

CREATE TABLE IF NOT EXISTS user_data_idempotency_receipts (
  requester_id           TEXT NOT NULL,
  idempotency_key_hash   TEXT NOT NULL,
  canonical_request_hash TEXT NOT NULL,
  event_id               UUID NOT NULL,
  event_seq              BIGINT NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL,
  expires_at             TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (requester_id, idempotency_key_hash)
);

CREATE OR REPLACE FUNCTION user_data_events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'user_data_events is append-only';
  END IF;
  IF current_setting('app.user_data_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'user_data_events may only be updated by the maintenance path';
  END IF;
  IF NEW.privacy_redacted_at IS NULL THEN
    RAISE EXCEPTION 'user_data_events update must record privacy redaction';
  END IF;
  IF NEW.event_seq IS DISTINCT FROM OLD.event_seq
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.record_id IS DISTINCT FROM OLD.record_id
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.logical_key IS DISTINCT FROM OLD.logical_key
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.operation IS DISTINCT FROM OLD.operation
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.annotation_namespace IS DISTINCT FROM OLD.annotation_namespace
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.schema_hash IS DISTINCT FROM OLD.schema_hash
     OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
     OR NEW.actor_reason IS DISTINCT FROM OLD.actor_reason
     OR NEW.provenance IS DISTINCT FROM OLD.provenance
     OR NEW.integrity IS DISTINCT FROM OLD.integrity
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'user_data_events update touches immutable columns';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_data_events_append_only ON user_data_events;
CREATE TRIGGER user_data_events_append_only
  BEFORE UPDATE OR DELETE ON user_data_events
  FOR EACH ROW EXECUTE FUNCTION user_data_events_append_only();
