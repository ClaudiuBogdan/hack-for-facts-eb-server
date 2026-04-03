-- One-time production cutover from the legacy main user DB schema to the
-- current dev schema.
--
-- Preserve user data in:
-- - shortlinks
-- - notifications
--
-- Rebuild everything else from scratch so the resulting catalog matches
-- src/infra/database/user/schema.sql.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Preserve ShortLinks rows while normalizing the latest index set.
ALTER TABLE shortlinks
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE shortlinks
SET created_at = COALESCE(created_at, last_access_at, NOW())
WHERE created_at IS NULL;

ALTER TABLE shortlinks
ALTER COLUMN created_at SET DEFAULT NOW();

ALTER TABLE shortlinks
ALTER COLUMN created_at SET NOT NULL;

DROP INDEX IF EXISTS idx_shortlinks_user_ids;
DROP INDEX IF EXISTS idx_shortlinks_code;
DROP INDEX IF EXISTS idx_shortlinks_original_url;
DROP INDEX IF EXISTS idx_shortlinks_created_at;

CREATE INDEX IF NOT EXISTS idx_shortlinks_user_ids
ON shortlinks USING GIN(user_ids);

CREATE INDEX IF NOT EXISTS idx_shortlinks_created_at
ON shortlinks(created_at);

-- Preserve Notifications rows while normalizing the latest indexes/comments.
ALTER TABLE notifications
ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE notifications
SET created_at = COALESCE(created_at, updated_at, NOW())
WHERE created_at IS NULL;

ALTER TABLE notifications
ALTER COLUMN created_at SET DEFAULT NOW();

ALTER TABLE notifications
ALTER COLUMN created_at SET NOT NULL;

WITH ranked_global_unsubscribe AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY user_id, notification_type
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS duplicate_rank
  FROM notifications
  WHERE notification_type = 'global_unsubscribe'
)
DELETE FROM notifications
WHERE ctid IN (
  SELECT ctid
  FROM ranked_global_unsubscribe
  WHERE duplicate_rank > 1
);

WITH ranked_funky_global AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY user_id, notification_type
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS duplicate_rank
  FROM notifications
  WHERE notification_type = 'funky:notification:global'
)
DELETE FROM notifications
WHERE ctid IN (
  SELECT ctid
  FROM ranked_funky_global
  WHERE duplicate_rank > 1
);

DROP INDEX IF EXISTS idx_notifications_user_active;
DROP INDEX IF EXISTS idx_notifications_entity;
DROP INDEX IF EXISTS idx_notifications_type_active;
DROP INDEX IF EXISTS idx_notifications_hash;
DROP INDEX IF EXISTS idx_notifications_global_unsubscribe_user;
DROP INDEX IF EXISTS idx_notifications_public_debate_global_user;
DROP INDEX IF EXISTS idx_notifications_funky_global_user;

CREATE INDEX IF NOT EXISTS idx_notifications_user_active
ON notifications(user_id)
WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_notifications_entity
ON notifications(entity_cui)
WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_notifications_type_active
ON notifications(notification_type)
WHERE is_active = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_global_unsubscribe_user
ON notifications(user_id, notification_type)
WHERE notification_type = 'global_unsubscribe';

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_funky_global_user
ON notifications(user_id, notification_type)
WHERE notification_type = 'funky:notification:global';

COMMENT ON TABLE notifications IS
'User-owned notification preferences and subscriptions. Sent or queued notification records live in NotificationsOutbox.';

-- Drop legacy and partially migrated objects that do not need data preserved.
DROP TABLE IF EXISTS advancedmapanalyticssnapshots CASCADE;
DROP TABLE IF EXISTS advancedmapanalyticsmaps CASCADE;
DROP TABLE IF EXISTS resendwebhookevents CASCADE;
DROP TABLE IF EXISTS resend_wh_emails CASCADE;
DROP TABLE IF EXISTS institutionemailcapturetokens CASCADE;
DROP TABLE IF EXISTS institutionemailmessages CASCADE;
DROP TABLE IF EXISTS institutionemailthreads CASCADE;
DROP TABLE IF EXISTS userinteractions CASCADE;
DROP TABLE IF EXISTS learningprogress CASCADE;
DROP TABLE IF EXISTS notificationsoutbox CASCADE;
DROP TABLE IF EXISTS notificationoutbox CASCADE;
DROP TABLE IF EXISTS notificationdeliveries CASCADE;
DROP TABLE IF EXISTS unsubscribetokens CASCADE;

DROP SEQUENCE IF EXISTS userinteractions_updated_seq CASCADE;
DROP SEQUENCE IF EXISTS learningprogress_updated_seq CASCADE;

-- NotificationsOutbox: Durable sent/queued/audited notification records.
CREATE TABLE IF NOT EXISTS notificationsoutbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  reference_id TEXT NULL,
  scope_key TEXT NOT NULL,
  delivery_key TEXT UNIQUE NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  rendered_subject TEXT,
  rendered_html TEXT,
  rendered_text TEXT,
  content_hash TEXT,
  template_name TEXT,
  template_version TEXT,
  to_email TEXT,
  resend_email_id TEXT,
  last_error TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notification_outbox_status_check CHECK (status IN (
    'pending', 'composing', 'sending', 'sent', 'delivered', 'webhook_timeout',
    'failed_transient', 'failed_permanent',
    'suppressed', 'skipped_unsubscribed', 'skipped_no_email'
  ))
);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_user_scope
ON notificationsoutbox(user_id, scope_key);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_created_at
ON notificationsoutbox(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_reference
ON notificationsoutbox(notification_type, reference_id)
WHERE reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_scope_type_reference
ON notificationsoutbox(scope_key, notification_type, reference_id)
WHERE reference_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_user_sent_at_desc
ON notificationsoutbox(user_id, sent_at DESC, created_at DESC)
WHERE sent_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_outbox_status_pending
ON notificationsoutbox(status)
WHERE status IN ('pending', 'failed_transient');

CREATE INDEX IF NOT EXISTS idx_notification_outbox_sending_stuck
ON notificationsoutbox(last_attempt_at)
WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS idx_notification_outbox_resend_email_id
ON notificationsoutbox(resend_email_id)
WHERE resend_email_id IS NOT NULL;

COMMENT ON TABLE notificationsoutbox IS
'Durable notification outbox used for deduplication, compose/send lifecycle, audit, and recovery.';

-- UserInteractions: generic record storage for learning and challenge state.
CREATE SEQUENCE userinteractions_updated_seq;

CREATE TABLE IF NOT EXISTS userinteractions (
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
ON userinteractions(user_id, updated_seq);

CREATE INDEX IF NOT EXISTS idx_userinteractions_user_record_key_prefix
ON userinteractions(user_id, record_key text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_userinteractions_record_key_prefix
ON userinteractions(record_key text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_userinteractions_review_pending_updated_at
ON userinteractions(updated_at DESC, user_id, record_key)
WHERE record->>'phase' = 'pending';

CREATE INDEX IF NOT EXISTS idx_userinteractions_review_status_updated_at
ON userinteractions(
  ((record->'review'->>'status')),
  updated_at DESC,
  user_id,
  record_key
)
WHERE record ? 'review';

-- InstitutionEmailThreads: generic correspondence thread aggregates.
CREATE TABLE IF NOT EXISTS institutionemailthreads (
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
ON institutionemailthreads(thread_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_institution_email_threads_platform_send_active_unique
ON institutionemailthreads(entity_cui, campaign_key)
WHERE record->>'submissionPath' = 'platform_send'
  AND phase <> 'failed'
  AND campaign_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_institution_email_threads_self_send_interaction_unique
ON institutionemailthreads(
  entity_cui,
  campaign_key,
  (record->'metadata'->>'interactionKey')
)
WHERE record->>'submissionPath' = 'self_send_cc'
  AND campaign_key IS NOT NULL
  AND record->'metadata'->>'interactionKey' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_entity_campaign_recent
ON institutionemailthreads(entity_cui, campaign_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_phase
ON institutionemailthreads(phase, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_pending_reply
ON institutionemailthreads(last_reply_at DESC)
WHERE phase = 'reply_received_unreviewed' AND last_reply_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_next_action_at
ON institutionemailthreads(next_action_at)
WHERE next_action_at IS NOT NULL;

-- resend_wh_emails: generic shared Resend email event store.
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_resend_wh_emails_svix_id_unique
ON resend_wh_emails(svix_id);

CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_email_id
ON resend_wh_emails(email_id);

CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_event_type
ON resend_wh_emails(event_type);

CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_webhook_received_at
ON resend_wh_emails(webhook_received_at);

CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_from_address
ON resend_wh_emails(from_address);

CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_message_id
ON resend_wh_emails(message_id)
WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_thread_key
ON resend_wh_emails(thread_key)
WHERE thread_key IS NOT NULL;

-- AdvancedMapAnalyticsMaps: User-owned map analytics projects with latest snapshot cache.
CREATE TABLE IF NOT EXISTS advancedmapanalyticsmaps (
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
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT advanced_map_analytics_maps_visibility_check
    CHECK (visibility IN ('private', 'public')),
  CONSTRAINT advanced_map_analytics_maps_snapshot_count_check
    CHECK (snapshot_count >= 0),
  CONSTRAINT advanced_map_analytics_maps_public_view_count_check
    CHECK (public_view_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_advanced_map_analytics_maps_user_updated
ON advancedmapanalyticsmaps(user_id, updated_at DESC)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_advanced_map_analytics_maps_public_id
ON advancedmapanalyticsmaps(public_id)
WHERE public_id IS NOT NULL AND deleted_at IS NULL;

-- AdvancedMapAnalyticsSnapshots: append-only immutable snapshots.
CREATE TABLE IF NOT EXISTS advancedmapanalyticssnapshots (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES advancedmapanalyticsmaps(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_advanced_map_analytics_snapshots_map_created_at
ON advancedmapanalyticssnapshots(map_id, created_at DESC);
