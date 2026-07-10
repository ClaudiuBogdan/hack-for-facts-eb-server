-- Notification platform persistence. Mirrors the notification-platform section
-- in schema.sql and is safe when schema.sql has already created the objects.

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
