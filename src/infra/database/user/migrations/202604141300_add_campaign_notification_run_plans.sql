CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS campaignnotificationrunplans (
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
ON campaignnotificationrunplans(actor_user_id, campaign_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaign_notification_run_plans_expires_at
ON campaignnotificationrunplans(expires_at)
WHERE consumed_at IS NULL;

COMMENT ON TABLE campaignnotificationrunplans IS
'Short-lived stored dry-run plans for template-first campaign admin notification sends.';
