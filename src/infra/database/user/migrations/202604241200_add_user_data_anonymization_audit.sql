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
