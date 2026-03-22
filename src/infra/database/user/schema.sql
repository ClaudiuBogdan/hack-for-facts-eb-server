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
CREATE INDEX IF NOT EXISTS idx_shortlinks_code ON ShortLinks(code);
CREATE INDEX IF NOT EXISTS idx_shortlinks_original_url ON ShortLinks(original_url);
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
CREATE INDEX IF NOT EXISTS idx_notifications_hash ON Notifications(hash);

-- NotificationDeliveries: Tracks notification delivery lifecycle (outbox pattern)
-- Status lifecycle: pending → sending → sent → delivered (via webhook)
--                           ↘ failed_transient (retryable)
--                           ↘ failed_permanent (no retry)
--                           ↘ suppressed (from webhook)
--                           ↘ skipped_unsubscribed
--                           ↘ skipped_no_email
CREATE TABLE IF NOT EXISTS NotificationDeliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES Notifications(id) ON DELETE CASCADE,

  -- Period identifier for deduplication
  period_key TEXT NOT NULL, -- '2025-01', '2025-Q1', '2025'

  -- Composite deduplication key: user_id:notification_id:period_key
  delivery_key TEXT UNIQUE NOT NULL,

  -- Delivery status (outbox pattern)
  status VARCHAR(20) NOT NULL DEFAULT 'pending',

  -- FK to UnsubscribeTokens (set at compose time)
  unsubscribe_token TEXT REFERENCES UnsubscribeTokens(token) ON DELETE SET NULL,

  -- Rendered email content (persisted for retry safety)
  rendered_subject TEXT,
  rendered_html TEXT,
  rendered_text TEXT,
  content_hash TEXT, -- Hash of rendered content for change detection
  template_name TEXT,
  template_version TEXT,

  -- Snapshot of email used at send time
  to_email TEXT,

  -- Resend integration
  resend_email_id TEXT, -- ID returned by Resend API

  -- Error tracking
  last_error TEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,

  -- Timestamps
  sent_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Status check constraint for valid values
ALTER TABLE NotificationDeliveries
DROP CONSTRAINT IF EXISTS deliveries_status_check;
ALTER TABLE NotificationDeliveries
ADD CONSTRAINT deliveries_status_check
CHECK (status IN (
  'pending', 'sending', 'sent', 'delivered',
  'failed_transient', 'failed_permanent',
  'suppressed', 'skipped_unsubscribed', 'skipped_no_email'
));

-- Unique constraint on delivery_key (critical for idempotency)
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_delivery_key_unique ON NotificationDeliveries(delivery_key);

CREATE INDEX IF NOT EXISTS idx_deliveries_user_period ON NotificationDeliveries(user_id, period_key);
CREATE INDEX IF NOT EXISTS idx_deliveries_created_at ON NotificationDeliveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_notification ON NotificationDeliveries(notification_id);

-- Index for querying pending/failed deliveries (for worker processing)
CREATE INDEX IF NOT EXISTS idx_deliveries_status_pending
ON NotificationDeliveries(status) WHERE status IN ('pending', 'failed_transient');

-- Index for finding stuck 'sending' records (for sweeper)
CREATE INDEX IF NOT EXISTS idx_deliveries_sending_stuck
ON NotificationDeliveries(last_attempt_at) WHERE status = 'sending';

-- Index for Resend email ID lookup (webhook processing)
CREATE INDEX IF NOT EXISTS idx_deliveries_resend_email_id ON NotificationDeliveries(resend_email_id) WHERE resend_email_id IS NOT NULL;

-- UnsubscribeTokens: Manages unsubscribe tokens for email links
CREATE TABLE IF NOT EXISTS UnsubscribeTokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id UUID NOT NULL REFERENCES Notifications(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 year'),
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_user ON UnsubscribeTokens(user_id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_expires ON UnsubscribeTokens(expires_at) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_notification ON UnsubscribeTokens(notification_id);

-- LearningProgress: generic record storage for learning and challenge state.
-- Clean cut from the old per-user event array model.
DROP TABLE IF EXISTS LearningProgress;
DROP SEQUENCE IF EXISTS learningprogress_updated_seq;

CREATE SEQUENCE learningprogress_updated_seq;

CREATE TABLE LearningProgress (
  user_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  record JSONB NOT NULL,
  audit_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_seq BIGINT NOT NULL DEFAULT nextval('learningprogress_updated_seq'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, record_key)
);

CREATE INDEX IF NOT EXISTS idx_learningprogress_user_updated_seq
ON LearningProgress(user_id, updated_seq);

-- ResendWebhookEvents: Tracks Resend webhook events for idempotent processing
-- Uses svix-id header as unique event identifier (NOT event.id from payload)
CREATE TABLE IF NOT EXISTS ResendWebhookEvents (
  id BIGSERIAL PRIMARY KEY,
  svix_id TEXT UNIQUE NOT NULL,  -- Use svix-id header as unique event ID
  event_type TEXT NOT NULL,  -- email.sent, email.delivered, email.bounced, etc.
  resend_email_id TEXT NOT NULL,  -- Resend's email ID from the event
  delivery_id UUID,  -- Our delivery UUID from tags (if present)
  payload JSONB NOT NULL,  -- Full event payload for audit
  processed_at TIMESTAMPTZ,  -- When we finished processing (null = still processing)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resend_events_email_id ON ResendWebhookEvents(resend_email_id);
CREATE INDEX IF NOT EXISTS idx_resend_events_delivery_id ON ResendWebhookEvents(delivery_id) WHERE delivery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resend_events_unprocessed ON ResendWebhookEvents(created_at) WHERE processed_at IS NULL;

-- InstitutionEmailThreads: business workflow for institution outreach
CREATE TABLE IF NOT EXISTS InstitutionEmailThreads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_cui VARCHAR(20) NOT NULL,
  owner_user_id TEXT NULL,
  campaign_ref TEXT NULL,
  request_type TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  status_reason TEXT NULL,
  last_email_at TIMESTAMPTZ NULL,
  last_reply_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE InstitutionEmailThreads
DROP CONSTRAINT IF EXISTS institution_email_threads_status_check;
ALTER TABLE InstitutionEmailThreads
ADD CONSTRAINT institution_email_threads_status_check
CHECK (status IN (
  'draft', 'waiting_reply', 'replied', 'closed', 'failed'
));

CREATE UNIQUE INDEX IF NOT EXISTS idx_institution_email_threads_thread_key_unique
ON InstitutionEmailThreads(thread_key);

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_entity_cui
ON InstitutionEmailThreads(entity_cui);

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_owner_user_id
ON InstitutionEmailThreads(owner_user_id)
WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_institution_email_threads_campaign_ref
ON InstitutionEmailThreads(campaign_ref)
WHERE campaign_ref IS NOT NULL;

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
  subject TEXT NOT NULL,
  email_created_at TIMESTAMPTZ NOT NULL,
  broadcast_id TEXT NULL,
  template_id TEXT NULL,
  tags JSONB NULL,
  bounce_type TEXT NULL,
  bounce_sub_type TEXT NULL,
  bounce_message TEXT NULL,
  bounce_diagnostic_code TEXT[] NULL,
  click_ip_address TEXT NULL,
  click_link TEXT NULL,
  click_timestamp TIMESTAMPTZ NULL,
  click_user_agent TEXT NULL,
  thread_key TEXT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resend_wh_emails_svix_id_unique ON resend_wh_emails(svix_id);
CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_email_id ON resend_wh_emails(email_id);
CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_event_type ON resend_wh_emails(event_type);
CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_webhook_received_at ON resend_wh_emails(webhook_received_at);
CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_from_address ON resend_wh_emails(from_address);
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
