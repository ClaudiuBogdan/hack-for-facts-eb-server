DROP TABLE IF EXISTS resendwebhookevents;
DROP TABLE IF EXISTS institutionemailcapturetokens;
DROP TABLE IF EXISTS institutionemailmessages;
DROP TABLE IF EXISTS institutionemailthreads;

-- Valid phase values are enforced in application code to keep campaigns flexible.
CREATE TABLE institutionemailthreads (
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

CREATE UNIQUE INDEX idx_institution_email_threads_thread_key_unique
ON institutionemailthreads(thread_key);

CREATE INDEX idx_institution_email_threads_entity_campaign_recent
ON institutionemailthreads(entity_cui, campaign_key, created_at DESC);

CREATE INDEX idx_institution_email_threads_phase
ON institutionemailthreads(phase, updated_at DESC);

CREATE INDEX idx_institution_email_threads_pending_reply
ON institutionemailthreads(last_reply_at DESC)
WHERE phase = 'reply_received_unreviewed' AND last_reply_at IS NOT NULL;

CREATE INDEX idx_institution_email_threads_next_action_at
ON institutionemailthreads(next_action_at)
WHERE next_action_at IS NOT NULL;

ALTER TABLE resend_wh_emails
ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_resend_wh_emails_message_id
ON resend_wh_emails(message_id)
WHERE message_id IS NOT NULL;
