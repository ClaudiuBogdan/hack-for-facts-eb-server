-- Schema for user-generated data
CREATE TABLE IF NOT EXISTS UserFeedback (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_userfeedback_user_id ON UserFeedback(user_id);


