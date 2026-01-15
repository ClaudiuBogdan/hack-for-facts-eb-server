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

-- LearningProgress: User learning progress events (event-sourced)
-- Stores all events in a JSONB array for simple load/save operations.
-- The client derives the snapshot from events; server stores and syncs.
CREATE TABLE IF NOT EXISTS LearningProgress (
  user_id TEXT PRIMARY KEY,
  
  -- All progress events as JSONB array (event-sourced, append-only semantically)
  -- Each event has: eventId, occurredAt, clientId, type, payload
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  
  -- Timestamp of the most recent event (used as cursor for sync)
  last_event_at TIMESTAMPTZ,
  
  -- Event count for quick limit checking (max 10,000 per user)
  event_count INT NOT NULL DEFAULT 0,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for quick user lookup (primary key covers this)
-- No additional indexes needed since we always load the full row

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
