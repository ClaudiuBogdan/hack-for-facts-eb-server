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
