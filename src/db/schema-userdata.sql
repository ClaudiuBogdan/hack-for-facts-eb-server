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
  id BIGSERIAL PRIMARY KEY,
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

-- NotificationDeliveries: Tracks only successfully delivered notifications
CREATE TABLE IF NOT EXISTS NotificationDeliveries (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id BIGINT NOT NULL REFERENCES Notifications(id) ON DELETE CASCADE,

  -- Period identifier for deduplication
  period_key TEXT NOT NULL, -- '2025-01', '2025-Q1', '2025'

  -- Composite deduplication key: user_id:notification_id:period_key
  delivery_key TEXT UNIQUE NOT NULL,

  -- Email batch identifier (groups notifications sent in same email)
  email_batch_id UUID NOT NULL,

  -- Delivery timestamp (always set - only successful sends recorded)
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Optional metadata for audit (alert values, etc.)
  metadata JSONB DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_delivery_key ON NotificationDeliveries(delivery_key);
CREATE INDEX IF NOT EXISTS idx_deliveries_user_period ON NotificationDeliveries(user_id, period_key);
CREATE INDEX IF NOT EXISTS idx_deliveries_created_at ON NotificationDeliveries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_notification ON NotificationDeliveries(notification_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_email_batch ON NotificationDeliveries(email_batch_id);

-- UnsubscribeTokens: Manages unsubscribe tokens for email links
CREATE TABLE IF NOT EXISTS UnsubscribeTokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  notification_id BIGINT NOT NULL REFERENCES Notifications(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 year'),
  used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_user ON UnsubscribeTokens(user_id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_expires ON UnsubscribeTokens(expires_at) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_notification ON UnsubscribeTokens(notification_id);

