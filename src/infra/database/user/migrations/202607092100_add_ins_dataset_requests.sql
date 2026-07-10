-- INS dataset requests: users asking for a CATALOG_ONLY dataset to be loaded,
-- optionally scoped to a territory. Anonymous submissions are allowed, so both
-- contact_email and clerk_user_id are nullable. Both are anonymized on Clerk
-- user.deleted (see docs/USER-DATA-ANONYMIZATION.md). Mirrors schema.sql.

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
